import Papa from "papaparse";
import * as XLSX from "xlsx";
import { countUnsafeIntegerCells, quoteLongJsonIntegers, recoverCellsFromXlsx } from "./exactNumbers";

// Pemuat tabel untuk "Bandingkan 2 File" (CEK STRUK). Murni (tanpa DOM): menerima ArrayBuffer sehingga dapat diuji.
// CSV memakai papaparse (kutip, kutip ganda ter-escape, newline dalam field), bukan split() sederhana.

export type SourceFormat = "csv" | "txt" | "json" | "xlsx" | "xls";
export type OpenedSource = {
  format: SourceFormat;
  fileName: string;
  size: number;
  /** CSV / TXT / JSON (teks mentah) */
  text?: string;
  /** JSON: hasil parse */
  json?: unknown;
  /** catatan pembacaan (mis. ekstensi tidak sesuai isi) */
  notes?: string[];
  /** Excel */
  workbook?: XLSX.WorkBook;
  sheets: string[];
};
export type TableData = {
  headers: string[];
  rows: string[][];
  /** nomor baris asli di file (1-based) untuk tiap baris data */
  sourceRows: number[];
  headerRow: number; // 1-based
  headerAuto: boolean;
  sheetName: string | null;
  delimiter: string | null;
  delimiterAuto: boolean;
  blankRows: number;
  repeatedHeaders: number;
  warnings: string[];
};
export class FileReadError extends Error {}

export const DELIMITERS: Array<{ value: string; label: string }> = [
  { value: ",", label: "Koma ( , )" },
  { value: ";", label: "Titik koma ( ; )" },
  { value: "|", label: "Pipe ( | )" },
  { value: "\t", label: "Tab" },
];

const clean = (v: unknown) => (v == null ? "" : String(v));

export function decodeText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes).replace(/^\ufeff/, "");
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes).replace(/^\ufeff/, "");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes); // bukan UTF-8 yang valid: umumnya ekspor Excel lama
  }
  return text.replace(/^\ufeff/, "");
}

/** Pilih delimiter dengan jumlah kolom paling konsisten pada sampel baris. Mengembalikan null bila tidak ada yang meyakinkan. */
export function detectDelimiter(text: string): string | null {
  const sample = text.length > 200_000 ? text.slice(0, 200_000) : text;
  let best: { d: string; score: number } | null = null;
  for (const { value } of DELIMITERS) {
    const parsed = Papa.parse<string[]>(sample, { delimiter: value, skipEmptyLines: "greedy", preview: 60 });
    const counts = parsed.data.map((r) => r.length);
    if (!counts.length) continue;
    const freq = new Map<number, number>();
    counts.forEach((c) => freq.set(c, (freq.get(c) ?? 0) + 1));
    let modal = 0, modalN = 0;
    freq.forEach((n, c) => { if (n > modalN || (n === modalN && c > modal)) { modal = c; modalN = n; } });
    if (modal < 2) continue;
    const score = (modalN / counts.length) * 100 + modal; // konsistensi dulu, lalu jumlah kolom
    if (!best || score > best.score) best = { d: value, score };
  }
  return best ? best.d : null;
}

export type SniffKind = "xlsx" | "xls" | "pdf" | "json" | "text" | "unknown";
/** Deteksi jenis file dari ISI (tanda tangan byte + struktur teks), bukan dari ekstensi. */
export function sniffFormat(buffer: ArrayBuffer): SniffKind {
  const head = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
  if (head[0] === 0x50 && head[1] === 0x4b) return "xlsx";
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return "xls";
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return "pdf";
  const probe = new Uint8Array(buffer, 0, Math.min(4096, buffer.byteLength));
  let bin = 0;
  for (const b of probe) if (b === 0 || (b < 9) || (b > 13 && b < 32)) bin++;
  const isUtf16 = (probe[0] === 0xff && probe[1] === 0xfe) || (probe[0] === 0xfe && probe[1] === 0xff);
  if (!isUtf16 && bin / Math.max(1, probe.length) > 0.02) return "unknown";
  const text = decodeText(buffer).trimStart();
  if (text.startsWith("{") || text.startsWith("[")) { try { JSON.parse(text); return "json"; } catch { /* mungkin CSV yang diawali "[" */ } }
  if (/^<(\?xml|html|table|!doctype)/i.test(text)) return "xls"; // tabel HTML/XML hasil ekspor Excel lama
  return "text";
}

