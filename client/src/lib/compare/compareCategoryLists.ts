import type { TableData } from "./compareTable";
import { REVIEW_REASON_LABEL, type CompareRecord, type CompareResult, type ExportData } from "./compareFilesEngine";

// FITUR TAMBAHAN (hanya membaca hasil perbandingan): daftar nomor struk per kategori untuk disalin & diekspor.
// Modul ini TIDAK mengubah pencocokan, status, maupun rumus perhitungan di compareFilesEngine.ts. Ia hanya membaca
// `CompareResult` yang sudah jadi dan tabel sumber, lalu menyusun daftar baris + nomor struknya.

export type ListCategory = "ONLY_A" | "ONLY_B" | "DUP" | "REVIEW";
export const LIST_CATEGORIES: ListCategory[] = ["ONLY_A", "ONLY_B", "DUP", "REVIEW"];
export const LIST_LABEL: Record<ListCategory, string> = {
  ONLY_A: "Hanya di File A", ONLY_B: "Hanya di File B", DUP: "Duplikat", REVIEW: "Perlu ditinjau",
};
export const LIST_HINT: Record<ListCategory, string> = {
  ONLY_A: "Ada di File A, tidak ditemukan di File B",
  ONLY_B: "Ada di File B, tidak ditemukan di File A",
  DUP: "Nomor struk muncul lebih dari sekali di salah satu/kedua file",
  REVIEW: "Tanpa pasangan, duplikat, nomor kosong, benturan, atau nilai ambigu",
};

export type Cell = string | number | null;
/** Satu baris transaksi sumber (File A atau File B) yang masuk sebuah kategori. */
export type ListItem = {
  category: ListCategory;
  source: "A" | "B";
  /** nomor baris asli di file sumber (1-based, sama dengan kolom "Baris Sumber" di ekspor lain) */
  row: number;
  /** indeks baris di tabel sumber */
  index: number;
  /** nomor struk / identitas asli (tanpa dipotong atau dinormalisasi) */
  receipt: string;
  reason: string;
  detail: string;
};
export type CategoryList = {
  category: ListCategory;
  label: string;
  items: ListItem[];
  /** nomor struk unik (penulisan asli), urutan kemunculan; tidak termasuk yang kosong */
  receipts: string[];
  emptyReceiptRows: number;
};

const cellAt = (t: TableData, r: number, c: number) => (c >= 0 ? (t.rows[r]?.[c] ?? "") : "");
const keyColOf = (res: CompareResult, source: "A" | "B") => (source === "A" ? res.config.a.key : res.config.b.key);

// Definisi sama dengan filter kartu di halaman hasil, sehingga angka daftar = angka kartu.
const inCategory = (r: CompareRecord, cat: Exclude<ListCategory, "REVIEW">): boolean => {
  if (cat === "ONLY_A") return !r.noKey && r.idxA.length > 0 && r.idxB.length === 0;
  if (cat === "ONLY_B") return !r.noKey && r.idxB.length > 0 && r.idxA.length === 0;
  return r.status === "DUPLIKAT";
};

