import Papa from "papaparse";
import * as XLSX from "xlsx";

// Pemuat tabel untuk "Bandingkan 2 File" (CEK STRUK). Murni (tanpa DOM): menerima ArrayBuffer sehingga dapat diuji.
// CSV memakai papaparse (kutip, kutip ganda ter-escape, newline dalam field), bukan split() sederhana.

export type SourceFormat = "csv" | "xlsx" | "xls";
export type OpenedSource = {
  format: SourceFormat;
  fileName: string;
  size: number;
  /** CSV */
  text?: string;
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

export function openSource(buffer: ArrayBuffer, fileName: string): OpenedSource {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (buffer.byteLength === 0) throw new FileReadError("File kosong (0 byte).");
  if (ext === "csv") {
    const text = decodeText(buffer);
    if (!text.trim()) throw new FileReadError("File CSV tidak berisi data (hanya spasi atau baris kosong).");
    return { format: "csv", fileName, size: buffer.byteLength, text, sheets: [] };
  }
  if (ext === "xlsx" || ext === "xls") {
    // SheetJS menerima teks apa pun sebagai "worksheet"; periksa tanda tangan file agar file palsu tidak lolos diam-diam.
    const head = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
    const isZip = head[0] === 0x50 && head[1] === 0x4b;
    const isOle = head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;
    const looksMarkup = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(64, buffer.byteLength))).trimStart().startsWith("<");
    if (!(isZip || isOle || (ext === "xls" && looksMarkup))) throw new FileReadError(`Isi file bukan format Excel yang valid (ekstensi .${ext}, tetapi bukan berkas ${ext === "xlsx" ? "XLSX/ZIP" : "XLS"} sebenarnya).`);
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(buffer, { type: "array", cellDates: true });
    } catch (err) {
      throw new FileReadError(`File Excel tidak dapat dibaca (rusak atau bukan file Excel sebenarnya): ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!workbook.SheetNames.length) throw new FileReadError("File Excel tidak memiliki worksheet.");
    return { format: ext, fileName, size: buffer.byteLength, workbook, sheets: workbook.SheetNames };
  }
  throw new FileReadError(`Format .${ext || "?"} tidak didukung di sini. Gunakan CSV, XLSX, atau XLS.`);
}

const pad = (n: number) => String(n).padStart(2, "0");
function cellText(v: unknown): string {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "";
    const day = `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    return v.getHours() || v.getMinutes() || v.getSeconds() ? `${day} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}` : day;
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return clean(v);
}

export function matrixOf(src: OpenedSource, opts: { sheet?: string; delimiter?: string | null } = {}): { matrix: string[][]; sheetName: string | null; delimiter: string | null; delimiterAuto: boolean; warnings: string[] } {
  const warnings: string[] = [];
  if (src.format === "csv") {
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
