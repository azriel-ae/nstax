/**
 * CEK UPL THE OMALA — parser HOTEL & RESTO.
 *
 * Mengikuti SQL acuan (tabel d_file_data, id_command = 'UPL0204') namun membaca
 * langsung dari file CSV (delimiter ';'). Kolom SQL (A, B, F, H, K, M, ...)
 * dipetakan ke KOLOM CSV berdasarkan posisi huruf kolom Excel, dan header tabel
 * dicari dulu (laporan memiliki beberapa baris judul sebelum header).
 *
 *  HOTEL (filename LIKE '%_FO%')       : A=Date, B=Room Number, F=Bill Number,
 *                                        H=Description, M=Amount
 *  RESTO (filename LIKE '%_Cashier%')  : A=Bill Number, K=Total
 *
 * Tidak ada data dummy / hardcode hasil: semua nilai dihitung dari isi file.
 */
import { findDuplicateFiles, yieldToUi, type MonthlyFileResult, type MonthlyProgress } from "@/lib/monthlyCommon";

export type OmalaCategory = "HOTEL" | "RESTO";

export const OMALA_AGENT: Record<OmalaCategory, "omala_hotel" | "omala_resto"> = {
  HOTEL: "omala_hotel",
  RESTO: "omala_resto",
};

/** Presisi pembulatan sesuai SQL: RESTO ROUND(x, 0), HOTEL ROUND(x, 2). */
export const OMALA_DECIMALS: Record<OmalaCategory, number> = { HOTEL: 2, RESTO: 0 };

export type OmalaRow = {
  filename: string;
  id_agent: "omala_hotel" | "omala_resto";
  no_struk: string;
  date_trans: string;
  subtotal: number;
  service_charge: number;
  discount: number;
  dpp: number;
  tax: number;
  total: number;
  /** Hanya HOTEL (kolom H). RESTO tidak memiliki keterangan. */
  keterangan?: string;
  /** Nomor baris (record) di file CSV, 1-based. */
  sourceRow: number;
};

export type OmalaIssue = { fileName: string; sourceRow: number; reason: string; value?: string };

export type OmalaSummary = {
  fileCount: number;
  transactionCount: number;
  subtotal: number;
  service_charge: number;
  discount: number;
  dpp: number;
  tax: number;
  total: number;
};

export type OmalaTextResult =
  | {
      ok: true;
      headerRow: number;
      totalRecords: number;
      rows: OmalaRow[];
      issues: OmalaIssue[];
      skipped: { blank: number; total: number; other: number; otherSamples: string[] };
    }
  | { ok: false; error: string };

export type OmalaFileResult = MonthlyFileResult & {
  headerRow?: number;
  skippedBlank: number;
  skippedTotal: number;
  skippedOther: number;
  problemRows: number;
};

export type OmalaBatchResult = {
  ok: boolean;
  error?: string;
  category: OmalaCategory;
  files: OmalaFileResult[];
  rows: OmalaRow[];
  issues: OmalaIssue[];
  summary: OmalaSummary;
};

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Parser CSV ber-delimiter (default ';') dengan dukungan field ber-kutip.
 * Setiap record (termasuk baris kosong) tetap menjadi 1 entri sehingga nomor
 * record = nomor baris file. Tanda kutip hanya dianggap pembuka jika berada
 * di awal field.
 */
export function parseDelimited(text: string, delimiter = ";"): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStart = true;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"' && fieldStart) { inQuotes = true; fieldStart = false; continue; }
    if (ch === delimiter) { record.push(field); field = ""; fieldStart = true; continue; }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      record.push(field);
      records.push(record);
      record = []; field = ""; fieldStart = true;
      continue;
    }
    field += ch;
    fieldStart = false;
  }
  if (field !== "" || record.length > 0) { record.push(field); records.push(record); }
  return records;
}

const norm = (value: unknown) => String(value ?? "").replace(/^\uFEFF/, "").replace(/\s+/g, " ").trim().toLowerCase();
const columnLetter = (index: number) => {
  let n = index; let out = "";
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return out;
};

/* ------------------------------------------------------------------ */
/* Angka & tanggal                                                     */
/* ------------------------------------------------------------------ */

