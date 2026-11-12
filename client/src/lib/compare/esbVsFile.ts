import * as XLSX from "xlsx";
import { matrixOf, FileReadError, type OpenedSource } from "./compareTable";

// Mode "ESB vs File" (terpisah dari Compare 2 File).
// ESB: identitas transaksi = `Bill Number` + " - " + `Sales Number`, dirangkai per baris dari isi file (tanpa format/panjang/awalan tetap).
// Pembanding: kolom `no_struk`. Pencocokan = exact match teks penuh atas hasil normalizeReceipt (trim tepi + spasi di sekitar "-" dihapus),
// TANPA Set: jumlah kemunculan diperhitungkan. Normalisasi hanya untuk kunci pencocokan; nilai asli tidak diubah.
// Modul ini murni (tanpa DOM) supaya dapat diuji.

export const ESB_JOINER = " - ";
export const ESB_BILL_HEADER = "Bill Number";
export const ESB_SALES_HEADER = "Sales Number";
export const FILE_HEADER = "no_struk";

/** Normalisasi HANYA untuk mencari nama kolom (bukan nilai transaksi): huruf kecil, tanpa spasi/garis bawah/tanda baca. */
export const normHeader = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Trim spasi di awal/akhir saja (termasuk NBSP/BOM); isi nilai tidak diubah. */
export const trimEdge = (s: unknown): string => (s === null || s === undefined ? "" : String(s)).replace(/^[\s\uFEFF\u200B]+|[\s\uFEFF\u200B]+$/g, "");

/**
 * Normalisasi nomor struk KHUSUS untuk kunci pencocokan (nilai asli yang ditampilkan/diekspor tidak diubah):
 *  - trim whitespace di awal/akhir,
 *  - hapus seluruh whitespace tepat sebelum dan sesudah tanda hubung "-" (tanda hubung dipertahankan).
 * Tidak ada perubahan lain: huruf/angka/karakter lain, urutan, huruf besar-kecil, dan spasi di dalam token tetap. Bukan fuzzy/partial match.
 */
export const normalizeReceipt = (s: unknown): string => trimEdge(s).replace(/[\s\uFEFF\u200B]*-[\s\uFEFF\u200B]*/g, "-");

export type HeaderHit = { headerRow: number; cols: number[] };

/** Cari baris header yang memuat SEMUA nama kolom wajib (di baris mana pun, kolom mana pun). */
export function locateHeader(matrix: string[][], required: string[]): HeaderHit | null {
  const want = required.map(normHeader);
  for (let r = 0; r < matrix.length; r++) {
    const normed = matrix[r].map((c) => normHeader(trimEdge(c)));
    const cols = want.map((w) => normed.indexOf(w));
    if (cols.every((c) => c >= 0)) return { headerRow: r, cols };
  }
  return null;
}

export type SourceRow = { row: number; value: string; bill?: string; sales?: string };
export type SkippedRow = { row: number; reason: string; detail: string };
export type SideRead = {
  fileName: string;
  sheet: string | null;
  headerRow: number; // 1-based
  rowsRead: number; // baris data setelah header yang tidak kosong total
  blankRows: number;
  items: SourceRow[]; // baris valid (urut sesuai file)
  skipped: SkippedRow[]; // baris dilewati karena tidak valid (bukan baris kosong)
  warnings: string[];
};

const rowIsBlank = (r: string[]) => !r.some((c) => trimEdge(c) !== "");

function describeFound(matrix: string[][]): string {
  const firstFilled = matrix.find((r) => !rowIsBlank(r));
  return firstFilled ? ` Baris terisi pertama berisi: ${firstFilled.map(trimEdge).filter(Boolean).slice(0, 8).join(", ")}.` : "";
}

