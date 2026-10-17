import JSZip from "jszip";
import Papa from "papaparse";

// CEK UPL · OMAH PADHANG
// Sumber: ZIP berisi satu/lebih CSV laporan transaksi (delimiter koma, field Items di-quote).
// Rumus mengikuti SQL acuan (JANGAN diubah):
//   subtotal = G (Net Sales)      service_charge = H (Gratuity)   discount = E (Discounts)
//   dpp = G - E + H               tax = I (Tax)                   total = K (Total Amount)
//   no_struk = M (Receipt Number) keterangan = R (Items)
//   date_trans = STR_TO_DATE(CONCAT(B,' ',C), '%d-%m-%Y %H:%i:%s') → YYYY-MM-DD HH:mm:ss
// Kolom dipetakan lewat HEADER (bukan posisi), sehingga perubahan urutan kolom tidak menggeser nilai.

export const OMAH_PADHANG_AGENT_ID = "omahpadhang_kabpas";

export type OmahPadhangRow = {
  filename: string; // nama CSV di dalam ZIP
  id_agent: string;
  no_struk: string;
  date_trans: string;
  subtotal: number;
  service_charge: number;
  discount: number;
  dpp: number;
  tax: number;
  total: number;
  keterangan: string;
  sourceRow: number; // nomor baris di file CSV (header = baris 1)
  eventType: string;
  refunds: number | null;
  issues: string[]; // catatan validasi (struk kosong / duplikat), data tidak diubah
};

export type OmahPadhangIssue = { filename: string; row: number | null; message: string };

export type OmahPadhangFileInfo = {
  filename: string;
  status: "processed" | "duplicate" | "failed";
  transactions: number;
  invalidRows: number;
  summaryRowsSkipped: number;
  message?: string;
};

export type OmahPadhangSummary = {
  files: number;
  count: number;
  subtotal: number;
  service_charge: number;
  discount: number;
  dpp: number;
  tax: number;
  total: number;
};

export type OmahPadhangResult = {
  ok: boolean;
  error?: string;
  zipName: string;
  zipExtracted: boolean;
  csvFound: number;
  files: OmahPadhangFileInfo[];
  rows: OmahPadhangRow[];
  issues: OmahPadhangIssue[]; // baris tidak valid / catatan
  duplicateReceipts: number; // jumlah no_struk yang muncul > 1x
  summary: OmahPadhangSummary;
};

const emptySummary = (): OmahPadhangSummary => ({ files: 0, count: 0, subtotal: 0, service_charge: 0, discount: 0, dpp: 0, tax: 0, total: 0 });

// Buang noise floating point (mis. 0.1+0.2) tanpa membulatkan nilai sumber secara berarti.
const clean = (value: number) => Math.round(value * 1e6) / 1e6;

const normalizeHeader = (value: unknown) =>
  String(value ?? "").replace(/^﻿/, "").replace(/\s+/g, " ").trim().toLowerCase();

// Nama kolom sumber (A..U) → field. Pencocokan memakai nama header persis (case-insensitive).
const REQUIRED = {
  date: "date",
  time: "time",
  discount: "discounts",
  subtotal: "net sales",
  service: "gratuity",
  tax: "tax",
  total: "total amount",
  receipt: "receipt number",
  items: "items",
} as const;
type FieldKey = keyof typeof REQUIRED;

type ColumnMap = Record<FieldKey, number> & { eventType: number; refunds: number; outlet: number };

function mapColumns(header: string[]): { map?: ColumnMap; error?: string } {
  const normalized = header.map(normalizeHeader);
  const find = (name: string): { index: number; error?: string } => {
    const hits = normalized.reduce<number[]>((acc, h, i) => (h === name ? [...acc, i] : acc), []);
    if (hits.length > 1) return { index: -1, error: `Header "${name}" ambigu (muncul ${hits.length}x)` };
    return { index: hits.length ? hits[0] : -1 };
  };
  const problems: string[] = [];
  const map = { eventType: -1, refunds: -1, outlet: -1 } as ColumnMap;
  (Object.keys(REQUIRED) as FieldKey[]).forEach((key) => {
    const hit = find(REQUIRED[key]);
    if (hit.error) problems.push(hit.error);
    else if (hit.index < 0) problems.push(`Header wajib "${REQUIRED[key]}" tidak ditemukan`);
    map[key] = hit.index;
  });
  if (problems.length) return { error: problems.join("; ") };
  map.eventType = find("event type").index;
  map.refunds = find("refunds").index;
  map.outlet = find("outlet").index;
  return { map };
}

