export const ASTANA_REQUIRED_FIELDS = ["Date", "Product", "Gross", "Service", "Tax", "Nett"] as const;
export type AstanaStatus = "Valid" | "Perlu diperiksa" | "Invalid";

export type AstanaTransaction = {
  date: string;
  product: string;
  noBill: string | null;
  gross: number | null;
  service: number | null;
  tax: number | null;
  nett: number | null;
  status: AstanaStatus;
  error?: string;
  raw: Record<string, unknown>;
};

export type AstanaParseResult = {
  ok: boolean;
  error?: string;
  rows: AstanaTransaction[];
  totalRows: number;
  validRows: number;
  invalidRows: number;
  needsReviewRows: number;
};

export type AstanaSummary = {
  transactionCount: number;
  gross: number;
  service: number;
  tax: number;
  nett: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function parseMoney(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim().replace(/^rp\.?\s*/i, "").replace(/\s/g, "");
  if (!text) return null;
  // ASTANA JSON uses decimal notation (e.g. "257905.76"). Commas are
  // accepted only as decimal separators when no dot is present.
  const normalized = text.includes(".") ? text.replace(/,/g, "") : text.replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

export function formatAstanaRupiah(value: number): string {
  return `Rp ${value.toLocaleString("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function parseAstana(input: string): AstanaParseResult {
  if (!input.trim()) return { ok: false, error: "JSON kosong. Tempelkan data ASTANA atau upload file .json terlebih dahulu.", rows: [], totalRows: 0, validRows: 0, invalidRows: 0, needsReviewRows: 0 };
  let root: unknown;
  try {
    root = JSON.parse(input);
  } catch {
    return { ok: false, error: "JSON tidak valid. Periksa kembali format ASTANA.", rows: [], totalRows: 0, validRows: 0, invalidRows: 0, needsReviewRows: 0 };
  }
  if (!Array.isArray(root) || root.some((item) => !isRecord(item))) {
    return { ok: false, error: "Format JSON tidak sesuai dengan CEK ASTANA.", rows: [], totalRows: 0, validRows: 0, invalidRows: 0, needsReviewRows: 0 };
  }
  const hasAstanaField = root.some((record) => ASTANA_REQUIRED_FIELDS.some((field) => field in record) || "NoBill" in record);
  if (!hasAstanaField) {
    return { ok: false, error: "Format JSON tidak sesuai dengan CEK ASTANA.", rows: [], totalRows: 0, validRows: 0, invalidRows: 0, needsReviewRows: 0 };
  }
  const rows = root.map((record) => {
    const date = stringValue(record.Date);
    const product = stringValue(record.Product);
    const gross = parseMoney(record.Gross);
    const service = parseMoney(record.Service);
    const tax = parseMoney(record.Tax);
    const nett = parseMoney(record.Nett);
    const missing = ASTANA_REQUIRED_FIELDS.filter((field) => {
      if (field === "Date") return !date;
      if (field === "Product") return !product;
      return parseMoney(record[field]) === null;
    });
    if (missing.length) {
      return { date, product, noBill: record.NoBill == null ? null : stringValue(record.NoBill), gross, service, tax, nett, status: "Invalid" as const, error: `Field wajib kosong/tidak valid: ${missing.join(", ")}`, raw: record };
    }
    const difference = Math.abs((gross as number) - (service as number) - (tax as number) - (nett as number));
    const status: AstanaStatus = difference <= 0.01 ? "Valid" : "Perlu diperiksa";
    return { date, product, noBill: record.NoBill == null ? null : stringValue(record.NoBill), gross, service, tax, nett, status, ...(status === "Perlu diperiksa" ? { error: `Selisih konsistensi: ${formatAstanaRupiah(difference)}` } : {}), raw: record };
  });
  return {
    ok: true,
    rows,
    totalRows: rows.length,
    validRows: rows.filter((row) => row.status === "Valid").length,
    invalidRows: rows.filter((row) => row.status === "Invalid").length,
    needsReviewRows: rows.filter((row) => row.status === "Perlu diperiksa").length,
  };
}

export function summarizeAstana(rows: AstanaTransaction[]): AstanaSummary {
  const valid = rows.filter((row) => row.status !== "Invalid");
  return {
    transactionCount: valid.length,
    gross: valid.reduce((sum, row) => sum + (row.gross ?? 0), 0),
    service: valid.reduce((sum, row) => sum + (row.service ?? 0), 0),
    tax: valid.reduce((sum, row) => sum + (row.tax ?? 0), 0),
    nett: valid.reduce((sum, row) => sum + (row.nett ?? 0), 0),
  };
}

export function astanaToCsv(rows: AstanaTransaction[]): string {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  return [
    ["No", "Date", "Product", "NoBill", "Gross", "Service", "Tax", "Nett", "Status"],
    ...rows.map((row, index) => [String(index + 1), row.date, row.product, row.noBill ?? "-", String(row.gross ?? ""), String(row.service ?? ""), String(row.tax ?? ""), String(row.nett ?? ""), row.status]),
  ].map((line) => line.map(escape).join(",")).join("\n");
}
