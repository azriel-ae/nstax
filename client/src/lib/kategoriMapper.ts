import * as XLSX from "xlsx";
import { clean, columnLetter, normalizeHeader, type UplRow } from "./uplParser";

/**
 * Modul KATEGORI untuk CEK UPL.
 *
 * File ini SENGAJA dibuat terpisah dari `uplParser.ts` agar penambahan fitur
 * kategori tidak menyentuh atau mengubah logic pembacaan/perhitungan
 * Day-Gros & Tax yang sudah berjalan di CEK UPL. `uplParser.ts` hanya
 * dipinjam fungsi utilitasnya (clean, normalizeHeader, columnLetter) dan
 * tipe `UplRow` — tidak ada baris logic di `uplParser.ts` yang diubah oleh
 * modul ini selain menambahkan kata kunci `export` pada dua util tersebut.
 *
 * Prinsip utama pemetaan kategori:
 * - Kategori tidak pernah ditentukan dari posisi/index/nomor baris.
 * - Kategori dicari dari NAMA HEADER file transaksi (account/outlet/company/
 *   category/kategori/description/keterangan/item/subcategory), lalu
 *   dicocokkan terhadap MASTER KATEGORI yang diupload user.
 * - Matching bersifat deterministic & dapat diaudit: LEVEL 1 (account/kode)
 *   -> LEVEL 2 (nama perusahaan/unit/outlet) -> LEVEL 3 (kolom kategori
 *   langsung pada file transaksi) -> LEVEL 4 (subkategori/keterangan).
 * - Tidak ada fuzzy matching agresif. Kecocokan hanya berdasarkan nilai
 *   ter-normalisasi yang persis sama (atau, khusus LEVEL 2, kecocokan
 *   substring yang tidak ambigu).
 * - Satu transaksi berhenti pada level match PERTAMA yang cocok, sehingga
 *   satu transaksi tidak pernah dihitung ke lebih dari satu kategori.
 * - Jika tidak dapat dipastikan, transaksi ditandai "Tidak Terpetakan" —
 *   tidak pernah dipaksakan masuk ke salah satu dari 4 kategori utama.
 */

export const MAIN_CATEGORIES = [
  "HOTEL — K GALLERY",
  "HOTEL — GLAMPING",
  "K FOOD",
  "RESTO PREGO",
  "HIBURAN — MESIN CAPIT",
  "HIBURAN — KLAND HIBURAN",
  "HIBURAN — WATER SLIDE",
  "PARKIR",
] as const;
export type MainCategory = (typeof MAIN_CATEGORIES)[number];
export const UNMAPPED_LABEL = "Tidak Terpetakan" as const;
export type TransactionCategory = MainCategory | typeof UNMAPPED_LABEL;
export type CategoryFilter = MainCategory | "ALL";

/**
 * Kriteria kategori bawaan aplikasi. User cukup memilih kategori; tidak perlu
 * mengunggah file master. Nilai ini sengaja dipisah per kategori agar satu
 * kelompok usaha tidak pernah otomatis masuk ke kelompok lain.
 */
