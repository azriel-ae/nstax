import { clean, normalizeHeader, type UplRow } from "./uplParser";

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
  "C&C",
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
  // KFOOD: tepat 12 nama sesuai daftar yang ditetapkan (ejaan, spasi, tanda hubung, & dan
  // kapitalisasi mengikuti nama aslinya). Tidak ada alias ejaan lain (mis. "KFOD").
  "K FOOD": [
    "Food OPPA KFOOD",
    "Beverage OPPA KFOOD",
    "Other OPPA KFOOD",
    "Disc Bev OPPA KFOOD",
    "Disc Food OPPA KFOOD",
    "RESTO PADI - C&C-FAR",
    "Food Resto Padi",
    "Beverage Resto padi",
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
    "Pastry & Bakery", // nama item di file sumber (kolom Description) tanpa awalan nomor
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
  // C&C hanya item berikut. Item section "3 - RESTO PADI - C&C-FAR" lain
  // (Food/Beverage Resto Padi, Disc ...) tetap di K FOOD. Item ini
  // dikeluarkan dari K FOOD agar satu baris hanya masuk satu kategori.
  // "Disc food C & C" = baris diskon khusus C&C; diperlakukan sama seperti baris diskon
  // kategori lain (nilainya ikut Day-Gros/Tax kategori dan tercatat di kolom discount record).
  "C&C": ["Food C & C", "Beverage C & C", "Disc food C & C"],
};

// Normalisasi teks untuk matching (bukan untuk tampilan)

function normalizeItemText(value: unknown): string {
  return clean(value).toLowerCase().replace(/\s+/g, " ").trim();
}

// MASTER KATEGORI: tipe hasil dan kriteria bawaan aplikasi

type MasterField = "kategori" | "account" | "company" | "subkategori";

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

// TRANSAKSI: deteksi kolom sumber kategori & matching per baris

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
  if (directDescription && master.subkategoriMap.has(directDescription)) {
    return { category: master.subkategoriMap.get(directDescription)!, matchLevel: 4 };
  }
  for (const colIndex of sourceCols.subCols) {
    const text = normalizeItemText(row.cells[colIndex] || row.description);
    if (!text) continue;
    if (master.subkategoriMap.has(text)) {
      return { category: master.subkategoriMap.get(text)!, matchLevel: 4 };
    }
  }

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
