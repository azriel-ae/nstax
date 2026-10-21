import { isRecord, stringValue } from "../shared/parseHelpers";
// HANGRY SDA (menu CEK DATA API / BACA DATA APITRANS).
// Sumber: JSON API { status, count, data: [...] }. Nilai subtotal/dpp/tax/total diambil
// dari sumber apa adanya dan TIDAK pernah dihitung ulang (total tidak diganti subtotal + tax,
// dpp tidak diasumsikan sama dengan subtotal).
//
// Identitas: id_agent "hangry_sda" (dibandingkan setelah trim + huruf kecil). nama_usaha
// "Hangry Sidoarjo" hanya penguat; bila keduanya ada dan bertentangan, record ditolak.

export const HANGRY_SDA_AGENT = "hangry_sda";
export const HANGRY_SDA_NAMA_USAHA = "hangry sidoarjo";

export type HangrySdaStatus = "Valid" | "Invalid";

export type HangrySdaTransaction = {
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
  status: HangrySdaStatus;
  error?: string;
  // Object asli dari sumber, tidak diubah (dipakai untuk detail transaksi).
  raw: Record<string, unknown>;
};

export type HangrySdaParseResult = {
  ok: boolean;
  error?: string;
  rows: HangrySdaTransaction[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  voidRows: number;
  // `count` dari API (jika ada). HANYA pembanding; jumlah transaksi selalu rows.length.
  declaredCount: number | null;
};

export type HangrySdaExtractResult =
  | { ok: true; records: Record<string, unknown>[]; declaredCount: number | null }
  | { ok: false; error: string };

export type HangrySdaAmountSummary = {
  /** Jumlah dari nilai numerik valid saja (null/hilang TIDAK dianggap 0). */
  sum: number;
  /** Jumlah record yang punya nilai valid. */
  validCount: number;
  /** Jumlah record tanpa nilai valid (null, hilang, atau bukan angka). */
  missingCount: number;
};

export type HangrySdaSummaryBlock = {
  transactionCount: number;
  subtotal: HangrySdaAmountSummary;
  serviceCharge: HangrySdaAmountSummary;
  discount: HangrySdaAmountSummary;
  dpp: HangrySdaAmountSummary;
  tax: HangrySdaAmountSummary;
  total: HangrySdaAmountSummary;
};

export type HangrySdaSummary = {
  /** Seluruh transaksi di data (void dan non-void). */
  all: HangrySdaSummaryBlock;
  /** Hanya void = 0. Disediakan karena perlakuan void belum dikonfirmasi; tidak ada yang dibuang. */
  nonVoid: HangrySdaSummaryBlock;
  /** Hanya void = 1. */
  voided: HangrySdaSummaryBlock;
};

const EMPTY_RESULT_BASE = { rows: [] as HangrySdaTransaction[], totalRows: 0, validRows: 0, invalidRows: 0, voidRows: 0, declaredCount: null };
const INVALID_DATA_FIELD_MESSAGE = "Format HANGRY SDA tidak valid: field data tidak ditemukan atau bukan array.";

/** Normalisasi identitas: trim + huruf kecil + spasi berulang jadi satu. */
export const normalizeIdentity = (value: unknown): string => (typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : "");

// null/undefined/"" tetap null (tidak diubah menjadi 0). Null juga bila bukan angka.
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

// Desimal sumber tidak dibulatkan ke bilangan bulat; maksimal `maxFraction` digit desimal.
export function formatHangrySdaRupiah(value: number, maxFraction = 2): string {
  return `Rp ${value.toLocaleString("id-ID", { minimumFractionDigits: 0, maximumFractionDigits: maxFraction })}`;
}

/** true bila record memakai identitas Hangry SDA (id_agent atau nama_usaha). */
export function isHangrySdaIdentity(record: Record<string, unknown>): boolean {
  return normalizeIdentity(record.id_agent) === HANGRY_SDA_AGENT || normalizeIdentity(record.nama_usaha) === HANGRY_SDA_NAMA_USAHA;
}

// Langkah 1: JSON.parse (sekali) + validasi root + status + identitas + ambil SEMUA objek di `data`.
// Tidak ada slice/sampling; `count` tidak dipakai untuk memotong dataset.
export function extractHangrySdaRecords(input: string): HangrySdaExtractResult {
  if (!input.trim()) {
    return { ok: false, error: "JSON kosong. Tempelkan data HANGRY SDA atau upload file .json terlebih dahulu." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { ok: false, error: "JSON tidak valid. Periksa kembali format HANGRY SDA." };
  }

  let data: unknown[];
  let declaredCount: number | null = null;
  if (Array.isArray(parsed)) {
    data = parsed;
  } else if (isRecord(parsed)) {
    // status diperiksa SEBELUM data diproses.
    if (typeof parsed.status === "string" && parsed.status.trim().toLowerCase() !== "ok") {
      return { ok: false, error: `Status HANGRY SDA bukan "ok" (status: "${parsed.status}"). Periksa kembali respons API.` };
    }
    if (!Array.isArray(parsed.data)) return { ok: false, error: INVALID_DATA_FIELD_MESSAGE };
    data = parsed.data;
    declaredCount = parseNumber(parsed.count);
  } else {
    return { ok: false, error: "Format HANGRY SDA tidak valid" };
  }

  if (data.length === 0) {
    return { ok: false, error: "Data kosong. Tidak ada transaksi HANGRY SDA untuk diperiksa." };
  }
  const records: Record<string, unknown>[] = [];
  for (const item of data) {
    if (!isRecord(item)) {
      return { ok: false, error: "Format JSON tidak sesuai dengan HANGRY SDA. Setiap elemen data harus berupa object transaksi." };
    }
    records.push(item);
  }
  const hasSignature = records.some((record) => "no_struk" in record && ("id_outlet" in record || "dpp" in record || "id_agent" in record));
  if (!hasSignature) {
    return { ok: false, error: "Format JSON tidak sesuai dengan HANGRY SDA. Field yang dibutuhkan antara lain: no_struk, dpp, tax, total." };
  }
  // Identitas: semua record yang menyebut id_agent harus hangry_sda; minimal satu record harus Hangry.
  const foreign = records.find((record) => {
    const agent = normalizeIdentity(record.id_agent);
    const usaha = normalizeIdentity(record.nama_usaha);
    return (agent !== "" && agent !== HANGRY_SDA_AGENT) || (usaha !== "" && usaha !== HANGRY_SDA_NAMA_USAHA);
  });
  if (foreign) {
    const agent = stringValue(foreign.id_agent) || "-";
    const usaha = stringValue(foreign.nama_usaha) || "-";
    return { ok: false, error: `Format JSON tidak sesuai dengan HANGRY SDA. Ditemukan identitas lain (id_agent: "${agent}", nama_usaha: "${usaha}"); yang diterima id_agent "${HANGRY_SDA_AGENT}".` };
  }
  if (!records.some(isHangrySdaIdentity)) {
    return { ok: false, error: `Identitas HANGRY SDA tidak ditemukan. Field id_agent "${HANGRY_SDA_AGENT}" atau nama_usaha "Hangry Sidoarjo" dibutuhkan.` };
  }
  return { ok: true, records, declaredCount };
}

// Langkah 2: petakan SELURUH record. Tidak ada record yang dibuang (void, no_struk kembar,
// atau field null tetap masuk). Record dengan field wajib kosong tetap dihitung dan ditandai Invalid.
// service_charge dan discount BOLEH null (bukan field wajib); null dipertahankan sebagai null.
export function buildHangrySdaResult(records: Record<string, unknown>[], declaredCount: number | null = null): HangrySdaParseResult {
  const rows: HangrySdaTransaction[] = new Array(records.length);
  let validRows = 0;
  let invalidRows = 0;
  let voidRows = 0;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const id = stringValue(record.id);
    const idAgent = stringValue(record.id_agent);
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
    if (!idAgent) missing.push("id_agent");
    if (!noStruk) missing.push("no_struk");
    if (!dateTrans) missing.push("date_trans");
    if (subtotal === null) missing.push("subtotal");
    if (dpp === null) missing.push("dpp");
    if (tax === null) missing.push("tax");
    if (total === null) missing.push("total");

    const base = {
      id,
      idAgent,
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
export function parseHangrySda(input: string): HangrySdaParseResult {
  const extracted = extractHangrySdaRecords(input);
  if (!extracted.ok) return { ok: false, error: extracted.error, ...EMPTY_RESULT_BASE };
  return buildHangrySdaResult(extracted.records, extracted.declaredCount);
}

// Peringatan bila `count` API berbeda dari jumlah objek aktual di `data`. Data tidak diubah.
export function hangrySdaCountWarning(result: Pick<HangrySdaParseResult, "declaredCount" | "totalRows">): string | null {
  if (result.declaredCount === null || result.declaredCount === result.totalRows) return null;
  return `Peringatan: field count API = ${result.declaredCount.toLocaleString("id-ID")}, tetapi jumlah objek aktual di data = ${result.totalRows.toLocaleString("id-ID")}. Seluruh ${result.totalRows.toLocaleString("id-ID")} transaksi di data tetap diproses; mohon periksa sumber data.`;
}

// Pagination murni untuk tampilan; tidak pernah dipakai untuk summary.
export function paginateHangrySda<T>(rows: readonly T[], page: number, pageSize: number) {
  const size = Math.max(1, Math.floor(pageSize));
  const totalPages = Math.max(1, Math.ceil(rows.length / size));
  const activePage = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const startIndex = (activePage - 1) * size;
  const endIndex = Math.min(startIndex + size, rows.length);
  return { visible: rows.slice(startIndex, endIndex), activePage, totalPages, startIndex, endIndex };
}

const clean = (value: number) => Math.round(value * 1e6) / 1e6;

function sumField(rows: readonly HangrySdaTransaction[], pick: (row: HangrySdaTransaction) => number | null): HangrySdaAmountSummary {
  let sum = 0;
  let validCount = 0;
  let missingCount = 0;
  for (const row of rows) {
    const value = pick(row);
    if (value === null) missingCount += 1;
    else {
      validCount += 1;
      sum += value;
    }
  }
  return { sum: clean(sum), validCount, missingCount };
}

function summarizeBlock(rows: readonly HangrySdaTransaction[]): HangrySdaSummaryBlock {
  return {
    transactionCount: rows.length,
    subtotal: sumField(rows, (row) => row.subtotal),
    serviceCharge: sumField(rows, (row) => row.serviceCharge),
    discount: sumField(rows, (row) => row.discount),
    dpp: sumField(rows, (row) => row.dpp),
    tax: sumField(rows, (row) => row.tax),
    total: sumField(rows, (row) => row.total),
  };
}

// Ringkasan dari nilai sumber apa adanya. Nilai null TIDAK dianggap 0: hanya nilai valid yang dijumlah,
// dan jumlah yang kosong dilaporkan (missingCount). Void tidak dibuang diam-diam: ringkasan
// disediakan untuk semua transaksi, hanya non-void, dan hanya void, supaya perlakuannya bisa dikonfirmasi.
export function summarizeHangrySda(rows: readonly HangrySdaTransaction[]): HangrySdaSummary {
  return {
    all: summarizeBlock(rows),
    nonVoid: summarizeBlock(rows.filter((row) => !row.isVoid)),
    voided: summarizeBlock(rows.filter((row) => row.isVoid)),
  };
}

export function hangrySdaToCsv(rows: readonly HangrySdaTransaction[]): string {
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
