import type { TableData } from "./compareTable";

// Engine "Bandingkan 2 File" (CEK STRUK): pencocokan PER TRANSAKSI berdasarkan kunci (bukan nomor baris, bukan total file).
//
// Definisi "transaksi": baris data (di bawah header) yang tidak kosong dan bukan baris ringkasan laporan (TOTAL/JUMLAH/dst).
// Header, baris kosong, header berulang, dan baris ringkasan TIDAK dihitung. Baris tanpa kunci tetap transaksi
// (dihitung) tetapi tidak dapat dicocokkan → status PERLU DITINJAU.
//
// Prioritas status utama per kunci (satu kunci = satu record):
//   1. DUPLIKAT        — kunci muncul >1 kali di File A dan/atau File B (SELALU tampil, walau nominalnya cocok)
//   2. PERLU DITINJAU  — kunci kosong, atau nilai ambigu yang tidak bisa ditafsirkan dan tidak ada selisih pasti
//   3. HANYA DI FILE A / HANYA DI FILE B
//   4. NOMINAL BERBEDA — kunci cocok, ada kolom yang dibandingkan (nominal/tanggal/no struk) yang berbeda
//   5. COCOK
// Record DUPLIKAT dipasangkan deterministik: pasangan dengan nilai identik lebih dulu (urutan baris), sisanya berdasarkan
// urutan baris, sisa terakhir "hanya di salah satu file". Bila pemasangan tidak seluruhnya cocok → ditandai ambigu.

export type CompareStatus = "COCOK" | "NOMINAL BERBEDA" | "HANYA DI FILE A" | "HANYA DI FILE B" | "DUPLIKAT" | "PERLU DITINJAU";
export type NumberFormat = "auto" | "id" | "en";
export type MatchMode = "key" | "key_date" | "key_amount";
export type SideMap = { key: number; receipt: number; date: number }; // -1 = tidak dipakai
export type AmountPair = { a: number; b: number; label: string };
/**
 * Aturan normalisasi identitas (nomor struk). Seluruh nomor struk selalu dibandingkan UTUH:
 *  - "alnum" (DEFAULT) = hanya perbedaan PENULISAN yang disamakan: spasi, koma, tanda hubung, dan tanda baca lain dibuang;
 *    huruf besar/kecil diabaikan. Semua huruf & digit (prefix, suffix, nol di depan) dipertahankan.
 *  - "strict" = hanya karakter tak terlihat, spasi berlebih, dan huruf besar/kecil yang disamakan.
 * TIDAK ADA pencocokan awalan (prefix), akhiran/digit terakhir, hanya-digit, pemotongan panjang, atau pembuangan nol di depan:
 * dua nomor yang karakter identitasnya berbeda tidak pernah dianggap sama.
 */
export type KeyRule = "alnum" | "strict";
export const DEFAULT_KEY_RULE: KeyRule = "alnum";
export const KEY_RULE_LABEL: Record<KeyRule, string> = {
  alnum: "Standar (default): spasi, koma, tanda hubung & tanda baca diabaikan; huruf besar-kecil diabaikan; semua huruf/angka (termasuk nol di depan) dipertahankan",
  strict: "Persis: hanya spasi berlebih/karakter tak terlihat & huruf besar-kecil diabaikan (INV-001 ≠ INV001)",
};
export const KEY_RULES: KeyRule[] = ["alnum", "strict"];
export type CompareConfig = {
  a: SideMap; b: SideMap; amounts: AmountPair[]; mode: MatchMode;
  /** aturan normalisasi identitas; kosong = "strict" */
  /** false = pencocokan murni berdasarkan identitas; nominal/tax/tanggal tidak dibandingkan (total per file tetap dihitung) */
  compareValues?: boolean;
  keyRule?: KeyRule;
  trim: boolean; normalizeDate: boolean; normalizeNumber: boolean; caseSensitive: boolean; numberFormat: NumberFormat; tolerance: number;
};
export const MODE_LABEL: Record<MatchMode, string> = {
  key: "Kunci transaksi saja",
  key_date: "Kunci + tanggal harus sama",
  key_amount: "Kunci + nominal utama harus sama",
};

export type ParsedNumber = { state: "empty" } | { state: "ambiguous" } | { state: "ok"; canon: string; value: number; assumed: boolean };
const NULLISH = /^(null|undefined|nan|n\/a|na|-|—)?$/i;

export function inferLocale(values: readonly string[]): "id" | "en" | "unknown" {
  let id = 0, en = 0;
  for (const v of values) {
    const t = v.replace(/rp\.?|idr|usd|\$|[\s\u00a0()\-−]/gi, "");
    if (!/^[\d.,]+$/.test(t) || !/\d/.test(t)) continue;
    const dots = (t.match(/\./g) ?? []).length, commas = (t.match(/,/g) ?? []).length;
    if (dots && commas) { t.lastIndexOf(",") > t.lastIndexOf(".") ? id++ : en++; }
    else if (commas > 1) en++;
    else if (dots > 1) id++;
    else if (commas === 1 && t.split(",")[1].length !== 3) id++;
    else if (dots === 1 && t.split(".")[1].length !== 3) en++;
  }
  return id > 0 && en === 0 ? "id" : en > 0 && id === 0 ? "en" : "unknown";
}

const build = (neg: boolean, intPart: string, frac: string, assumed: boolean): ParsedNumber => {
  const i = intPart.replace(/^0+(?=\d)/, "") || "0";
  const f = frac.replace(/0+$/, "");
  const isZero = /^0*$/.test(i) && f === "";
  const canon = `${neg && !isZero ? "-" : ""}${i}${f ? "." + f : ""}`;
  return { state: "ok", canon, value: Number(canon), assumed };
};