/** Temukan matriks (sheet) yang memuat header wajib. Semua worksheet diperiksa; yang pertama cocok dipakai. */
function pickMatrix(src: OpenedSource, required: string[], label: string): { matrix: string[][]; sheet: string | null; hit: HeaderHit; warnings: string[] } {
  const names: Array<string | undefined> = src.sheets.length ? src.sheets : [undefined];
  let lastMatrix: string[][] = [];
  for (const name of names) {
    const m = matrixOf(src, { sheet: name });
    lastMatrix = m.matrix;
    const hit = locateHeader(m.matrix, required);
    if (hit) {
      const warnings = [...m.warnings];
      if (names.length > 1 && name !== names[0]) warnings.push(`Header ditemukan pada worksheet "${m.sheetName}", bukan worksheet pertama.`);
      return { matrix: m.matrix, sheet: m.sheetName, hit, warnings };
    }
  }
  const list = required.map((h) => `"${h}"`).join(" dan ");
  throw new FileReadError(`Header ${list} tidak ditemukan pada ${label}${names.length > 1 ? ` (${names.length} worksheet diperiksa)` : ""}. Pastikan file memiliki kolom tersebut.${describeFound(lastMatrix)}`);
}

/** Baca file ESB: gabungkan Bill Number + " - " + Sales Number untuk tiap baris. */
export function readEsb(src: OpenedSource): SideRead {
  const { matrix, sheet, hit, warnings } = pickMatrix(src, [ESB_BILL_HEADER, ESB_SALES_HEADER], "file ESB");
  const [bc, sc] = hit.cols;
  const headerKey = matrix[hit.headerRow].map((c) => normHeader(trimEdge(c))).join("\u0001");
  const items: SourceRow[] = [], skipped: SkippedRow[] = [];
  let blankRows = 0, rowsRead = 0;
  for (let r = hit.headerRow + 1; r < matrix.length; r++) {
    const row = matrix[r];
    if (rowIsBlank(row)) { blankRows++; continue; }
    if (row.map((c) => normHeader(trimEdge(c))).join("\u0001") === headerKey) continue; // header berulang
    rowsRead++;
    const bill = trimEdge(row[bc]), sales = trimEdge(row[sc]);
    if (!bill && !sales) { skipped.push({ row: r + 1, reason: "Bill Number dan Sales Number kosong", detail: "" }); continue; }
    if (!bill || !sales) { skipped.push({ row: r + 1, reason: !bill ? "Bill Number kosong" : "Sales Number kosong", detail: `Bill Number: "${bill}" · Sales Number: "${sales}"` }); continue; }
    items.push({ row: r + 1, value: `${bill}${ESB_JOINER}${sales}`, bill, sales });
  }
  return { fileName: src.fileName, sheet, headerRow: hit.headerRow + 1, rowsRead, blankRows, items, skipped, warnings };
}

/** Baca file pembanding: kolom no_struk apa adanya (trim tepi). */
export function readFile(src: OpenedSource): SideRead {
  const { matrix, sheet, hit, warnings } = pickMatrix(src, [FILE_HEADER], "file pembanding");
  const [nc] = hit.cols;
  const headerNorm = normHeader(FILE_HEADER);
  const items: SourceRow[] = [], skipped: SkippedRow[] = [];
  let blankRows = 0, rowsRead = 0;
  for (let r = hit.headerRow + 1; r < matrix.length; r++) {
    const row = matrix[r];
    if (rowIsBlank(row)) { blankRows++; continue; }
    const v = trimEdge(row[nc]);
    if (normHeader(v) === headerNorm) continue; // header berulang
    rowsRead++;
    if (!v) { skipped.push({ row: r + 1, reason: "no_struk kosong", detail: "" }); continue; }
    items.push({ row: r + 1, value: v });
  }
  return { fileName: src.fileName, sheet, headerRow: hit.headerRow + 1, rowsRead, blankRows, items, skipped, warnings };
}

export type Unmatched = { value: string; row: number; occurrence: number; total: number; bill?: string; sales?: string };
export type DupInfo = { value: string; count: number; rows: number[] };
export type EsbVsFileResult = {
  esbValid: number;
  fileValid: number;
  matched: number;
  /** A. ada di file (no_struk), tidak ada pasangan di ESB */
  notInEsb: Unmatched[];
  /** B. ada di ESB (hasil gabungan), tidak ada pasangan di file */
  notInFile: Unmatched[];
  matchedList: Array<{ value: string; esbRow: number; fileRow: number }>;
  esbDuplicates: DupInfo[];
  fileDuplicates: DupInfo[];
  esbSkipped: SkippedRow[];
  fileSkipped: SkippedRow[];
};

