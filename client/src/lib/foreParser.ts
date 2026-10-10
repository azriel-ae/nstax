export const FORE_REQUIRED_FIELDS = ["tgl", "counter_id", "counter_name", "billing_id", "total", "pajak"] as const;

type RawForeRecord = Record<string, unknown>;
export type ForeTransaction = {
  id: string;
  sourceIndex: number;
  raw: RawForeRecord;
  dateTime: string;
  counterId: string;
  counterName: string;
  billingId: string;
  total: number;
  pajak: number;
};

export type ForeParseResult = {
  ok: boolean;
  error?: string;
  validTransactions: ForeTransaction[];
  issues: string[];
};

const isRecord = (value: unknown): value is RawForeRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const display = (value: unknown) => value == null ? "" : String(value).trim();
const isNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim()));
const collect = (value: unknown, output: RawForeRecord[]) => {
  if (Array.isArray(value)) return value.forEach((item) => collect(item, output));
  if (!isRecord(value)) return;
  if ("billing_id" in value || "counter_id" in value || "pajak" in value) output.push(value);
  else Object.values(value).forEach((child) => collect(child, output));
};

export function parseForeJson(text: string): ForeParseResult {
  if (!text.trim()) return { ok: false, error: "JSON kosong. Tempelkan data FORE atau upload file .json terlebih dahulu.", validTransactions: [], issues: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, error: "JSON tidak valid. Periksa kembali format JSON.", validTransactions: [], issues: [] }; }
  if (!Array.isArray(parsed) && !isRecord(parsed)) return { ok: false, error: "Format JSON FORE tidak sesuai mode FORE.", validTransactions: [], issues: [] };
  const candidates: RawForeRecord[] = [];
  collect(parsed, candidates);
  if (!candidates.length) return { ok: false, error: "Format JSON tidak sesuai dengan mode FORE. Field FORE: billing_id, counter_id, counter_name, tgl, total, pajak.", validTransactions: [], issues: [] };
  const issues: string[] = [];
  const validTransactions: ForeTransaction[] = [];
  candidates.forEach((record, index) => {
    const missing = FORE_REQUIRED_FIELDS.filter((field) => !(field in record));
    const invalidNumbers = ["total", "pajak"].filter((field) => !isNumber(record[field]));
    const counterName = display(record.counter_name);
    const billingId = display(record.billing_id);
    if (missing.length || invalidNumbers.length || !counterName || !billingId) {
      issues.push(`Baris ${index + 1}: ${missing.length ? `field kurang (${missing.join(", ")})` : "data FORE tidak valid"}.`);
      return;
    }
    validTransactions.push({ id: `${billingId}-${index}`, sourceIndex: index, raw: record, dateTime: display(record.tgl), counterId: display(record.counter_id), counterName, billingId, total: Number(record.total), pajak: Number(record.pajak) });
  });
  return { ok: true, validTransactions, issues };
}

export function formatForeRupiah(value: number) {
  return `Rp${Math.round(value).toLocaleString("id-ID")}`;
}

export function calculateForeSummary(transactions: ForeTransaction[]) {
  return {
    count: transactions.length,
    total: transactions.reduce((sum, item) => sum + item.total, 0),
    pajak: transactions.reduce((sum, item) => sum + item.pajak, 0),
    uniqueCounters: new Set(transactions.map((item) => item.counterId)).size,
  };
}

export function foreToCsv(transactions: ForeTransaction[]) {
  const headers = ["No", "Tanggal", "Counter ID", "Counter Name", "Billing ID", "Total", "Pajak"];
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const rows = transactions.map((item, index) => [String(index + 1), item.dateTime, item.counterId, item.counterName, item.billingId, String(item.total), String(item.pajak)]);
  return [headers, ...rows].map((row) => row.map(escape).join(",")).join("\n");
}
