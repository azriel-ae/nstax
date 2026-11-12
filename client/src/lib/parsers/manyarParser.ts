import { isRecord, numberToPlain, stringValue } from "../shared/parseHelpers";

// Parser MANYAR: satu array JSON berisi ribuan transaksi HOTEL (NoBill FL…) dan RESTO (NoBill SL…).
// Angka dijumlahkan sebagai BigInt berskala (bukan float, bukan parseInt, tanpa pembulatan per record),
// sehingga total sama persis dengan penjumlahan desimal dari data sumber.

export const MANYAR_REQUIRED_FIELDS = ["Date", "Product", "NoBill", "Gross", "Service", "Tax", "Nett"] as const;
export const MANYAR_MONEY_FIELDS = ["Gross", "Service", "Tax", "Nett"] as const;
type MoneyField = (typeof MANYAR_MONEY_FIELDS)[number];

export type ManyarCategory = "HOTEL" | "RESTO" | "UNKNOWN";
export type ManyarFilter = "ALL" | "HOTEL" | "RESTO";
export type ManyarStatus = "Valid" | "Nilai invalid" | "Kategori tidak dikenal";

/** Presisi maksimum data sumber yang diterima (digit desimal). Lebih dari ini ditandai invalid, bukan dipotong diam-diam. */
export const MANYAR_MAX_DECIMALS = 8;
const SCALE = 10n ** BigInt(MANYAR_MAX_DECIMALS);

/** Nilai uang eksak: `scaled` = nilai × 10^8; `decimals` = jumlah digit desimal pada sumber. */
export type ManyarMoney = { scaled: bigint; decimals: number };

export type ManyarRow = {
  /** Urutan record pada array sumber (0-based). */
  index: number;
  date: string;
  product: string;
  noBill: string | null;
  category: ManyarCategory;
  gross: ManyarMoney | null;
  service: ManyarMoney | null;
  tax: ManyarMoney | null;
  nett: ManyarMoney | null;
  /** true bila semua nilai wajib terisi dan valid. */
  valuesValid: boolean;
  status: ManyarStatus;
  errors: string[];
  raw: unknown;
};

export type ManyarValidation = {
  totalRecords: number;
  hotelRecords: number;
  restoRecords: number;
  /** NoBill kosong / bukan FL atau SL. */
  unknownCategory: number;
  /** Record (kategori apa pun) dengan nilai wajib kosong/tidak valid. */
  invalidValues: number;
  /** Subset invalidValues yang kategorinya dikenal (HOTEL/RESTO). */
  invalidKnownCategory: number;
  /** Subset invalidValues yang kategorinya juga tidak dikenal. */
  invalidUnknownCategory: number;
  /** Record kategori dikenal dengan nilai valid → ikut total. */
  includedRecords: number;
};

export type ManyarParseResult = {
  ok: boolean;
  error?: string;
  rows: ManyarRow[];
  validation: ManyarValidation;
  /** Digit desimal terbanyak pada nilai valid (minimal 0); dipakai untuk format tampilan. */
  maxDecimals: number;
};

export type ManyarSummary = {
  filter: ManyarFilter;
  transactionCount: number;
  gross: bigint;
  service: bigint;
  tax: bigint;
  nett: bigint;
  /** Digit desimal untuk menampilkan total (≥ 2, ≥ presisi data). */
  decimals: number;
};

const emptyValidation = (): ManyarValidation => ({ totalRecords: 0, hotelRecords: 0, restoRecords: 0, unknownCategory: 0, invalidValues: 0, invalidKnownCategory: 0, invalidUnknownCategory: 0, includedRecords: 0 });
const failure = (error: string): ManyarParseResult => ({ ok: false, error, rows: [], validation: emptyValidation(), maxDecimals: 0 });

/**
 * Kategori dari NoBill: trim + huruf besar, lalu cek prefix FL / SL.
 * Pemisah setelah prefix (titik, tanda hubung, atau tidak ada) sengaja tidak diperiksa.
 */
export function classifyManyarNoBill(noBill: unknown): ManyarCategory {
  const normalized = stringValue(noBill).toUpperCase();
  if (normalized.startsWith("FL")) return "HOTEL";
  if (normalized.startsWith("SL")) return "RESTO";
  return "UNKNOWN";
}

