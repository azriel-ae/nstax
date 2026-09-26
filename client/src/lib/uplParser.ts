import * as XLSX from "xlsx";

/**
 * Parser khusus untuk fitur CEK UPL.
 *
 * File ini SENGAJA dibuat terpisah dari `receiptParser.ts` (yang dipakai oleh
 * CEK STRUK) agar perbaikan pada CEK UPL tidak menyentuh, mengubah, atau
 * mencampur logic/dataset milik CEK STRUK sama sekali.
 *
 * Prinsip utama:
 * - Seluruh kolom & seluruh baris worksheet dibaca berdasarkan dimensi asli
 *   workbook (bukan range hardcode, bukan slice/limit).
 * - Header dicari secara dinamis di seluruh worksheet, bukan diasumsikan
 *   selalu di baris pertama.
 * - Nilai numerik asli dari cell Excel (tipe number) selalu diprioritaskan
 *   dan TIDAK diparsing ulang sebagai teks berformat.
 * - Dataset penuh (fullRows) dipisahkan secara eksplisit dari data preview.
 *   Perhitungan (jumlah transaksi, total Day-Gros, total pajak) HANYA
 *   menggunakan fullRows, tidak pernah menggunakan subset preview.
 *
 * Target perhitungan utama CEK UPL adalah Day-Gros (bukan lagi Subtotal).
 * Kolom Day-Gros dicari berdasarkan NAMA HEADER "Day-Gros" (posisi kolom
 * bebas — bisa di kolom mana pun), lalu SELURUH nilainya dari SEMUA baris
 * transaksi dijumlahkan langsung dari Excel (tidak direkalkulasi dari total
 * atau field lain). Jika header "Day-Gros" tidak ditemukan, subtotal TIDAK
 * dipakai sebagai fallback.
 */

export const UPL_FIELDS = ["no_struk", "description", "qty", "subtotal", "tax"] as const;
export type UplField = (typeof UPL_FIELDS)[number];

export const UPL_FIELD_LABELS: Record<UplField, string> = {
  no_struk: "No Struk",
  description: "Description / Rincian",
  qty: "Day-qty",
  subtotal: "Day-Gros",
  tax: "Pajak",
};

// Alias header yang dikenali per field, dicocokkan berdasarkan NAMA HEADER
// (bukan posisi kolom). Target CEK UPL adalah Day-Gros: field "subtotal" di
// sini hanyalah nama internal/variabel lama, isinya SEKARANG hanya varian
// penulisan header "Day-Gros" (day-gros, day gros, day_gross, dst).
//
// PENTING: "subtotal" / "sub_total" SENGAJA TIDAK dimasukkan sebagai alias
// lagi. Kolom yang headernya benar-benar "Subtotal" tidak lagi dianggap
// sebagai target CEK UPL dan tidak dipakai sebagai fallback — hanya header
// "Day-Gros" (dalam berbagai varian penulisan) yang dicari. Begitu juga
// "total", "dpp", "service_charge", atau "discount" tetap tidak pernah
// dimasukkan supaya kolom-kolom tersebut tidak pernah ikut terjumlah.
const FIELD_ALIASES: Record<UplField, string[]> = {
  no_struk: [
    "no_struk",
    "nomor_struk",
    "no_receipt",
    "receipt_no",
    "receipt_number",
    "nomor_transaksi",
    "no_transaksi",
    "transaction_no",
    "transaction_id",
    "id_transaksi",
    "no_transaction",
    "struk",
    "receipt_id",
    "no_bill",
    "bill_number",
  ],
  description: ["description", "rincian", "rincian_item", "item", "keterangan"],
  qty: ["day_qty", "dayqty", "quantity", "qty"],
  subtotal: [
    "day_gross",
    "day_gros",
    "daygross",
    "daygros",
    "day_gross_total",
    "day_gros_total",
    "gross_day",
  ],
  tax: [
    "tax",
    "pajak",
    "tax_amount",
    "pajak_amount",
    "ppn",
    "vat",
    "vat_amount",
    "tax_total",
    "total_pajak",
    "nilai_pajak",
  ],
};

