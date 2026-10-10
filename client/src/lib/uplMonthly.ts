import { parseUplFile } from "./uplParser";
import {
  categorizeAllRows,
  createBuiltInKategoriResult,
  detectTransactionKategoriColumns,
  summarizeByCategory,
  validateCategoryTotals,
  type CategorizedUplRow,
  type CategoryBucket,
  type TransactionCategory,
} from "./kategoriMapper";
import {
  DUPLICATE_WARNING,
  findDuplicateFiles,
  sortMonthlyFiles,
  yieldToUi,
  type MonthlyFileResult,
  type MonthlyProgress,
} from "./monthlyCommon";

/**
 * Parser UPLOAD BULANAN untuk CEK KLAND.
 *
 * Modul ini SENGAJA terpisah dari jalur upload 1 file / harian. Satu-satunya
 * hal yang dipakai bersama adalah `parseUplFile` (fungsi yang sama persis dan
 * TIDAK diubah) dan fungsi kategori yang murni. Tidak ada state, dataset,
 * atau summary harian yang disentuh di sini.
 *
 * Alur:
 *  1. setiap file diparse sendiri-sendiri (header, sheet utama, Sheet1 hotel
 *     milik file itu sendiri),
 *  2. setiap file dikategorikan dengan header/kolom file itu sendiri,
 *  3. seluruh row digabung dengan push (tidak pernah menimpa),
 *  4. summary dihitung SEKALI dari allMonthlyRows lengkap, bukan dari state.
 */

export type UplMonthlyRow = CategorizedUplRow & { fileName: string; fileIndex: number };

export type UplMonthlySummary = {
  totalFiles: number;
  successFiles: number;
  warningFiles: number;
  failedFiles: number;
  duplicateFiles: number;
  /** Total data/row valid dari seluruh file. */
  rowCount: number;
  /** Total Day-qty dari seluruh row valid. */
  quantityTotal: number;
  /** Total Day-Gros dari seluruh row valid. */
  subtotalTotal: number;
  /** Total Tax dari seluruh row valid. */
  taxTotal: number;
  perCategory: Record<TransactionCategory, CategoryBucket>;
};

export type UplMonthlyValidation = {
  ok: boolean;
  sumOfFileRows: number;
  allMonthlyRowsLength: number;
  categoryError: string | null;
};

export type UplMonthlyResult = {
  ok: boolean;
  error?: string;
  monthlyFileResults: MonthlyFileResult[];
  allMonthlyRows: UplMonthlyRow[];
  monthlySummary: UplMonthlySummary;
  validation: UplMonthlyValidation;
};

/** Menghitung summary bulanan dari dataset LENGKAP (bukan dari rows yang tampil). */
export function calculateUplMonthlySummary(
  allMonthlyRows: UplMonthlyRow[],
  fileResults: MonthlyFileResult[],
): UplMonthlySummary {
  let quantityTotal = 0;
  let subtotalTotal = 0;
  let taxTotal = 0;
  for (const row of allMonthlyRows) {
    quantityTotal += row.qty ?? 1;
    subtotalTotal += row.subtotal ?? 0;
    taxTotal += row.tax ?? 0;
  }
  return {
    totalFiles: fileResults.length,
    successFiles: fileResults.filter((r) => r.status === "success").length,
    warningFiles: fileResults.filter((r) => r.status === "warning" && !r.duplicate).length,
    failedFiles: fileResults.filter((r) => r.status === "error").length,
    duplicateFiles: fileResults.filter((r) => r.duplicate).length,
    rowCount: allMonthlyRows.length,
    quantityTotal,
    subtotalTotal,
    taxTotal,
    perCategory: summarizeByCategory(allMonthlyRows),
  };
}

const emptySummary = (fileResults: MonthlyFileResult[]): UplMonthlySummary =>
  calculateUplMonthlySummary([], fileResults);