/** Tafsir angka secara ketat. Nilai yang tidak dapat ditafsirkan tanpa ambiguitas → "ambiguous" (BUKAN nol). */
export function parseNumber(raw: string, locale: "id" | "en" | "unknown" = "unknown"): ParsedNumber {
  let t = raw.trim();
  if (NULLISH.test(t)) return { state: "empty" };
  let neg = false;
  const paren = /^\((.*)\)$/.exec(t);
  if (paren) { neg = true; t = paren[1].trim(); }
  t = t.replace(/^(rp\.?|idr|usd|\$)\s*/i, "").replace(/\s*(rp\.?|idr|usd)$/i, "");
  if (/^[-−]/.test(t)) { neg = !neg; t = t.slice(1); }
  else if (/-$/.test(t)) { neg = !neg; t = t.slice(0, -1); }
  t = t.replace(/[\s\u00a0]/g, "");
  if (!/^[\d.,]+$/.test(t) || !/\d/.test(t)) return { state: "ambiguous" };
  const dots = (t.match(/\./g) ?? []).length, commas = (t.match(/,/g) ?? []).length;
  const grouped = (s: string, sep: string) => new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`).test(s);
  if (dots && commas) {
    const dec = t.lastIndexOf(",") > t.lastIndexOf(".") ? "," : ".";
    const thou = dec === "," ? "." : ",";
    const k = t.lastIndexOf(dec);
    const intP = t.slice(0, k), frac = t.slice(k + 1);
    if ((t.match(dec === "," ? /,/g : /\./g) ?? []).length !== 1 || !grouped(intP, thou) || !/^\d+$/.test(frac)) return { state: "ambiguous" };
    return build(neg, intP.split(thou).join(""), frac, false);
  }
  if (!dots && !commas) return build(neg, t, "", false);
  const sep = dots ? "." : ",";
  const n = dots || commas;
  if (n > 1) return grouped(t, sep) ? build(neg, t.split(sep).join(""), "", false) : { state: "ambiguous" };
  const [i, f] = t.split(sep);
  if (!/^\d+$/.test(i) || !/^\d+$/.test(f)) return { state: "ambiguous" }; // mis. "12." atau ".5"
  if (f.length !== 3 || i.length > 3 || i.startsWith("0")) return build(neg, i, f, false); // tidak mungkin ribuan → desimal
  // persis 3 digit setelah satu pemisah (mis. 1.234): bergantung format
  const thousand = sep === "." ? locale !== "en" : locale === "en";
  return thousand ? build(neg, i + f, "", locale === "unknown") : build(neg, i, f, locale === "unknown");
}

const MONTHS: Record<string, number> = { jan: 1, januari: 1, january: 1, feb: 2, februari: 2, february: 2, mar: 3, maret: 3, march: 3, apr: 4, april: 4, mei: 5, may: 5, jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7, agu: 8, agt: 8, agustus: 8, aug: 8, august: 8, sep: 9, sept: 9, september: 9, okt: 10, oktober: 10, oct: 10, october: 10, nov: 11, november: 11, des: 12, desember: 12, dec: 12, december: 12 };
const validYmd = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
const ymd = (y: number, m: number, d: number) => (validYmd(y, m, d) ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null);

/** Tanggal → YYYY-MM-DD. Pola dd/mm/yyyy dianggap format Indonesia (hari dulu). null bila tidak dapat ditafsirkan. */
export function normalizeDateText(raw: string): string | null {
  const t = raw.trim().replace(/[T ]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i, "");
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t);
  if (m) return ymd(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[-/.\s]([A-Za-z]+)[-/.,\s]+(\d{4})$/.exec(t);
  if (m && MONTHS[m[2].toLowerCase()]) return ymd(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}

export type AmountKind = "total" | "subtotal" | "dpp" | "tax" | "service" | "discount" | "other";
export const AMOUNT_KIND_LABEL: Record<AmountKind, string> = { total: "Total", subtotal: "Subtotal", dpp: "DPP", tax: "Tax / Pajak", service: "Service charge", discount: "Discount", other: "Lainnya" };
export type ColDiff = { label: string; a: string; b: string; delta: number | null; kind?: AmountKind | "date" | "receipt" };
/** Nilai satu jenis nominal pada satu transaksi (null = sisi itu tidak punya baris; "" = sel kosong). */
export type KindValue = { label: string; a: string | null; b: string | null; delta: number | null };
export type PairOutcome = "COCOK" | "NOMINAL BERBEDA" | "HANYA DI FILE A" | "HANYA DI FILE B" | "PERLU DITINJAU";
export type PairResult = { a: number | null; b: number | null; outcome: PairOutcome; diffs: ColDiff[]; reasons: string[] };
export type CompareRecord = {
  id: number; key: string; status: CompareStatus; idxA: number[]; idxB: number[]; pairs: PairResult[];
  note: string; receipt: string; date: string; amountA: string | null; amountB: string | null; delta: number | null;
  diffColumns: string[]; ambiguousPairing: boolean;
  /** true bila ada kolom nominal (bukan tanggal/no struk) yang berbeda pada pasangan baris mana pun */
  amountDiff: boolean;
  /** true bila kolom tax/pajak/ppn berbeda pada pasangan baris mana pun */
  taxDiff: boolean;
  /** true bila transaksi tidak punya kunci (tidak dapat dicocokkan) */
  noKey: boolean;
  /** nilai per jenis nominal (tax, total, dst) untuk tabel ringkas; hanya jenis yang dipetakan */
  kinds: Partial<Record<AmountKind, KindValue>>;
  /** kunci hasil normalisasi (hanya untuk pencocokan); `key` tetap nomor struk asli */
  normKey: string;
  /** penulisan asli yang BERBEDA tetapi menjadi identik setelah normalisasi, per file (kosong = tidak ada benturan) */
  collisionA: string[]; collisionB: string[];
};
/** Alasan sebuah baris transaksi masuk "Perlu Ditinjau". */
export type ReviewReason = "HANYA_A" | "HANYA_B" | "DUPLIKAT" | "BENTURAN" | "KOSONG" | "AMBIGU";
export const REVIEW_REASON_LABEL: Record<ReviewReason, string> = {
  HANYA_A: "Tidak ada pasangan (hanya di File A)", HANYA_B: "Tidak ada pasangan (hanya di File B)", DUPLIKAT: "Nomor struk duplikat",
  BENTURAN: "Benturan normalisasi", KOSONG: "Nomor struk kosong/tidak valid", AMBIGU: "Nilai ambigu",
};
/** Satu baris transaksi (File A atau File B) yang perlu ditinjau manual. Tidak pernah dinyatakan salah/hilang secara pasti. */
export type ReviewItem = {
  recordId: number; source: "A" | "B";
  /** nomor baris asli di file sumber (1-based) */
  row: number;
  /** nomor struk asli (lengkap, tanpa dipotong) */
  receipt: string;
  /** kunci hasil normalisasi yang dipakai untuk pencocokan */
  normalized: string;
  reasons: ReviewReason[];
  detail: string;
};
export type CompareTotals = { label: string; kind: AmountKind; sumA: number; sumB: number; parsedA: number; parsedB: number; ambiguousA: number; ambiguousB: number };
export type CompareSummary = {
  totalA: number; totalB: number; cocok: number; berbeda: number; onlyA: number; onlyB: number; duplikat: number; review: number;
  dupKeysA: number; dupKeysB: number; dupRowsA: number; dupRowsB: number;
  summaryRowsA: number; summaryRowsB: number; emptyKeyA: number; emptyKeyB: number; blankRowsA: number; blankRowsB: number;
  /** jumlah identitas unik (kunci tidak kosong) tiap file */
  uniqueKeysA: number; uniqueKeysB: number;
  /** identitas ada di kedua file / hanya di salah satu (termasuk identitas duplikat); tumpang tindih dengan status DUPLIKAT */
  keysBoth: number; keysOnlyA: number; keysOnlyB: number;
  /** jumlah transaksi (identitas) dengan selisih nominal / selisih tax; tumpang tindih dengan status */
  amountDiff: number; taxDiff: number;
  /** jumlah identitas dengan benturan normalisasi; jumlah baris transaksi (A+B) di daftar Perlu Ditinjau */
  collisionKeys: number; reviewRows: number;
  /** nomor struk valid (kunci terbaca, bukan ringkasan/kosong/notasi ilmiah) dihitung per KEMUNCULAN; unik = uniqueKeysA/B */
  validA: number; validB: number;
  /** nomor struk duplikat: jumlah kemunculan SAMA di kedua file / BERBEDA (termasuk duplikat yang hanya ada di satu file) */
  dupSameCount: number; dupDiffCount: number;
};
export type CompareResult = { records: CompareRecord[]; summary: CompareSummary; totals: CompareTotals[]; notes: string[]; config: CompareConfig; review: ReviewItem[] };

// ───────────── util ─────────────
// Baris ringkasan laporan: seluruh isi sel label berupa "Total", "Grand Total", "Jumlah", dst. (boleh diikuti ≤2 kata tanpa angka,
// mis. "Total Penjualan"). Identitas seperti "TOTAL-001" atau "Total 12" BUKAN ringkasan. Jumlah kolom terisi tidak menentukan:
// baris TOTAL laporan dengan banyak kolom nominal tetap ringkasan.
const SUMMARY_LABEL = /^\s*(grand\s*total|sub\s*total|total|jumlah|sum)(\s+[^\W\d_]+){0,2}\s*[:.]?\s*$/i;
function isSummaryRow(t: TableData, r: number, keyCol: number): boolean {
  const k = keyCol >= 0 ? (t.rows[r][keyCol] ?? "").trim() : "";
  if (k) return SUMMARY_LABEL.test(k);
  return t.rows[r].some((c) => SUMMARY_LABEL.test(c));
}
const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));
const CHUNK = 4000;

type Side = "A" | "B";
type Prepared = {
  table: TableData; map: SideMap; groups: Map<string, number[]>; blank: number; summaryRows: number; emptyKeyRows: number[];
  locales: Map<number, "id" | "en" | "unknown">;
  /** kunci pencocokan → penulisan asli yang berbeda (untuk mendeteksi benturan normalisasi) */
  variants: Map<string, Set<string>>;
};

/** Deteksi otomatis pemetaan kolom umum. Pengguna tetap dapat mengubahnya. */
export const norm = (h: string) => h.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
export const KEY_NAMES = ["no_struk", "nomor_struk", "no_order", "nomor_order", "no_transaksi", "nomor_transaksi", "no_bill", "bill_no", "bill_number", "billing_id", "receipt", "no_receipt", "receipt_no", "receipt_number", "order_no", "order_id", "transaction_id", "transaction_no", "trans_id", "id_transaksi", "invoice_no", "no_invoice", "invoice", "no_folio", "folio", "no_nota", "nomor_nota", "nota", "receipt_id", "bill_id", "bill", "trx_id", "no_trx", "trx_no", "transaction_number", "kode_transaksi", "check_no", "check_number", "id"];
export const DATE_NAMES = ["date_trans", "tanggal_transaksi", "tgl_transaksi", "tanggal", "tgl", "date", "transaction_date", "trans_date", "waktu"];
const AMOUNT_NAMES = ["total", "grand_total", "paid_amount", "total_bayar", "nominal", "amount", "jumlah", "subtotal", "tax", "pajak", "service_charge", "discount", "dpp"];

const find = (h: string[], names: string[]) => { const n = h.map(norm); for (const x of names) { const i = n.indexOf(x); if (i >= 0) return i; } return -1; };

/** Jenis nominal dari nama header (subtotal / dpp / tax / service / discount / total). "other" bila tidak dikenali. */
export function classifyAmount(header: string): AmountKind {
  const toks = norm(header).split("_").filter(Boolean);
  const has = (...w: string[]) => w.some((x) => toks.includes(x));
  if (has("dpp", "dasar") || (has("tax") && has("base"))) return "dpp";
  if (has("tax", "pajak", "ppn", "pb1", "vat")) return "tax";
  if (has("service", "servis", "svc")) return "service";
  if (has("discount", "diskon", "disc", "potongan")) return "discount";
  if (has("subtotal") || (has("sub") && has("total"))) return "subtotal";
  if (has("total", "grand", "jumlah", "nominal", "amount", "bayar", "paid", "nilai")) return "total";
  return "other";
}
const KIND_ORDER: AmountKind[] = ["total", "subtotal", "dpp", "tax", "service", "discount", "other"];

/** Bagian nilai (maks. 400 sel terisi pertama) yang dapat ditafsirkan sebagai angka. Kolom kosong dianggap numerik. */
function numericRatio(t: TableData, col: number): number {
  let ok = 0, seen = 0;
  for (let r = 0; r < t.rows.length && seen < 400; r++) {
    const v = (t.rows[r][col] ?? "").trim();
    if (!v) continue;
    seen++;
    if (parseNumber(v, "unknown").state !== "ambiguous") ok++;
  }
  return seen ? ok / seen : 1;
}

// Karakter tak terlihat yang tidak bermakna: zero-width, soft hyphen, BOM, word joiner, karakter kontrol.
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
// Spasi unicode (NBSP, thin space, ideographic space, dst.) → spasi biasa.
const UNI_SPACE = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g;
/** Pembersihan dasar yang aman: buang karakter tak terlihat, samakan spasi unicode, rapikan spasi berlebih. */
export const cleanInvisible = (raw: string): string => raw.replace(INVISIBLE, "").replace(UNI_SPACE, " ");

/** Notasi ilmiah hasil Excel (mis. 2.0261E+12): presisi nomor sudah hilang di file sumber, tidak dapat dipulihkan. */
export const isSciNotationKey = (raw: string): boolean => /^\s*\d(\.\d+)?e[+-]?\d+\s*$/i.test(raw);

/**
 * Normalisasi kunci untuk PENCOCOKAN (nomor asli tetap disimpan untuk tampilan): karakter tak terlihat, spasi, huruf besar/kecil,
 * ".0" dari Excel; pada aturan standar ("alnum") juga spasi/koma/tanda hubung/tanda baca. Nol di depan dan seluruh huruf/digit TIDAK dibuang.
 */
export function normalizeKey(raw: string, trim = true, caseSensitive = false, rule: KeyRule = DEFAULT_KEY_RULE): string {
  // NFKC: angka/huruf lebar-penuh (１２３) → biasa; variasi tanda hubung unicode (‐ ‑ – — −) → "-" supaya tidak tampak sama tetapi berbeda.
  const cleaned = cleanInvisible(raw).normalize("NFKC").replace(/[\u2010-\u2015\u2212]/g, "-");
  if (/^(null|undefined|nan)?$/i.test(cleaned.trim())) return "";
  let s = trim ? cleaned.trim() : cleaned;
  if (trim) s = s.replace(/ {2,}/g, " ");
  if (/^-?\d+\.0+$/.test(s.trim())) s = s.trim().replace(/\.0+$/, "");
  if (!caseSensitive) s = s.toLowerCase();
  return rule === "alnum" ? s.replace(/[^\p{L}\p{N}]+/gu, "") : s;
}

/** Penulisan asli nomor struk untuk mendeteksi benturan: hanya pembersihan tak terlihat/spasi tepi; huruf besar-kecil, spasi internal, dan tanda baca dipertahankan. */
export function rawIdentity(raw: string): string {
  let s = cleanInvisible(raw).normalize("NFKC").replace(/[\u2010-\u2015\u2212]/g, "-").trim().replace(/ {2,}/g, " ");
  if (/^-?\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, "");
  return s;
}

export type KeyCandidate = { index: number; header: string; score: number; fill: number; unique: number; byName: boolean };
export type KeyConfidence = "high" | "low" | "none";
export type KeyPairing = { a: number; b: number; confidence: KeyConfidence; overlap: number; matched: number; candidatesA: KeyCandidate[]; candidatesB: KeyCandidate[] };

export const keySet = (t: TableData, col: number, rule: KeyRule = DEFAULT_KEY_RULE, caseSensitive = false): { set: Set<string>; filled: number } => {
  const set = new Set<string>(); let filled = 0;
  for (let r = 0; r < t.rows.length; r++) { const k = normalizeKey(t.rows[r][col] ?? "", true, caseSensitive, rule); if (k) { set.add(k); filled++; } }
  return { set, filled };
};
const moneyLike = (t: TableData, col: number): boolean => {
  let seen = 0;
  for (let r = 0; r < t.rows.length && seen < 200; r++) {
    const v = (t.rows[r][col] ?? "").trim();
    if (!v) continue;
    seen++;
    if (/^[-(]?\s*(rp\.?\s*)?\d+[.,]\d+\)?$/i.test(v)) return true;
  }
  return false;
};

// Nama header kolom penomoran baris. Kolom seperti ini BUKAN identitas transaksi: memakainya sama dengan mencocokkan berdasarkan posisi baris.
const ROW_INDEX_NAMES = ["no_urut", "nomor_urut", "urut", "seq", "sequence", "idx", "index", "row", "row_no", "row_num", "row_number", "baris", "line", "line_no", "sr_no", "s_no", "sno", "sl_no"];
/**
 * Kolom penomoran baris (1,2,3,… berurutan menurut posisi baris). Dikenali dari nama (No Urut, Index, …) atau isi:
 * semua sel terisi berupa bilangan bulat tanpa nol di depan, mulai dari 0/1, dan naik tepat +1 pada ≥95% pasangan baris.
 * Kolom bernama kunci transaksi (No Struk, Order No, …) tidak pernah dianggap penomoran baris, walau nomornya berurutan.
 */
export function isRowIndexColumn(t: TableData, col: number): boolean {
  const name = norm(t.headers[col] ?? "");
  if (ROW_INDEX_NAMES.includes(name)) return true;
  if (KEY_NAMES.includes(name) && name !== "id") return false;
  let n = 0, steps = 0, ok = 0, prev = NaN, first = NaN;
  for (let r = 0; r < t.rows.length; r++) {
    const v = cleanInvisible(t.rows[r][col] ?? "").trim();
    if (!v) continue;
    if (!/^(0|[1-9]\d{0,8})$/.test(v)) return false;
    const x = Number(v);
    if (n === 0) first = x; else { steps++; if (x === prev + 1) ok++; }
    prev = x; n++;
  }
  return n >= 3 && first <= 1 && ok >= 0.95 * steps;
}

/** Kandidat kolom identitas transaksi, terurut dari paling meyakinkan. Berdasarkan nama header DAN isi kolom (terisi, unik). */
export function rankKeyColumns(t: TableData): KeyCandidate[] {
  const names = t.headers.map(norm);
  const total = t.rows.length || 1;
  const out: KeyCandidate[] = [];
  for (let c = 0; c < t.headers.length; c++) {
    const rank = KEY_NAMES.indexOf(names[c]);
    if (rank < 0 && (classifyAmount(t.headers[c]) !== "other" || DATE_NAMES.includes(names[c]))) continue;
    if (isRowIndexColumn(t, c)) continue;
    const { set, filled } = keySet(t, c);
    const fill = filled / total, unique = filled ? set.size / filled : 0;
    let score: number;
    if (rank >= 0) {
      if (fill < 0.5) continue;
      if (names[c] === "id" && unique < 0.9) continue; // "id" generik hanya dianggap identitas bila hampir unik
      score = 1000 - rank * 10 + fill * 5 + unique * 2;
    } else {
      if (fill < 0.95 || unique < 0.98 || moneyLike(t, c)) continue;
      score = 400 + unique * 5 + fill * 5;
    }
    out.push({ index: c, header: t.headers[c], score, fill, unique, byName: rank >= 0 });
  }
  return out.sort((x, y) => y.score - x.score || x.index - y.index);
}

/** Pilih pasangan kolom identitas File A ↔ File B dengan membandingkan nama DAN nilai (berapa banyak identitas yang sama). */
export function pairKeyColumns(ta: TableData, tb: TableData): KeyPairing {
  const ca = rankKeyColumns(ta), cb = rankKeyColumns(tb);
  if (!ca.length || !cb.length) return { a: ca[0]?.index ?? -1, b: cb[0]?.index ?? -1, confidence: "none", overlap: 0, matched: 0, candidatesA: ca, candidatesB: cb };
  const sets = new Map<string, Set<string>>();
  const get = (side: "a" | "b", t: TableData, col: number) => { const id = side + col; let s = sets.get(id); if (!s) { s = keySet(t, col).set; sets.set(id, s); } return s; };
  let best: { x: KeyCandidate; y: KeyCandidate; overlap: number; matched: number; pts: number } | null = null;
  for (const x of ca.slice(0, 5)) for (const y of cb.slice(0, 5)) {
    const sa = get("a", ta, x.index), sb = get("b", tb, y.index);
    const [small, big] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
    let matched = 0; small.forEach((k) => { if (big.has(k)) matched++; });
    const overlap = small.size ? matched / small.size : 0;
    const pts = overlap * 400 + (x.score + y.score) / 4;
    if (!best || pts > best.pts) best = { x, y, overlap, matched, pts };
  }
  const b = best!;
  const confident = b.overlap >= 0.5 || (b.x.byName && b.y.byName && b.overlap >= 0.05);
  return { a: b.x.index, b: b.y.index, confidence: confident ? "high" : "low", overlap: b.overlap, matched: b.matched, candidatesA: ca, candidatesB: cb };
}

export function autoDetectConfig(ta: TableData, tb: TableData): CompareConfig {
  const pk = pairKeyColumns(ta, tb);
  const ka = pk.a, kb = pk.b;
  const na = ta.headers.map(norm), nb = tb.headers.map(norm);
  const dateA = find(ta.headers, DATE_NAMES), dateB = find(tb.headers, DATE_NAMES);
  const amounts: AmountPair[] = [];
  const usedA = new Set<number>(), usedB = new Set<number>();
  const push = (ia: number, ib: number) => { amounts.push({ a: ia, b: ib, label: ta.headers[ia] }); usedA.add(ia); usedB.add(ib); };
  // 1) nama kolom identik (perilaku lama)
  for (const name of AMOUNT_NAMES) {
    const ia = na.indexOf(name), ib = nb.indexOf(name);
    if (ia >= 0 && ib >= 0 && ia !== ka && ib !== kb && !usedA.has(ia) && !usedB.has(ib)) push(ia, ib);
  }
  // 2) nama berbeda tetapi jenis nominal sama (Tax ↔ Pajak, Diskon ↔ Discount, ...); kolom harus berisi angka
  const kindCols = (t: TableData, skip: Set<number>, key: number, date: number) => {
    const m = new Map<AmountKind, number>();
    t.headers.forEach((h, i) => {
      if (i === key || i === date || skip.has(i)) return;
      const k = classifyAmount(h);
      if (k !== "other" && !m.has(k) && numericRatio(t, i) >= 0.8) m.set(k, i);
    });
    return m;
  };
  const covered = new Set(amounts.map((p) => classifyAmount(ta.headers[p.a]) !== "other" ? classifyAmount(ta.headers[p.a]) : classifyAmount(tb.headers[p.b])));
  const colsA = kindCols(ta, usedA, ka, dateA), colsB = kindCols(tb, usedB, kb, dateB);
  for (const k of KIND_ORDER) {
    if (k === "other" || covered.has(k)) continue;
    const ia = colsA.get(k), ib = colsB.get(k);
    if (ia !== undefined && ib !== undefined) { push(ia, ib); covered.add(k); }
  }
  if (!amounts.length) {
    const re = /total|amount|nominal|jumlah|nilai|harga|bayar/;
    const ia = na.findIndex((n, i) => re.test(n) && i !== ka), ib = nb.findIndex((n, i) => re.test(n) && i !== kb);
    if (ia >= 0 && ib >= 0) push(ia, ib);
  }
  const rank = (p: AmountPair) => { const k = classifyAmount(ta.headers[p.a]) !== "other" ? classifyAmount(ta.headers[p.a]) : classifyAmount(tb.headers[p.b]); return KIND_ORDER.indexOf(k); };
  amounts.sort((x, y) => rank(x) - rank(y)); // stabil: total dulu (nominal utama), lalu subtotal, dpp, tax, service, discount
  const side = (h: string[], k: number): SideMap => ({ key: k, receipt: k, date: find(h, DATE_NAMES) });
  return { a: side(ta.headers, ka), b: side(tb.headers, kb), amounts, mode: "key", keyRule: DEFAULT_KEY_RULE, trim: true, normalizeDate: true, normalizeNumber: true, caseSensitive: false, numberFormat: "auto", tolerance: 0 };
}

/** Irisan identitas untuk pasangan kolom kunci yang dipilih: berapa identitas unik tiap file dan berapa yang sama. */
export function keyOverlapInfo(ta: TableData, tb: TableData, ka: number, kb: number, rule: KeyRule = DEFAULT_KEY_RULE, caseSensitive = false): { uniqueA: number; uniqueB: number; matched: number } {
  if (ka < 0 || kb < 0 || ka >= ta.headers.length || kb >= tb.headers.length) return { uniqueA: 0, uniqueB: 0, matched: 0 };
  const sa = keySet(ta, ka, rule, caseSensitive).set, sb = keySet(tb, kb, rule, caseSensitive).set;
  let matched = 0; sa.forEach((k) => { if (sb.has(k)) matched++; });
  return { uniqueA: sa.size, uniqueB: sb.size, matched };
}

export type KeySuggestion = { a: number; b: number; rule: KeyRule; matched: number; uniqueA: number; uniqueB: number; ratio: number };
/**
 * Saran perbaikan identitas saat irisan nol/rendah: coba kandidat kolom (nama + isi) × aturan normalisasi, urut dari irisan terbesar.
 * Hanya saran — tidak pernah diterapkan otomatis (aturan longgar dapat menyamakan identitas yang sebenarnya berbeda).
 */
export function suggestKeyFixes(ta: TableData, tb: TableData, cur: { a: number; b: number }, caseSensitive = false, limit = 4): KeySuggestion[] {
  const colsA = new Set<number>(rankKeyColumns(ta).slice(0, 5).map((c) => c.index)), colsB = new Set<number>(rankKeyColumns(tb).slice(0, 5).map((c) => c.index));
  if (cur.a >= 0) colsA.add(cur.a);
  if (cur.b >= 0) colsB.add(cur.b);
  const cache = new Map<string, Set<string>>();
  const get = (side: "a" | "b", t: TableData, col: number, rule: KeyRule) => { const id = `${side}${col}${rule}`; let v = cache.get(id); if (!v) { v = keySet(t, col, rule, caseSensitive).set; cache.set(id, v); } return v; };
  const out: KeySuggestion[] = [];
  colsA.forEach((x) => colsB.forEach((y) => {
    for (const rule of KEY_RULES) {
      const sa = get("a", ta, x, rule), sb = get("b", tb, y, rule);
      if (!sa.size || !sb.size) continue;
      const [small, big] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
      let matched = 0; small.forEach((k) => { if (big.has(k)) matched++; });
      if (matched > 0) out.push({ a: x, b: y, rule, matched, uniqueA: sa.size, uniqueB: sb.size, ratio: matched / small.size });
    }
  }));
  // utamakan irisan terbesar; seri → aturan paling ketat, lalu kolom yang bukan kolom saat ini
  out.sort((p, q) => q.matched - p.matched || KEY_RULES.indexOf(p.rule) - KEY_RULES.indexOf(q.rule));
  const seen = new Set<string>();
  return out.filter((o) => { const k = `${o.a}|${o.b}|${o.rule}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, limit);
}