const JSON_ROOT = "(isi utama)";
const PREFERRED_KEYS = ["data", "rows", "items", "transactions", "transaksi", "records", "result", "results", "list"];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isRecordArray = (v: unknown): v is unknown[] => Array.isArray(v) && v.length > 0 && v.every((x) => isObj(x) || Array.isArray(x));

/** Cari daftar array-of-record di JSON (maks. kedalaman 3). Hasil: path → array. Urutan: kunci yang umum dipakai dulu. */
export function jsonCandidates(root: unknown): Array<{ path: string; rows: unknown[] }> {
  if (isRecordArray(root)) return [{ path: JSON_ROOT, rows: root }];
  const out: Array<{ path: string; rows: unknown[] }> = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (!isObj(v) || depth > 3) return;
    const keys = Object.keys(v).sort((x, y) => { const px = PREFERRED_KEYS.indexOf(x.toLowerCase()), py = PREFERRED_KEYS.indexOf(y.toLowerCase()); return (px < 0 ? 99 : px) - (py < 0 ? 99 : py); });
    for (const k of keys) {
      const child = v[k], p = path ? `${path}.${k}` : k;
      if (isRecordArray(child)) out.push({ path: p, rows: child });
      else walk(child, p, depth + 1);
    }
  };
  walk(root, "", 0);
  return out;
}

const flattenValue = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (Array.isArray(v)) return v.every((x) => x === null || typeof x !== "object") ? v.map(flattenValue).join(", ") : JSON.stringify(v);
  return JSON.stringify(v);
};
const flattenRecord = (o: Record<string, unknown>, prefix: string, depth: number, out: Map<string, string>) => {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isObj(v) && depth < 3) flattenRecord(v, key, depth + 1, out); // objek bersarang → kolom "induk.anak"
    else out.set(key, flattenValue(v));
  }
};

/** Array record JSON → matriks (baris pertama = header, gabungan seluruh kunci berurutan kemunculan). */
export function jsonToMatrix(rows: unknown[]): string[][] {
  if (rows.every((r) => Array.isArray(r))) return (rows as unknown[][]).map((r) => r.map(flattenValue)); // array of arrays: baris pertama = header
  const headers: string[] = [], seen = new Set<string>();
  const flat = rows.map((r) => { const m = new Map<string, string>(); if (isObj(r)) flattenRecord(r, "", 0, m); else m.set("value", flattenValue(r)); m.forEach((_, k) => { if (!seen.has(k)) { seen.add(k); headers.push(k); } }); return m; });
  return [headers, ...flat.map((m) => headers.map((h) => m.get(h) ?? ""))];
}