/**
 * Pencocokan exact berbasis jumlah kemunculan (multiset): n kemunculan di ESB dipasangkan dengan m di file → min(n, m) cocok,
 * sisa n−m (atau m−n) dilaporkan sebagai tidak ditemukan. Urutan baris kedua file tidak berpengaruh.
 */
export function compareEsbVsFile(esb: SideRead, file: SideRead): EsbVsFileResult {
  // Kunci pencocokan = normalizeReceipt(value); `value` asli tetap dipakai untuk tampilan, salin, dan ekspor.
  const group = (items: SourceRow[]) => {
    const m = new Map<string, SourceRow[]>();
    for (const it of items) { const k = normalizeReceipt(it.value); const a = m.get(k); if (a) a.push(it); else m.set(k, [it]); }
    return m;
  };
  const ge = group(esb.items), gf = group(file.items);
  const matchedList: EsbVsFileResult["matchedList"] = [];
  const notInFile: Unmatched[] = [], notInEsb: Unmatched[] = [];
  for (const [key, rows] of ge) {
    const other = gf.get(key) ?? [];
    const pair = Math.min(rows.length, other.length);
    for (let i = 0; i < pair; i++) matchedList.push({ value: rows[i].value, esbRow: rows[i].row, fileRow: other[i].row });
    for (let i = pair; i < rows.length; i++) notInFile.push({ value: rows[i].value, row: rows[i].row, occurrence: i + 1, total: rows.length, bill: rows[i].bill, sales: rows[i].sales });
  }
  for (const [key, rows] of gf) {
    const pair = Math.min(rows.length, (ge.get(key) ?? []).length);
    for (let i = pair; i < rows.length; i++) notInEsb.push({ value: rows[i].value, row: rows[i].row, occurrence: i + 1, total: rows.length });
  }
  const byRow = (a: { row: number }, b: { row: number }) => a.row - b.row;
  notInFile.sort(byRow); notInEsb.sort(byRow); matchedList.sort((a, b) => a.esbRow - b.esbRow);
  const dups = (g: Map<string, SourceRow[]>): DupInfo[] => [...g].filter(([, r]) => r.length > 1).map(([, r]) => ({ value: r[0].value, count: r.length, rows: r.map((x) => x.row) })).sort((a, b) => a.rows[0] - b.rows[0]);
  return {
    esbValid: esb.items.length, fileValid: file.items.length, matched: matchedList.length,
    notInEsb, notInFile, matchedList,
    esbDuplicates: dups(ge), fileDuplicates: dups(gf),
    esbSkipped: esb.skipped, fileSkipped: file.skipped,
  };
}

/** Selisih antara jumlah yang dilaporkan dan jumlah yang diproses; 0 = konsisten. */
export const consistencyErrors = (r: EsbVsFileResult): string[] => {
  const errs: string[] = [];
  if (r.matched + r.notInFile.length !== r.esbValid) errs.push(`ESB: cocok (${r.matched}) + tidak ditemukan di File (${r.notInFile.length}) ≠ data valid ESB (${r.esbValid})`);
  if (r.matched + r.notInEsb.length !== r.fileValid) errs.push(`File: cocok (${r.matched}) + tidak ditemukan di ESB (${r.notInEsb.length}) ≠ data valid file (${r.fileValid})`);
  return errs;
};

/** Teks untuk tombol salin: satu nomor per baris. */
export const unmatchedToText = (list: Unmatched[]): string => list.map((u) => u.value).join("\n");
export const allUnmatchedText = (r: EsbVsFileResult): string => {
  const parts: string[] = [];
  if (r.notInEsb.length) parts.push(`TIDAK DITEMUKAN DI ESB (${r.notInEsb.length})\n${unmatchedToText(r.notInEsb)}`);
  if (r.notInFile.length) parts.push(`TIDAK DITEMUKAN DI FILE (${r.notInFile.length})\n${unmatchedToText(r.notInFile)}`);
  return parts.join("\n\n");
};