export const BUILT_IN_CATEGORY_CRITERIA: Record<MainCategory, string[]> = {
  // These entries are exact master-item keys. Matching never falls back to
  // account, code, company, outlet, or a generic keyword.
  "HOTEL — K GALLERY": ["K Gallery Hotel", "Kgallery Hotel"],
  "HOTEL — GLAMPING": ["Glamping"],
  "K FOOD": [
    "2 - KFOOD-HANBOK-CANTEEN",
    "Food OPPA KFOOD",
    "Beverage OPPA KFOOD",
    "Other OPPA KFOOD",
    "3 - RESTO PADI - C&C-FAR",
    "Food Resto Padi",
    "Beverage Resto padi",
    "Food C & C",
    "Beverage C & C",
    "FOOD ZONE",
    "MP OPPA K FOOD",
    "Disc Food Resto padi",
    "Disc Bev Resto padi",
  ],
  "RESTO PREGO": [
    "1 - PREGO",
    "10 Food PREEGO",
    "Food PREEGO",
    "11 Beverage PREEGO",
    "Beverage PREEGO",
    "12 B'fast PREEGO",
    "B'fast PREEGO",
    "14 Dinner PREEGO",
    "Dinner PREEGO",
    "25 Pastry & Bakery",
    "30 Other PREEGO",
    "Other PREEGO",
    "911 Disc Food PREEGO",
    "Disc Food PREEGO",
    "912 Disc Bev PREEGO.",
    "912 Disc Bev PREEGO",
    "Disc Bev PREEGO.",
    "Disc Bev PREEGO",
    "11 - BANQUET",
    "Food BANQUET",
    "Beverage BANQUET",
    "Other BANQUET",
    "Room Rental",
  ],
  "HIBURAN — MESIN CAPIT": ["Other REST No Serv"],
  "HIBURAN — KLAND HIBURAN": [
    "Activity Sport",
    "Activity Nature",
    "Activity Culture",
    "Activity Outbound",
    "Activity Tour",
    "Activity Education",
    "Activity Merchandise",
    "Activity Other Revenue",
    "Disc ACTIVITY",
    "22 Activity Sport",
    "23 Activity Nature",
    "24 Activity Culture",
    "25 Activity Outbound",
    "26 Activity Tour",
    "27 Activity Education",
    "29 Activity Merchandise",
    "31 Activity Other Revenue",
    "911 Disc ACTIVITY",
  ],
  "HIBURAN — WATER SLIDE": ["Activity Entry Gate", "20 Activity Entry Gate", "Disc waterslide", "914 Disc waterslide"],
  PARKIR: ["Activity Parking", "21 Activity Parking"],
};

// ------------------------------------------------------------------------
// Normalisasi teks untuk matching (bukan untuk tampilan)
// ------------------------------------------------------------------------

function normalizeIdentifier(value: unknown): string {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(Math.trunc(value) === value ? Math.trunc(value) : value) : "";
  }
  const raw = clean(value);
  if (!raw) return "";
  return raw.replace(/\s+/g, "").toUpperCase();
}