/** Statistik pembacaan sebelum perbandingan: baris terbaca, kosong, header berulang, ringkasan, tanpa kunci, valid. */
export function readStats(t: TableData, keyCol: number) {
  let summaryRows = 0, emptyKey = 0;
  for (let r = 0; r < t.rows.length; r++) {
    if (isSummaryRow(t, r, keyCol)) { summaryRows++; continue; }
    if (keyCol >= 0 && !normalizeKey(t.rows[r][keyCol] ?? "")) emptyKey++;
  }
  const rowsRead = t.rows.length + t.blankRows + t.repeatedHeaders;
  return { rowsRead, blank: t.blankRows, repeatedHeaders: t.repeatedHeaders, summaryRows, emptyKey, valid: t.rows.length - summaryRows, columns: t.headers.length };
}

export function validateConfig(c: CompareConfig, ta: TableData, tb: TableData): string[] {
  const errs: string[] = [];
  if (c.a.key < 0 || c.a.key >= ta.headers.length) errs.push("Pilih kolom kunci transaksi untuk File A.");
  if (c.b.key < 0 || c.b.key >= tb.headers.length) errs.push("Pilih kolom kunci transaksi untuk File B.");
  c.amounts.forEach((p, i) => { if (p.a < 0 || p.b < 0) errs.push(`Pasangan nominal #${i + 1}: pilih kolom di kedua file.`); });
  if (c.mode === "key_date" && (c.a.date < 0 || c.b.date < 0)) errs.push("Mode 'Kunci + tanggal' membutuhkan kolom tanggal di kedua file.");
  if (c.mode === "key_amount" && !c.amounts.length) errs.push("Mode 'Kunci + nominal' membutuhkan minimal satu pasangan kolom nominal.");
  if (!(c.tolerance >= 0) || !Number.isFinite(c.tolerance)) errs.push("Toleransi nominal harus angka ≥ 0.");
  if (c.compareValues !== false && !c.amounts.length && c.a.date < 0 && c.b.date < 0) errs.push("Tidak ada kolom yang dibandingkan: tambahkan minimal satu pasangan nominal atau kolom tanggal.");
  return errs;
}