export function buildCategoryList(res: CompareResult, ta: TableData, tb: TableData, category: ListCategory): CategoryList {
  const items: ListItem[] = [];
  const tbl = (s: "A" | "B") => (s === "A" ? ta : tb);
  const receiptOf = (s: "A" | "B", i: number) => cellAt(tbl(s), i, keyColOf(res, s)).trim();

  if (category === "REVIEW") {
    // Daftar yang sama dengan bagian "Perlu Ditinjau" (res.review): setiap baris transaksi, dari File A maupun File B.
    const idxA = new Map<number, number>(), idxB = new Map<number, number>();
    ta.sourceRows.forEach((n, i) => { if (!idxA.has(n)) idxA.set(n, i); });
    tb.sourceRows.forEach((n, i) => { if (!idxB.has(n)) idxB.set(n, i); });
    for (const it of res.review) {
      const index = (it.source === "A" ? idxA : idxB).get(it.row) ?? -1;
      items.push({ category, source: it.source, row: it.row, index, receipt: it.receipt, reason: it.reasons.map((x) => REVIEW_REASON_LABEL[x]).join("; "), detail: it.detail });
    }
  } else {
    for (const rec of res.records) {
      if (!inCategory(rec, category)) continue;
      const nA = rec.idxA.length, nB = rec.idxB.length;
      const reason = category === "ONLY_A" ? "Tidak ditemukan di File B" : category === "ONLY_B" ? "Tidak ditemukan di File A" : `Nomor struk duplikat (${nA}× di File A, ${nB}× di File B)`;
      const add = (s: "A" | "B", i: number) => items.push({ category, source: s, row: tbl(s).sourceRows[i], index: i, receipt: receiptOf(s, i), reason, detail: rec.note });
      rec.idxA.forEach((i) => add("A", i));
      rec.idxB.forEach((i) => add("B", i));
    }
    if (category === "DUP") items.sort((x, y) => x.receipt.localeCompare(y.receipt, "id", { numeric: true }) || (x.source === y.source ? 0 : x.source === "A" ? -1 : 1) || x.row - y.row);
    else items.sort((x, y) => (x.source === y.source ? 0 : x.source === "A" ? -1 : 1) || x.row - y.row);
  }

  const seen = new Set<string>(), receipts: string[] = [];
  let emptyReceiptRows = 0;
  for (const it of items) {
    if (!it.receipt) { emptyReceiptRows++; continue; }
    if (!seen.has(it.receipt)) { seen.add(it.receipt); receipts.push(it.receipt); }
  }
  return { category, label: LIST_LABEL[category], items, receipts, emptyReceiptRows };
}

/** Teks untuk clipboard: satu nomor struk per baris (bisa langsung ditempel ke Excel / pencarian). */
export const receiptsToText = (list: CategoryList): string => list.receipts.join("\n");

// ───────────── tabel ekspor ─────────────
// Satu tabel rapi per kategori: kolom pengantar (No, Nomor Struk, Sumber File, Baris Sumber, Alasan) lalu SELURUH kolom asli baris sumber.
// Bila File A dan File B memakai nama kolom yang sama, kolomnya digabung (satu kolom); kolom yang hanya ada di salah satu file tetap
// ditampilkan dan dikosongkan untuk baris dari file lain. Kolom milik file yang tidak muncul di daftar tidak ditampilkan.
export type CategoryTable = { header: string[]; rows: Cell[][] };

/** Nama kolom dibuat unik per tabel ("Total", "Total (2)") agar tidak saling menimpa. */
const uniqueHeaders = (hs: string[]): string[] => {
  const seen = new Map<string, number>();
  return hs.map((h) => { const base = h.trim() || "Kolom"; const n = (seen.get(base) ?? 0) + 1; seen.set(base, n); return n === 1 ? base : `${base} (${n})`; });
};

export function buildCategoryExport(list: CategoryList, ta: TableData, tb: TableData): CategoryTable {
  const hasA = list.items.some((i) => i.source === "A"), hasB = list.items.some((i) => i.source === "B");
  const ha = uniqueHeaders(ta.headers), hb = uniqueHeaders(tb.headers);
  const data: string[] = [];
  const pos = new Map<string, number>();
  for (const h of [...(hasA ? ha : []), ...(hasB ? hb : [])]) if (!pos.has(h)) { pos.set(h, data.length); data.push(h); }
  const colA = new Map(ha.map((h, i) => [h, i] as const)), colB = new Map(hb.map((h, i) => [h, i] as const));
  const withNote = list.category === "REVIEW";
  const lead = ["No", "Nomor Struk", "Sumber File", "Baris Sumber", "Alasan", ...(withNote ? ["Keterangan"] : [])];
  const rows = list.items.map((it, n): Cell[] => {
    const t = it.source === "A" ? ta : tb, col = it.source === "A" ? colA : colB;
    const vals = data.map((h): Cell => {
      const c = col.get(h);
      const v = c === undefined || it.index < 0 ? "" : (t.rows[it.index]?.[c] ?? "");
      return v === "" ? null : v;
    });
    return [n + 1, it.receipt || null, `File ${it.source}`, it.row, it.reason, ...(withNote ? [it.detail] : []), ...vals];
  });
  return { header: [...lead, ...data], rows };
}