function normalizeMatchText(value: unknown): string {
  return clean(value)
    .toUpperCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function normalizeItemText(value: unknown): string {
  return clean(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeCategoryLabel(value: unknown): MainCategory | null {
  const norm = normalizeMatchText(value).replace(/\s+/g, "");
  if (!norm) return null;
  return (MAIN_CATEGORIES as readonly string[]).some((label) => normalizeMatchText(label).replace(/\s+/g, "") === norm)
    ? (MAIN_CATEGORIES.find((label) => normalizeMatchText(label).replace(/\s+/g, "") === norm) as MainCategory)
    : null;
}

// ------------------------------------------------------------------------
// MASTER KATEGORI: parsing file Excel master
// ------------------------------------------------------------------------

type MasterField = "kategori" | "account" | "company" | "subkategori";

// Alias header master kategori dicari berdasarkan NAMA HEADER, bukan posisi
// kolom. "no" / "nomor" polos SENGAJA TIDAK dimasukkan sebagai alias account
// karena pada banyak file itu adalah kolom nomor urut baris, bukan kode
// account — memasukkannya akan melanggar aturan "jangan gunakan nomor baris
// untuk menentukan kategori".
const MASTER_FIELD_ALIASES: Record<MasterField, string[]> = {
  kategori: ["kategori", "category", "kategori_utama", "main_category", "maincategory"],
  account: [
    "account",
    "account_id",
    "account_no",
    "accountno",
    "no_account",
    "account_number",
    "kode_account",
    "kode",
    "code",
    "billing_id",
    "nomor_account",
  ],
  company: [
    "nama_perusahaan",
    "perusahaan",
    "company",
    "company_name",
    "unit",
    "nama_unit",
    "outlet",
    "outlet_name",
    "nama_company",
    "nama_unit_perusahaan",
    "nama_perusahaan_unit",
  ],
  subkategori: [
    "subkategori",
    "sub_kategori",
    "keterangan",
    "description",
    "item",
    "subcategory",
    "sub_category",
    "sub_kategori_transaksi",
  ],
};

const MASTER_HEADER_SCAN_LIMIT = 500;

type MasterFieldCandidates = Record<MasterField, number[]>;

function findMasterFieldCandidates(row: unknown[]): MasterFieldCandidates {
  const candidates: MasterFieldCandidates = { kategori: [], account: [], company: [], subkategori: [] };
  row.forEach((cell, columnIndex) => {
    const normalized = normalizeHeader(cell);
    if (!normalized) return;
    (Object.keys(MASTER_FIELD_ALIASES) as MasterField[]).forEach((field) => {
      if (MASTER_FIELD_ALIASES[field].includes(normalized)) candidates[field].push(columnIndex);
    });
  });
  return candidates;
}

export type MasterKategoriMapping = {
  field: MasterField;
  label: string;
  column: string;
  columnIndex: number;
  header: string;
};

export type MasterKategoriRow = {
  sourceRow: number; // nomor baris asli di file master (1-based)
  kategori: MainCategory;
  account: string;
  company: string;
  subkategori: string;
};

export type MasterKategoriResult = {
  ok: boolean;
  error?: string;
  warnings: string[];
  fileName?: string;
  mappings: MasterKategoriMapping[];
  rows: MasterKategoriRow[];
  totalDataRows: number;
  invalidKategoriRows: number;
  accountMap: Map<string, MainCategory>;
  companyMap: Map<string, MainCategory>;
  subkategoriMap: Map<string, MainCategory>;
};

const emptyMasterResult = (
  overrides: Partial<MasterKategoriResult> & { ok: boolean; warnings: string[] },
): MasterKategoriResult => ({
  ok: overrides.ok,
  error: overrides.error,
  warnings: overrides.warnings,
  fileName: overrides.fileName,
  mappings: overrides.mappings ?? [],
  rows: overrides.rows ?? [],
  totalDataRows: overrides.totalDataRows ?? 0,
  invalidKategoriRows: overrides.invalidKategoriRows ?? 0,
  accountMap: overrides.accountMap ?? new Map(),
  companyMap: overrides.companyMap ?? new Map(),
  subkategoriMap: overrides.subkategoriMap ?? new Map(),
});

export function createBuiltInKategoriResult(): MasterKategoriResult {
  const companyMap = new Map<string, MainCategory>();
  const subkategoriMap = new Map<string, MainCategory>();
  const rows: MasterKategoriRow[] = [];
  let sourceRow = 1;
  (Object.keys(BUILT_IN_CATEGORY_CRITERIA) as MainCategory[]).forEach((kategori) => {
    BUILT_IN_CATEGORY_CRITERIA[kategori].forEach((label) => {
      const key = normalizeItemText(label);
      subkategoriMap.set(key, kategori);
      rows.push({ sourceRow: sourceRow++, kategori, account: "", company: "", subkategori: label });
    });
  });
  return {
    ok: true,
    warnings: [],
    fileName: "Kriteria kategori bawaan aplikasi",
    mappings: [],
    rows,
    totalDataRows: rows.length,
    invalidKategoriRows: 0,
    accountMap: new Map(),
    companyMap,
    subkategoriMap,
  };
}

export async function parseMasterKategoriFile(file: File): Promise<MasterKategoriResult> {
  const warnings: string[] = [];

  let workbook: XLSX.WorkBook;
  try {
    const buffer = await file.arrayBuffer();
    workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  } catch {
    return emptyMasterResult({
      ok: false,
      error: "File Excel master kategori tidak dapat dibuka. Pastikan file tidak rusak.",
      warnings,
    });
  }

  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) {
    return emptyMasterResult({ ok: false, error: "Worksheet master kategori tidak ditemukan pada workbook.", warnings });
  }

  const ref = sheet["!ref"] || "A1";
  const matrix = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: "",
    blankrows: true,
    range: ref,
  }) as unknown[][];

  const scanLimit = Math.min(matrix.length, MASTER_HEADER_SCAN_LIMIT);
  let headerIndex = -1;
  let bestScore = 0;
  let bestCandidates: MasterFieldCandidates = { kategori: [], account: [], company: [], subkategori: [] };
  for (let index = 0; index < scanLimit; index++) {
    const candidates = findMasterFieldCandidates(matrix[index] ?? []);
    if (candidates.kategori.length === 0) continue; // kolom Kategori wajib ada untuk baris header yang valid
    const score = (Object.keys(candidates) as MasterField[]).reduce(
      (sum, field) => sum + (candidates[field].length > 0 ? 1 : 0),
      0,
    );
    if (score > bestScore) {
      bestScore = score;
      headerIndex = index;
      bestCandidates = candidates;
    }
  }

  if (headerIndex < 0 || bestCandidates.kategori.length === 0) {
    return emptyMasterResult({
      ok: false,
      error: "Kolom Kategori tidak ditemukan pada file master kategori.",
      warnings,
    });
  }

  const headerRowValues = matrix[headerIndex] ?? [];
  const kategoriCol = bestCandidates.kategori[0];
  const accountCol = bestCandidates.account[0];
  const companyCol = bestCandidates.company[0];
  const subCol = bestCandidates.subkategori[0];

  const mappings: MasterKategoriMapping[] = [];
  const pushMapping = (field: MasterField, label: string, colIndex: number | undefined) => {
    if (colIndex === undefined) return;
    mappings.push({ field, label, column: columnLetter(colIndex), columnIndex: colIndex, header: clean(headerRowValues[colIndex]) });
  };
  pushMapping("kategori", "Kategori", kategoriCol);
  pushMapping("account", "Account", accountCol);
  pushMapping("company", "Nama Perusahaan/Unit", companyCol);
  pushMapping("subkategori", "Subkategori/Keterangan", subCol);

  const dataRows = matrix.slice(headerIndex + 1);
  const rows: MasterKategoriRow[] = [];
  const accountMap = new Map<string, MainCategory>();
  const companyMap = new Map<string, MainCategory>();
  const subkategoriMap = new Map<string, MainCategory>();
  const conflictKeys = new Set<string>();
  let invalidKategoriRows = 0;

  const setOrFlagConflict = (
    map: Map<string, MainCategory>,
    rawValue: unknown,
    normalize: (v: unknown) => string,
    kategori: MainCategory,
  ) => {
    const key = normalize(rawValue);
    if (!key) return;
    if (map.has(key) && map.get(key) !== kategori) {
      conflictKeys.add(key);
      return;
    }
    if (!conflictKeys.has(key)) map.set(key, kategori);
  };

  dataRows.forEach((row, offset) => {
    const sourceRow = headerIndex + 2 + offset;
    const isBlank = row.every((cell) => clean(cell) === "");
    if (isBlank) return;

    const kategori = normalizeCategoryLabel(row[kategoriCol]);
    if (!kategori) {
      if (clean(row[kategoriCol]) !== "") invalidKategoriRows += 1;
      return;
    }

    const accountRaw = accountCol !== undefined ? clean(row[accountCol]) : "";
    const companyRaw = companyCol !== undefined ? clean(row[companyCol]) : "";
    const subRaw = subCol !== undefined ? clean(row[subCol]) : "";

    rows.push({ sourceRow, kategori, account: accountRaw, company: companyRaw, subkategori: subRaw });

    if (accountCol !== undefined) setOrFlagConflict(accountMap, row[accountCol], normalizeIdentifier, kategori);
    if (companyCol !== undefined) setOrFlagConflict(companyMap, row[companyCol], normalizeMatchText, kategori);
    if (subCol !== undefined) setOrFlagConflict(subkategoriMap, row[subCol], normalizeMatchText, kategori);
  });

  conflictKeys.forEach((key) => {
    accountMap.delete(key);
    companyMap.delete(key);
    subkategoriMap.delete(key);
    warnings.push(
      `Konflik pemetaan kategori untuk "${key}" pada master kategori — ditemukan lebih dari satu kategori berbeda untuk key yang sama, sehingga key ini diabaikan agar tidak salah kategori.`,
    );
  });

  if (invalidKategoriRows > 0) {
    warnings.push(
      `${invalidKategoriRows.toLocaleString("id-ID")} baris pada master kategori memiliki nilai Kategori yang tidak dikenali (bukan HOTEL/RESTORAN/HIBURAN/PARKIR) dan dilewati.`,
    );
  }

  if (!rows.length) {
    return emptyMasterResult({
      ok: false,
      error: "Tidak ditemukan baris kategori yang valid pada file master kategori.",
      warnings,
      mappings,
    });
  }

  return {
    ok: true,
    warnings,
    fileName: file.name,
    mappings,
    rows,
    totalDataRows: dataRows.length,
    invalidKategoriRows,
    accountMap,
    companyMap,
    subkategoriMap,
  };
}