export async function compareFiles(ta: TableData, tb: TableData, cfg: CompareConfig, onProgress?: (m: string) => void): Promise<CompareResult> {
  const errs = validateConfig(cfg, ta, tb);
  if (errs.length) throw new Error(errs.join(" "));
  const notes: string[] = [];
  const cell = (t: TableData, r: number, c: number) => (c >= 0 ? t.rows[r][c] ?? "" : "");
  const txt = (v: string) => { let s = cfg.trim ? v.trim() : v; if (!cfg.caseSensitive) s = s.toLowerCase(); return s; };
  const isNullish = (v: string) => /^(null|undefined|nan)?$/i.test(v.trim());

  // locale angka per kolom nominal & per file
  const localeFor = (t: TableData, col: number): "id" | "en" | "unknown" => {
    if (cfg.numberFormat !== "auto") return cfg.numberFormat;
    const loc = inferLocale(t.rows.map((r) => r[col] ?? ""));
    return loc;
  };
  const locA = new Map<number, "id" | "en" | "unknown">(), locB = new Map<number, "id" | "en" | "unknown">();
  const primary = cfg.amounts[0];
  const need = (m: Map<number, "id" | "en" | "unknown">, t: TableData, col: number) => { if (col >= 0 && !m.has(col)) m.set(col, localeFor(t, col)); };
  cfg.amounts.forEach((p) => { need(locA, ta, p.a); need(locB, tb, p.b); });

  let assumedCount = 0;
  const num = (raw: string, loc: "id" | "en" | "unknown"): ParsedNumber => {
    if (!cfg.normalizeNumber) {
      const t = raw.trim();
      if (NULLISH.test(t)) return { state: "empty" };
      return /^-?\d+(\.\d+)?$/.test(t) ? parseNumber(t, "en") : { state: "ambiguous" };
    }
    const p = parseNumber(raw, loc);
    if (p.state === "ok" && p.assumed) assumedCount++;
    return p;
  };
  const dateKey = (raw: string): string => {
    if (isNullish(raw)) return "";
    if (cfg.normalizeDate) return normalizeDateText(raw) ?? txt(raw);
    return txt(raw);
  };
  const keyOf = (raw: string): string => normalizeKey(raw, cfg.trim, cfg.caseSensitive, cfg.keyRule ?? DEFAULT_KEY_RULE); // 12345.0 dari Excel = 12345; nol di depan SELALU dipertahankan
  const isSummary = (t: TableData, r: number, keyCol: number): boolean => isSummaryRow(t, r, keyCol);
  const kindOf = (p: AmountPair): AmountKind => {
    const ka = p.a >= 0 ? classifyAmount(ta.headers[p.a] ?? "") : "other";
    return ka !== "other" ? ka : p.b >= 0 ? classifyAmount(tb.headers[p.b] ?? "") : "other";
  };

  const prepare = async (t: TableData, map: SideMap, side: Side, locales: Map<number, "id" | "en" | "unknown">): Promise<Prepared> => {
    const groups = new Map<string, number[]>();
    const variants = new Map<string, Set<string>>();
    let summaryRows = 0;
    const emptyKeyRows: number[] = [];
    for (let r = 0; r < t.rows.length; r++) {
      if (isSummary(t, r, map.key)) { summaryRows++; continue; }
      const rawKey = cell(t, r, map.key);
      // Notasi ilmiah (2.0261E+12): digit asli sudah hilang, dua nomor berbeda dapat tampak sama → tidak boleh dicocokkan, tandai PERLU DITINJAU.
      if (isSciNotationKey(rawKey)) { emptyKeyRows.push(r); continue; }
      let k = keyOf(rawKey);
      if (k) {
        if (cfg.mode === "key_date") k += `\u0001${dateKey(cell(t, r, side === "A" ? cfg.a.date : cfg.b.date))}`;
        else if (cfg.mode === "key_amount") {
          const p = num(cell(t, r, side === "A" ? primary.a : primary.b), locales.get(side === "A" ? primary.a : primary.b) ?? "unknown");
          if (p.state === "ambiguous") { emptyKeyRows.push(r); continue; }
          k += `\u0001${p.state === "ok" ? p.canon : ""}`;
        }
      } else { emptyKeyRows.push(r); continue; }
      const g = groups.get(k); if (g) g.push(r); else groups.set(k, [r]);
      const v = variants.get(k), rid = rawIdentity(rawKey); if (v) v.add(rid); else variants.set(k, new Set([rid]));
      if (r % CHUNK === CHUNK - 1) await yieldToUi();
    }
    return { table: t, map, groups, blank: t.blankRows, summaryRows, emptyKeyRows, locales, variants };
  };

  onProgress?.("Mencocokkan transaksi...");
  const A = await prepare(ta, cfg.a, "A", locA), B = await prepare(tb, cfg.b, "B", locB);

  const comparePair = (ra: number, rb: number): PairResult => {
    if (cfg.compareValues === false) return { a: ra, b: rb, outcome: "COCOK", diffs: [], reasons: [] };
    const diffs: ColDiff[] = [], reasons: string[] = [];
    for (const p of cfg.amounts) {
      const va = cell(ta, ra, p.a), vb = cell(tb, rb, p.b);
      const pa = num(va, locA.get(p.a) ?? "unknown"), pb = num(vb, locB.get(p.b) ?? "unknown");
      if (pa.state === "ambiguous" || pb.state === "ambiguous") {
        if (pa.state === "ambiguous") reasons.push(`Nilai ambigu di File A, kolom ${p.label}: "${va}"`);
        if (pb.state === "ambiguous") reasons.push(`Nilai ambigu di File B, kolom ${p.label}: "${vb}"`);
        continue;
      }
      if (pa.state === "empty" && pb.state === "empty") continue;
      if (pa.state === "empty" || pb.state === "empty") { diffs.push({ label: p.label, a: va, b: vb, delta: null, kind: kindOf(p) }); continue; } // kosong ≠ 0
      const delta = pb.value - pa.value;
      const same = cfg.tolerance > 0 ? Math.abs(delta) <= cfg.tolerance + 1e-9 : pa.canon === pb.canon;
      if (!same) diffs.push({ label: p.label, a: va, b: vb, delta, kind: kindOf(p) });
    }
    if (cfg.a.date >= 0 && cfg.b.date >= 0 && cfg.mode !== "key_date") {
      const da = cell(ta, ra, cfg.a.date), db = cell(tb, rb, cfg.b.date);
      if (dateKey(da) !== dateKey(db)) diffs.push({ label: "Tanggal", a: da, b: db, delta: null, kind: "date" });
    }
    if (cfg.a.receipt >= 0 && cfg.b.receipt >= 0 && cfg.a.receipt !== cfg.a.key && cfg.b.receipt !== cfg.b.key) {
      const xa = cell(ta, ra, cfg.a.receipt), xb = cell(tb, rb, cfg.b.receipt);
      if (txt(xa) !== txt(xb)) diffs.push({ label: "Nomor struk", a: xa, b: xb, delta: null, kind: "receipt" });
    }
    const outcome: PairOutcome = diffs.length ? "NOMINAL BERBEDA" : reasons.length ? "PERLU DITINJAU" : "COCOK";
    return { a: ra, b: rb, outcome, diffs, reasons };
  };

  const pairUp = (idxA: number[], idxB: number[]): { pairs: PairResult[]; ambiguous: boolean } => {
    if (idxA.length === 1 && idxB.length === 1) return { pairs: [comparePair(idxA[0], idxB[0])], ambiguous: false };
    const pairs: PairResult[] = [];
    const usedB = new Set<number>(), usedA = new Set<number>();
    if (idxA.length && idxB.length && idxA.length * idxB.length <= 4_000_000) {
      for (const ra of idxA) for (const rb of idxB) {
        if (usedB.has(rb)) continue;
        const p = comparePair(ra, rb);
        if (p.outcome === "COCOK") { pairs.push(p); usedA.add(ra); usedB.add(rb); break; }
      }
    }
    const restA = idxA.filter((x) => !usedA.has(x)), restB = idxB.filter((x) => !usedB.has(x));
    const n = Math.min(restA.length, restB.length);
    for (let i = 0; i < n; i++) pairs.push(comparePair(restA[i], restB[i]));
    for (let i = n; i < restA.length; i++) pairs.push({ a: restA[i], b: null, outcome: "HANYA DI FILE A", diffs: [], reasons: [] });
    for (let i = n; i < restB.length; i++) pairs.push({ a: null, b: restB[i], outcome: "HANYA DI FILE B", diffs: [], reasons: [] });
    pairs.sort((x, y) => (x.a ?? Infinity) - (y.a ?? Infinity) || (x.b ?? Infinity) - (y.b ?? Infinity));
    const ambiguous = idxA.length > 0 && idxB.length > 0 && pairs.some((p) => p.outcome !== "COCOK");
    return { pairs, ambiguous };
  };

  const summary: CompareSummary = {
    totalA: ta.rows.length - A.summaryRows, totalB: tb.rows.length - B.summaryRows, cocok: 0, berbeda: 0, onlyA: 0, onlyB: 0, duplikat: 0, review: 0,
    dupKeysA: 0, dupKeysB: 0, dupRowsA: 0, dupRowsB: 0, summaryRowsA: A.summaryRows, summaryRowsB: B.summaryRows,
    emptyKeyA: A.emptyKeyRows.length, emptyKeyB: B.emptyKeyRows.length, blankRowsA: ta.blankRows, blankRowsB: tb.blankRows,
    uniqueKeysA: A.groups.size, uniqueKeysB: B.groups.size, keysBoth: 0, keysOnlyA: 0, keysOnlyB: 0, amountDiff: 0, taxDiff: 0,
    collisionKeys: 0, reviewRows: 0,
    validA: 0, validB: 0, dupSameCount: 0, dupDiffCount: 0,
  };
  for (const l of A.groups.values()) summary.validA += l.length;
  for (const l of B.groups.values()) summary.validB += l.length;
  for (const l of A.groups.values()) if (l.length > 1) { summary.dupKeysA++; summary.dupRowsA += l.length - 1; }
  for (const l of B.groups.values()) if (l.length > 1) { summary.dupKeysB++; summary.dupRowsB += l.length - 1; }

  const describeDiff = (d: ColDiff): string => `${d.kind === "tax" ? "Tax berbeda — " : ""}${d.label}: ${d.a.trim() || "(kosong)"} → ${d.b.trim() || "(kosong)"}${d.delta !== null ? ` (selisih ${d.delta > 0 ? "+" : ""}${d.delta})` : ""}`;
  const showAmount = (t: TableData, idx: number[], col: number) => (idx.length && col >= 0 ? idx.map((r) => cell(t, r, col)).join(" | ") : idx.length ? "" : null);
  const records: CompareRecord[] = [];
  const fallbackKey = (t: TableData, r: number, side: Side) => `(tanpa kunci — File ${side} baris ${t.sourceRows[r]})`;
  let id = 0;

  const addRecord = (key: string, idxA: number[], idxB: number[], pairs: PairResult[], ambiguous: boolean, forced?: { status: CompareStatus; note: string }) => {
    let status: CompareStatus, note: string;
    const dup = idxA.length > 1 || idxB.length > 1;
    const variantsOf = (m: Map<string, Set<string>>): string[] => { const v = forced ? undefined : m.get(key); return v && v.size > 1 ? [...v] : []; };
    const collisionA = variantsOf(A.variants), collisionB = variantsOf(B.variants);
    const collisionNote = collisionA.length || collisionB.length ? ` Benturan normalisasi: penulisan berbeda menjadi identik${collisionA.length ? ` di File A (${collisionA.map((x) => `"${x}"`).join(", ")})` : ""}${collisionB.length ? ` di File B (${collisionB.map((x) => `"${x}"`).join(", ")})` : ""} — tinjau manual.` : "";
    if (forced) { status = forced.status; note = forced.note; }
    else if (dup) {
      status = "DUPLIKAT";
      // Bandingkan JUMLAH kemunculan (bukan sekadar ada/tidak ada): sama → cocok berdasarkan jumlah; beda → jumlah tidak sesuai.
      const sameCount = idxA.length === idxB.length;
      if (sameCount) summary.dupSameCount++; else summary.dupDiffCount++;
      const c = (o: PairOutcome) => pairs.filter((p) => p.outcome === o).length;
      note = `${sameCount ? `Jumlah kemunculan SAMA (${idxA.length}× di kedua file) → cocok berdasarkan jumlah.` : `Jumlah kemunculan TIDAK SESUAI.`} Muncul ${idxA.length}× di File A dan ${idxB.length}× di File B. Pemasangan: ${c("COCOK")} cocok, ${c("NOMINAL BERBEDA")} berbeda, ${c("HANYA DI FILE A")} hanya di A, ${c("HANYA DI FILE B")} hanya di B${c("PERLU DITINJAU") ? `, ${c("PERLU DITINJAU")} perlu ditinjau` : ""}.${ambiguous ? " Pemasangan ambigu — tinjau manual." : ""}${collisionNote}`;
    } else {
      const o = pairs[0].outcome;
      status = o;
      note = o === "COCOK" ? "Kunci dan nilai yang dibandingkan cocok." : o === "NOMINAL BERBEDA" ? "Kunci cocok, nilai berbeda: " + pairs[0].diffs.map(describeDiff).join("; ") + "." : o === "HANYA DI FILE A" ? "Tidak ditemukan di File B." : o === "HANYA DI FILE B" ? "Tidak ditemukan di File A." : pairs[0].reasons.join("; ") + ".";
    }
    if (status === "COCOK") summary.cocok++; else if (status === "NOMINAL BERBEDA") summary.berbeda++; else if (status === "HANYA DI FILE A") summary.onlyA++;
    else if (status === "HANYA DI FILE B") summary.onlyB++; else if (status === "DUPLIKAT") summary.duplikat++; else summary.review++;
    const firstA = idxA[0], firstB = idxB[0];
    const deltaFor = (p: AmountPair): number | null => {
      if (!idxA.length || !idxB.length) return null;
      const pa = idxA.map((r) => num(cell(ta, r, p.a), locA.get(p.a) ?? "unknown")), pb = idxB.map((r) => num(cell(tb, r, p.b), locB.get(p.b) ?? "unknown"));
      if (![...pa, ...pb].every((x) => x.state === "ok")) return null;
      return Math.round(((pb as { value: number }[]).reduce((sum, x) => sum + x.value, 0) - (pa as { value: number }[]).reduce((sum, x) => sum + x.value, 0)) * 1e6) / 1e6;
    };
    const amountA = primary ? showAmount(ta, idxA, primary.a) : null, amountB = primary ? showAmount(tb, idxB, primary.b) : null;
    const delta = primary ? deltaFor(primary) : null;
    const kinds: Partial<Record<AmountKind, KindValue>> = {};
    for (const p of cfg.amounts) {
      const k = kindOf(p);
      if (kinds[k]) continue;
      kinds[k] = { label: p.label, a: showAmount(ta, idxA, p.a), b: showAmount(tb, idxB, p.b), delta: deltaFor(p) };
    }
    const diffCols = [...new Set(pairs.flatMap((p) => p.diffs.map((d) => d.label)))];
    const isNoKey = !!forced && forced.status === "PERLU DITINJAU" && key.startsWith("(tanpa kunci");
    const amountDiff = !isNoKey && pairs.some((p) => p.diffs.some((d) => d.kind !== "date" && d.kind !== "receipt"));
    const taxDiff = !isNoKey && pairs.some((p) => p.diffs.some((d) => d.kind === "tax"));
    if (amountDiff) summary.amountDiff++;
    if (taxDiff) summary.taxDiff++;
    if (collisionA.length || collisionB.length) summary.collisionKeys++;
    if (!isNoKey) { if (idxA.length && idxB.length) summary.keysBoth++; else if (idxA.length) summary.keysOnlyA++; else summary.keysOnlyB++; }
    const rawKey = (): string => firstA !== undefined ? cell(ta, firstA, cfg.a.key).trim() : cell(tb, firstB, cfg.b.key).trim();
    const recA = firstA !== undefined ? { t: ta, r: firstA, m: cfg.a } : null, recB = firstB !== undefined ? { t: tb, r: firstB, m: cfg.b } : null;
    const src = recA ?? recB!;
    records.push({
      id: id++, key: forced ? key : rawKey() || key, status, idxA, idxB, pairs, note,
      receipt: src.m.receipt >= 0 ? cell(src.t, src.r, src.m.receipt) : "", date: src.m.date >= 0 ? cell(src.t, src.r, src.m.date) : "",
      amountA, amountB, delta, diffColumns: diffCols, ambiguousPairing: ambiguous,
      amountDiff, taxDiff, noKey: isNoKey, kinds, normKey: forced ? "" : key.split("\u0001")[0], collisionA, collisionB,
    });
  };

  onProgress?.("Menganalisis perbedaan...");
  let n = 0;
  for (const [k, idxA] of A.groups) {
    const idxB = B.groups.get(k) ?? [];
    const { pairs, ambiguous } = pairUp(idxA, idxB);
    addRecord(k, idxA, idxB, pairs, ambiguous);
    if (++n % CHUNK === 0) await yieldToUi();
  }
  for (const [k, idxB] of B.groups) {
    if (A.groups.has(k)) continue;
    const { pairs, ambiguous } = pairUp([], idxB);
    addRecord(k, [], idxB, pairs, ambiguous);
    if (++n % CHUNK === 0) await yieldToUi();
  }
  for (const r of A.emptyKeyRows) addRecord(fallbackKey(ta, r, "A"), [r], [], [{ a: r, b: null, outcome: "PERLU DITINJAU", diffs: [], reasons: ["Kunci kosong, berupa notasi ilmiah, atau nilai kunci/nominal ambigu"] }], false, { status: "PERLU DITINJAU", note: "Kunci transaksi kosong / tidak valid (atau berupa notasi ilmiah Excel yang digitnya sudah hilang, atau nominal ambigu pada mode kunci+nominal) sehingga tidak dapat dicocokkan otomatis." });
  for (const r of B.emptyKeyRows) addRecord(fallbackKey(tb, r, "B"), [], [r], [{ a: null, b: r, outcome: "PERLU DITINJAU", diffs: [], reasons: ["Kunci kosong, berupa notasi ilmiah, atau nilai kunci/nominal ambigu"] }], false, { status: "PERLU DITINJAU", note: "Kunci transaksi kosong / tidak valid (atau berupa notasi ilmiah Excel yang digitnya sudah hilang, atau nominal ambigu pada mode kunci+nominal) sehingga tidak dapat dicocokkan otomatis." });

  // total per kolom nominal — dari SELURUH transaksi (bukan preview), hanya nilai yang dapat ditafsirkan
  const totals: CompareTotals[] = cfg.amounts.map((p) => {
    const t: CompareTotals = { label: p.label, kind: kindOf(p), sumA: 0, sumB: 0, parsedA: 0, parsedB: 0, ambiguousA: 0, ambiguousB: 0 };
    let sa = 0, sb = 0;
    const acc = (tb2: TableData, col: number, loc: "id" | "en" | "unknown", skip: (r: number) => boolean, side: Side) => {
      for (let r = 0; r < tb2.rows.length; r++) {
        if (skip(r)) continue;
        const v = num(tb2.rows[r][col] ?? "", loc);
        if (v.state === "ok") { const c = Math.round(v.value * 1e4); if (side === "A") { sa += c; t.parsedA++; } else { sb += c; t.parsedB++; } }
        else if (v.state === "ambiguous") side === "A" ? t.ambiguousA++ : t.ambiguousB++;
      }
    };
    acc(ta, p.a, locA.get(p.a) ?? "unknown", (r) => isSummary(ta, r, cfg.a.key), "A");
    acc(tb, p.b, locB.get(p.b) ?? "unknown", (r) => isSummary(tb, r, cfg.b.key), "B");
    t.sumA = sa / 1e4; t.sumB = sb / 1e4;
    return t;
  });

  // Peringatan identitas: jangan sampai "semua tidak cocok" terbaca sebagai perbedaan nyata padahal kolom/format identitasnya yang tidak selaras.
  const sci = (t: TableData, col: number) => { let n = 0; for (let r = 0; r < t.rows.length; r++) if (isSciNotationKey(cell(t, r, col))) n++; return n; };
  const sciA = sci(ta, cfg.a.key), sciB = sci(tb, cfg.b.key);
  if (sciA || sciB) notes.push(`Identitas berbentuk notasi ilmiah Excel (mis. 2.0261E+12) ditemukan: ${sciA} di File A, ${sciB} di File B. Digit asli sudah hilang di file sumber dan tidak dapat dipulihkan; ekspor ulang kolom nomor struk sebagai teks.`);
  if (summary.keysBoth === 0 && summary.uniqueKeysA > 0 && summary.uniqueKeysB > 0) notes.push("Tidak ada satu pun identitas yang sama antar file. Hasil \"Hanya di File A/B\" di bawah kemungkinan besar karena kolom atau format identitas tidak selaras, BUKAN karena transaksinya berbeda. Periksa kolom identitas atau aturan normalisasi, lalu bandingkan ulang.");
  else if (summary.uniqueKeysA && summary.uniqueKeysB && summary.keysBoth / Math.min(summary.uniqueKeysA, summary.uniqueKeysB) < 0.05) notes.push(`Hanya ${summary.keysBoth.toLocaleString("id-ID")} identitas yang sama dari ${Math.min(summary.uniqueKeysA, summary.uniqueKeysB).toLocaleString("id-ID")} — sangat rendah. Pastikan kolom identitas dan formatnya benar.`);
  if (cfg.keyRule === "strict") notes.push(`Aturan pencocokan "Persis" dipakai: ${KEY_RULE_LABEL.strict}. Perbedaan spasi/koma/tanda baca akan terbaca sebagai nomor struk berbeda.`);
  if (assumedCount > 0) notes.push(`Format angka tidak dapat dipastikan dari data untuk ${assumedCount.toLocaleString("id-ID")} nilai (mis. "1.234"); nilai tersebut diasumsikan berformat Indonesia (titik = ribuan). Pilih format angka secara eksplisit jika asumsi ini salah.`);
  if (summary.summaryRowsA || summary.summaryRowsB) notes.push(`Baris ringkasan laporan dikeluarkan dari hitungan transaksi: ${summary.summaryRowsA} di File A, ${summary.summaryRowsB} di File B.`);
  if (summary.emptyKeyA || summary.emptyKeyB) notes.push(`Transaksi tanpa kunci (tidak dapat dicocokkan, berstatus PERLU DITINJAU): ${summary.emptyKeyA} di File A, ${summary.emptyKeyB} di File B.`);
  {
    // Rekonsiliasi: setiap baris transaksi tepat satu kali di hasil (kemunculan valid + tanpa kunci = total transaksi).
    const seenA = records.reduce((n, x) => n + x.idxA.length, 0), seenB = records.reduce((n, x) => n + x.idxB.length, 0);
    if (seenA !== summary.totalA || seenB !== summary.totalB || summary.validA + summary.emptyKeyA !== summary.totalA || summary.validB + summary.emptyKeyB !== summary.totalB)
      notes.push(`Rekonsiliasi TIDAK sesuai: File A ${seenA}/${summary.totalA} baris, File B ${seenB}/${summary.totalB} baris tercatat di hasil. Laporkan sebagai bug.`);
  }
  if (summary.dupSameCount) notes.push(`${summary.dupSameCount} nomor struk duplikat dengan jumlah kemunculan sama di kedua file (cocok berdasarkan jumlah).`);
  if (summary.dupDiffCount) notes.push(`${summary.dupDiffCount} nomor struk duplikat dengan jumlah kemunculan TIDAK sama di kedua file; perlu diperiksa.`);
  if (summary.dupKeysA || summary.dupKeysB) notes.push(`Kunci duplikat: ${summary.dupKeysA} di File A, ${summary.dupKeysB} di File B. Duplikat dipasangkan secara deterministik; lihat detail untuk pemasangan ambigu.`);

  // ── Perlu Ditinjau: SETIAP baris transaksi yang tidak berpasangan / duplikat / benturan / kosong / ambigu, dari File A maupun File B ──
  const review: ReviewItem[] = [];
  const sideOf = (src: Side) => (src === "A" ? { t: ta, key: cfg.a.key } : { t: tb, key: cfg.b.key });
  for (const rec of records) {
    const items = new Map<string, { source: Side; r: number; codes: Set<ReviewReason>; details: string[] }>();
    const touch = (source: Side, r: number, code: ReviewReason, detail: string) => {
      const id = `${source}${r}`; let it = items.get(id);
      if (!it) { it = { source, r, codes: new Set(), details: [] }; items.set(id, it); }
      it.codes.add(code); if (!it.details.includes(detail)) it.details.push(detail);
    };
    const nA = rec.idxA.length, nB = rec.idxB.length;
    if (rec.noKey) {
      for (const r of rec.idxA) touch("A", r, "KOSONG", "Nomor struk kosong atau tidak valid; tidak dapat dicocokkan otomatis.");
      for (const r of rec.idxB) touch("B", r, "KOSONG", "Nomor struk kosong atau tidak valid; tidak dapat dicocokkan otomatis.");
    } else {
      for (const p of rec.pairs) {
        if (p.a !== null && p.b === null) touch("A", p.a, "HANYA_A", nB === 0 ? "Tidak ditemukan pasangan di File B." : `Nomor struk ini muncul ${nA}× di File A dan ${nB}× di File B; baris ini tidak mendapat pasangan.`);
        if (p.b !== null && p.a === null) touch("B", p.b, "HANYA_B", nA === 0 ? "Tidak ditemukan pasangan di File A." : `Nomor struk ini muncul ${nA}× di File A dan ${nB}× di File B; baris ini tidak mendapat pasangan.`);
        if (p.outcome === "PERLU DITINJAU") {
          const why = p.reasons.length ? p.reasons.join("; ") : "Nilai tidak dapat dipastikan.";
          if (p.a !== null) touch("A", p.a, "AMBIGU", why);
          if (p.b !== null) touch("B", p.b, "AMBIGU", why);
        }
      }
      if (nA > 1 || nB > 1) {
        const d = `Nomor struk duplikat: ${nA}× di File A dan ${nB}× di File B; pasangan transaksi tidak dapat dipastikan.`;
        for (const r of rec.idxA) touch("A", r, "DUPLIKAT", d);
        for (const r of rec.idxB) touch("B", r, "DUPLIKAT", d);
      }
      if (rec.collisionA.length) for (const r of rec.idxA) touch("A", r, "BENTURAN", `Penulisan berbeda menjadi identik setelah normalisasi: ${rec.collisionA.map((x) => `"${x}"`).join(", ")}.`);
      if (rec.collisionB.length) for (const r of rec.idxB) touch("B", r, "BENTURAN", `Penulisan berbeda menjadi identik setelah normalisasi: ${rec.collisionB.map((x) => `"${x}"`).join(", ")}.`);
    }
    items.forEach((it) => {
      const { t, key } = sideOf(it.source);
      const receipt = cell(t, it.r, key).trim();
      review.push({ recordId: rec.id, source: it.source, row: t.sourceRows[it.r], receipt, normalized: rec.noKey ? "" : keyOf(receipt), reasons: [...it.codes], detail: it.details.join(" ") });
    });
  }
  review.sort((x, y) => (x.source === y.source ? 0 : x.source === "A" ? -1 : 1) || x.row - y.row);
  summary.reviewRows = review.length;
  return { records, summary, totals, notes, config: cfg, review };
}

