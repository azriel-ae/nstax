import { fieldForHeader, normalizeDate, normalizeHeader, parseIndonesianNumber, type ReceiptRawTable } from "./receiptParser";

// ---------------------------------------------------------------------------
// Engine BANDINGKAN 2 FILE: mencocokkan transaksi berdasarkan KEY (bukan nomor
// baris), lalu membandingkan field yang tersedia di kedua file.
// ---------------------------------------------------------------------------

export type CompareStatus = "SAMA" | "BERBEDA" | "HANYA DI FILE 1" | "HANYA DI FILE 2" | "DUPLIKAT";
export type FieldDiff = { field: string; label: string; v1: string; v2: string };
export type CompareRecord = { key: string; status: CompareStatus; idx1: number[]; idx2: number[]; diffs: FieldDiff[] };
export type CompareField = { name: string; label: string; col1: number; col2: number };
export type CompareSummary = { total1: number; total2: number; same: number; different: number; only1: number; only2: number; dupKeys1: number; dupKeys2: number; dupRows1: number; dupRows2: number };
export type CompareResult = { records: CompareRecord[]; summary: CompareSummary; fields: CompareField[]; emptyKey1: number; emptyKey2: number };
export type KeyDetection = { key1: number; key2: number; detected: boolean; sameName: boolean };

export const KEY_PRIORITY = ["no_struk", "no_order", "nomor_struk", "nomor_order", "no_transaksi", "nomor_transaksi", "transaction_no", "transaction_id", "id_transaksi", "id"];
const FIELD_PRIORITY = ["id_agent", "no_struk", "no_order", "date_trans", "subtotal", "service_charge", "discount", "dpp", "tax", "total", "keterangan", "nama_usaha", "id_outlet", "outlet_name"];
const NUMERIC_FIELDS = new Set(["subtotal", "service_charge", "discount", "dpp", "tax", "paid_amount", "total"]);

// ---- Key -------------------------------------------------------------------
export function normalizeKey(value: unknown): string {
  if (value == null) return "";
  let text = String(value).trim();
  if (/^(null|undefined)$/i.test(text)) return "";
  if (/^-?\d+\.0+$/.test(text)) text = text.replace(/\.0+$/, ""); // 12345.0 (angka Excel) = "12345"
  return text;
}

function bestKeyColumn(table: ReceiptRawTable): number {
  const names = table.headers.map((header) => normalizeHeader(header));
  for (const name of KEY_PRIORITY) {
    const index = names.indexOf(name);
    if (index >= 0) return index;
  }
  // alias lain yang sudah dikenal parser CEK STRUK (receipt_no, order_no, dst.)
  return table.headers.findIndex((header) => fieldForHeader(header) === "no_struk");
}

export function detectKeys(t1: ReceiptRawTable, t2: ReceiptRawTable): KeyDetection {
  const n1 = t1.headers.map((header) => normalizeHeader(header));
  const n2 = t2.headers.map((header) => normalizeHeader(header));
  for (const name of KEY_PRIORITY) {
    const a = n1.indexOf(name), b = n2.indexOf(name);
    if (a >= 0 && b >= 0) return { key1: a, key2: b, detected: true, sameName: true };
  }
  const key1 = bestKeyColumn(t1), key2 = bestKeyColumn(t2);
  return { key1, key2, detected: key1 >= 0 && key2 >= 0, sameName: false };
}

// ---- Nilai -----------------------------------------------------------------
export const isEmptyValue = (value: string) => /^(null|undefined|nan)?$/i.test(value.trim());
const looksNumeric = (value: string) => /\d/.test(value) && /^-?\s*(rp\.?)?\s*-?[\d.,\s]+$/i.test(value.trim());
const hasLeadingZero = (value: string) => /^-?0\d/.test(value.trim().replace(/^rp\.?\s*/i, ""));

export function valuesEqual(field: string, a: string, b: string): boolean {
  const emptyA = isEmptyValue(a), emptyB = isEmptyValue(b);
  if (emptyA || emptyB) return emptyA && emptyB; // null/kosong ≠ 0
  if (field === "date_trans") return normalizeDate(a) === normalizeDate(b);
  const known = NUMERIC_FIELDS.has(field);
  if (looksNumeric(a) && looksNumeric(b) && (known || (!hasLeadingZero(a) && !hasLeadingZero(b)))) {
    return Math.abs(parseIndonesianNumber(a) - parseIndonesianNumber(b)) < 1e-6;
  }
  return a.trim() === b.trim();
}

// ---- Field yang dibandingkan -------------------------------------------------
const canonicalName = (header: string) => fieldForHeader(header) ?? normalizeHeader(header);

export function commonFields(t1: ReceiptRawTable, t2: ReceiptRawTable, key1: number, key2: number): CompareField[] {
  const map = (table: ReceiptRawTable, skip: number) => {
    const result = new Map<string, number>();
    table.headers.forEach((header, index) => {
      const name = canonicalName(header);
      if (index !== skip && name && !result.has(name)) result.set(name, index);
    });
    return result;
  };
  const m1 = map(t1, key1), m2 = map(t2, key2);
  const names = [...m1.keys()].filter((name) => m2.has(name));
  const ordered = [...FIELD_PRIORITY.filter((name) => names.includes(name)), ...names.filter((name) => !FIELD_PRIORITY.includes(name))];
  return ordered.map((name) => ({ name, label: t1.headers[m1.get(name)!] || name, col1: m1.get(name)!, col2: m2.get(name)! }));
}

// ---- Pembanding ---------------------------------------------------------------
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const CHUNK = 4000;

