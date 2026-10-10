import * as XLSX from "xlsx";

// CEK UPL · JAMBULUWUK (kategori HOTEL dan RESTO)
// Sumber: satu file Excel (.xls/.xlsx) laporan folio. Kolom dibaca berdasarkan POSISI sesuai SQL acuan:
//   A = FOLIO   E = NAME (nama item)   J = NETT (nilai)
// Header divalidasi (A=FOLIO, E=NAME, J=NETT) — jika tidak cocok, parser berhenti dengan error (tidak menebak).
//
// Rumus mengikuti SQL acuan (JANGAN diubah):
//   Filter HOTEL : E ~ Room|Miscellaneous|Padel|Laundry|Phone|Jeep|Transportation|Swimming ; tax = item "Tax"
//   Filter RESTO : E ~ Breakfast|Dinner|Restaurant|Banquet                                   ; tax = item "Tax"
//   A tidak mengandung "FOLIO"; GROUP BY folio (A) + file sumber
//   dpp      = SUM(J) jika E !~ Service|Tax
//   subtotal = SUM(J) jika E !~ Service|Tax|Disc
//   discount = SUM(J) jika E ~ Disc
//   service  = SUM(J) jika E ~ Service
//   tax      = SUM(J) jika E ~ Tax (HOTEL dan RESTO sama; sama dengan pola pengecualian dpp 'Service|Tax').
//              Jika folio TIDAK punya baris Tax sama sekali: tax = (dpp + service) / 10.
//   total    = ROUND(dpp + service + tax, 2)  (memakai jumlah belum dibulatkan, seperti SQL)
//   date_trans = STR_TO_DATE(SUBSTRING_INDEX(filename,'.',3), '%d.%m.%Y')
// MySQL: CAST(TRIM(J) AS DECIMAL(15,4)) membulatkan tiap nilai ke 4 desimal SEBELUM dijumlahkan; REGEXP bersifat
// case-insensitive pada collation default. Keduanya ditiru di sini dengan aritmetika desimal eksak (BigInt).

export type JambuluwukCategory = "HOTEL" | "RESTO";

export const JAMBULUWUK_AGENT: Record<JambuluwukCategory, string> = {
  HOTEL: "hotel_jambuluwuk",
  RESTO: "resto_jambuluwuk",
};

const CATEGORY_FILTER: Record<JambuluwukCategory, RegExp> = {
  HOTEL: /Room|Miscellaneous|Padel|Laundry|Phone|Jeep|Transportation|Swimming/i,
  RESTO: /Breakfast|Dinner|Restaurant|Banquet/i,
};
// Pola pajak harus sama dengan pola pengecualian dpp (RX_SERVICE_OR_TAX), kalau tidak baris pajak hilang dari total.
const TAX_PATTERN: Record<JambuluwukCategory, RegExp> = {
  HOTEL: /Tax/i,
  RESTO: /Tax/i,
};
const RX_SERVICE_OR_TAX = /Service|Tax/i;
const RX_SERVICE_TAX_OR_DISC = /Service|Tax|Disc/i;
const RX_DISC = /Disc/i;
const RX_SERVICE = /Service/i;

const SCALE = 4; // DECIMAL(15,4)
const MAX_SCALED = 10n ** 15n; // |nilai| < 10^11 pada 4 desimal

export type JambuluwukSourceRow = {
  sheetRow: number; // nomor baris di Excel (1-based)
  folio: string; // kolom A
  item: string; // kolom E (TRIM + whitespace dinormalisasi)
  amount: bigint | null; // kolom J skala 4 desimal; null = kosong
  invalid: boolean; // J tidak valid sebagai angka
  rawAmount: string; // nilai J asli (untuk pesan error)
};

export type JambuluwukSourceStats = {
  dataRows: number; // baris data (setelah header) yang berisi sesuatu
  blankRows: number;
  repeatedHeaders: number; // A mengandung FOLIO → dikeluarkan (sesuai SQL)
  summaryRows: number; // baris total laporan → dikeluarkan agar tidak double count
  missingFolio: number; // A kosong → dikeluarkan (sesuai SQL, NULL tidak lolos filter)
  usedRows: number; // baris yang disimpan sebagai sumber
  unmatchedRows: number; // baris yang tidak cocok HOTEL maupun RESTO
};