export type Cell = string | number | null;
export type ExportData = { summary: Array<[string, Cell]>; header: string[]; rows: Cell[][]; pairHeader: string[]; pairRows: Cell[][]; diffHeader: string[]; diffRows: Cell[][]; reviewHeader: string[]; reviewRows: Cell[][] };

export function buildExport(res: CompareResult, ta: TableData, tb: TableData, names: { a: string; b: string }): ExportData {
  const s = res.summary, c = res.config;
  const summary: Array<[string, Cell]> = [
    ["File A", names.a], ["File B", names.b], ["Mode pencocokan", MODE_LABEL[c.mode]],
    ["Toleransi nominal", c.tolerance],
    ["Total transaksi File A", s.totalA], ["Total transaksi File B", s.totalB],
    ["Nomor struk valid File A (kemunculan)", s.validA], ["Nomor struk valid File B (kemunculan)", s.validB],
    ["Duplikat: jumlah kemunculan sama", s.dupSameCount], ["Duplikat: jumlah kemunculan berbeda", s.dupDiffCount],
    ["COCOK", s.cocok], ["NOMINAL BERBEDA", s.berbeda], ["HANYA DI FILE A", s.onlyA], ["HANYA DI FILE B", s.onlyB], ["DUPLIKAT (kunci)", s.duplikat], ["PERLU DITINJAU", s.review],
    ["Kunci duplikat di File A", s.dupKeysA], ["Kunci duplikat di File B", s.dupKeysB], ["Baris ekstra duplikat di File A", s.dupRowsA], ["Baris ekstra duplikat di File B", s.dupRowsB],
    ["Baris ringkasan dikeluarkan (A)", s.summaryRowsA], ["Baris ringkasan dikeluarkan (B)", s.summaryRowsB],
    ["Identitas unik File A", s.uniqueKeysA], ["Identitas unik File B", s.uniqueKeysB], ["Identitas ada di kedua file", s.keysBoth], ["Identitas hanya di File A (termasuk duplikat)", s.keysOnlyA], ["Identitas hanya di File B (termasuk duplikat)", s.keysOnlyB],
    ["Transaksi dengan selisih nominal", s.amountDiff], ["Transaksi dengan selisih tax/pajak", s.taxDiff],
    ["Baris Perlu Ditinjau (A+B)", s.reviewRows], ["Identitas dengan benturan normalisasi", s.collisionKeys],
    ...res.totals.flatMap((t): Array<[string, Cell]> => [[`Total ${t.label} File A`, t.sumA], [`Total ${t.label} File B`, t.sumB], [`Selisih ${t.label} (B − A)`, Math.round((t.sumB - t.sumA) * 1e4) / 1e4]]),
    ...res.notes.map((n, i): [string, Cell] => [`Catatan ${i + 1}`, n]),
  ];
  const header = ["Status", "Kunci Transaksi", "Nomor Struk", "Tanggal", "Nominal File A", "Nominal File B", "Selisih (B − A)", "Kolom Berbeda", "Baris Sumber File A", "Baris Sumber File B", "Jumlah di File A", "Jumlah di File B", "Catatan", "Tax File A", "Tax File B", "Selisih Tax (B − A)", "Total File A", "Total File B", "Selisih Total (B − A)", "Selisih Nominal", "Tax Berbeda"];
  const rows: Cell[][] = res.records.map((r) => [
    r.status, r.key, r.receipt, r.date, r.amountA, r.amountB, r.delta, r.diffColumns.join(", "),
    r.idxA.map((i) => ta.sourceRows[i]).join(", "), r.idxB.map((i) => tb.sourceRows[i]).join(", "), r.idxA.length, r.idxB.length, r.note,
    r.kinds.tax?.a ?? null, r.kinds.tax?.b ?? null, r.kinds.tax?.delta ?? null, r.kinds.total?.a ?? null, r.kinds.total?.b ?? null, r.kinds.total?.delta ?? null,
    r.amountDiff ? "YA" : "", r.taxDiff ? "YA" : "",
  ]);
  const diffHeader = ["Kunci Transaksi", "Status", "Kolom", "Nilai File A", "Nilai File B", "Selisih (B − A)", "Baris File A", "Baris File B"];
  const diffRows: Cell[][] = res.records.flatMap((r) => r.pairs.flatMap((p) => p.diffs.map((d): Cell[] => [r.key, r.status, d.label, d.a, d.b, d.delta, p.a === null ? null : ta.sourceRows[p.a], p.b === null ? null : tb.sourceRows[p.b]])));
  const reviewHeader = ["Sumber", "Nomor Struk Asli", "Nomor Struk Ternormalisasi", "Baris Sumber", "Alasan", "Keterangan"];
  const reviewRows: Cell[][] = res.review.map((i): Cell[] => [`File ${i.source}`, i.receipt, i.normalized, i.row, i.reasons.map((x) => REVIEW_REASON_LABEL[x]).join("; "), i.detail]);
  const pairHeader = ["Kunci Transaksi", "Status Utama", "Hasil Pasangan", "Baris File A", "Baris File B", "Kolom Berbeda", "Nilai File A", "Nilai File B", "Alasan Perlu Ditinjau"];
  const pairRows: Cell[][] = res.records.filter((r) => r.pairs.length > 1 || r.status === "DUPLIKAT" || r.status === "PERLU DITINJAU").flatMap((r) =>
    r.pairs.map((p): Cell[] => [r.key, r.status, p.outcome, p.a === null ? null : ta.sourceRows[p.a], p.b === null ? null : tb.sourceRows[p.b], p.diffs.map((d) => d.label).join(", "), p.diffs.map((d) => `${d.label}=${d.a}`).join("; "), p.diffs.map((d) => `${d.label}=${d.b}`).join("; "), p.reasons.join("; ")]));
  if (c.compareValues === false) {
    const dropSummary = new Set(["NOMINAL BERBEDA", "Transaksi dengan selisih nominal", "Transaksi dengan selisih tax/pajak"]);
    const dropCols = new Set(["Nominal File A", "Nominal File B", "Selisih (B − A)", "Kolom Berbeda", "Tax File A", "Tax File B", "Selisih Tax (B − A)", "Total File A", "Total File B", "Selisih Total (B − A)", "Selisih Nominal", "Tax Berbeda"]);
    const keep = header.map((h, i) => (dropCols.has(h) ? -1 : i)).filter((i) => i >= 0);
    return { summary: summary.filter(([k]) => !dropSummary.has(k)), header: keep.map((i) => header[i]), rows: rows.map((r) => keep.map((i) => r[i])), pairHeader, pairRows, diffHeader, diffRows: [], reviewHeader, reviewRows };
  }
  return { summary, header, rows, pairHeader, pairRows, diffHeader, diffRows, reviewHeader, reviewRows };
}