export async function parseUplMonthly(
  inputFiles: File[],
  onProgress?: (progress: MonthlyProgress) => void,
): Promise<UplMonthlyResult> {
  const files = sortMonthlyFiles(inputFiles);
  const duplicates = findDuplicateFiles(files);
  const master = createBuiltInKategoriResult();

  const monthlyFileResults: MonthlyFileResult[] = [];
  const allMonthlyRows: UplMonthlyRow[] = [];

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    onProgress?.({ done: index, total: files.length, fileName: file.name });
    await yieldToUi();

    const base = { index, name: file.name, size: file.size, lastModified: file.lastModified };

    if (!/\.(xlsx|xls)$/i.test(file.name)) {
      monthlyFileResults.push({ ...base, status: "error", message: "Hanya file Excel .xlsx atau .xls yang didukung.", warnings: [], rowCount: 0, duplicate: false });
      continue;
    }

    const originalIndex = duplicates.get(index);
    if (originalIndex !== undefined) {
      // Tidak dihitung agar tidak terjadi double counting, tetapi SELALU diberi tahu ke user.
      monthlyFileResults.push({
        ...base,
        status: "warning",
        message: `${DUPLICATE_WARNING} Identik dengan ${files[originalIndex].name} — tidak dihitung dua kali.`,
        warnings: [DUPLICATE_WARNING],
        rowCount: 0,
        duplicate: true,
        duplicateOf: files[originalIndex].name,
      });
      continue;
    }

    try {
      const parsed = await parseUplFile(file);
      if (!parsed.ok || !parsed.workbook) {
        monthlyFileResults.push({ ...base, status: "error", message: parsed.error || "Format file tidak sesuai.", warnings: parsed.warnings, rowCount: 0, duplicate: false });
        continue;
      }
      if (!parsed.mappings.some((m) => m.field === "subtotal")) {
        monthlyFileResults.push({ ...base, status: "error", message: "Header Day-Gros tidak ditemukan.", warnings: parsed.warnings, rowCount: 0, duplicate: false });
        continue;
      }

      // Kategori memakai header/kolom file ini sendiri (posisi kolom bisa berbeda antar file).
      const sourceCols = detectTransactionKategoriColumns(parsed.workbook.headerValues);
      const categorized = categorizeAllRows(parsed.fullRows, master, sourceCols);

      let qty = 0;
      let gross = 0;
      let tax = 0;
      for (const row of categorized) {
        qty += row.qty ?? 1;
        gross += row.subtotal ?? 0;
        tax += row.tax ?? 0;
        allMonthlyRows.push({ ...row, fileName: file.name, fileIndex: index });
      }

      const warnings = [...parsed.warnings];
      if (!categorized.length) warnings.push("Tidak ada baris transaksi valid pada file ini.");
      monthlyFileResults.push({
        ...base,
        status: warnings.length ? "warning" : "success",
        message: warnings.length ? warnings.join(" ") : undefined,
        warnings,
        rowCount: categorized.length,
        duplicate: false,
        qty,
        gross,
        tax,
      });
    } catch {
      monthlyFileResults.push({ ...base, status: "error", message: "File gagal dibaca.", warnings: [], rowCount: 0, duplicate: false });
    }
  }
  onProgress?.({ done: files.length, total: files.length, fileName: "" });

  // Summary dihitung dari hasil LOKAL yang lengkap (bukan dari state React).
  const monthlySummary = calculateUplMonthlySummary(allMonthlyRows, monthlyFileResults);
  const sumOfFileRows = monthlyFileResults.reduce((sum, r) => sum + r.rowCount, 0);
  const categoryError = allMonthlyRows.length ? validateCategoryTotals(allMonthlyRows, monthlySummary.perCategory) : null;
  const validation: UplMonthlyValidation = {
    ok: sumOfFileRows === allMonthlyRows.length && !categoryError,
    sumOfFileRows,
    allMonthlyRowsLength: allMonthlyRows.length,
    categoryError,
  };

  if (!monthlyFileResults.some((r) => r.status !== "error" && !r.duplicate)) {
    return {
      ok: false,
      error: "Tidak ada file yang berhasil diproses.",
      monthlyFileResults,
      allMonthlyRows: [],
      monthlySummary: emptySummary(monthlyFileResults),
      validation: { ok: false, sumOfFileRows: 0, allMonthlyRowsLength: 0, categoryError: null },
    };
  }
  return { ok: true, monthlyFileResults, allMonthlyRows, monthlySummary, validation };
}