export type JambuluwukSource = {
  ok: boolean;
  error?: string;
  fileName: string;
  dateTrans: string | null; // YYYY-MM-DD dari nama file
  sheetName: string;
  headerRow: number; // 1-based
  ignoredSheets: string[];
  rows: JambuluwukSourceRow[];
  stats: JambuluwukSourceStats;
};

export type JambuluwukRow = {
  id_agent: string;
  no_struk: string;
  date_trans: string;
  dpp: number;
  subtotal: number;
  discount: number;
  service_charge: number;
  tax: number;
  total: number;
  keterangan: string;
  namaFile: string;
  folio: string;
};

export type JambuluwukIssue = { row: number | null; message: string };

export type JambuluwukSummary = {
  category: JambuluwukCategory;
  fileName: string;
  count: number;
  subtotal: number;
  discount: number;
  service_charge: number;
  dpp: number;
  tax: number;
  total: number;
};

export type JambuluwukResult = {
  category: JambuluwukCategory;
  rows: JambuluwukRow[];
  summary: JambuluwukSummary;
  issues: JambuluwukIssue[];
  invalidRows: number;
  emptyAmountRows: number;
  matchedLines: number;
};

const emptyStats = (): JambuluwukSourceStats => ({ dataRows: 0, blankRows: 0, repeatedHeaders: 0, summaryRows: 0, missingFolio: 0, usedRows: 0, unmatchedRows: 0 });

const failSource = (fileName: string, error: string, extra: Partial<JambuluwukSource> = {}): JambuluwukSource => ({
  ok: false, error, fileName, dateTrans: null, sheetName: "", headerRow: 0, ignoredSheets: [], rows: [], stats: emptyStats(), ...extra,
});

// ---------- tanggal dari nama file ----------

/** Setara STR_TO_DATE(SUBSTRING_INDEX(filename,'.',3),'%d.%m.%Y'); ekstensi tidak ikut. */
export function dateFromFileName(fileName: string): { ok: true; date: string } | { ok: false; error: string } {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const firstThree = base.split(".").slice(0, 3).join(".");
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(firstThree);
  if (!m) {
    return { ok: false, error: `Nama file "${base}" tidak sesuai format tanggal DD.MM.YYYY (contoh: 01.09.2026.xls). Bagian yang dibaca: "${firstThree}".` };
  }
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return { ok: false, error: `Tanggal pada nama file "${base}" tidak valid (${firstThree}).` };
  }
  return { ok: true, date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
}

// ---------- angka desimal eksak ----------

const numberToPlain = (value: number): string | null => {
  if (!Number.isFinite(value)) return null;
  const plain = String(value);
  return /e/i.test(plain) ? value.toFixed(20) : plain;
};

/** Desimal → bigint skala 4, pembulatan setengah menjauhi nol (seperti CAST ... AS DECIMAL(15,4)). null = tidak valid. */
export function parseDecimalScaled(text: string): bigint | null {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!m) return null;
  const intPart = m[2] ?? "";
  const fracPart = m[3] ?? "";
  if (intPart === "" && fracPart === "") return null;
  const kept = (fracPart + "0".repeat(SCALE)).slice(0, SCALE);
  const nextDigit = fracPart.charAt(SCALE);
  let scaled = BigInt(intPart === "" ? "0" : intPart) * 10n ** BigInt(SCALE) + BigInt(kept);
  if (nextDigit !== "" && nextDigit >= "5") scaled += 1n;
  if (scaled >= MAX_SCALED) return null; // di luar DECIMAL(15,4)
  return m[1] === "-" ? -scaled : scaled;
}

/** ROUND(x, 2) dari skala 4 → sen (skala 2), setengah menjauhi nol. */
const roundToCents = (scaled4: bigint): bigint => {
  const negative = scaled4 < 0n;
  const abs = negative ? -scaled4 : scaled4;
  let cents = abs / 100n;
  if (abs % 100n >= 50n) cents += 1n;
  return negative ? -cents : cents;
};

/** ROUND(x, 2) dari skala 5 → sen, setengah menjauhi nol. */
const roundScale5ToCents = (scaled5: bigint): bigint => {
  const negative = scaled5 < 0n;
  const abs = negative ? -scaled5 : scaled5;
  let cents = abs / 1000n;
  if (abs % 1000n >= 500n) cents += 1n;
  return negative ? -cents : cents;
};

