export type VendorKind = "rotio" | "kai" | "hokben" | "kopken" | "fore" | "fave" | "sams";
export const VENDOR_LABELS: Record<VendorKind, string> = { rotio: "Rotio", kai: "KAI", hokben: "HokBen", kopken: "KopKen", fore: "FORE", fave: "Fave", sams: "SAMS" };
export type VendorRow = { id: string; date: string; reference: string; outlet: string; dpp: number; tax: number; total: number; raw: Record<string, unknown> };
export type VendorParseResult = { ok: boolean; error?: string; rows: VendorRow[]; issues: string[] };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => value == null ? "" : String(value).trim();
const num = (value: unknown) => { if (typeof value === "number") return Number.isFinite(value) ? value : null; if (typeof value === "string" && value.trim() && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value); return null; };
const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const arr = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(record) : [];
const wrapped = (value: unknown, key: string) => record(value) && Array.isArray(value[key]) ? arr(value[key]) : null;
const idOf = (row: Record<string, unknown>, fallback: number) => text(row.no_transaksi ?? row.transaction_id ?? row.no_struk ?? row.ID ?? row.id ?? row.billing_id) || `row-${fallback + 1}`;

export function parseVendorJson(kind: VendorKind, input: string): VendorParseResult {
  if (!input.trim()) return { ok: false, error: "JSON kosong.", rows: [], issues: [] };
  let root: unknown; try { root = JSON.parse(input); } catch { return { ok: false, error: "JSON tidak valid.", rows: [], issues: [] }; }
  let source: Record<string, unknown>[] = [];
  if (kind === "rotio") { if (!Array.isArray(root)) return { ok: false, error: "Format JSON tidak sesuai dengan mode Rotio.", rows: [], issues: [] }; source = root.flatMap((item) => record(item) ? Object.entries(item).flatMap(([key, value]) => record(value) ? [{ ...value, __id: key }] : []) : []); }
  else if (kind === "kai") source = arr(root);
  else if (kind === "hokben") source = wrapped(root, "data") ?? [];
  else if (kind === "kopken") source = wrapped(root, "result") ?? [];
  else if (kind === "fore") source = wrapped(root, "data") ?? [];
  else if (kind === "fave") source = wrapped(root, "Data") ?? [];
  else if (kind === "sams") source = wrapped(root, "data") ?? [];
  if (!source.length) return { ok: false, error: `Format JSON tidak sesuai dengan mode ${VENDOR_LABELS[kind]}.`, rows: [], issues: [] };
  const issues: string[] = []; const rows: VendorRow[] = [];
  source.forEach((item, index) => {
    let dpp: number | null = null, tax: number | null = null, total: number | null = null;
    if (kind === "rotio") { total = num(item["4"]); if (total !== null) { dpp = money(total / 1.1); tax = money(total / 11); } }
    if (kind === "kai") { total = num(item.biayatotal); if (total !== null) { tax = money(total / 11); dpp = money(total - tax); } }
    if (kind === "hokben") { tax = num(item.tax); if (tax !== null) { total = money(tax / 0.1); dpp = money(total - tax); } }
    if (kind === "kopken") { dpp = num(item.dpp); tax = num(item.pajak); total = num(item.total); }
    if (kind === "fore") { total = num(item.total); tax = num(item.pajak); if (total !== null && tax !== null) dpp = money(total - tax); }
    if (kind === "fave") { dpp = num(item.base_amount); tax = num(item.tax_amount); total = num(item.grand_total); }
    if (kind === "sams") { dpp = num(item.dpp); tax = num(item.tax); total = num(item.total); }
    if (dpp === null || tax === null || total === null) { issues.push(`Baris ${index + 1}: field nilai transaksi tidak lengkap atau bukan angka.`); return; }
    rows.push({ id: text(item.__id) || idOf(item, index), date: text(item.tgl ?? item.waktu_out ?? item.trans_date ?? item.waktu_transaksi ?? item.created_date_time ?? item.date_trans ?? item.revenue_date), reference: idOf(item, index), outlet: text(item.outlet ?? item.nama_lokasi ?? item.branch_id ?? item.outlet_id ?? item.revenue_center_name ?? item.nama_usaha), dpp, tax, total, raw: item });
  });
  return { ok: true, rows, issues };
}
export const formatVendorRupiah = (value: number) => `Rp${Math.round(value).toLocaleString("id-ID")}`;
export function summarizeVendor(rows: VendorRow[]) { return { count: rows.length, dpp: rows.reduce((sum, row) => sum + row.dpp, 0), tax: rows.reduce((sum, row) => sum + row.tax, 0), total: rows.reduce((sum, row) => sum + row.total, 0) }; }
export function vendorToCsv(rows: VendorRow[]) { const esc = (v: string) => `"${v.replace(/"/g, '""')}"`; return [["No", "Tanggal", "Referensi", "Outlet", "DPP", "Tax", "Total"], ...rows.map((row, i) => [String(i + 1), row.date, row.reference, row.outlet, String(row.dpp), String(row.tax), String(row.total)])].map((line) => line.map(esc).join(",")).join("\n"); }
