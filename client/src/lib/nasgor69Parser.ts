export const NASGOR69_REQUIRED_FIELDS = ["id", "no_struk", "date_trans", "subtotal", "dpp", "tax", "total"] as const;
export type Nasgor69Status = "Valid" | "Invalid";

export type Nasgor69Transaction = {
  id: string;
  idAgent: string;
  noStruk: string;
  dateTrans: string;
  subtotal: number | null;
  serviceCharge: number | null;
  discount: number | null;
  dpp: number | null;
  tax: number | null;
  total: number | null;
  logTime: string;
  keterangan: string | null;
  posTipe: string | null;
  namaUsaha: string;
  idServer: string;
  isVoid: boolean;
  idOutlet: string;
  outletName: string;
  status: Nasgor69Status;
  error?: string;
  raw: Record<string, unknown>;
};

export type Nasgor69ParseResult = {
  ok: boolean;
  error?: string;
  rows: Nasgor69Transaction[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  voidRows: number;
  // Metadata `count` dari API (jika ada). HANYA informasi — tidak pernah dipakai
  // sebagai batas atau jumlah dataset. Jumlah transaksi selalu rows.length.
  declaredCount: number | null;
};

export type Nasgor69ExtractResult =
  | { ok: true; records: Record<string, unknown>[]; declaredCount: number | null }
  | { ok: false; error: string };

export type Nasgor69Summary = {
  transactionCount: number;
  subtotal: number;
  dpp: number;
  tax: number;
  total: number;
};

const EMPTY_RESULT_BASE = { rows: [] as Nasgor69Transaction[], totalRows: 0, validRows: 0, invalidRows: 0, voidRows: 0, declaredCount: null };
const INVALID_DATA_FIELD_MESSAGE = "Format NASGOR 69 tidak valid: field data tidak ditemukan atau bukan array.";

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function stringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

// Accepts null, "", 0, numbers, decimal numbers, and numeric strings.
// Returns null only when the value cannot be read as a number at all.
function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const normalized = text.replace(/,/g, "");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function formatNasgor69Rupiah(value: number): string {
  return `Rp ${Math.round(value).toLocaleString("id-ID")}`;
}

// Langkah 1: JSON.parse (sekali saja) + validasi root + ambil dataset dari `data`.
// Root resmi NASGOR 69 adalah object { status, count, data: [...] }.
// Array transaksi polos tetap diterima demi kompatibilitas input lama.
// TIDAK ada slice/sampling dan `count` tidak dipakai untuk memotong dataset.
export function extractNasgor69Records(input: string): Nasgor69ExtractResult {
  if (!input.trim()) {
    return { ok: false, error: "JSON kosong. Tempelkan data NASGOR 69 atau upload file .json terlebih dahulu." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { ok: false, error: "JSON tidak valid. Periksa kembali format NASGOR 69." };
  }

  let data: unknown[];
  let declaredCount: number | null = null;
  if (Array.isArray(parsed)) {
    data = parsed;
  } else if (isRecord(parsed)) {
    if (typeof parsed.status === "string" && parsed.status.trim().toLowerCase() !== "ok") {
      return { ok: false, error: `Status NASGOR 69 bukan "ok" (status: "${parsed.status}"). Periksa kembali respons API.` };
    }
    if (!Array.isArray(parsed.data)) {
      return { ok: false, error: INVALID_DATA_FIELD_MESSAGE };
    }
    data = parsed.data;
    declaredCount = parseNumber(parsed.count);
  } else {
    return { ok: false, error: "Format NASGOR 69 tidak valid" };
  }

  if (data.length === 0) {
    return { ok: false, error: "Data kosong. Tidak ada transaksi NASGOR 69 untuk diperiksa." };
  }
  const records: Record<string, unknown>[] = [];
  for (const item of data) {
    if (!isRecord(item)) {
      return { ok: false, error: "Format JSON tidak sesuai dengan CEK NASGOR 69. Setiap elemen data harus berupa object transaksi." };
    }
    records.push(item);
  }
  const hasSignature = records.some((record) => "no_struk" in record && ("id_outlet" in record || "dpp" in record || "id_agent" in record));
  if (!hasSignature) {
    return { ok: false, error: "Format JSON tidak sesuai dengan CEK NASGOR 69. Field yang dibutuhkan antara lain: no_struk, dpp, tax, total." };
  }
  return { ok: true, records, declaredCount };
}

// Langkah 2: petakan SELURUH record menjadi allTransactions. Semua field
// dipertahankan (lihat `raw`); nilai tax/total tidak pernah dihitung ulang.
export function buildNasgor69Result(records: Record<string, unknown>[], declaredCount: number | null = null): Nasgor69ParseResult {
  const rows: Nasgor69Transaction[] = new Array(records.length);
  let validRows = 0;
  let invalidRows = 0;
  let voidRows = 0;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const id = stringValue(record.id);
    const noStruk = stringValue(record.no_struk);
    const dateTrans = stringValue(record.date_trans);
    const subtotal = parseNumber(record.subtotal);
    const dpp = parseNumber(record.dpp);
    const tax = parseNumber(record.tax);
    const total = parseNumber(record.total);
    const serviceCharge = parseNumber(record.service_charge);
    const discount = parseNumber(record.discount);
    const voidValue = record.void;
    const isVoid = voidValue === 1 || voidValue === "1" || voidValue === true;

    const missing: string[] = [];
    if (!id) missing.push("id");
    if (!noStruk) missing.push("no_struk");
    if (!dateTrans) missing.push("date_trans");
    if (subtotal === null) missing.push("subtotal");
    if (dpp === null) missing.push("dpp");
    if (tax === null) missing.push("tax");
    if (total === null) missing.push("total");

    const base = {
      id,
      idAgent: stringValue(record.id_agent),
      noStruk,
      dateTrans,
      subtotal,
      serviceCharge,
      discount,
      dpp,
      tax,
      total,
      logTime: stringValue(record.log_time),
      keterangan: record.keterangan === null || record.keterangan === undefined ? null : stringValue(record.keterangan),
      posTipe: record.pos_tipe === null || record.pos_tipe === undefined ? null : stringValue(record.pos_tipe),
      namaUsaha: stringValue(record.nama_usaha),
      idServer: stringValue(record.id_server),
      isVoid,
      idOutlet: stringValue(record.id_outlet),
      outletName: stringValue(record.outlet_name),
      raw: record,
    };

    if (isVoid) voidRows += 1;
    if (missing.length) {
      invalidRows += 1;
      rows[index] = { ...base, status: "Invalid", error: `Field wajib kosong/tidak valid: ${missing.join(", ")}` };
    } else {
      validRows += 1;
      rows[index] = { ...base, status: "Valid" };
    }
  }

  return { ok: true, rows, totalRows: rows.length, validRows, invalidRows, voidRows, declaredCount };
}

// Satu-satunya jalur parsing: dipakai bersama oleh upload file dan paste JSON.
export function parseNasgor69(input: string): Nasgor69ParseResult {
  const extracted = extractNasgor69Records(input);
  if (!extracted.ok) return { ok: false, error: extracted.error, ...EMPTY_RESULT_BASE };
  return buildNasgor69Result(extracted.records, extracted.declaredCount);
}

// Pagination murni untuk tampilan. Tidak pernah dipakai untuk perhitungan summary.
export function paginateNasgor69<T>(rows: readonly T[], page: number, pageSize: number) {
  const size = Math.max(1, Math.floor(pageSize));
  const totalPages = Math.max(1, Math.ceil(rows.length / size));
  const activePage = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const startIndex = (activePage - 1) * size;
  const endIndex = Math.min(startIndex + size, rows.length);
  return { visible: rows.slice(startIndex, endIndex), activePage, totalPages, startIndex, endIndex };
}

// Ringkasan dihitung dari SELURUH transaksi (allTransactions), bukan dari
// halaman/filter tampilan. Memakai subtotal/dpp/tax/total persis seperti data
// API (tanpa hitung ulang); nilai null dianggap 0 untuk agregasi. Nilai pada
// baris asli tidak pernah diubah.
export function summarizeNasgor69(rows: readonly Nasgor69Transaction[]): Nasgor69Summary {
  let subtotal = 0;
  let dpp = 0;
  let tax = 0;
  let total = 0;
  for (const row of rows) {
    subtotal += row.subtotal ?? 0;
    dpp += row.dpp ?? 0;
    tax += row.tax ?? 0;
    total += row.total ?? 0;
  }
  return { transactionCount: rows.length, subtotal, dpp, tax, total };
}

export function nasgor69ToCsv(rows: readonly Nasgor69Transaction[]): string {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const money = (value: number | null) => (value === null ? "" : String(value));
  return [
    ["No", "ID", "ID Agent", "No Struk", "Date Trans", "Subtotal", "Service Charge", "Discount", "DPP", "Tax", "Total", "Void", "ID Server", "ID Outlet", "Outlet Name", "Nama Usaha", "Status"],
    ...rows.map((row, index) => [
      String(index + 1),
      row.id,
      row.idAgent,
      row.noStruk,
      row.dateTrans,
      money(row.subtotal),
      money(row.serviceCharge),
      money(row.discount),
      money(row.dpp),
      money(row.tax),
      money(row.total),
      row.isVoid ? "1" : "0",
      row.idServer,
      row.idOutlet,
      row.outletName,
      row.namaUsaha,
      row.status,
    ]),
  ].map((line) => line.map(escape).join(",")).join("\n");
}