const centsToNumber = (cents: bigint): number => Number(cents) / 100;

const normalizeText = (value: unknown): string => (value === null || value === undefined ? "" : String(value)).replace(/\s+/g, " ").trim();

// ---------- membaca workbook ----------

type Matrix = unknown[][];

const findHeaderRow = (matrix: Matrix): number => {
  const limit = Math.min(matrix.length, 30);
  for (let i = 0; i < limit; i++) {
    const row = matrix[i] ?? [];
    if (normalizeText(row[0]).toUpperCase() === "FOLIO" && normalizeText(row[4]).toUpperCase() === "NAME" && normalizeText(row[9]).toUpperCase() === "NETT") return i;
  }
  return -1;
};

const sheetToMatrix = (sheet: XLSX.WorkSheet): Matrix => {
  const ref = sheet["!ref"];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  // Mulai dari A1 agar posisi kolom (A, E, J) dan nomor baris tetap absolut walaupun !ref tidak dimulai di A1.
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1, raw: true, defval: null, blankrows: true,
    range: { s: { r: 0, c: 0 }, e: { r: range.e.r, c: Math.max(range.e.c, 9) } },
  }) as Matrix;
};

export function parseJambuluwukWorkbook(buffer: ArrayBuffer, fileName: string): JambuluwukSource {
  const date = dateFromFileName(fileName);
  if (!date.ok) return failSource(fileName, date.error);

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "array" });
  } catch {
    return failSource(fileName, "File tidak dapat dibaca sebagai workbook Excel (.xls/.xlsx).", { dateTrans: date.date });
  }
  if (!workbook.SheetNames.length) return failSource(fileName, "Workbook tidak memiliki sheet.", { dateTrans: date.date });

  const candidates: Array<{ name: string; matrix: Matrix; headerIndex: number }> = [];
  const withoutHeader: string[] = [];
  for (const name of workbook.SheetNames) {
    const matrix = sheetToMatrix(workbook.Sheets[name]);
    const headerIndex = findHeaderRow(matrix);
    if (headerIndex >= 0) candidates.push({ name, matrix, headerIndex });
    else withoutHeader.push(name);
  }
  if (candidates.length === 0) {
    return failSource(fileName, `Struktur file tidak sesuai: tidak ada sheet dengan header kolom A=FOLIO, E=NAME, J=NETT (sheet diperiksa: ${workbook.SheetNames.join(", ")}).`, { dateTrans: date.date, ignoredSheets: withoutHeader });
  }
  if (candidates.length > 1) {
    return failSource(fileName, `Lebih dari satu sheet memiliki header transaksi (${candidates.map((c) => c.name).join(", ")}). Tidak dapat dipastikan sheet mana yang dipakai — file tidak diproses agar tidak terjadi double counting.`, { dateTrans: date.date });
  }

  const { name: sheetName, matrix, headerIndex } = candidates[0];
  const stats = emptyStats();
  const rows: JambuluwukSourceRow[] = [];

  for (let i = headerIndex + 1; i < matrix.length; i++) {
    const row = matrix[i] ?? [];
    if (row.every((cell) => cell === null || cell === undefined || String(cell).trim() === "")) {
      stats.blankRows++;
      continue;
    }
    stats.dataRows++;
    const folio = normalizeText(row[0]);
    if (folio === "") { stats.missingFolio++; continue; }
    if (/FOLIO/i.test(folio)) { stats.repeatedHeaders++; continue; }
    if (/^(grand\s+)?total\b/i.test(folio)) { stats.summaryRows++; continue; }

    const rawJ = row[9];
    let amount: bigint | null = null;
    let invalid = false;
    let rawAmount = "";
    if (rawJ !== null && rawJ !== undefined && String(rawJ).trim() !== "") {
      const text = typeof rawJ === "number" ? numberToPlain(rawJ) : String(rawJ).trim();
      rawAmount = text ?? String(rawJ);
      const plain = text !== null && /^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text.trim()) ? text : null;
      const scaled = plain === null ? null : parseDecimalScaled(plain);
      if (scaled === null) invalid = true;
      else amount = scaled;
    }
    const item = normalizeText(row[4]);
    if (!CATEGORY_FILTER.HOTEL.test(item) && !CATEGORY_FILTER.RESTO.test(item)) stats.unmatchedRows++;
    rows.push({ sheetRow: i + 1, folio, item, amount, invalid, rawAmount });
    stats.usedRows++;
  }

  return { ok: true, fileName, dateTrans: date.date, sheetName, headerRow: headerIndex + 1, ignoredSheets: withoutHeader, rows, stats };
}