export function openSource(buffer: ArrayBuffer, fileName: string): OpenedSource {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (buffer.byteLength === 0) throw new FileReadError("File kosong (0 byte).");
  const kind = sniffFormat(buffer);
  const notes: string[] = [];
  const TEXT_EXT = ["csv", "tsv", "txt", "dat", "text"];
  if (kind === "pdf") throw new FileReadError("File ini adalah PDF; gunakan jalur pembacaan PDF.");
  if (kind === "unknown") throw new FileReadError(`Format .${ext || "?"} tidak didukung atau isinya bukan teks/Excel yang dapat dibaca. Gunakan CSV, TXT, JSON, XLSX, XLS, atau PDF.`);
  if ((kind === "xlsx" || kind === "xls") && !["xlsx", "xls", "xlsm"].includes(ext)) notes.push(`Ekstensi .${ext || "?"} tidak sesuai isi file; isinya dikenali sebagai Excel dan dibaca sebagai Excel.`);
  if ((ext === "xlsx" || ext === "xls") && kind !== "xlsx" && kind !== "xls") throw new FileReadError(`Isi file bukan format Excel yang valid (ekstensi .${ext}, tetapi bukan berkas ${ext === "xlsx" ? "XLSX/ZIP" : "XLS"} sebenarnya).`);
  if (ext === "json" && kind !== "json") throw new FileReadError("File berekstensi .json, tetapi isinya bukan JSON yang valid.");
  if (kind === "json" && ext !== "json") notes.push(`Ekstensi .${ext || "?"} tidak sesuai isi file; isinya dikenali sebagai JSON.`);

  if (kind === "json") {
    const text = decodeText(buffer);
    // Angka bulat ≥ 16 digit tanpa tanda kutip dibungkus dulu agar nomor struk tidak kehilangan digit saat JSON.parse (jadi teks utuh).
    const exact = quoteLongJsonIntegers(text);
    const json = JSON.parse(exact.text);
    const cands = jsonCandidates(json);
    if (!cands.length) throw new FileReadError("Struktur JSON tidak dikenali: tidak ditemukan daftar (array) objek transaksi. Contoh yang didukung: [{...},{...}] atau {\"data\":[{...}]}.");
    if (exact.quoted > 0) notes.push(`JSON berisi ${exact.quoted.toLocaleString("id-ID")} angka tanpa tanda kutip lebih dari 15 digit; dibaca sebagai teks utuh (tidak ada digit yang hilang). Sebaiknya nomor struk disimpan sebagai string.`);
    return { format: "json", fileName, size: buffer.byteLength, text, json, sheets: cands.map((c) => c.path), notes };
  }
  if (kind === "xlsx" || kind === "xls") {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(buffer, { type: "array", cellDates: true });
    } catch (err) {
      throw new FileReadError(`File Excel tidak dapat dibaca (rusak atau bukan file Excel sebenarnya): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!workbook.SheetNames.length) throw new FileReadError("File Excel tidak memiliki worksheet.");
    return { format: kind === "xlsx" ? "xlsx" : "xls", fileName, size: buffer.byteLength, workbook, sheets: workbook.SheetNames, notes };
  }
  // teks terstruktur (CSV / TSV / TXT / ekstensi lain berisi teks)
  const text = decodeText(buffer);
  if (!text.trim()) throw new FileReadError("File tidak berisi data (hanya spasi atau baris kosong).");
  if (!TEXT_EXT.includes(ext)) notes.push(`Ekstensi .${ext || "?"} tidak umum; isinya dibaca sebagai teks berpemisah.`);
  return { format: ext === "csv" ? "csv" : "txt", fileName, size: buffer.byteLength, text, sheets: [], notes };
}

/**
 * Pembuka file untuk Compare 2 File. Sama dengan openSource, ditambah pemulihan nomor struk panjang pada .xlsx:
 * sel angka ≥ 16 digit dibaca langsung dari XML (teks) sehingga 641126010100002641 tidak berubah menjadi 641126010100002700.
 */
export async function openSourceExact(buffer: ArrayBuffer, fileName: string): Promise<OpenedSource> {
  const src = openSource(buffer, fileName);
  if (src.format === "xlsx" && src.workbook) {
    const rec = await recoverCellsFromXlsx(buffer, src.workbook);
    const notes = [...(src.notes ?? [])];
    if (rec.longNumbers > 0) notes.push(`${rec.longNumbers.toLocaleString("id-ID")} sel angka panjang (≥ 16 digit, mis. nomor struk) dibaca sebagai teks utuh langsung dari file Excel; tidak ada digit yang dipotong.`);
    if (rec.inlineStrings > 0) notes.push(`${rec.inlineStrings.toLocaleString("id-ID")} sel teks yang tidak terbaca oleh pembaca Excel standar (format XML tidak lazim) dipulihkan langsung dari isi file.`);
    src.notes = notes;
  }
  return src;
}

const pad = (n: number) => String(n).padStart(2, "0");
export function cellText(v: unknown): string {
  // Sel Excel hasil rumus sering membawa noise floating-point (150000.00000000003 padahal 150000). Dibulatkan ke 15 digit signifikan
  // (batas presisi double) agar tidak terbaca sebagai nominal berbeda. Bilangan bulat tidak disentuh (nomor struk panjang tetap utuh).
  if (typeof v === "number" && Number.isFinite(v) && !Number.isInteger(v)) return String(Number(v.toPrecision(15)));
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "";
    const day = `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    return v.getHours() || v.getMinutes() || v.getSeconds() ? `${day} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}` : day;
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return clean(v);
}

export function matrixOf(src: OpenedSource, opts: { sheet?: string; delimiter?: string | null } = {}): { matrix: string[][]; sheetName: string | null; delimiter: string | null; delimiterAuto: boolean; warnings: string[] } {
  const warnings: string[] = [...(src.notes ?? [])];
  if (src.format === "json") {
    const cands = jsonCandidates(src.json);
    const pick = cands.find((c) => c.path === opts.sheet) ?? cands[0];
    if (cands.length > 1 && !opts.sheet) warnings.push(`JSON berisi ${cands.length} daftar data (${cands.map((c) => c.path).join(", ")}); yang dipakai: "${pick.path}". Pilih dari menu worksheet bila salah.`);
    return { matrix: jsonToMatrix(pick.rows), sheetName: pick.path, delimiter: null, delimiterAuto: false, warnings };
  }
  if (src.format === "csv" || src.format === "txt") {
    const auto = !opts.delimiter;
    const delimiter = opts.delimiter ?? detectDelimiter(src.text!) ?? ",";
    if (auto && detectDelimiter(src.text!) === null) warnings.push("Delimiter tidak dapat dideteksi dengan yakin (kemungkinan hanya satu kolom). Pilih delimiter secara manual jika kolom tidak terpisah.");
    const parsed = Papa.parse<string[]>(src.text!, { delimiter, skipEmptyLines: false });
    const fatal = parsed.errors.find((e) => e.type === "Quotes");
    if (fatal) throw new FileReadError(`CSV tidak valid: tanda kutip tidak seimbang di baris ${(fatal.row ?? 0) + 1} (${fatal.message}).`);
    const matrix = parsed.data.map((r) => r.map(clean));
    return { matrix, sheetName: null, delimiter, delimiterAuto: auto, warnings };
  }
  const sheetName = opts.sheet && src.sheets.includes(opts.sheet) ? opts.sheet : src.sheets[0];
  const full = withActualRange(src.workbook!.Sheets[sheetName], sheetName);
  if (full.warning) warnings.push(full.warning);
  const unsafe = countUnsafeIntegerCells(full.ws);
  if (unsafe > 0) warnings.push(`${unsafe.toLocaleString("id-ID")} sel berisi angka bulat lebih dari 15 digit yang tersimpan sebagai ANGKA di file ini; digit aslinya sudah hilang di file sumber dan tidak dapat dipulihkan (nomor yang berbeda bisa tampak sama). Ekspor ulang kolom nomor struk sebagai teks.`);
  const raw = XLSX.utils.sheet_to_json(full.ws, { header: 1, raw: true, defval: "" }) as unknown[][];
  return { matrix: raw.map((r) => r.map(cellText)), sheetName, delimiter: null, delimiterAuto: false, warnings };
}

/** Sebagian aplikasi menulis rentang worksheet (!ref) yang lebih kecil dari isi sebenarnya. Baca gabungan rentang tertulis dan rentang sel nyata agar tidak ada baris/kolom yang terpotong. */
function withActualRange(ws: XLSX.WorkSheet, name: string): { ws: XLSX.WorkSheet; warning: string | null } {
  let minR = Infinity, minC = Infinity, maxR = -1, maxC = -1;
  for (const addr of Object.keys(ws)) {
    if (addr.charCodeAt(0) === 33) continue; // "!ref", "!merges", dst.
    const c = XLSX.utils.decode_cell(addr);
    if (c.r < minR) minR = c.r; if (c.c < minC) minC = c.c;
    if (c.r > maxR) maxR = c.r; if (c.c > maxC) maxC = c.c;
  }
  if (maxR < 0) return { ws, warning: null };
  const declared = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]) : null;
  if (declared && declared.s.r <= minR && declared.s.c <= minC && declared.e.r >= maxR && declared.e.c >= maxC) return { ws, warning: null };
  const range = {
    s: { r: Math.min(minR, declared?.s.r ?? minR), c: Math.min(minC, declared?.s.c ?? minC) },
    e: { r: Math.max(maxR, declared?.e.r ?? maxR), c: Math.max(maxC, declared?.e.c ?? maxC) },
  };
  const ref = XLSX.utils.encode_range(range);
  return { ws: { ...ws, "!ref": ref }, warning: `Rentang data worksheet "${name}" yang tertulis di file lebih kecil dari isi sebenarnya; seluruh sel tetap dibaca (${ref}).` };
}