// Angka sumber memakai titik desimal ("69000.0"). Kosong / tidak valid → null (tidak dikarang).
function parseNumber(raw: string | undefined): number | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

// "DD-MM-YYYY" + "HH:mm:ss" → "YYYY-MM-DD HH:mm:ss" (divalidasi, tidak ada tanggal bawaan).
export function convertDateTime(dateRaw: string, timeRaw: string): string | null {
  const d = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(dateRaw ?? "").trim());
  const t = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(timeRaw ?? "").trim());
  if (!d || !t) return null;
  const day = Number(d[1]), month = Number(d[2]), year = Number(d[3]);
  const hour = Number(t[1]), minute = Number(t[2]), second = Number(t[3]);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

const isSummaryRow = (cells: string[], outletIndex: number) => {
  const first = normalizeHeader(cells[outletIndex >= 0 ? outletIndex : 0]);
  return /^(grand\s*)?total\b/.test(first) || /^(sub\s*total|summary|jumlah)$/.test(first);
};

export type OmahPadhangCsvParse = {
  ok: boolean;
  error?: string;
  rows: OmahPadhangRow[];
  issues: OmahPadhangIssue[];
  invalidRows: number;
  summaryRowsSkipped: number;
};

export function parseOmahPadhangCsv(text: string, filename: string): OmahPadhangCsvParse {
  const issues: OmahPadhangIssue[] = [];
  const parsed = Papa.parse<string[]>(text.replace(/^﻿/, ""), { delimiter: ",", quoteChar: '"', skipEmptyLines: "greedy" });
  const table = parsed.data.filter((cells) => Array.isArray(cells));
  if (!table.length) return { ok: false, error: "CSV kosong.", rows: [], issues, invalidRows: 0, summaryRowsSkipped: 0 };
  const header = table[0];
  const { map, error } = mapColumns(header);
  if (!map) return { ok: false, error, rows: [], issues, invalidRows: 0, summaryRowsSkipped: 0 };

  const rows: OmahPadhangRow[] = [];
  let invalidRows = 0;
  let summaryRowsSkipped = 0;
  const bad = (rowNo: number, message: string) => { invalidRows += 1; issues.push({ filename, row: rowNo, message }); };

  table.slice(1).forEach((cells, index) => {
    const rowNo = index + 2; // header = baris 1 (baris kosong dilewati parser, jadi nomor ini perkiraan berurutan)
    if (cells.every((cell) => String(cell ?? "").trim() === "")) return;
    if (isSummaryRow(cells, map.outlet)) { summaryRowsSkipped += 1; return; }
    if (cells.length !== header.length) { bad(rowNo, `Jumlah kolom ${cells.length}, seharusnya ${header.length} (baris tidak dipetakan agar nilai tidak bergeser)`); return; }
    const dateTime = convertDateTime(cells[map.date], cells[map.time]);
    if (!dateTime) { bad(rowNo, `Tanggal/waktu tidak valid: "${cells[map.date]} ${cells[map.time]}"`); return; }
    const nums = {
      subtotal: parseNumber(cells[map.subtotal]),
      service: parseNumber(cells[map.service]),
      discount: parseNumber(cells[map.discount]),
      tax: parseNumber(cells[map.tax]),
      total: parseNumber(cells[map.total]),
    };
    const badField = (Object.keys(nums) as Array<keyof typeof nums>).find((key) => nums[key] === null);
    if (badField) { bad(rowNo, `Nilai ${REQUIRED[badField]} kosong/tidak valid`); return; }
    const subtotal = nums.subtotal as number, service = nums.service as number, discount = nums.discount as number;
    const rowIssues: string[] = [];
    const noStruk = String(cells[map.receipt] ?? "").trim();
    if (!noStruk) rowIssues.push("No struk kosong — perlu diperiksa");
    rows.push({
      filename,
      id_agent: OMAH_PADHANG_AGENT_ID,
      no_struk: noStruk,
      date_trans: dateTime,
      subtotal,
      service_charge: service,
      discount,
      dpp: clean(subtotal - discount + service),
      tax: nums.tax as number,
      total: nums.total as number,
      keterangan: cells[map.items] ?? "",
      sourceRow: rowNo,
      eventType: map.eventType >= 0 ? String(cells[map.eventType] ?? "").trim() : "",
      refunds: map.refunds >= 0 ? parseNumber(cells[map.refunds]) : null,
      issues: rowIssues,
    });
  });
  return { ok: true, rows, issues, invalidRows, summaryRowsSkipped };
}