// ---------- perhitungan per kategori ----------

type Accumulator = { dpp: bigint; subtotal: bigint; discount: bigint; service: bigint; tax: bigint; taxRows: number };

/** Menghitung satu kategori dari dataset sumber yang sama (tanpa upload ulang). Tidak ada data bawaan. */
export function computeJambuluwukCategory(source: JambuluwukSource, category: JambuluwukCategory): JambuluwukResult {
  const filter = CATEGORY_FILTER[category];
  const taxPattern = TAX_PATTERN[category];
  const groups = new Map<string, Accumulator>(); // kunci = folio (file sumber tunggal)
  const issues: JambuluwukIssue[] = [];
  let invalidRows = 0;
  let emptyAmountRows = 0;
  let matchedLines = 0;

  for (const row of source.ok ? source.rows : []) {
    if (!filter.test(row.item)) continue;
    if (row.invalid) {
      invalidRows++;
      issues.push({ row: row.sheetRow, message: `Folio ${row.folio} · "${row.item}": nilai kolom J "${row.rawAmount}" bukan angka valid — baris tidak dihitung.` });
      continue;
    }
    if (row.amount === null) emptyAmountRows++;
    const amount = row.amount ?? 0n;
    matchedLines++;
    let acc = groups.get(row.folio);
    if (!acc) {
      acc = { dpp: 0n, subtotal: 0n, discount: 0n, service: 0n, tax: 0n, taxRows: 0 };
      groups.set(row.folio, acc);
    }
    if (!RX_SERVICE_OR_TAX.test(row.item)) acc.dpp += amount;
    if (!RX_SERVICE_TAX_OR_DISC.test(row.item)) acc.subtotal += amount;
    if (RX_DISC.test(row.item)) acc.discount += amount;
    if (RX_SERVICE.test(row.item)) acc.service += amount;
    if (taxPattern.test(row.item)) { acc.tax += amount; acc.taxRows++; }
  }

  const date = source.dateTrans ?? "";
  const rows: JambuluwukRow[] = [];
  const totals = { subtotal: 0n, discount: 0n, service: 0n, dpp: 0n, tax: 0n, total: 0n };

  for (const [folio, acc] of groups) {
    const dpp = roundToCents(acc.dpp);
    const subtotal = roundToCents(acc.subtotal);
    const discount = roundToCents(acc.discount);
    const service = roundToCents(acc.service);
    // Ada baris Tax → pakai langsung. Tidak ada → (dpp + service) / 10, dihitung eksak di skala 5 (hasil bagi 10 dari skala 4).
    const fallbackTax = acc.taxRows === 0;
    const tax = fallbackTax ? roundScale5ToCents(acc.dpp + acc.service) : roundToCents(acc.tax);
    const total = fallbackTax ? roundScale5ToCents((acc.dpp + acc.service) * 11n) : roundToCents(acc.dpp + acc.service + acc.tax);
    totals.dpp += dpp; totals.subtotal += subtotal; totals.discount += discount;
    totals.service += service; totals.tax += tax; totals.total += total;
    rows.push({
      id_agent: JAMBULUWUK_AGENT[category],
      no_struk: `${folio}-${date}`,
      date_trans: date,
      dpp: centsToNumber(dpp),
      subtotal: centsToNumber(subtotal),
      discount: centsToNumber(discount),
      service_charge: centsToNumber(service),
      tax: centsToNumber(tax),
      total: centsToNumber(total),
      keterangan: `no folio = ${folio}`,
      namaFile: source.fileName,
      folio,
    });
  }

  return {
    category,
    rows,
    issues,
    invalidRows,
    emptyAmountRows,
    matchedLines,
    summary: {
      category,
      fileName: source.fileName,
      count: rows.length,
      subtotal: centsToNumber(totals.subtotal),
      discount: centsToNumber(totals.discount),
      service_charge: centsToNumber(totals.service),
      dpp: centsToNumber(totals.dpp),
      tax: centsToNumber(totals.tax),
      total: centsToNumber(totals.total),
    },
  };
}

export const formatJambuluwukMoney = (value: number) =>
  `Rp${value.toLocaleString("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