/**
 * Pola NoBill yang lebih ketat khusus untuk DETEKSI otomatis (V2):
 * FL/SL + (titik | tanda hubung | spasi | tanpa pemisah) + digit. Menghindari kata biasa seperti "FLOWER-1".
 */
export function looksLikeManyarNoBill(noBill: unknown): boolean {
  if (typeof noBill !== "string") return false;
  return /^(FL|SL)[.\-\s]?\d/i.test(noBill.trim());
}

/** String/angka desimal → nilai eksak, atau null bila kosong/tidak valid. Tidak ada pembulatan. */
export function parseManyarMoney(value: unknown): ManyarMoney | null {
  let text: string;
  if (typeof value === "number") {
    const plain = numberToPlain(value);
    if (plain === null) return null;
    text = plain;
  } else if (typeof value === "string") {
    text = value.trim().replace(/^rp\.?\s*/i, "").replace(/\s/g, "");
  } else return null;
  if (!text) return null;
  // Konvensi sama dengan parser ASTANA: bila ada titik, koma = pemisah ribuan; bila tidak, koma = desimal.
  const normalized = text.includes(".") ? text.replace(/,/g, "") : text.replace(",", ".");
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(normalized);
  if (!match) return null;
  const [, sign, whole, frac = ""] = match;
  if (!whole && !frac) return null;
  if (frac.length > MANYAR_MAX_DECIMALS) return null;
  const magnitude = BigInt(whole || "0") * SCALE + BigInt(frac.padEnd(MANYAR_MAX_DECIMALS, "0") || "0");
  return { scaled: sign === "-" ? -magnitude : magnitude, decimals: frac.length };
}

/** Format id-ID eksak dari BigInt berskala, tanpa float. `decimals` ≤ 8. */
export function formatManyarAmount(scaled: bigint, decimals = 2): string {
  const d = Math.min(Math.max(decimals, 0), MANYAR_MAX_DECIMALS);
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const divisor = 10n ** BigInt(MANYAR_MAX_DECIMALS - d);
  const units = abs / divisor; // pemotongan hanya membuang digit nol di luar presisi data
  const unitsText = units.toString().padStart(d + 1, "0");
  const intPart = unitsText.slice(0, unitsText.length - d).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const fracPart = d ? `,${unitsText.slice(unitsText.length - d)}` : "";
  return `${negative && units !== 0n ? "-" : ""}${intPart}${fracPart}`;
}

export function formatManyarRupiah(scaled: bigint, decimals = 2): string {
  return `Rp ${formatManyarAmount(scaled, decimals)}`;
}

/** Tampilan nilai per record: minimal 2 desimal, atau sebanyak presisi nilai itu sendiri. */
export function formatManyarRowMoney(money: ManyarMoney | null): string {
  return money === null ? "—" : formatManyarRupiah(money.scaled, Math.max(2, money.decimals));
}