type Cell = string | number;
const textSheet = (rows: Cell[][], textCols: number[]): XLSX.WorkSheet => {
  const ws = XLSX.utils.aoa_to_sheet(rows as never[][]);
  // Nomor struk selalu bertipe teks (format "@"): angka nol di depan, tanda baca, dan format asli tidak berubah.
  rows.forEach((row, r) => textCols.forEach((c) => {
    const v = row[c];
    if (typeof v !== "string" || v === "") return;
    ws[XLSX.utils.encode_cell({ r, c })] = { t: "s", v, z: "@" };
  }));
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  ws["!cols"] = Array.from({ length: width }, (_, c) => ({ wch: Math.min(60, Math.max(10, ...rows.slice(0, 1000).map((r) => String(r[c] ?? "").length + 2))) }));
  return ws;
};

/** Workbook hasil: Summary, Tidak Ditemukan di ESB, Tidak Ditemukan di File, Matched. */
export function buildExportWorkbook(r: EsbVsFileResult, names: { esb: string; file: string }): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const summary: Cell[][] = [
    ["Ringkasan ESB vs File", ""],
    ["File ESB", names.esb],
    ["File Pembanding", names.file],
    ["", ""],
    ["Jumlah data valid ESB", r.esbValid],
    ["Jumlah data valid File Pembanding", r.fileValid],
    ["Jumlah transaksi cocok", r.matched],
    ["Tidak Ditemukan di ESB", r.notInEsb.length],
    ["Tidak Ditemukan di File", r.notInFile.length],
    ["Nomor duplikat di ESB (nilai unik)", r.esbDuplicates.length],
    ["Nomor duplikat di File Pembanding (nilai unik)", r.fileDuplicates.length],
    ["Baris ESB dilewati (tidak valid)", r.esbSkipped.length],
    ["Baris File Pembanding dilewati (tidak valid)", r.fileSkipped.length],
  ];
  if (r.esbDuplicates.length || r.fileDuplicates.length) {
    summary.push(["", ""], ["Detail duplikat", "Jumlah muncul · baris"]);
    r.esbDuplicates.forEach((d) => summary.push([`ESB: ${d.value}`, `${d.count}× · baris ${d.rows.join(", ")}`]));
    r.fileDuplicates.forEach((d) => summary.push([`File: ${d.value}`, `${d.count}× · baris ${d.rows.join(", ")}`]));
  }
  const skippedAll = [...r.esbSkipped.map((s) => ["ESB", s] as const), ...r.fileSkipped.map((s) => ["File", s] as const)];
  if (skippedAll.length) {
    summary.push(["", ""], ["Baris dilewati", "Sumber · baris · alasan"]);
    skippedAll.forEach(([src, s]) => summary.push([`${src} baris ${s.row}`, s.detail ? `${s.reason} (${s.detail})` : s.reason]));
  }
  XLSX.utils.book_append_sheet(wb, textSheet(summary, [1]), "Summary");
  const occ = (u: Unmatched) => (u.total > 1 ? `${u.occurrence} dari ${u.total}` : "");
  XLSX.utils.book_append_sheet(wb, textSheet([["No", "No Struk (no_struk)", "Baris di File", "Kemunculan"], ...r.notInEsb.map((u, i) => [i + 1, u.value, u.row, occ(u)] as Cell[])], [1]), "Tidak Ditemukan di ESB");
  XLSX.utils.book_append_sheet(wb, textSheet([["No", "Bill Number + Sales Number", "Bill Number", "Sales Number", "Baris di ESB", "Kemunculan"], ...r.notInFile.map((u, i) => [i + 1, u.value, u.bill ?? "", u.sales ?? "", u.row, occ(u)] as Cell[])], [1, 2, 3]), "Tidak Ditemukan di File");
  XLSX.utils.book_append_sheet(wb, textSheet([["No", "No Struk", "Baris di ESB", "Baris di File"], ...r.matchedList.map((m, i) => [i + 1, m.value, m.esbRow, m.fileRow] as Cell[])], [1]), "Matched");
  return wb;
}