export type UplColumnMapping = {
  field: UplField;
  label: string;
  column: string;
  columnIndex: number;
  header: string;
  alternateColumns: string[];
};

export type UplRow = {
  sourceRow: number; // nomor baris asli di Excel (1-based)
  sourceSheet: string;
  no_struk: string;
  description: string;
  qtyRaw: string;
  qty: number | null;
  subtotalRaw: string;
  subtotal: number | null;
  taxRaw: string;
  tax: number | null;
  cells: string[]; // seluruh isi baris, selaras dengan workbook.columnNames
};

export type UplWorkbookInfo = {
  fileName: string;
  sheetNames: string[];
  activeSheet: string;
  columnNames: string[]; // A, B, C, ... AAA sesuai dimensi asli worksheet
  headerValues: string[]; // isi header per kolom, selaras dengan columnNames
  firstColumn: string;
  lastColumn: string;
  totalColumns: number;
  headerRow: number; // 1-based
  firstDataRow: number; // 1-based
  lastDataRow: number; // 1-based (baris terakhir pada worksheet, bukan hanya yang valid)
  totalSheetRows: number; // total baris pada dimensi worksheet (termasuk header & baris kosong)
};

export type UplStats = {
  totalColumnsRead: number;
  totalRowsRead: number; // seluruh baris setelah header yang benar-benar dibaca
  validTransactionRows: number;
  emptyRows: number;
  skippedRows: number; // baris footer/total/tidak relevan yang dilewati
  subtotalValidCount: number;
  subtotalInvalidCount: number;
  taxValidCount: number;
  taxInvalidCount: number;
  qtyValidCount: number;
  qtyInvalidCount: number;
  skippedBlankRows: number;
  skippedTotalRows: number;
  skippedSectionRows: number;
  activityParkingDetected: boolean;
  activityParkingQty: number | null;
  activityParkingTax: number | null;
  activityParkingGross: number | null;
};

export type UplSummary = {
  transactionCount: number;
  quantityTotal: number;
  subtotalTotal: number;
  taxTotal: number;
};

export type UplParseResult = {
  ok: boolean;
  error?: string;
  warnings: string[];
  workbook?: UplWorkbookInfo;
  mappings: UplColumnMapping[];
  stats?: UplStats;
  summary?: UplSummary;
  fullRows: UplRow[];
};

export const clean = (value: unknown): string => (value === null || value === undefined ? "" : String(value).trim());

