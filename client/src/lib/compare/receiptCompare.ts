import { parseIndonesianNumber, summarizeReceiptRows, type ReceiptRow } from "./receiptParser";

export type ReceiptCompareStatus = "SAMA" | "BERBEDA" | "HANYA DI FILE 1" | "HANYA DI FILE 2";
export type ReceiptCompareRow = { no_struk: string; status: ReceiptCompareStatus; differences: string[]; file1?: ReceiptRow; file2?: ReceiptRow };
const fields = ["id_agent", "date_trans", "subtotal", "service_charge", "discount", "dpp", "tax", "paid_amount", "total", "keterangan"] as const;
const numeric = new Set(["subtotal", "service_charge", "discount", "dpp", "tax", "paid_amount", "total"]);
const numericValue = (row: ReceiptRow, field: typeof fields[number]) => field === "total" && !row.total && row.paid_amount ? parseIndonesianNumber(row.paid_amount) : parseIndonesianNumber(row[field]);
export function compareReceiptRows(file1: ReceiptRow[], file2: ReceiptRow[]) {
  const left = new Map(file1.filter((row) => row.no_struk).map((row) => [row.no_struk, row]));
  const right = new Map(file2.filter((row) => row.no_struk).map((row) => [row.no_struk, row]));
  const keys = new Set([...left.keys(), ...right.keys()]);
  const rows: ReceiptCompareRow[] = [];
  for (const no_struk of keys) {
    const a = left.get(no_struk), b = right.get(no_struk);
    if (!a) { rows.push({ no_struk, status: "HANYA DI FILE 2", differences: [], file2: b }); continue; }
    if (!b) { rows.push({ no_struk, status: "HANYA DI FILE 1", differences: [], file1: a }); continue; }
    const differences = fields.filter((field) => numeric.has(field) ? numericValue(a, field) !== numericValue(b, field) : a[field] !== b[field]).map((field) => field);
    rows.push({ no_struk, status: differences.length ? "BERBEDA" : "SAMA", differences, file1: a, file2: b });
  }
  return { rows, summary: { file1: file1.length, file2: file2.length, same: rows.filter((row) => row.status === "SAMA").length, only1: rows.filter((row) => row.status === "HANYA DI FILE 1").length, only2: rows.filter((row) => row.status === "HANYA DI FILE 2").length, different: rows.filter((row) => row.status === "BERBEDA").length } };
}

// ---------------------------------------------------------------------------
// Perbandingan berbasis TOTAL (dipakai halaman "Bandingkan 2 File").
// Tidak memakai no_struk sama sekali: sistem menghitung jumlah transaksi,
// subtotal, tax, dan total dari SELURUH baris tiap file, lalu membandingkan
// hasilnya. Aturan hitung sama dengan halaman CEK STRUK (summarizeReceiptRows),
// termasuk Total = Paid Amount bila kolom Paid Amount ada.
// ---------------------------------------------------------------------------
export type ReceiptTotalsMetric = "count" | "subtotal" | "tax" | "total";
export type ReceiptTotalsStatus = "SAMA" | "BERBEDA";
export type ReceiptTotalsLine = { metric: ReceiptTotalsMetric; label: string; file1: number; file2: number; difference: number; status: ReceiptTotalsStatus };
export type ReceiptTotalsComparison = { lines: ReceiptTotalsLine[]; allMatch: boolean; differentCount: number };

// Hindari selisih semu akibat floating point (mis. 0.1 + 0.2).
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function compareReceiptTotals(file1: ReceiptRow[], file2: ReceiptRow[]): ReceiptTotalsComparison {
  const a = summarizeReceiptRows(file1);
  const b = summarizeReceiptRows(file2);
  const source: Array<[ReceiptTotalsMetric, string, number, number]> = [
    ["count", "Jumlah transaksi", a.count, b.count],
    ["subtotal", "Subtotal", a.subtotal, b.subtotal],
    ["tax", "Tax", a.tax, b.tax],
    ["total", "Total", a.total, b.total],
  ];
  const lines = source.map(([metric, label, left, right]): ReceiptTotalsLine => {
    const value1 = round2(left);
    const value2 = round2(right);
    const difference = round2(value2 - value1);
    return { metric, label, file1: value1, file2: value2, difference, status: difference === 0 ? "SAMA" : "BERBEDA" };
  });
  const differentCount = lines.filter((line) => line.status === "BERBEDA").length;
  return { lines, allMatch: differentCount === 0, differentCount };
}