const guard = (v: string) => (/^[=@]/.test(v) || /^[+-][^\d.,\s]/.test(v) ? `'${v}` : v); // cegah formula injection pada CSV
export function toCsv(data: ExportData): string {
  const q = (v: Cell) => `"${(v === null ? "" : typeof v === "number" ? String(v) : guard(v)).replace(/"/g, '""')}"`;
  const lines: Cell[][] = [["RINGKASAN HASIL"], ...data.summary.map(([k, v]) => [k, v] as Cell[]), [], ["HASIL PERBANDINGAN (SELURUH TRANSAKSI)"], data.header, ...data.rows];
  if (data.diffRows.length) lines.push([], ["DETAIL SELISIH PER KOLOM"], data.diffHeader, ...data.diffRows);
  if (data.pairRows.length) lines.push([], ["DETAIL PEMASANGAN (DUPLIKAT / PERLU DITINJAU)"], data.pairHeader, ...data.pairRows);
  if (data.reviewRows.length) lines.push([], ["PERLU DITINJAU (TRANSAKSI TANPA PASANGAN, DUPLIKAT, BENTURAN, KOSONG, AMBIGU)"], data.reviewHeader, ...data.reviewRows);
  return "\ufeff" + lines.map((r) => r.map(q).join(",")).join("\r\n");
}

/** Identitas input perbandingan: berubah bila file/sheet/header/delimiter (versi tabel) atau konfigurasi berubah → hasil lama kedaluwarsa. */
export const inputSignature = (versionA: number, versionB: number, cfg: CompareConfig | null): string => JSON.stringify([versionA, versionB, cfg]);