async function indexByKey(table: ReceiptRawTable, keyCol: number, onProgress?: (done: number) => void) {
  const groups = new Map<string, number[]>();
  let empty = 0;
  for (let i = 0; i < table.rows.length; i++) {
    const key = normalizeKey(table.rows[i][keyCol]);
    if (!key) empty++;
    else { const list = groups.get(key); if (list) list.push(i); else groups.set(key, [i]); }
    if (i % CHUNK === CHUNK - 1) { onProgress?.(i + 1); await yieldToUi(); }
  }
  return { groups, empty };
}

export async function compareTables(t1: ReceiptRawTable, t2: ReceiptRawTable, key1: number, key2: number, onProgress?: (message: string) => void): Promise<CompareResult> {
  onProgress?.("Mencocokkan transaksi...");
  const [a, b] = [await indexByKey(t1, key1), await indexByKey(t2, key2)];
  const fields = commonFields(t1, t2, key1, key2);
  const records: CompareRecord[] = [];
  const summary: CompareSummary = { total1: t1.rows.length, total2: t2.rows.length, same: 0, different: 0, only1: 0, only2: 0, dupKeys1: 0, dupKeys2: 0, dupRows1: 0, dupRows2: 0 };
  for (const list of a.groups.values()) if (list.length > 1) { summary.dupKeys1++; summary.dupRows1 += list.length - 1; }
  for (const list of b.groups.values()) if (list.length > 1) { summary.dupKeys2++; summary.dupRows2 += list.length - 1; }

  const diffsFor = (i1: number, i2: number): FieldDiff[] => {
    const diffs: FieldDiff[] = [];
    for (const field of fields) {
      const v1 = t1.rows[i1][field.col1] ?? "", v2 = t2.rows[i2][field.col2] ?? "";
      if (!valuesEqual(field.name, v1, v2)) diffs.push({ field: field.name, label: field.label, v1, v2 });
    }
    return diffs;
  };

  onProgress?.("Menganalisis perbedaan...");
  let processed = 0;
  const visit = async (key: string, idx1: number[], idx2: number[]) => {
    let status: CompareStatus, diffs: FieldDiff[] = [];
    if (idx1.length && idx2.length) diffs = diffsFor(idx1[0], idx2[0]);
    if (idx1.length > 1 || idx2.length > 1) status = "DUPLIKAT";
    else if (!idx2.length) { status = "HANYA DI FILE 1"; summary.only1++; }
    else if (!idx1.length) { status = "HANYA DI FILE 2"; summary.only2++; }
    else if (diffs.length) { status = "BERBEDA"; summary.different++; }
    else { status = "SAMA"; summary.same++; }
    records.push({ key, status, idx1, idx2, diffs });
    if (++processed % CHUNK === 0) await yieldToUi();
  };
  for (const [key, idx1] of a.groups) await visit(key, idx1, b.groups.get(key) ?? []);
  for (const [key, idx2] of b.groups) if (!a.groups.has(key)) await visit(key, [], idx2);
  return { records, summary, fields, emptyKey1: a.empty, emptyKey2: b.empty };
}

// ---- Tampilan & export -------------------------------------------------------
export function formatCellValue(field: string, value: string): string {
  if (isEmptyValue(value)) return "(kosong)";
  if (NUMERIC_FIELDS.has(field) && looksNumeric(value) && !hasLeadingZero(value)) return parseIndonesianNumber(value).toLocaleString("id-ID", { maximumFractionDigits: 2 });
  return value;
}

export function describeDifference(record: CompareRecord): string {
  if (record.status === "DUPLIKAT") {
    const parts = [];
    if (record.idx1.length > 1) parts.push(`${record.idx1.length}× di File 1`);
    if (record.idx2.length > 1) parts.push(`${record.idx2.length}× di File 2`);
    return `Muncul ${parts.join(", ")}`;
  }
  return record.diffs.length ? record.diffs.map((diff) => diff.label).join(", ") : "-";
}

const EXPORT_HEADERS = ["status", "comparison_key", "file1_value", "file2_value", "difference", "count_file1", "count_file2"] as const;

// Seluruh hasil perbandingan (bukan hanya halaman yang tampil).
export function buildExportRows(result: CompareResult, t1: ReceiptRawTable, t2: ReceiptRawTable): string[][] {
  const rowText = (table: ReceiptRawTable, indexes: number[]) => indexes.map((index) => table.headers.map((header, col) => `${header}=${table.rows[index][col] ?? ""}`).join("; ")).join(" | ");
  const limit = (text: string) => (text.length > 32000 ? `${text.slice(0, 32000)}…` : text);
  const rows = result.records.map((record) => {
    let v1: string, v2: string;
    if (record.status === "BERBEDA") {
      v1 = record.diffs.map((diff) => `${diff.field}=${diff.v1}`).join("; ");
      v2 = record.diffs.map((diff) => `${diff.field}=${diff.v2}`).join("; ");
    } else {
      v1 = rowText(t1, record.idx1);
      v2 = rowText(t2, record.idx2);
    }
    const difference = record.status === "DUPLIKAT" ? describeDifference(record) : record.diffs.map((diff) => `${diff.field}: ${diff.v1 || "(kosong)"} → ${diff.v2 || "(kosong)"}`).join("; ");
    return [record.status, record.key, limit(v1), limit(v2), limit(difference), String(record.idx1.length), String(record.idx2.length)];
  });
  return [[...EXPORT_HEADERS], ...rows];
}

export function rowsToCsv(rows: string[][]): string {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  return "\ufeff" + rows.map((row) => row.map(escape).join(",")).join("\r\n");
}