export function summarizeOmahPadhang(rows: OmahPadhangRow[], files: number): OmahPadhangSummary {
  const sum = (pick: (row: OmahPadhangRow) => number) => clean(rows.reduce((acc, row) => acc + pick(row), 0));
  return {
    files,
    count: rows.length,
    subtotal: sum((r) => r.subtotal),
    service_charge: sum((r) => r.service_charge),
    discount: sum((r) => r.discount),
    dpp: sum((r) => r.dpp),
    tax: sum((r) => r.tax),
    total: sum((r) => r.total),
  };
}

// Decode: UTF-8 (dengan/tanpa BOM); jika bukan UTF-8 valid, fallback ke windows-1252.
function decodeBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

const isCsvEntry = (path: string) => {
  const base = path.split("/").pop() ?? path;
  return /\.csv$/i.test(base) && !path.startsWith("__MACOSX/") && !base.startsWith("._");
};

const failure = (zipName: string, error: string, extra: Partial<OmahPadhangResult> = {}): OmahPadhangResult => ({
  ok: false, error, zipName, zipExtracted: false, csvFound: 0, files: [], rows: [], issues: [], duplicateReceipts: 0, summary: emptySummary(), ...extra,
});

export async function parseOmahPadhangZip(input: Blob | ArrayBuffer | Uint8Array, zipName: string, seenContent: Map<string, string> = new Map()): Promise<OmahPadhangResult> {
  if (!/\.zip$/i.test(zipName)) return failure(zipName, "File harus berformat .zip. ZIP tidak boleh dibaca langsung sebagai CSV.");
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(input);
  } catch {
    return failure(zipName, "ZIP rusak atau tidak bisa diekstrak.");
  }
  const entries = Object.values(zip.files).filter((entry) => !entry.dir && isCsvEntry(entry.name));
  if (!entries.length) return failure(zipName, "ZIP berhasil diekstrak, tetapi tidak berisi file CSV.", { zipExtracted: true });

  const files: OmahPadhangFileInfo[] = [];
  const issues: OmahPadhangIssue[] = [];
  const rows: OmahPadhangRow[] = [];
  // seenContent: isi CSV (normalisasi) → nama file pertama. Dibagi antar-ZIP saat banyak ZIP diproses sekaligus agar CSV yang sama tidak dihitung dua kali.

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    let text: string;
    try {
      text = decodeBytes(await entry.async("uint8array"));
    } catch {
      files.push({ filename: entry.name, status: "failed", transactions: 0, invalidRows: 0, summaryRowsSkipped: 0, message: "Gagal mengekstrak file" });
      continue;
    }
    const fingerprint = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").trim();
    const original = seenContent.get(fingerprint);
    if (original !== undefined) {
      files.push({ filename: entry.name, status: "duplicate", transactions: 0, invalidRows: 0, summaryRowsSkipped: 0, message: `Isi sama dengan ${original}; tidak dihitung ulang` });
      continue;
    }
    seenContent.set(fingerprint, entry.name);
    const parsed = parseOmahPadhangCsv(text, entry.name);
    if (!parsed.ok) {
      files.push({ filename: entry.name, status: "failed", transactions: 0, invalidRows: 0, summaryRowsSkipped: 0, message: parsed.error });
      issues.push({ filename: entry.name, row: null, message: parsed.error ?? "CSV tidak valid" });
      continue;
    }
    files.push({ filename: entry.name, status: "processed", transactions: parsed.rows.length, invalidRows: parsed.invalidRows, summaryRowsSkipped: parsed.summaryRowsSkipped });
    issues.push(...parsed.issues);
    rows.push(...parsed.rows);
  }

  const processed = files.filter((file) => file.status === "processed").length;
  if (!processed) {
    return failure(zipName, `Tidak ada CSV valid. ${files.map((f) => `${f.filename}: ${f.message ?? f.status}`).join("; ")}`, { zipExtracted: true, csvFound: entries.length, files, issues });
  }

  // Tandai no_struk duplikat (data TIDAK dihapus).
  const counts = new Map<string, number>();
  rows.forEach((row) => { if (row.no_struk) counts.set(row.no_struk, (counts.get(row.no_struk) ?? 0) + 1); });
  let duplicateReceipts = 0;
  counts.forEach((n) => { if (n > 1) duplicateReceipts += 1; });
  rows.forEach((row) => {
    const n = counts.get(row.no_struk) ?? 0;
    if (row.no_struk && n > 1) row.issues.push(`No struk duplikat (${n}x) — perlu diperiksa`);
  });

  return { ok: true, zipName, zipExtracted: true, csvFound: entries.length, files, rows, issues, duplicateReceipts, summary: summarizeOmahPadhang(rows, processed) };
}

