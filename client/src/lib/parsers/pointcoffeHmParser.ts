import { isRecord, stringValue } from "../shared/parseHelpers";
// POINTCOFFE HM (menu CEK DATA API).
// Terpisah dari parser Point Coffee di CEK UPL (CSV pipe). Sumber: JSON API
// { status, count, data: [...] }. Nilai subtotal/dpp/tax/discount/total diambil
// langsung dari sumber dan TIDAK pernah dihitung ulang.

export type PointCoffeeHmStatus = "Valid" | "Invalid";

export type PointCoffeeHmTransaction = {
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
  outletName: string | null;
  status: PointCoffeeHmStatus;
  error?: string;
  // Object asli dari sumber, tidak diubah (dipakai untuk detail transaksi).
  raw: Record<string, unknown>;
};

export type PointCoffeeHmParseResult = {
  ok: boolean;
  error?: string;
  rows: PointCoffeeHmTransaction[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  voidRows: number;
  // `count` dari API (jika ada). HANYA informasi pembanding; jumlah transaksi
  // selalu rows.length (jumlah objek aktual di array `data`).
  declaredCount: number | null;
};

export type PointCoffeeHmExtractResult =
  | { ok: true; records: Record<string, unknown>[]; declaredCount: number | null }
  | { ok: false; error: string };

export type PointCoffeeHmSummary = {
  transactionCount: number;
  subtotal: number;
  discount: number;
  dpp: number;
  tax: number;
  total: number;
};

const EMPTY_RESULT_BASE = { rows: [] as PointCoffeeHmTransaction[], totalRows: 0, validRows: 0, invalidRows: 0, voidRows: 0, declaredCount: null };
const INVALID_DATA_FIELD_MESSAGE = "Format POINTCOFFE HM tidak valid: field data tidak ditemukan atau bukan array.";

// null/undefined tetap null (tidak diubah menjadi 0). Mengembalikan null juga
// bila nilai tidak bisa dibaca sebagai angka.
function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const parsed = Number(text.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : stringValue(value);
}

// Tampilan rupiah: desimal sumber (mis. 24545.454545) tidak dibulatkan ke
// bilangan bulat; maksimal `maxFraction` digit desimal.
export function formatPointCoffeeHmRupiah(value: number, maxFraction = 2): string {
  return `Rp ${value.toLocaleString("id-ID", { minimumFractionDigits: 0, maximumFractionDigits: maxFraction })}`;
}

// Langkah 1: JSON.parse (sekali) + validasi root + ambil SEMUA objek di `data`.
// Tidak ada slice/sampling; `count` tidak dipakai untuk memotong dataset.
export function extractPointCoffeeHmRecords(input: string): PointCoffeeHmExtractResult {
  if (!input.trim()) {
    return { ok: false, error: "JSON kosong. Tempelkan data POINTCOFFE HM atau upload file .json terlebih dahulu." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { ok: false, error: "JSON tidak valid. Periksa kembali format POINTCOFFE HM." };
  }

  let data: unknown[];
  let declaredCount: number | null = null;
  if (Array.isArray(parsed)) {
    data = parsed;
  } else if (isRecord(parsed)) {
    if (typeof parsed.status === "string" && parsed.status.trim().toLowerCase() !== "ok") {
      return { ok: false, error: `Status bukan "ok" (status: "${parsed.status}"). Periksa kembali respons API.` };
    }
    if (!Array.isArray(parsed.data)) return { ok: false, error: INVALID_DATA_FIELD_MESSAGE };
    data = parsed.data;
    declaredCount = parseNumber(parsed.count);
  } else {
    return { ok: false, error: "Format POINTCOFFE HM tidak valid" };
  }

  if (data.length === 0) {
    return { ok: false, error: "Data kosong. Tidak ada transaksi POINTCOFFE HM untuk diperiksa." };
  }
  const records: Record<string, unknown>[] = [];
  for (const item of data) {
    if (!isRecord(item)) {
      return { ok: false, error: "Format JSON tidak sesuai dengan POINTCOFFE HM. Setiap elemen data harus berupa object transaksi." };
    }
    records.push(item);
  }
  const hasSignature = records.some((record) => "no_struk" in record && ("id_outlet" in record || "dpp" in record || "id_agent" in record));
  if (!hasSignature) {
    return { ok: false, error: "Format JSON tidak sesuai dengan POINTCOFFE HM. Field yang dibutuhkan antara lain: no_struk, dpp, tax, total." };
  }
  return { ok: true, records, declaredCount };
}

// Langkah 2: petakan SELURUH record. Tidak ada record yang dibuang (void,
// no_struk kembar, atau field null tetap masuk). Record dengan field wajib
// kosong tetap dihitung dan ditandai Invalid.
export function buildPointCoffeeHmResult(records: Record<string, unknown>[], declaredCount: number | null = null): PointCoffeeHmParseResult {
  const rows: PointCoffeeHmTransaction[] = new Array(records.length);
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
      serviceCharge: parseNumber(record.service_charge),
      discount: parseNumber(record.discount),
      dpp,
      tax,
      total,
      logTime: stringValue(record.log_time),
      keterangan: nullableString(record.keterangan),
      posTipe: nullableString(record.pos_tipe),
      namaUsaha: stringValue(record.nama_usaha),
      idServer: stringValue(record.id_server),
      isVoid,
      idOutlet: stringValue(record.id_outlet),
      outletName: nullableString(record.outlet_name),
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
export function parsePointCoffeeHm(input: string): PointCoffeeHmParseResult {
  const extracted = extractPointCoffeeHmRecords(input);
  if (!extracted.ok) return { ok: false, error: extracted.error, ...EMPTY_RESULT_BASE };
  return buildPointCoffeeHmResult(extracted.records, extracted.declaredCount);
}

// Peringatan bila `count` API berbeda dari jumlah objek aktual di `data`.
export function pointCoffeeHmCountWarning(result: Pick<PointCoffeeHmParseResult, "declaredCount" | "totalRows">): string | null {
  if (result.declaredCount === null || result.declaredCount === result.totalRows) return null;
  return `Peringatan: field count API = ${result.declaredCount.toLocaleString("id-ID")}, tetapi jumlah objek aktual di data = ${result.totalRows.toLocaleString("id-ID")}. Seluruh ${result.totalRows.toLocaleString("id-ID")} transaksi di data tetap diproses; mohon periksa sumber data.`;
}

// Pagination murni untuk tampilan; tidak pernah dipakai untuk summary.
export function paginatePointCoffeeHm<T>(rows: readonly T[], page: number, pageSize: number) {
  const size = Math.max(1, Math.floor(pageSize));
  const totalPages = Math.max(1, Math.ceil(rows.length / size));
  const activePage = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const startIndex = (activePage - 1) * size;
  const endIndex = Math.min(startIndex + size, rows.length);
  return { visible: rows.slice(startIndex, endIndex), activePage, totalPages, startIndex, endIndex };
}

// Ringkasan dari SELURUH transaksi (termasuk void; void tidak dibuang).
// Menjumlah nilai sumber apa adanya; null dianggap 0 hanya untuk penjumlahan
// (nilai pada baris tidak diubah). Hasil dibulatkan ke 6 desimal untuk
// membuang noise floating point.
export function summarizePointCoffeeHm(rows: readonly PointCoffeeHmTransaction[]): PointCoffeeHmSummary {
  let subtotal = 0;
  let discount = 0;
  let dpp = 0;
  let tax = 0;
  let total = 0;
  for (const row of rows) {
    subtotal += row.subtotal ?? 0;
    discount += row.discount ?? 0;
    dpp += row.dpp ?? 0;
    tax += row.tax ?? 0;
    total += row.total ?? 0;
  }
  const clean = (value: number) => Math.round(value * 1e6) / 1e6;
  return { transactionCount: rows.length, subtotal: clean(subtotal), discount: clean(discount), dpp: clean(dpp), tax: clean(tax), total: clean(total) };
}

export function pointCoffeeHmToCsv(rows: readonly PointCoffeeHmTransaction[]): string {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const num = (value: number | null) => (value === null ? "" : String(value));
  return [
    ["No", "ID", "ID Agent", "No Struk", "Date Trans", "Subtotal", "Service Charge", "Discount", "DPP", "Tax", "Total", "Log Time", "Keterangan", "Pos Tipe", "Nama Usaha", "ID Server", "Void", "ID Outlet", "Outlet Name", "Status"],
    ...rows.map((row, index) => [
      String(index + 1),
      row.id,
      row.idAgent,
      row.noStruk,
      row.dateTrans,
      num(row.subtotal),
      num(row.serviceCharge),
      num(row.discount),
      num(row.dpp),
      num(row.tax),
      num(row.total),
      row.logTime,
      row.keterangan ?? "",
      row.posTipe ?? "",
      row.namaUsaha,
      row.idServer,
      row.isVoid ? "1" : "0",
      row.idOutlet,
      row.outletName ?? "",
      row.status,
    ]),
  ].map((line) => line.map(escape).join(",")).join("\n");
}