/** Lebar kolom Excel (jumlah karakter) dari isi tabel; dibatasi agar sheet tidak terlalu lebar. */
export function columnWidths(rows: Cell[][], min = 8, max = 48): number[] {
  const n = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const w = new Array<number>(n).fill(min);
  rows.slice(0, 1000).forEach((r) => r.forEach((v, c) => { const len = v === null ? 0 : String(v).length + 2; if (len > w[c]) w[c] = Math.min(len, max); }));
  return w;
}

const guard = (v: string) => (/^[=@]/.test(v) || /^[+-][^\d.,\s]/.test(v) ? `'${v}` : v); // cegah formula injection (sama seperti ekspor lain)

/**
 * Teks yang HARUS tetap teks di Excel: deretan angka ≥ 11 digit (nomor struk panjang, mis. 641126010100002641 — Excel menampilkannya
 * sebagai 6.41126E+17 dan memotong digitnya) atau angka berawalan nol (00123 → 123).
 */
export const isTextDigits = (v: string): boolean => /^\d{11,}$/.test(v) || /^0\d+$/.test(v);
/** CSV: sel teks-angka ditulis sebagai ="…" supaya Excel membacanya sebagai teks utuh. */
export const csvCell = (v: Cell): string => {
  if (v === null) return '""';
  if (typeof v === "number") return `"${String(v)}"`;
  if (isTextDigits(v)) return `="${v}"`;
  return `"${guard(v).replace(/"/g, '""')}"`;
};
/** Excel (.xlsx): paksa sel teks-angka bertipe teks (format "@") pada worksheet yang sudah dibuat. */
export function forceTextCells(ws: Record<string, unknown>): void {
  for (const addr of Object.keys(ws)) {
    if (addr.startsWith("!")) continue;
    const c = ws[addr] as { t?: string; v?: unknown; z?: string } | undefined;
    if (c && typeof c.v === "string" && isTextDigits(c.v)) { c.t = "s"; c.z = "@"; }
  }
}
const q = csvCell;
const line = (r: Cell[]) => r.map(q).join(",");

/** CSV satu kategori: satu tabel bersih (baris pertama = judul kolom), tanpa blok tambahan, siap dibuka di Excel. */
export function categoryToCsv(ex: CategoryTable): string {
  return "\ufeff" + [ex.header, ...ex.rows].map(line).join("\r\n");
}

/**
 * CSV "Ekspor Hasil" (seluruh hasil). Susunan sama persis dengan toCsv() di engine; satu-satunya beda: nomor struk panjang / angka
 * berawalan nol ditulis sebagai teks (="…") agar Excel tidak mengubahnya menjadi 6.41126E+17.
 */
export function exportDataToCsv(data: ExportData): string {
  const lines: Cell[][] = [["RINGKASAN HASIL"], ...data.summary.map(([k, v]) => [k, v] as Cell[]), [], ["HASIL PERBANDINGAN (SELURUH TRANSAKSI)"], data.header, ...data.rows];
  if (data.diffRows.length) lines.push([], ["DETAIL SELISIH PER KOLOM"], data.diffHeader, ...data.diffRows);
  if (data.pairRows.length) lines.push([], ["DETAIL PEMASANGAN (DUPLIKAT / PERLU DITINJAU)"], data.pairHeader, ...data.pairRows);
  if (data.reviewRows.length) lines.push([], ["PERLU DITINJAU (TRANSAKSI TANPA PASANGAN, DUPLIKAT, BENTURAN, KOSONG, AMBIGU)"], data.reviewHeader, ...data.reviewRows);
  return "\ufeff" + lines.map(line).join("\r\n");
}