// ------------------------------------------------------------------------
// TRANSAKSI: deteksi kolom sumber kategori & matching per baris
// ------------------------------------------------------------------------

// Alias field pada file TRANSAKSI (bukan file master) — persis mengikuti
// daftar field yang diminta: account, account_id, account_no, billing_id,
// outlet, outlet_name, company, company_name, category, kategori,
// description, keterangan, item, subcategory.
const TRANSACTION_ACCOUNT_ALIASES = ["account", "account_id", "account_no", "billing_id"];
const TRANSACTION_COMPANY_ALIASES = ["outlet", "outlet_name", "company", "company_name"];
const TRANSACTION_CATEGORY_ALIASES = ["category", "kategori"];
const TRANSACTION_SUB_ALIASES = ["rincian", "rincian_item", "description", "keterangan", "item", "subcategory", "sub_category"];

export type TransactionSourceColumns = {
  accountCols: number[];
  companyCols: number[];
  categoryCols: number[];
  subCols: number[];
};

// Kolom sumber kategori pada file transaksi dicari berdasarkan NAMA HEADER
// (workbook.headerValues), sama seperti prinsip pembacaan Day-Gros/Tax —
// bukan berdasarkan posisi/index kolom.
export function detectTransactionKategoriColumns(headerValues: string[]): TransactionSourceColumns {
  const accountCols: number[] = [];
  const companyCols: number[] = [];
  const categoryCols: number[] = [];
  const subCols: number[] = [];
  headerValues.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    if (!normalized) return;
    if (TRANSACTION_ACCOUNT_ALIASES.includes(normalized)) accountCols.push(index);
    if (TRANSACTION_COMPANY_ALIASES.includes(normalized)) companyCols.push(index);
    if (TRANSACTION_CATEGORY_ALIASES.includes(normalized)) categoryCols.push(index);
    if (TRANSACTION_SUB_ALIASES.includes(normalized)) subCols.push(index);
  });
  return { accountCols, companyCols, categoryCols, subCols };
}

