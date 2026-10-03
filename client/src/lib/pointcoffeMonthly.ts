import { parsePointCoffeeCsv, type PointCoffeeRow } from "./pointcoffeParser";
import {
  DUPLICATE_WARNING,
  findDuplicateFiles,
  sortMonthlyFiles,
  yieldToUi,
  type MonthlyFileResult,
  type MonthlyProgress,
} from "./monthlyCommon";

/**
 * Parser UPLOAD BULANAN untuk CEK POINTCOFFE.
 *
 * Terpisah dari jalur 1 file / harian. Memakai `parsePointCoffeeCsv` yang sama
 * persis (tidak diubah): delimiter |, mapping DPP/Pajak/Total tetap.
 *
 * Satu-satunya perbedaan: nomor urut `rn` pada no_struk dibuat GLOBAL
 * (offset total baris file sebelumnya + rn lokal) supaya tiap transaksi
 * bulanan unik walau banyak file mulai dari rn=1. Pada mode 1 file `rn`
 * tetap lokal seperti sebelumnya.
 */

export type PointCoffeeMonthlyRow = PointCoffeeRow & { fileName: string; fileIndex: number };

export type PointCoffeeMonthlySummary = {
  totalFiles: number;
  successFiles: number;
  warningFiles: number;
  failedFiles: number;
  duplicateFiles: number;
  transactionCount: number;
  subtotal: number;
  dpp: number;
  tax: number;
  total: number;
};

export type PointCoffeeMonthlyResult = {
  ok: boolean;
  error?: string;
  monthlyFileResults: MonthlyFileResult[];
  allMonthlyRows: PointCoffeeMonthlyRow[];
  monthlySummary: PointCoffeeMonthlySummary;
  validation: { ok: boolean; sumOfFileRows: number; allMonthlyRowsLength: number; duplicateReceiptKeys: number };
};

export function calculatePointCoffeeMonthlySummary(
  allMonthlyRows: PointCoffeeMonthlyRow[],
  fileResults: MonthlyFileResult[],
): PointCoffeeMonthlySummary {
  let subtotal = 0;
  let dpp = 0;
  let tax = 0;
  let total = 0;
  for (const row of allMonthlyRows) {
    subtotal += row.subtotal;
    dpp += row.dpp;
    tax += row.tax;
    total += row.total;
  }
  return {
    totalFiles: fileResults.length,
    successFiles: fileResults.filter((r) => r.status === "success").length,
    warningFiles: fileResults.filter((r) => r.status === "warning" && !r.duplicate).length,
    failedFiles: fileResults.filter((r) => r.status === "error").length,
    duplicateFiles: fileResults.filter((r) => r.duplicate).length,
    transactionCount: allMonthlyRows.length,
    subtotal,
    dpp,
    tax,
    total,
  };
}

export async function parsePointCoffeeMonthly(
  inputFiles: File[],
  onProgress?: (progress: MonthlyProgress) => void,
): Promise<PointCoffeeMonthlyResult> {
  const files = sortMonthlyFiles(inputFiles);
  const duplicates = findDuplicateFiles(files);
  const monthlyFileResults: MonthlyFileResult[] = [];
  const allMonthlyRows: PointCoffeeMonthlyRow[] = [];
  let rnOffset = 0;

  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    onProgress?.({ done: index, total: files.length, fileName: file.name });
    await yieldToUi();
    const base = { index, name: file.name, size: file.size, lastModified: file.lastModified };

    if (!/\.csv$/i.test(file.name)) {
      monthlyFileResults.push({ ...base, status: "error", message: "Hanya file CSV yang didukung.", warnings: [], rowCount: 0, duplicate: false });
      continue;
    }
    const originalIndex = duplicates.get(index);
    if (originalIndex !== undefined) {
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
      const parsed = parsePointCoffeeCsv(await file.text());
      if (!parsed.ok) {
        monthlyFileResults.push({ ...base, status: "error", message: parsed.error || "Format file tidak sesuai.", warnings: parsed.warnings, rowCount: 0, duplicate: false });
        continue;
      }
      let tax = 0;
      let total = 0;
      for (const row of parsed.rows) {
        const localRn = row.sourceRow - 1; // rn lokal asli = index baris + 1
        allMonthlyRows.push({
          ...row,
          no_struk: row.no_struk.replace(/_\d+$/, `_${rnOffset + localRn}`),
          fileName: file.name,
          fileIndex: index,
        });
        tax += row.tax;
        total += row.total;
      }
      rnOffset += parsed.totalRows;
      const warnings = [...parsed.warnings];
      if (!parsed.rows.length) warnings.push("Tidak ada transaksi valid pada file ini.");
      monthlyFileResults.push({
        ...base,
        status: warnings.length ? "warning" : "success",
        message: warnings.length ? warnings.join(" ") : undefined,
        warnings,
        rowCount: parsed.rows.length,
        duplicate: false,
        tax,
        total,
      });
    } catch {
      monthlyFileResults.push({ ...base, status: "error", message: "File gagal dibaca.", warnings: [], rowCount: 0, duplicate: false });
    }
  }
  onProgress?.({ done: files.length, total: files.length, fileName: "" });

  const monthlySummary = calculatePointCoffeeMonthlySummary(allMonthlyRows, monthlyFileResults);
  const sumOfFileRows = monthlyFileResults.reduce((sum, r) => sum + r.rowCount, 0);
  const uniqueKeys = new Set(allMonthlyRows.map((r) => r.no_struk));
  const duplicateReceiptKeys = allMonthlyRows.length - uniqueKeys.size;
  const validation = { ok: sumOfFileRows === allMonthlyRows.length && duplicateReceiptKeys === 0, sumOfFileRows, allMonthlyRowsLength: allMonthlyRows.length, duplicateReceiptKeys };

  if (!monthlyFileResults.some((r) => r.status !== "error" && !r.duplicate)) {
    return {
      ok: false,
      error: "Tidak ada file yang berhasil diproses.",
      monthlyFileResults,
      allMonthlyRows: [],
      monthlySummary: calculatePointCoffeeMonthlySummary([], monthlyFileResults),
      validation: { ok: false, sumOfFileRows: 0, allMonthlyRowsLength: 0, duplicateReceiptKeys: 0 },
    };
  }
  return { ok: true, monthlyFileResults, allMonthlyRows, monthlySummary, validation };
}