export const normalizeHeader = (value: unknown): string =>
  clean(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

export function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * Parser angka format Indonesia.
 *
 * ATURAN PALING PENTING: jika cell Excel memang bertipe number, nilai
 * numerik asli dari cell tersebut langsung dipakai apa adanya — TIDAK
 * pernah diformat ulang lalu diparsing kembali sebagai teks. Ini yang
 * mencegah kasus "90.909 menjadi 18.930.900" akibat nilai numerik
 * dibaca ulang seolah-olah teks berformat ribuan.
 *
 * Untuk nilai berupa teks, dot (.) dianggap pemisah ribuan dan koma (,)
 * dianggap pemisah desimal, kecuali polanya jelas menunjukkan sebaliknya
 * (mis. satu titik dengan 1-2 digit di belakangnya dianggap desimal).
 */
export function parseIndonesianNumber(value: unknown): { value: number | null; wasBlank: boolean } {
  if (typeof value === "number") {
    return Number.isFinite(value) ? { value, wasBlank: false } : { value: null, wasBlank: false };
  }
  const raw = clean(value);
  if (!raw) return { value: null, wasBlank: true };

  let text = raw.replace(/rp\.?/gi, "").replace(/\s+/g, "");
  if (!text) return { value: null, wasBlank: true };

  const negative = /^-/.test(text) || /^\(.*\)$/.test(raw);
  text = text.replace(/[()]/g, "");
  text = text.replace(/[^0-9,.-]/g, "");
  if (!text || !/[0-9]/.test(text)) return { value: null, wasBlank: false };

  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      // format: 1.234.567,89 -> dot = ribuan, koma = desimal
      text = text.replace(/\./g, "").replace(",", ".");
    } else {
      // format: 1,234,567.89 -> koma = ribuan, dot = desimal
      text = text.replace(/,/g, "");
    }
  } else if (lastComma >= 0) {
    const decimals = text.length - lastComma - 1;
    text = decimals > 0 && decimals <= 2 ? text.replace(",", ".") : text.replace(/,/g, "");
  } else if (lastDot >= 0) {
    const decimals = text.length - lastDot - 1;
    const dotCount = (text.match(/\./g) ?? []).length;
    if (dotCount > 1) {
      // beberapa titik = seluruhnya pemisah ribuan, mis. 18.930.900
      text = text.replace(/\./g, "");
    } else if (!(decimals > 0 && decimals <= 2)) {
      // satu titik tapi bukan pola desimal (>2 digit di belakang) = pemisah ribuan
      text = text.replace(/\./g, "");
    }
    // jika satu titik dengan 1-2 digit di belakang, biarkan sebagai desimal
  }

  text = text.replace(/-/g, "");
  const result = Number(text);
  if (!Number.isFinite(result)) return { value: null, wasBlank: false };
  return { value: negative ? -result : result, wasBlank: false };
}

export const formatUplRupiah = (value: number) => `Rp${Math.round(value).toLocaleString("id-ID")}`;

type FieldCandidates = Record<UplField, number[]>;

function findFieldCandidates(row: unknown[]): FieldCandidates {
  const candidates: FieldCandidates = { no_struk: [], description: [], qty: [], subtotal: [], tax: [] };
  row.forEach((cell, columnIndex) => {
    const normalized = normalizeHeader(cell);
    if (!normalized) return;
    for (const field of UPL_FIELDS) {
      if (FIELD_ALIASES[field].includes(normalized)) candidates[field].push(columnIndex);
    }
  });
  return candidates;
}

const scoreCandidates = (candidates: FieldCandidates) =>
  UPL_FIELDS.reduce((score, field) => score + (candidates[field].length > 0 ? 1 : 0), 0);

// Header tidak diasumsikan selalu di baris pertama: seluruh worksheet
// (dibatasi ke 2000 baris pertama demi performa pada file yang sangat besar,
// karena pada praktiknya header selalu berada jauh di atas dataset) dipindai
// untuk mencari baris dengan kecocokan field terbanyak.
const HEADER_SCAN_LIMIT = 2000;

function locateHeaderRow(matrix: unknown[][]) {
  const scanLimit = Math.min(matrix.length, HEADER_SCAN_LIMIT);
  let bestIndex = -1;
  let bestScore = 0;
  let bestCandidates: FieldCandidates = { no_struk: [], description: [], qty: [], subtotal: [], tax: [] };
  for (let index = 0; index < scanLimit; index++) {
    const candidates = findFieldCandidates(matrix[index] ?? []);
    const score = scoreCandidates(candidates);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
      bestCandidates = candidates;
    }
  }
  return { index: bestIndex, candidates: bestCandidates, score: bestScore };
}

function buildMappings(
  headerRow: unknown[],
  candidates: FieldCandidates,
): { mappings: UplColumnMapping[]; warnings: string[] } {
  const mappings: UplColumnMapping[] = [];
  const warnings: string[] = [];
  for (const field of UPL_FIELDS) {
    const columns = candidates[field];
    if (!columns.length) continue;
    const primary = columns[0];
    mappings.push({
      field,
      label: UPL_FIELD_LABELS[field],
      column: columnLetter(primary),
      columnIndex: primary,
      header: clean(headerRow[primary]),
      alternateColumns: columns.slice(1).map(columnLetter),
    });
    if (columns.length > 1) {
      warnings.push(
        `Ditemukan ${columns.length} kolom yang cocok untuk "${UPL_FIELD_LABELS[field]}" (${columns
          .map(columnLetter)
          .join(", ")}). Kolom ${columnLetter(primary)} dipakai sebagai sumber utama — periksa kembali file jika ini tidak sesuai.`,
      );
    }
  }
  return { mappings, warnings };
}

