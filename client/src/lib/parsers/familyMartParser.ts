import { isRecord } from "../shared/parseHelpers";
// CEK DATA FAMILY MART (menu CEK DATA API).
// Port ke TypeScript dari logika filter_transaksi_json.html: parse JSON (array langsung
// atau { data: [...] }), ekstraksi prefix no_struk (teks sebelum "-" pertama), filter
// per prefix, serta format Rupiah/tanggal. Nilai sumber tidak pernah dihitung ulang
// atau diubah; setiap elemen array dipertahankan apa adanya di `raw`.

export type FamilyMartRow = {
  /** Urutan elemen pada array sumber (0-based). */
  index: number;
  /** Elemen asli dari sumber, tidak dimodifikasi. */
  raw: unknown;
  idAgent: unknown;
  noStruk: unknown;
  dateTrans: unknown;
  namaUsaha: unknown;
  total: unknown;
};

export type FamilyMartExtractResult =
  | { ok: true; records: unknown[] }
  | { ok: false; error: string };

export const FAMILY_MART_ALL = "all";

export const FAMILY_MART_ERRORS = {
  empty: "Mohon masukkan data JSON terlebih dahulu.",
  format: "Format JSON tidak dikenali. Pastikan struktur data berupa Array atau object memiliki properti 'data'.",
  noData: "Data kosong.",
  invalidJson: (detail: string) => `Gagal membaca JSON: ${detail}`,
} as const;

/** Membaca JSON (array langsung atau object dengan properti `data` berupa array). */
export function extractFamilyMartRecords(rawJson: string): FamilyMartExtractResult {
  const text = rawJson.trim();
  if (!text) return { ok: false, error: FAMILY_MART_ERRORS.empty };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: FAMILY_MART_ERRORS.invalidJson(error instanceof Error ? error.message : String(error)) };
  }

  let records: unknown[];
  if (isRecord(parsed) && Array.isArray(parsed.data)) records = parsed.data;
  else if (Array.isArray(parsed)) records = parsed;
  else return { ok: false, error: FAMILY_MART_ERRORS.format };

  if (records.length === 0) return { ok: false, error: FAMILY_MART_ERRORS.noData };
  return { ok: true, records };
}

/** Membungkus setiap elemen sebagai baris tampilan. Elemen non-object tetap dihitung (field kosong). */
export function buildFamilyMartRows(records: unknown[]): FamilyMartRow[] {
  return records.map((raw, index) => {
    const rec = isRecord(raw) ? raw : {};
    return {
      index,
      raw,
      idAgent: rec.id_agent,
      noStruk: rec.no_struk,
      dateTrans: rec.date_trans,
      namaUsaha: rec.nama_usaha,
      total: rec.total,
    };
  });
}

/** Teks sebelum "-" pertama; null bila no_struk bukan string. */
export function familyMartPrefixOf(noStruk: unknown): string | null {
  return typeof noStruk === "string" ? noStruk.split("-")[0] : null;
}

/** Prefix unik (non-kosong), diurut dengan sort() bawaan seperti referensi. */
export function extractFamilyMartPrefixes(rows: FamilyMartRow[]): string[] {
  const unique = new Set<string>();
  for (const row of rows) {
    if (row.noStruk && typeof row.noStruk === "string") {
      const prefix = row.noStruk.split("-")[0];
      if (prefix) unique.add(prefix);
    }
  }
  return Array.from(unique).sort();
}

/** "all" mengembalikan semua baris (termasuk yang tanpa no_struk valid). */
export function filterFamilyMartRows(rows: FamilyMartRow[], prefix: string): FamilyMartRow[] {
  if (prefix === FAMILY_MART_ALL) return rows;
  return rows.filter((row) => {
    if (!row.noStruk || typeof row.noStruk !== "string") return false;
    return familyMartPrefixOf(row.noStruk) === prefix;
  });
}

/** Pisahkan no_struk untuk penekanan visual prefix; null bila tidak ada "-". Nilai asli tidak berubah. */
export function splitFamilyMartNoStruk(noStruk: unknown): { prefix: string; rest: string } | null {
  if (typeof noStruk !== "string" || !noStruk.includes("-")) return null;
  const parts = noStruk.split("-");
  return { prefix: parts[0], rest: parts.slice(1).join("-") };
}

/** Nilai teks tabel: nilai falsy ditampilkan "-" seperti referensi. */
export function familyMartText(value: unknown): string {
  if (!value) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

const rupiahFormatter = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", minimumFractionDigits: 0 });

/** null/undefined -> "-"; angka (atau string numerik) -> Rupiah; selain itu ditampilkan apa adanya. */
export function formatFamilyMartRupiah(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "number") return Number.isFinite(value) ? rupiahFormatter.format(value) : String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "" && Number.isFinite(Number(trimmed))) return rupiahFormatter.format(Number(trimmed));
    return value === "" ? "-" : value;
  }
  return familyMartText(value);
}

const dateFormatter = new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** Tanggal lokal Indonesia; nilai kosong -> "-"; tidak valid -> teks asli. */
export function formatFamilyMartDate(value: unknown): string {
  if (!value) return "-";
  const text = typeof value === "string" ? value : familyMartText(value);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return dateFormatter.format(date);
}

// Ringkasan transaksi. Dihitung dari `rows` yang SUDAH difilter (hasil
// filterFamilyMartRows) sehingga tabel dan ringkasan memakai kumpulan yang sama.
// Nilai `total`/`tax` diambil apa adanya dari JSON sumber: tidak dihitung ulang,
// tidak diturunkan dari field lain, dan field yang hilang/tidak valid TIDAK dianggap 0.

export type FamilyMartAmountSummary = {
  /** Jumlah record dengan nilai numerik valid. */
  validCount: number;
  /** Jumlah record tanpa nilai numerik valid (hilang, null, kosong, atau bukan angka). */
  missingCount: number;
  /** Jumlah dari nilai valid saja. */
  sum: number;
};

export type FamilyMartSummary = {
  /** Jumlah record pada kumpulan yang dihitung. */
  transactionCount: number;
  /** Jumlah no_struk unik (string non-kosong). */
  uniqueReceiptCount: number;
  total: FamilyMartAmountSummary;
  tax: FamilyMartAmountSummary;
};

/** Angka valid: number terhingga atau string numerik non-kosong (sama dengan aturan formatFamilyMartRupiah). */
export function parseFamilyMartAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function summarizeAmounts(values: unknown[]): FamilyMartAmountSummary {
  const summary: FamilyMartAmountSummary = { validCount: 0, missingCount: 0, sum: 0 };
  for (const value of values) {
    const amount = parseFamilyMartAmount(value);
    if (amount === null) summary.missingCount += 1;
    else {
      summary.validCount += 1;
      summary.sum += amount;
    }
  }
  return summary;
}

/** Field `tax` dibaca dari elemen sumber asli (tidak ada di FamilyMartRow); elemen non-object -> undefined. */
const familyMartTaxOf = (row: FamilyMartRow): unknown => (isRecord(row.raw) ? row.raw.tax : undefined);

export function summarizeFamilyMartRows(filteredRows: FamilyMartRow[]): FamilyMartSummary {
  const receipts = new Set<string>();
  for (const row of filteredRows) {
    if (row.noStruk && typeof row.noStruk === "string") receipts.add(row.noStruk);
  }
  return {
    transactionCount: filteredRows.length,
    uniqueReceiptCount: receipts.size,
    total: summarizeAmounts(filteredRows.map((row) => row.total)),
    tax: summarizeAmounts(filteredRows.map(familyMartTaxOf)),
  };
}