const HEADER_WORDS = /(no|nomor|struk|order|transaksi|tanggal|tgl|date|total|amount|nominal|subtotal|tax|pajak|jumlah|id|folio|nama|name|outlet|receipt|bill)/i;
const isNumberish = (s: string) => /^[-+()\sRrPp.\d,]+$/.test(s) && /\d/.test(s);

/** Heuristik: baris (≤30 pertama) dengan sel teks unik terbanyak dan kata header umum. Mengembalikan indeks 0-based. */
export function detectHeaderRow(matrix: string[][]): number {
  let best = -1, bestScore = 0;
  const limit = Math.min(matrix.length, 30);
  for (let i = 0; i < limit; i++) {
    const cells = matrix[i].map((c) => c.trim()).filter(Boolean);
    if (cells.length < 1) continue;
    const textual = new Set(cells.filter((c) => !isNumberish(c)).map((c) => c.toLowerCase()));
    const hasData = matrix.slice(i + 1, i + 4).some((r) => r.some((c) => c.trim()));
    if (!hasData && i < matrix.length - 1) continue;
    let score = textual.size + cells.filter((c) => HEADER_WORDS.test(c)).length * 2;
    if (cells.length < 2) score = Math.min(score, 1);
    if (score > bestScore) { best = i; bestScore = score; }
  }
  return best;
}