export type CategoryMatch = { category: TransactionCategory; matchLevel: 0 | 1 | 2 | 3 | 4 };

/**
 * Cocokkan SATU baris transaksi hanya dari kolom Rincian/Item terhadap
 * master-item. Semua kolom identitas lain sengaja diabaikan agar account,
 * code, perusahaan, dan unit kerja tidak dapat mengganti kategori.
 */
export function categorizeTransactionRow(
  row: UplRow,
  master: MasterKategoriResult,
  sourceCols: TransactionSourceColumns,
): CategoryMatch {
  const directDescription = normalizeItemText(row.description);
  const isPregoDebugRow = /preego|prego|banquet|room rental/i.test(row.description);
  if (directDescription && master.subkategoriMap.has(directDescription)) {
    if (directDescription === "activity parking") {
      console.debug("CEK UPL category match", {
        rawDescription: row.description,
        normalizedDescription: directDescription,
        matchedCategory: master.subkategoriMap.get(directDescription),
      });
    }
    const category = master.subkategoriMap.get(directDescription)!;
    if (isPregoDebugRow) console.debug("PREGO MATCH DEBUG", { rawDescription: row.description, normalizedDescription: directDescription, matchedCategory: category, qty: row.qty, tax: row.tax, subtotal: row.subtotal, sourceSheet: row.sourceSheet, sourceRow: row.sourceRow });
    return { category, matchLevel: 4 };
  }
  if (directDescription === "activity parking") {
    console.debug("CEK UPL category match failed", {
      rawDescription: row.description,
      normalizedDescription: directDescription,
      matchedCategory: UNMAPPED_LABEL,
      availableMappingKeys: Array.from(master.subkategoriMap.keys()),
    });
  }
  for (const colIndex of sourceCols.subCols) {
    const text = normalizeItemText(row.cells[colIndex] || row.description);
    if (!text) continue;
    if (master.subkategoriMap.has(text)) {
      const category = master.subkategoriMap.get(text)!;
      if (isPregoDebugRow) console.debug("PREGO MATCH DEBUG", { rawDescription: row.description, normalizedDescription: text, matchedCategory: category, qty: row.qty, tax: row.tax, subtotal: row.subtotal, sourceSheet: row.sourceSheet, sourceRow: row.sourceRow });
      return { category, matchLevel: 4 };
    }
  }

  if (isPregoDebugRow) console.debug("PREGO MATCH DEBUG", { rawDescription: row.description, normalizedDescription: directDescription, matchedCategory: UNMAPPED_LABEL, qty: row.qty, tax: row.tax, subtotal: row.subtotal, sourceSheet: row.sourceSheet, sourceRow: row.sourceRow, availableMappingKeys: Array.from(master.subkategoriMap.keys()).filter((key) => /prego|banquet|room rental/.test(key)) });
  return { category: UNMAPPED_LABEL, matchLevel: 0 };
}