const FOOTER_PATTERN = /^(total|grand[\s_]?total|subtotal|sub[\s_]?total|jumlah|footer|day[\s_-]?gros)\b/i;

export async function parseUplFile(file: File): Promise<UplParseResult> {
  const warnings: string[] = [];

  let workbook: XLSX.WorkBook;
  try {
    const buffer = await file.arrayBuffer();
    workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  } catch {
    return { ok: false, error: "File Excel tidak dapat dibuka. Pastikan file tidak rusak.", warnings, mappings: [], fullRows: [] };
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) {
    return { ok: false, error: "Worksheet tidak ditemukan pada workbook.", warnings, mappings: [], fullRows: [] };
  }

  // Dimensi asli worksheet (bukan asumsi/hardcode) menentukan kolom
  // pertama/terakhir dan baris pertama/terakhir yang benar-benar dibaca.
  const ref = sheet["!ref"] || "A1";
  const range = XLSX.utils.decode_range(ref);
  const totalColumns = range.e.c - range.s.c + 1;
  const totalSheetRows = range.e.r - range.s.r + 1;

  // header: 1 -> array-of-arrays mentah. raw: true -> nilai numerik asli
  // cell dipertahankan (tidak diformat ulang jadi teks). defval: "" ->
  // cell kosong dalam rentang dipastikan tetap ada (tidak membuat array
  // per baris jadi lebih pendek dari kolom aslinya).
  const matrix = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: "",
    blankrows: true,
    range: ref,
  }) as unknown[][];

  // Jaring pengaman: pastikan setiap baris benar-benar sepanjang totalColumns,
  // walaupun secara normal sheet_to_json + defval sudah menjamin ini.
  for (const row of matrix) {
    while (row.length < totalColumns) row.push("");
  }

  const { index: headerIndex, candidates, score } = locateHeaderRow(matrix);
  if (headerIndex < 0 || score === 0) {
    return {
      ok: false,
      error:
        "Header tidak ditemukan di seluruh worksheet. Pastikan file memiliki kolom No Struk, Day-Gros, dan Tax/Pajak.",
      warnings,
      mappings: [],
      fullRows: [],
    };
  }

  const headerRowValues = matrix[headerIndex] ?? [];
  const { mappings, warnings: mappingWarnings } = buildMappings(headerRowValues, candidates);
  warnings.push(...mappingWarnings);

  const noStrukCol = mappings.find((m) => m.field === "no_struk")?.columnIndex;
  const descriptionCol = mappings.find((m) => m.field === "description")?.columnIndex;
  const qtyCol = mappings.find((m) => m.field === "qty")?.columnIndex;
  const subtotalCol = mappings.find((m) => m.field === "subtotal")?.columnIndex;
  const taxCol = mappings.find((m) => m.field === "tax")?.columnIndex;

  if (subtotalCol === undefined) warnings.push("Kolom Day-Gros tidak ditemukan.");
  if (taxCol === undefined) warnings.push("Kolom Pajak tidak ditemukan pada header — total pajak tidak dapat dihitung.");
  if (descriptionCol === undefined) warnings.push("Kolom Description/Rincian tidak ditemukan — item tidak dapat dipetakan ke kategori.");

  // Dataset PENUH: seluruh baris setelah header, tanpa slice/limit apa pun.
  const dataRows = matrix.slice(headerIndex + 1);

  const fullRows: UplRow[] = [];
  let emptyRows = 0;
  let skippedRows = 0;
  let subtotalValidCount = 0;
  let subtotalInvalidCount = 0;
  let taxValidCount = 0;
  let taxInvalidCount = 0;
  let qtyValidCount = 0;
  let qtyInvalidCount = 0;
  let skippedBlankRows = 0;
  let skippedTotalRows = 0;
  let skippedSectionRows = 0;
  let activityParkingDetected = false;
  let activityParkingQty: number | null = null;
  let activityParkingTax: number | null = null;
  let activityParkingGross: number | null = null;

  dataRows.forEach((row, offset) => {
    const sourceRow = headerIndex + 2 + offset; // nomor baris Excel, 1-based
    const cells = row.map((cell) => clean(cell));

    const isBlankRow = cells.every((cell) => cell === "");
    if (isBlankRow) {
      emptyRows += 1;
      skippedBlankRows += 1;
      return;
    }

    const description = descriptionCol !== undefined ? cells[descriptionCol] ?? "" : "";
    const rowText = cells.join(" ").replace(/\s+/g, " ").trim();
    const qtyParsed = qtyCol !== undefined ? parseIndonesianNumber(row[qtyCol]) : { value: 1, wasBlank: false };
    const isSectionHeader = qtyCol !== undefined && qtyParsed.value === null && /^(\d+\s*-\s*)?(front office|prego|kfood|kfood-hanbok-canteen|resto padi|activity|activity & gate|banquet|hotel)/i.test(description);
    const isTotalRow = FOOTER_PATTERN.test(rowText) || /^(grand\s+total|t\s*o\s*t\s*a\s*l|[-_]+)$/i.test(description);
    if (isTotalRow || isSectionHeader) {
      skippedRows += 1;
      if (isTotalRow) skippedTotalRows += 1;
      else skippedSectionRows += 1;
      return;
    }

    const subtotalParsed = subtotalCol !== undefined ? parseIndonesianNumber(row[subtotalCol]) : { value: null, wasBlank: true };
    const taxParsed = taxCol !== undefined ? parseIndonesianNumber(row[taxCol]) : { value: null, wasBlank: true };

    if (subtotalCol !== undefined) {
      if (subtotalParsed.value !== null) subtotalValidCount += 1;
      else if (!subtotalParsed.wasBlank) subtotalInvalidCount += 1;
    }
    if (taxCol !== undefined) {
      if (taxParsed.value !== null) taxValidCount += 1;
      else if (!taxParsed.wasBlank) taxInvalidCount += 1;
    }
    if (qtyCol !== undefined) {
      if (qtyParsed.value !== null) qtyValidCount += 1;
      else if (!qtyParsed.wasBlank) qtyInvalidCount += 1;
    }

    const no_struk = noStrukCol !== undefined ? cells[noStrukCol] ?? "" : "";
    const hasSignal = Boolean(description) || Boolean(no_struk) || subtotalParsed.value !== null || taxParsed.value !== null;
    if (!hasSignal) {
      skippedRows += 1;
      skippedBlankRows += 1;
      return;
    }

    if (description.toLowerCase().replace(/\s+/g, " ").trim() === "activity parking") {
      activityParkingDetected = true;
      activityParkingQty = qtyParsed.value;
      activityParkingTax = taxParsed.value;
      activityParkingGross = subtotalParsed.value;
    }

    fullRows.push({
      sourceRow,
      sourceSheet: sheetName,
      no_struk,
      description,
      qtyRaw: qtyCol !== undefined ? cells[qtyCol] ?? "" : "1",
      qty: qtyParsed.value,
      subtotalRaw: subtotalCol !== undefined ? cells[subtotalCol] ?? "" : "",
      subtotal: subtotalParsed.value,
      taxRaw: taxCol !== undefined ? cells[taxCol] ?? "" : "",
      tax: taxParsed.value,
      cells,
    });
  });

  // Sheet1 is a separate source only for the two hotel unit categories. Its
  // grand total is deliberately never imported into the main dataset.
  const hotelSheetName = workbook.SheetNames.find((name) => normalizeHeader(name) === "sheet1");
  const hotelSheet = hotelSheetName ? workbook.Sheets[hotelSheetName] : undefined;
  if (hotelSheet) {
    const hotelRef = hotelSheet["!ref"] || "A1";
    const hotelRange = XLSX.utils.decode_range(hotelRef);
    const hotelMatrix = XLSX.utils.sheet_to_json(hotelSheet, { header: 1, raw: true, defval: "", blankrows: true, range: hotelRef }) as unknown[][];
    const hotelHeaderIndex = hotelMatrix.findIndex((row) => {
      const headers = row.map(normalizeHeader);
      return headers.includes("day_qty") && headers.includes("tax") && headers.some((value) => ["day_gros", "day_gross"].includes(value));
    });
    if (hotelHeaderIndex >= 0) {
      const headers = hotelMatrix[hotelHeaderIndex].map(normalizeHeader);
      const namedUnitCol = headers.findIndex((value) => ["nama_unit", "unit", "description", "name"].includes(value));
      const unitCol = namedUnitCol >= 0 ? namedUnitCol : 0;
      const hotelQtyCol = headers.indexOf("day_qty");
      const hotelTaxCol = headers.indexOf("tax");
      const hotelGrossCol = headers.findIndex((value) => ["day_gros", "day_gross"].includes(value));
      hotelMatrix.slice(hotelHeaderIndex + 1).forEach((row, offset) => {
        const description = clean(row[unitCol]);
        const normalized = description.toLowerCase().replace(/\s+/g, " ").trim();
        if (!description || !["kgallery hotel", "k gallery hotel", "glamping"].includes(normalized)) return;
        const hotelQty = parseIndonesianNumber(row[hotelQtyCol]);
        const hotelTax = parseIndonesianNumber(row[hotelTaxCol]);
        const hotelGross = parseIndonesianNumber(row[hotelGrossCol]);
        fullRows.push({
          sourceRow: hotelHeaderIndex + 2 + offset,
          sourceSheet: hotelSheetName ?? "Sheet1",
          no_struk: "",
          description,
          qtyRaw: clean(row[hotelQtyCol]),
          qty: hotelQty.value,
          subtotalRaw: clean(row[hotelGrossCol]),
          subtotal: hotelGross.value,
          taxRaw: clean(row[hotelTaxCol]),
          tax: hotelTax.value,
          cells: ["", description, clean(row[hotelQtyCol]), "", "", clean(row[hotelTaxCol]), clean(row[hotelGrossCol])],
        });
      });
    }
  }

  // Perhitungan HANYA memakai fullRows — tidak pernah memakai data preview.
  const subtotalTotal = fullRows.reduce((sum, row) => sum + (row.subtotal ?? 0), 0);
  const taxTotal = fullRows.reduce((sum, row) => sum + (row.tax ?? 0), 0);
  const quantityTotal = fullRows.reduce((sum, row) => sum + (row.qty ?? 1), 0);

  const columnNames = Array.from({ length: totalColumns }, (_, index) => columnLetter(range.s.c + index));

  const workbookInfo: UplWorkbookInfo = {
    fileName: file.name,
    sheetNames: workbook.SheetNames,
    activeSheet: sheetName,
    columnNames,
    headerValues: columnNames.map((_, index) => clean(headerRowValues[index])),
    firstColumn: columnNames[0] ?? "A",
    lastColumn: columnNames[columnNames.length - 1] ?? "A",
    totalColumns,
    headerRow: headerIndex + 1,
    firstDataRow: headerIndex + 2,
    lastDataRow: range.e.r + 1,
    totalSheetRows,
  };

  const stats: UplStats = {
    totalColumnsRead: totalColumns,
    totalRowsRead: dataRows.length,
    validTransactionRows: fullRows.length,
    emptyRows,
    skippedRows,
    subtotalValidCount,
    subtotalInvalidCount,
    taxValidCount,
    taxInvalidCount,
    qtyValidCount,
    qtyInvalidCount,
    skippedBlankRows,
    skippedTotalRows,
    skippedSectionRows,
    activityParkingDetected,
    activityParkingQty,
    activityParkingTax,
    activityParkingGross,
  };

  const summary: UplSummary = {
    transactionCount: quantityTotal,
    quantityTotal,
    subtotalTotal,
    taxTotal,
  };

  if (!fullRows.length) {
    warnings.push("Tidak ditemukan baris transaksi yang valid setelah header.");
  }

  return { ok: true, warnings, workbook: workbookInfo, mappings, stats, summary, fullRows };
}

