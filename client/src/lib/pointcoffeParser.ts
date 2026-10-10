export type PointCoffeeRow = {
  no_struk: string;
  date_trans: string;
  toko: string;
  subtotal: number;
  dpp: number;
  tax: number;
  total: number;
  keterangan: "CSV file";
  sourceRow: number;
};

export type PointCoffeeResult = {
  ok: boolean;
  error?: string;
  warnings: string[];
  rows: PointCoffeeRow[];
  totalRows: number;
  invalidRows: number;
  summary: { count: number; subtotal: number; dpp: number; tax: number; total: number };
};

const normalize = (value: unknown) => String(value ?? "").replace(/^\uFEFF/, "").trim().toLowerCase();
const numberValue = (value: string): number | null => {
  const text = value.trim().replace(/\s/g, "");
  if (!text) return null;
  const normalized = text.includes(",") && text.includes(".") ? text.replace(/\./g, "").replace(",", ".") : text.replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

export function parsePointCoffeeCsv(text: string): PointCoffeeResult {
  const warnings: string[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (!lines.length) return { ok: false, error: "CSV PointCoffee kosong.", warnings, rows: [], totalRows: 0, invalidRows: 0, summary: { count: 0, subtotal: 0, dpp: 0, tax: 0, total: 0 } };
  const header = lines[0].split("|").map(normalize);
  const expected = ["tanggal", "waktu", "toko", "no_struk", "shift", "station", "deskripsi_item", "dpp", "pajak_restoran"];
  if (header.length < expected.length || expected.some((field, index) => header[index] !== field)) {
    return { ok: false, error: "Header CSV PointCoffee tidak sesuai. Gunakan delimiter |.", warnings, rows: [], totalRows: 0, invalidRows: 0, summary: { count: 0, subtotal: 0, dpp: 0, tax: 0, total: 0 } };
  }
  const rows: PointCoffeeRow[] = [];
  let invalidRows = 0;
  lines.slice(1).forEach((line, index) => {
    const values = line.split("|");
    const [date, time, store, receipt, , , , dppRaw, taxRaw] = values;
    const dpp = numberValue(dppRaw ?? "");
    const tax = numberValue(taxRaw ?? "");
    if (!date?.trim() || !time?.trim() || !store?.trim() || !receipt?.trim() || dpp === null || tax === null) { invalidRows += 1; return; }
    rows.push({ no_struk: `${store}_${receipt}${date}${time}_${index + 1}`, date_trans: `${date} ${time}`, toko: store, subtotal: dpp, dpp, tax, total: dpp + tax, keterangan: "CSV file", sourceRow: index + 2 });
  });
  const summary = rows.reduce((acc, row) => ({ count: acc.count + 1, subtotal: acc.subtotal + row.subtotal, dpp: acc.dpp + row.dpp, tax: acc.tax + row.tax, total: acc.total + row.total }), { count: 0, subtotal: 0, dpp: 0, tax: 0, total: 0 });
  if (invalidRows) warnings.push(`${invalidRows} baris tidak valid dilewati.`);
  return { ok: true, warnings, rows, totalRows: lines.length - 1, invalidRows, summary };
}

export const formatPointCoffeeMoney = (value: number) => `Rp${Math.round(value).toLocaleString("id-ID")}`;

export async function parsePointCoffeeFiles(files: File[]): Promise<PointCoffeeResult & { processedFiles: string[]; failedFiles: string[] }> {
  const processedFiles: string[] = [], failedFiles: string[] = [], parsedResults: PointCoffeeResult[] = [];
  for (const file of files) {
    if (!/\.csv$/i.test(file.name)) { failedFiles.push(`${file.name}: hanya CSV yang didukung`); continue; }
    const result = parsePointCoffeeCsv(await file.text());
    if (result.ok) { processedFiles.push(file.name); parsedResults.push(result); } else failedFiles.push(`${file.name}: ${result.error || "format tidak sesuai"}`);
  }
  if (!parsedResults.length) return { ok: false, error: failedFiles.join("; ") || "Tidak ada CSV yang berhasil diproses.", warnings: [], rows: [], totalRows: 0, invalidRows: 0, summary: { count: 0, subtotal: 0, dpp: 0, tax: 0, total: 0 }, processedFiles, failedFiles };
  const rows = parsedResults.flatMap((result) => result.rows);
  const summary = rows.reduce((acc, row) => ({ count: acc.count + 1, subtotal: acc.subtotal + row.subtotal, dpp: acc.dpp + row.dpp, tax: acc.tax + row.tax, total: acc.total + row.total }), { count: 0, subtotal: 0, dpp: 0, tax: 0, total: 0 });
  return { ok: true, warnings: [...parsedResults.flatMap((result) => result.warnings), ...(failedFiles.length ? [`File gagal: ${failedFiles.join("; ")}`] : [])], rows, totalRows: parsedResults.reduce((sum, result) => sum + result.totalRows, 0), invalidRows: parsedResults.reduce((sum, result) => sum + result.invalidRows, 0), summary, processedFiles, failedFiles };
}