export const formatOmahPadhangMoney = (value: number) => `Rp${value.toLocaleString("id-ID", { maximumFractionDigits: 2 })}`;


// ───────────── banyak ZIP sekaligus (mis. satu ZIP per hari / per minggu dalam satu bulan) ─────────────

export type OmahPadhangZipStatus = {
  zipName: string;
  status: "processed" | "failed" | "skipped";
  csvFound: number;
  transactions: number;
  message?: string;
};

export type OmahPadhangMultiResult = { result: OmahPadhangResult; zips: OmahPadhangZipStatus[] };

const DUP_RECEIPT_PREFIX = "No struk duplikat";

/**
 * Memproses beberapa ZIP dengan parser yang sama (parseOmahPadhangZip) lalu menggabungkan semua transaksi valid menjadi satu dataset.
 * - Satu ZIP: hasilnya identik dengan parseOmahPadhangZip (tidak ada perubahan perilaku).
 * - CSV berisi sama (di ZIP yang sama maupun beda ZIP) hanya dihitung sekali.
 * - ZIP yang gagal ditandai "failed" dan tidak menyumbang transaksi; ZIP yang seluruh CSV-nya duplikat ditandai "skipped".
 * - Nama CSV pada hasil gabungan diberi awalan nama ZIP supaya asal baris tetap bisa ditelusuri.
 */
export async function parseOmahPadhangZips(inputs: Array<{ data: Blob | ArrayBuffer | Uint8Array; name: string }>): Promise<OmahPadhangMultiResult> {
  if (inputs.length === 1) {
    const single = await parseOmahPadhangZip(inputs[0].data, inputs[0].name);
    return { result: single, zips: [{ zipName: inputs[0].name, status: single.ok ? "processed" : "failed", csvFound: single.csvFound, transactions: single.rows.length, message: single.ok ? undefined : single.error }] };
  }
  const seen = new Map<string, string>();
  const zips: OmahPadhangZipStatus[] = [];
  const files: OmahPadhangFileInfo[] = [];
  const issues: OmahPadhangIssue[] = [];
  const rows: OmahPadhangRow[] = [];
  let csvFound = 0;
  let extracted = false;
  for (const input of inputs) {
    const r = await parseOmahPadhangZip(input.data, input.name, seen);
    csvFound += r.csvFound;
    extracted = extracted || r.zipExtracted;
    const allDuplicate = r.files.length > 0 && r.files.every((f) => f.status === "duplicate");
    zips.push({
      zipName: input.name,
      status: r.ok ? "processed" : allDuplicate ? "skipped" : "failed",
      csvFound: r.csvFound,
      transactions: r.rows.length,
      message: r.ok ? undefined : allDuplicate ? "Seluruh CSV di ZIP ini sama dengan CSV yang sudah diproses; tidak dihitung ulang." : r.error,
    });
    const tag = (name: string) => `${input.name} › ${name}`;
    files.push(...r.files.map((f) => ({ ...f, filename: tag(f.filename) })));
    issues.push(...r.issues.map((i) => ({ ...i, filename: tag(i.filename) })));
    rows.push(...r.rows.map((row) => ({ ...row, filename: tag(row.filename), issues: row.issues.filter((m) => !m.startsWith(DUP_RECEIPT_PREFIX)) })));
  }
  const processed = files.filter((f) => f.status === "processed").length;
  const zipNames = inputs.map((i) => i.name).join(", ");
  if (!processed) {
    return { zips, result: failure(zipNames, `Tidak ada CSV valid dari ${inputs.length} ZIP. ${zips.map((z) => `${z.zipName}: ${z.message ?? z.status}`).join("; ")}`, { zipExtracted: extracted, csvFound, files, issues }) };
  }
  // Tandai no_struk duplikat pada dataset gabungan (data TIDAK dihapus).
  const counts = new Map<string, number>();
  rows.forEach((row) => { if (row.no_struk) counts.set(row.no_struk, (counts.get(row.no_struk) ?? 0) + 1); });
  let duplicateReceipts = 0;
  counts.forEach((n) => { if (n > 1) duplicateReceipts += 1; });
  rows.forEach((row) => {
    const n = counts.get(row.no_struk) ?? 0;
    if (row.no_struk && n > 1) row.issues.push(`${DUP_RECEIPT_PREFIX} (${n}x) — perlu diperiksa`);
  });
  return { zips, result: { ok: true, zipName: zipNames, zipExtracted: extracted, csvFound, files, rows, issues, duplicateReceipts, summary: summarizeOmahPadhang(rows, processed) } };
}