/** Parse one or more KLAND workbooks and aggregate every valid row. */
export async function parseUplFiles(files: File[]): Promise<UplParseResult & { processedFiles: string[]; failedFiles: string[] }> {
  const processedFiles: string[] = [];
  const failedFiles: string[] = [];
  const results: UplParseResult[] = [];
  for (const file of files) {
    try {
      const parsed = await parseUplFile(file);
      if (parsed.ok) { results.push(parsed); processedFiles.push(file.name); }
      else failedFiles.push(`${file.name}: ${parsed.error || "format tidak sesuai"}`);
    } catch { failedFiles.push(`${file.name}: gagal dibaca`); }
  }
  const first = results[0];
  if (!first) return { ok: false, error: failedFiles.join("; ") || "Tidak ada file Excel yang berhasil diproses.", warnings: [], mappings: [], fullRows: [], processedFiles, failedFiles };
  const fullRows = results.flatMap((result, fileIndex) => result.fullRows.map((row) => ({ ...row, sourceSheet: `${processedFiles[fileIndex]} / ${row.sourceSheet}` })));
  const summary = results.reduce((acc, result) => ({ transactionCount: acc.transactionCount + (result.summary?.transactionCount ?? 0), quantityTotal: acc.quantityTotal + (result.summary?.quantityTotal ?? 0), subtotalTotal: acc.subtotalTotal + (result.summary?.subtotalTotal ?? 0), taxTotal: acc.taxTotal + (result.summary?.taxTotal ?? 0) }), { transactionCount: 0, quantityTotal: 0, subtotalTotal: 0, taxTotal: 0 });
  const stats = results.reduce((acc, result) => { const s = result.stats; if (!s) return acc; for (const key of ["totalColumnsRead", "totalRowsRead", "validTransactionRows", "emptyRows", "skippedRows", "subtotalValidCount", "subtotalInvalidCount", "taxValidCount", "taxInvalidCount", "qtyValidCount", "qtyInvalidCount", "skippedBlankRows", "skippedTotalRows", "skippedSectionRows"] as const) acc[key] += s[key]; acc.activityParkingDetected ||= s.activityParkingDetected; acc.activityParkingQty = s.activityParkingQty ?? acc.activityParkingQty; acc.activityParkingTax = s.activityParkingTax ?? acc.activityParkingTax; acc.activityParkingGross = s.activityParkingGross ?? acc.activityParkingGross; return acc; }, { totalColumnsRead: 0, totalRowsRead: 0, validTransactionRows: 0, emptyRows: 0, skippedRows: 0, subtotalValidCount: 0, subtotalInvalidCount: 0, taxValidCount: 0, taxInvalidCount: 0, qtyValidCount: 0, qtyInvalidCount: 0, skippedBlankRows: 0, skippedTotalRows: 0, skippedSectionRows: 0, activityParkingDetected: false, activityParkingQty: null as number | null, activityParkingTax: null as number | null, activityParkingGross: null as number | null });
  return { ...first, workbook: first.workbook ? { ...first.workbook, fileName: `${processedFiles.length} file: ${processedFiles.join(", ")}`, totalSheetRows: results.reduce((sum, result) => sum + (result.workbook?.totalSheetRows ?? 0), 0) } : undefined, fullRows, summary, stats, warnings: [...results.flatMap((result) => result.warnings), ...(failedFiles.length ? [`File gagal: ${failedFiles.join("; ")}`] : [])], processedFiles, failedFiles };
}