export type CleanTotal = { ok: true; value: bigint } | { ok: false; reason: string };

/**
 * Pembersihan angka PERSIS seperti SQL:
 *  - jika 3 karakter terakhir (setelah TRIM) adalah ',00' atau '.00' → dibuang
 *  - lalu seluruh '.' dan ',' dihapus
 *
 * SQL menghapus semua pemisah sehingga nilai berpecahan non-nol (mis.
 * "480,265.50") akan terbaca 100x lipat. Nilai seperti itu TIDAK ditebak:
 * dikembalikan sebagai error agar baris dilaporkan, bukan dihitung salah.
 */
export function cleanOmalaTotal(raw: string | undefined): CleanTotal {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, reason: "nilai total kosong" };
  const last3 = trimmed.slice(-3);
  const stripped = last3 === ",00" || last3 === ".00" ? trimmed.slice(0, -3) : trimmed;
  if (/[.,]\d{1,2}$/.test(stripped)) {
    return { ok: false, reason: "angka memiliki pecahan non-nol; rumus pembersihan SQL akan menggeser nilai 100x, baris tidak dihitung" };
  }
  const digits = stripped.replace(/[.,]/g, "");
  if (!/^-?\d+$/.test(digits)) return { ok: false, reason: "format angka tidak valid" };
  if (digits.replace("-", "").length > 15) return { ok: false, reason: "angka terlalu besar untuk diproses dengan aman" };
  return { ok: true, value: BigInt(digits) };
}

/** Pembagian bilangan bulat dengan pembulatan half-away-from-zero (seperti ROUND SQL). */
function divRound(numerator: bigint, denominator: bigint): bigint {
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (2n * n + d) / (2n * d);
  return negative ? -q : q;
}

export type OmalaAmounts = { subtotal: number; service_charge: number; discount: number; dpp: number; tax: number; total: number };

/**
 * Rumus SQL (aritmetika bilangan bulat, tanpa galat floating point):
 *   subtotal = ROUND(total / 1.21, d)   service_charge = ROUND(total / 12.1, d)
 *   dpp      = ROUND(total / 1.1,  d)   tax            = ROUND(total / 11,   d)
 *   discount = 0                        total          = total_clean
 * d = 0 untuk RESTO, d = 2 untuk HOTEL.
 */
export function computeOmalaAmounts(total: bigint, category: OmalaCategory): OmalaAmounts {
  const decimals = OMALA_DECIMALS[category];
  const scale = 10n ** BigInt(decimals);
  const scaleNumber = Number(scale);
  // total / (num/den) = total * den / num
  const divide = (den: bigint, num: bigint) => Number(divRound(total * den * scale, num)) / scaleNumber;
  return {
    subtotal: divide(100n, 121n), // / 1.21
    service_charge: divide(10n, 121n), // / 12.1
    discount: 0,
    dpp: divide(10n, 11n), // / 1.1
    tax: divide(1n, 11n), // / 11
    total: Number(total),
  };
}

function validIso(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** HOTEL: STR_TO_DATE(A, '%d/%m/%Y') → 'YYYY-MM-DD'. */
export function parseHotelDate(raw: string | undefined): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((raw ?? "").trim());
  return match ? validIso(Number(match[3]), Number(match[2]), Number(match[1])) : null;
}