export type CategorizedUplRow = UplRow & CategoryMatch;

// Kategorisasi WAJIB memakai fullRows (dataset penuh), tidak pernah preview.
export function categorizeAllRows(
  fullRows: UplRow[],
  master: MasterKategoriResult,
  sourceCols: TransactionSourceColumns,
): CategorizedUplRow[] {
  return fullRows.map((row) => ({ ...row, ...categorizeTransactionRow(row, master, sourceCols) }));
}

export type CategoryBucket = { count: number; quantityTotal: number; subtotalTotal: number; taxTotal: number };

export function summarizeByCategory(categorizedRows: CategorizedUplRow[]): Record<TransactionCategory, CategoryBucket> {
  const perCategory = {} as Record<TransactionCategory, CategoryBucket>;
  const allLabels: TransactionCategory[] = [...MAIN_CATEGORIES, UNMAPPED_LABEL];
  allLabels.forEach((label) => {
    perCategory[label] = { count: 0, quantityTotal: 0, subtotalTotal: 0, taxTotal: 0 };
  });
  for (const row of categorizedRows) {
    const bucket = perCategory[row.category];
    bucket.count += 1;
    bucket.quantityTotal += row.qty ?? 1;
    bucket.subtotalTotal += row.subtotal ?? 0;
    bucket.taxTotal += row.tax ?? 0;
  }
  return perCategory;
}

export function filterRowsByCategory(categorizedRows: CategorizedUplRow[], selected: CategoryFilter): CategorizedUplRow[] {
  if (selected === "ALL") return categorizedRows;
  return categorizedRows.filter((row) => row.category === selected);
}

/**
 * Validasi item 13: jumlah HOTEL + RESTORAN + HIBURAN + PARKIR + Tidak
 * Terpetakan harus sama dengan seluruh transaksi valid. Karena algoritma di
 * atas hanya mengembalikan SATU kategori per baris (berhenti pada match
 * pertama), kesamaan ini terjamin secara struktural — fungsi ini tetap
 * dijalankan sebagai validasi eksplisit/dapat diaudit, bukan diasumsikan.
 */
export function validateCategoryTotals(
  categorizedRows: CategorizedUplRow[],
  perCategory: Record<TransactionCategory, CategoryBucket>,
): string | null {
  const allLabels: TransactionCategory[] = [...MAIN_CATEGORIES, UNMAPPED_LABEL];
  const sum = allLabels.reduce((total, label) => total + perCategory[label].count, 0);
  if (sum !== categorizedRows.length) {
    return `Validasi kategori gagal: total per-kategori (${sum.toLocaleString("id-ID")}) tidak sama dengan total transaksi valid (${categorizedRows.length.toLocaleString("id-ID")}). Hasil kategori tidak ditampilkan sampai ini diperbaiki.`;
  }
  return null;
}