const colLetter = (i: number) => { let n = i, s = ""; do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return s; };

export function buildTable(matrix: string[][], opts: { headerRow?: number | null; sheetName?: string | null; delimiter?: string | null; delimiterAuto?: boolean; warnings?: string[] } = {}): TableData {
  const warnings = [...(opts.warnings ?? [])];
  if (!matrix.some((r) => r.some((c) => c.trim()))) throw new FileReadError("Tidak ada data pada file/worksheet ini (semua baris kosong).");
  const auto = !opts.headerRow;
  const idx = auto ? (detectHeaderRow(matrix) >= 0 ? detectHeaderRow(matrix) : matrix.findIndex((r) => r.some((c) => c.trim()))) : Math.min(Math.max(1, opts.headerRow!), matrix.length) - 1;
  if (idx < 0) throw new FileReadError("Baris header tidak ditemukan. Tentukan baris header secara manual.");
  const width = Math.max(...matrix.slice(idx).map((r) => r.length), 1);
  const used = new Map<string, number>();
  const headers = Array.from({ length: width }, (_, c) => {
    let h = (matrix[idx][c] ?? "").trim() || `Kolom ${colLetter(c)}`;
    const k = h.toLowerCase();
    const n = (used.get(k) ?? 0) + 1;
    used.set(k, n);
    if (n > 1) h = `${h} (${n})`;
    return h;
  });
  const headerKey = headers.map((h) => h.toLowerCase()).join("\u0001");
  const rows: string[][] = [], sourceRows: number[] = [];
  let blankRows = 0, repeatedHeaders = 0;
  for (let r = idx + 1; r < matrix.length; r++) {
    const row = Array.from({ length: width }, (_, c) => matrix[r][c] ?? "");
    if (!row.some((c) => c.trim())) { blankRows++; continue; }
    if (row.map((c) => c.trim().toLowerCase()).join("\u0001") === headerKey) { repeatedHeaders++; continue; }
    rows.push(row);
    sourceRows.push(r + 1);
  }
  if (!rows.length) throw new FileReadError(`Header ditemukan di baris ${idx + 1}, tetapi tidak ada baris data di bawahnya.`);
  return { headers, rows, sourceRows, headerRow: idx + 1, headerAuto: auto, sheetName: opts.sheetName ?? null, delimiter: opts.delimiter ?? null, delimiterAuto: opts.delimiterAuto ?? false, blankRows, repeatedHeaders, warnings };
}

export function loadTable(src: OpenedSource, opts: { sheet?: string; delimiter?: string | null; headerRow?: number | null } = {}): TableData {
  const m = matrixOf(src, opts);
  return buildTable(m.matrix, { headerRow: opts.headerRow, sheetName: m.sheetName, delimiter: m.delimiter, delimiterAuto: m.delimiterAuto, warnings: m.warnings });
}