export function parseManyar(input: string): ManyarParseResult {
  if (!input.trim()) return failure("JSON kosong. Tempelkan data MANYAR atau upload file .json terlebih dahulu.");
  let root: unknown;
  try {
    root = JSON.parse(input);
  } catch (e) {
    return failure(`JSON tidak valid. Periksa kembali format MANYAR (${e instanceof Error ? e.message : "kesalahan sintaks"}).`);
  }
  if (!Array.isArray(root)) return failure("Format JSON tidak sesuai dengan MANYAR: data harus berupa array transaksi.");
  if (root.length === 0) return failure("Array kosong: tidak ada transaksi MANYAR untuk dibaca.");

  const validation = emptyValidation();
  let maxDecimals = 0;
  const rows: ManyarRow[] = root.map((item, index) => {
    if (!isRecord(item)) {
      validation.totalRecords++;
      validation.unknownCategory++;
      validation.invalidValues++;
      validation.invalidUnknownCategory++;
      return { index, date: "", product: "", noBill: null, category: "UNKNOWN" as const, gross: null, service: null, tax: null, nett: null, valuesValid: false, status: "Nilai invalid" as const, errors: ["Record bukan object JSON"], raw: item };
    }
    const date = stringValue(item.Date);
    const product = stringValue(item.Product);
    const noBillText = stringValue(item.NoBill);
    const category = classifyManyarNoBill(item.NoBill);
    const money = {} as Record<MoneyField, ManyarMoney | null>;
    for (const f of MANYAR_MONEY_FIELDS) money[f] = parseManyarMoney(item[f]);

    const errors: string[] = [];
    const missing: string[] = [];
    if (!date) missing.push("Date");
    if (!product) missing.push("Product");
    for (const f of MANYAR_MONEY_FIELDS) if (money[f] === null) missing.push(f);
    if (missing.length) errors.push(`Field wajib kosong/tidak valid: ${missing.join(", ")}`);
    if (category === "UNKNOWN") errors.push(noBillText ? `NoBill "${noBillText}" tidak berawalan FL atau SL` : "NoBill kosong");

    const valuesValid = missing.length === 0;
    const status: ManyarStatus = !valuesValid ? "Nilai invalid" : category === "UNKNOWN" ? "Kategori tidak dikenal" : "Valid";

    validation.totalRecords++;
    if (category === "HOTEL") validation.hotelRecords++;
    else if (category === "RESTO") validation.restoRecords++;
    else validation.unknownCategory++;
    if (!valuesValid) {
      validation.invalidValues++;
      if (category === "UNKNOWN") validation.invalidUnknownCategory++;
      else validation.invalidKnownCategory++;
    } else if (category !== "UNKNOWN") {
      validation.includedRecords++;
      for (const f of MANYAR_MONEY_FIELDS) maxDecimals = Math.max(maxDecimals, money[f]!.decimals);
    }
    return { index, date, product, noBill: item.NoBill == null ? null : noBillText, category, gross: money.Gross, service: money.Service, tax: money.Tax, nett: money.Nett, valuesValid, status, errors, raw: item };
  });
  return { ok: true, rows, validation, maxDecimals };
}

/** Baris yang tampil pada tabel untuk satu filter (ALL = semua record, termasuk yang tidak dikenal/invalid agar terlihat). */
export function filterManyarRows(rows: ManyarRow[], filter: ManyarFilter): ManyarRow[] {
  return filter === "ALL" ? rows : rows.filter((r) => r.category === filter);
}

/** Ringkasan: hanya record kategori dikenal + nilai valid. ALL = HOTEL + RESTO. Tidak memodifikasi `rows`. */
export function summarizeManyar(rows: ManyarRow[], filter: ManyarFilter = "ALL", maxDecimals = 0): ManyarSummary {
  let count = 0;
  let gross = 0n;
  let service = 0n;
  let tax = 0n;
  let nett = 0n;
  for (const r of rows) {
    if (!r.valuesValid || r.category === "UNKNOWN") continue;
    if (filter !== "ALL" && r.category !== filter) continue;
    count++;
    gross += r.gross!.scaled;
    service += r.service!.scaled;
    tax += r.tax!.scaled;
    nett += r.nett!.scaled;
  }
  return { filter, transactionCount: count, gross, service, tax, nett, decimals: Math.max(2, maxDecimals) };
}

export function manyarToCsv(rows: ManyarRow[]): string {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const plain = (m: ManyarMoney | null) => (m === null ? "" : formatPlain(m));
  return [
    ["No", "Date", "Product", "NoBill", "Kategori", "Gross", "Service", "Tax", "Nett", "Status", "Catatan"],
    ...rows.map((row, i) => [String(i + 1), row.date, row.product, row.noBill ?? "-", row.category === "UNKNOWN" ? "TIDAK DIKENAL" : row.category, plain(row.gross), plain(row.service), plain(row.tax), plain(row.nett), row.status, row.errors.join("; ")]),
  ].map((line) => line.map(escape).join(",")).join("\n");
}

/** Desimal polos (titik desimal, tanpa pemisah ribuan) sesuai presisi sumber, untuk CSV. */
function formatPlain(m: ManyarMoney): string {
  const negative = m.scaled < 0n;
  const abs = negative ? -m.scaled : m.scaled;
  const divisor = 10n ** BigInt(MANYAR_MAX_DECIMALS - m.decimals);
  const text = (abs / divisor).toString().padStart(m.decimals + 1, "0");
  const body = m.decimals ? `${text.slice(0, text.length - m.decimals)}.${text.slice(text.length - m.decimals)}` : text;
  return `${negative && abs !== 0n ? "-" : ""}${body}`;
}