/** RESTO: STR_TO_DATE(LEFT(filename, 8), '%Y%m%d') → 'YYYY-MM-DD'. */
export function parseRestoFilenameDate(fileName: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(fileName);
  return match ? validIso(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

/* ------------------------------------------------------------------ */
/* Nama file (LIKE '%_FO%' / '%_Cashier%'; '_' = satu karakter apa pun) */
/* ------------------------------------------------------------------ */

export const matchesCashierName = (fileName: string) => /.Cashier/i.test(fileName);
export const matchesFoName = (fileName: string) => /.FO/i.test(fileName);

/* ------------------------------------------------------------------ */
/* Struktur kolom                                                      */
/* ------------------------------------------------------------------ */

const REQUIRED_COLUMNS: Record<OmalaCategory, Array<{ index: number; header: string; label: string }>> = {
  HOTEL: [
    { index: 0, header: "date", label: "Date" },
    { index: 1, header: "room number", label: "Room Number" },
    { index: 5, header: "bill number", label: "Bill Number" },
    { index: 7, header: "description", label: "Description" },
    { index: 12, header: "amount", label: "Amount" },
  ],
  RESTO: [
    { index: 0, header: "bill number", label: "Bill Number" },
    { index: 10, header: "total", label: "Total" },
  ],
};

/** Header tabel HOTEL diawali 'Date' di kolom A; RESTO diawali 'Bill Number' di kolom A. */
const HEADER_FIRST_CELL: Record<OmalaCategory, string> = { HOTEL: "date", RESTO: "bill number" };

/** Mendeteksi jenis file dari struktur aslinya (header tabel). */
export function detectOmalaStructure(records: string[][]): OmalaCategory | null {
  for (const record of records) {
    const cells = record.map(norm);
    if (cells[0] === "date" && cells.includes("room number")) return "HOTEL";
    if (cells[0] === "bill number" && !cells.includes("room number")) return "RESTO";
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Parser per file                                                     */
/* ------------------------------------------------------------------ */

const isAllEmpty = (record: string[]) => record.every((cell) => cell.trim() === "");
const looksLikeTotalRow = (record: string[]) => record.some((cell) => /t\s*o\s*t\s*a\s*l/i.test(cell));

export function parseOmalaText(text: string, fileName: string, category: OmalaCategory): OmalaTextResult {
  const records = parseDelimited(text, ";");
  if (!records.length || records.every(isAllEmpty)) return { ok: false, error: "File CSV kosong." };

  const headerIndex = records.findIndex((record) => norm(record[0]) === HEADER_FIRST_CELL[category] && (category === "RESTO" ? !record.map(norm).includes("room number") : true));
  if (headerIndex < 0) {
    const detected = detectOmalaStructure(records);
    if (detected && detected !== category) {
      return { ok: false, error: `Struktur file adalah ${detected}, bukan ${category}. Pilih kategori ${detected} untuk file ini.` };
    }
    return {
      ok: false,
      error: category === "HOTEL"
        ? "Header tabel HOTEL tidak ditemukan (dicari baris dengan kolom A = \"Date\"). Pastikan file FO Transaction Journal dengan delimiter titik koma (;)."
        : "Header tabel RESTO tidak ditemukan (dicari baris dengan kolom A = \"Bill Number\"). Pastikan file Cashier Sales Report dengan delimiter titik koma (;).",
    };
  }

  const header = records[headerIndex];
  const mismatches = REQUIRED_COLUMNS[category]
    .filter((col) => norm(header[col.index]) !== col.header)
    .map((col) => `kolom ${columnLetter(col.index)} seharusnya "${col.label}" tetapi berisi "${(header[col.index] ?? "").trim() || "(tidak ada)"}"`);
  if (mismatches.length) {
    return { ok: false, error: `Struktur kolom ${category} tidak sesuai query pada baris header ${headerIndex + 1}: ${mismatches.join("; ")}.` };
  }

  const filenameDate = category === "RESTO" ? parseRestoFilenameDate(fileName) : null;
  if (category === "RESTO" && !filenameDate) {
    return { ok: false, error: "Nama file RESTO harus diawali tanggal 8 digit YYYYMMDD (contoh: 20261006_Cashier Sales Report.csv) yang valid." };
  }

  const rows: OmalaRow[] = [];
  const issues: OmalaIssue[] = [];
  const skipped = { blank: 0, total: 0, other: 0, otherSamples: [] as string[] };
  const idAgent = OMALA_AGENT[category];

  for (let i = headerIndex + 1; i < records.length; i += 1) {
    const record = records[i];
    const sourceRow = i + 1;
    const skip = (isCandidate: boolean) => {
      if (isCandidate) return false;
      if (isAllEmpty(record)) skipped.blank += 1;
      else if (looksLikeTotalRow(record)) skipped.total += 1;
      else {
        skipped.other += 1;
        if (skipped.otherSamples.length < 3) skipped.otherSamples.push(`baris ${sourceRow}`);
      }
      return true;
    };

    if (category === "RESTO") {
      const billNumber = record[0] ?? ""; // kolom A — tanpa trim, persis REGEXP '^[0-9]+$'
      if (skip(/^[0-9]+$/.test(billNumber))) continue;
      const cleaned = cleanOmalaTotal(record[10]);
      if (!cleaned.ok) { issues.push({ fileName, sourceRow, reason: `Kolom K (Total): ${cleaned.reason}`, value: record[10] }); continue; }
      rows.push({
        filename: fileName,
        id_agent: idAgent,
        // id sumber (d_file_data.id) tidak ada di CSV → nomor record file dipakai sebagai id baris.
        no_struk: `${billNumber}-${sourceRow}`,
        date_trans: filenameDate as string,
        ...computeOmalaAmounts(cleaned.value, "RESTO"),
        sourceRow,
      });
    } else {
      const description = record[7]; // kolom H
      const descriptionTrimmed = description === undefined ? null : description.replace(/\s+$/, "");
      // H NOT IN (' ', 'Description'): kosong/spasi (PAD SPACE), 'Description', atau NULL → bukan transaksi
      const isTransaction = descriptionTrimmed !== null && descriptionTrimmed !== "" && descriptionTrimmed.toLowerCase() !== "description";
      if (skip(isTransaction)) continue;
      const date = parseHotelDate(record[0]);
      if (!date) { issues.push({ fileName, sourceRow, reason: "Kolom A (Date) bukan tanggal DD/MM/YYYY yang valid", value: record[0] }); continue; }
      const billNumber = record[5] ?? ""; // kolom F
      if (billNumber.trim() === "") { issues.push({ fileName, sourceRow, reason: "Kolom F (Bill Number) kosong; no_struk tidak dapat dibentuk", value: billNumber }); continue; }
      const cleaned = cleanOmalaTotal(record[12]);
      if (!cleaned.ok) { issues.push({ fileName, sourceRow, reason: `Kolom M (Amount): ${cleaned.reason}`, value: record[12] }); continue; }
      rows.push({
        filename: fileName,
        id_agent: idAgent,
        no_struk: `${billNumber}-${record[1] ?? ""}`, // F + "-" + B
        date_trans: date,
        ...computeOmalaAmounts(cleaned.value, "HOTEL"),
        keterangan: description,
        sourceRow,
      });
    }
  }

  return { ok: true, headerRow: headerIndex + 1, totalRecords: records.length, rows, issues, skipped };
}

/* ------------------------------------------------------------------ */
/* Ringkasan (dari SELURUH baris valid)                                */
/* ------------------------------------------------------------------ */

export function summarizeOmalaRows(rows: OmalaRow[], fileCount: number, category: OmalaCategory): OmalaSummary {
  const decimals = OMALA_DECIMALS[category];
  const scale = 10 ** decimals;
  const sum = (pick: (row: OmalaRow) => number) => rows.reduce((acc, row) => acc + Math.round(pick(row) * scale), 0) / scale;
  return {
    fileCount,
    transactionCount: rows.length,
    subtotal: sum((r) => r.subtotal),
    service_charge: sum((r) => r.service_charge),
    discount: sum((r) => r.discount),
    dpp: sum((r) => r.dpp),
    tax: sum((r) => r.tax),
    total: sum((r) => r.total),
  };
}

export function formatOmalaMoney(value: number, category: OmalaCategory): string {
  const decimals = OMALA_DECIMALS[category];
  return `Rp${value.toLocaleString("id-ID", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

/* ------------------------------------------------------------------ */
/* Banyak file                                                         */
/* ------------------------------------------------------------------ */

const emptySummary = (category: OmalaCategory) => summarizeOmalaRows([], 0, category);

/**
 * Memproses setiap file secara terpisah. Satu file gagal tidak menghentikan file
 * lain. Hanya file kategori terpilih yang dihitung; HOTEL & RESTO tidak dicampur.
 * File identik (nama+ukuran+lastModified) hanya dihitung sekali.
 */
export async function parseOmalaFiles(files: File[], category: OmalaCategory, onProgress?: (progress: MonthlyProgress) => void): Promise<OmalaBatchResult> {
  const duplicates = findDuplicateFiles(files);
  const results: OmalaFileResult[] = [];
  const rows: OmalaRow[] = [];
  const issues: OmalaIssue[] = [];
  const other: OmalaCategory = category === "HOTEL" ? "RESTO" : "HOTEL";
  const nameMatches = (name: string, cat: OmalaCategory) => (cat === "HOTEL" ? matchesFoName(name) : matchesCashierName(name));
  const sqlPattern = category === "HOTEL" ? "%_FO%" : "%_Cashier%";

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    onProgress?.({ done: index, total: files.length, fileName: file.name });
    const base: OmalaFileResult = {
      name: file.name, size: file.size, lastModified: file.lastModified, index,
      status: "success", warnings: [], rowCount: 0, duplicate: false,
      skippedBlank: 0, skippedTotal: 0, skippedOther: 0, problemRows: 0,
    };
    const fail = (message: string) => results.push({ ...base, status: "error", message, warnings: [] });

    const original = duplicates.get(index);
    if (original !== undefined) {
      results.push({ ...base, status: "warning", duplicate: true, duplicateOf: files[original].name, message: `File identik dengan "${files[original].name}"; tidak dihitung dua kali.`, warnings: ["File kemungkinan duplikat."] });
      continue;
    }
    if (!/\.csv$/i.test(file.name)) { fail("Hanya file CSV yang didukung."); continue; }
    if (!nameMatches(file.name, category)) {
      fail(nameMatches(file.name, other)
        ? `File ini adalah file ${other} (nama file cocok dengan ${other === "HOTEL" ? "%_FO%" : "%_Cashier%"}), bukan ${category}. Gunakan kategori ${other}.`
        : `Nama file tidak memenuhi filter SQL ${category} (filename LIKE '${sqlPattern}').`);
      continue;
    }

    let parsed: OmalaTextResult;
    try {
      parsed = parseOmalaText(await file.text(), file.name, category);
    } catch {
      fail("File tidak dapat dibaca.");
      continue;
    }
    if (!parsed.ok) { fail(parsed.error); continue; }

    const warnings: string[] = [];
    if (parsed.skipped.other > 0) warnings.push(`${parsed.skipped.other} baris dilewati karena tidak memenuhi filter SQL (${parsed.skipped.otherSamples.join(", ")}${parsed.skipped.other > parsed.skipped.otherSamples.length ? ", ..." : ""}).`);
    if (parsed.issues.length > 0) warnings.push(`${parsed.issues.length} baris memenuhi filter tetapi bermasalah dan TIDAK dihitung (lihat daftar baris bermasalah).`);
    if (parsed.rows.length === 0) warnings.unshift(`Tidak ada baris transaksi yang memenuhi filter SQL (${parsed.skipped.total} baris total, ${parsed.skipped.blank} baris kosong diabaikan).`);

    rows.push(...parsed.rows);
    issues.push(...parsed.issues);
    results.push({
      ...base,
      status: warnings.length ? "warning" : "success",
      message: warnings.join(" "),
      warnings,
      rowCount: parsed.rows.length,
      headerRow: parsed.headerRow,
      skippedBlank: parsed.skipped.blank,
      skippedTotal: parsed.skipped.total,
      skippedOther: parsed.skipped.other,
      problemRows: parsed.issues.length,
      total: parsed.rows.reduce((s, r) => s + r.total, 0),
    });
    await yieldToUi();
  }
  onProgress?.({ done: files.length, total: files.length, fileName: "" });

  const countedFiles = results.filter((r) => r.status !== "error" && !r.duplicate).length;
  if (!countedFiles) {
    return { ok: false, error: results.map((r) => `${r.name}: ${r.message ?? "gagal"}`).join(" · ") || "Tidak ada file yang berhasil diproses.", category, files: results, rows: [], issues: [], summary: emptySummary(category) };
  }
  return { ok: true, category, files: results, rows, issues, summary: summarizeOmalaRows(rows, countedFiles, category) };
}
