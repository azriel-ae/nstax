import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { columnLetter, formatUplRupiah, parseIndonesianNumber, parseUplFile } from "./uplParser";

function fileFromMatrix(name: string, matrix: unknown[][]): File {
  const worksheet = XLSX.utils.aoa_to_sheet(matrix);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1");
  const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  return new File([buffer], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

describe("parseIndonesianNumber", () => {
  it("prioritizes the raw numeric Excel value over any text formatting", () => {
    expect(parseIndonesianNumber(90909)).toMatchObject({ value: 90909 });
    expect(parseIndonesianNumber(90909.0)).toMatchObject({ value: 90909 });
  });
  it("parses Indonesian formatted text values correctly", () => {
    expect(parseIndonesianNumber("90.909")).toMatchObject({ value: 90909 });
    expect(parseIndonesianNumber("90.909,00")).toMatchObject({ value: 90909 });
    expect(parseIndonesianNumber("90909")).toMatchObject({ value: 90909 });
    expect(parseIndonesianNumber("Rp 90.909")).toMatchObject({ value: 90909 });
    expect(parseIndonesianNumber("Rp90.909")).toMatchObject({ value: 90909 });
    expect(parseIndonesianNumber("18.930.900")).toMatchObject({ value: 18930900 });
  });
  it("treats blank cells as blank, not as invalid", () => {
    expect(parseIndonesianNumber("")).toMatchObject({ value: null, wasBlank: true });
    expect(parseIndonesianNumber("   ")).toMatchObject({ value: null, wasBlank: true });
  });
  it("flags genuinely unparsable text as invalid (not blank)", () => {
    expect(parseIndonesianNumber("N/A")).toMatchObject({ value: null, wasBlank: false });
  });
});

describe("columnLetter", () => {
  it("produces Excel-style column letters up to and beyond AAA", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(702)).toBe("AAA");
  });
});

describe("parseUplFile", () => {
  it("reads every column and every row, sums subtotal/tax from the full dataset, and matches the source exactly", async () => {
    // Header sengaja diletakkan di baris ke-5 (bukan baris pertama), dan
    // kolom subtotal/tax sengaja diletakkan jauh di kanan (lewat kolom Z)
    // untuk mensimulasikan file nyata dengan ratusan kolom.
    const junkRows: unknown[][] = [
      ["LAPORAN HARIAN"],
      ["Outlet: Jakarta Pusat"],
      ["Periode: Januari 2026"],
      [],
    ];
    const junkCols = Array.from({ length: 50 }, () => "");
    const header = ["No", "Tanggal", "No Struk", ...junkCols, "Day-Gross", "Tax"];

    let expectedSubtotal = 0;
    let expectedTax = 0;
    const dataRows: unknown[][] = [];
    for (let i = 0; i < 84; i++) {
      const subtotal = 1000 + i * 37;
      const tax = Math.round(subtotal * 0.1);
      expectedSubtotal += subtotal;
      expectedTax += tax;
      dataRows.push([i + 1, "2026-01-01", `STR${1000 + i}`, ...junkCols, subtotal, tax]);
    }
    const footerRow = ["", "", "TOTAL", ...junkCols, expectedSubtotal, expectedTax];

    const matrix = [...junkRows, header, ...dataRows, footerRow, []];
    const file = fileFromMatrix("upl-sample.xlsx", matrix);

    const result = await parseUplFile(file);

    expect(result.ok).toBe(true);
    expect(result.workbook?.headerRow).toBe(5);
    expect(result.stats?.validTransactionRows).toBe(84);
    // SheetJS does not retain a trailing blank row outside the worksheet !ref.
    expect(result.stats?.emptyRows).toBe(0);
    expect(result.stats?.skippedRows).toBe(1);
    expect(result.summary?.transactionCount).toBe(84);
    expect(result.summary?.subtotalTotal).toBe(expectedSubtotal);
    expect(result.summary?.taxTotal).toBe(expectedTax);

    const subtotalMapping = result.mappings.find((m) => m.field === "subtotal");
    const taxMapping = result.mappings.find((m) => m.field === "tax");
    expect(subtotalMapping?.column).toBe("BB");
    expect(taxMapping?.column).toBe("BC");

    // Regresi spesifik dari laporan bug: subtotal tunggal 90.909 harus tetap
    // 90.909, bukan berubah menjadi 18.930.900.
    expect(formatUplRupiah(90909)).toBe("Rp90.909");
  });

  it("keeps preview data separate from calculation data — full dataset is never truncated", async () => {
    const header = ["No Struk", "Day-Gros", "Tax"];
    const dataRows: unknown[][] = [];
    let expectedSubtotal = 0;
    for (let i = 0; i < 200; i++) {
      const subtotal = 10000 + i;
      expectedSubtotal += subtotal;
      dataRows.push([`STR${i}`, subtotal, 0]);
    }
    const file = fileFromMatrix("upl-large.xlsx", [header, ...dataRows]);
    const result = await parseUplFile(file);

    expect(result.fullRows).toHaveLength(200);
    expect(result.summary?.subtotalTotal).toBe(expectedSubtotal);
  });

  it("does not sum unrelated columns (total/dpp/discount) into Day-Gros", async () => {
    const header = ["No Struk", "Day-Gros", "Discount", "DPP", "Total", "Tax"];
    const matrix = [header, ["STR1", 90909, 5000, 85909, 100000, 9091]];
    const file = fileFromMatrix("upl-columns.xlsx", matrix);
    const result = await parseUplFile(file);

    expect(result.summary?.subtotalTotal).toBe(90909);
    expect(result.summary?.taxTotal).toBe(9091);
  });

  it("reports valid vs invalid Day-Gros/tax values instead of silently coercing them", async () => {
    const header = ["No Struk", "Day-Gros", "Tax"];
    const matrix = [header, ["STR1", 90909, 9091], ["STR2", "bukan angka", 100], ["STR3", 50000, ""]];
    const file = fileFromMatrix("upl-audit.xlsx", matrix);
    const result = await parseUplFile(file);

    expect(result.stats?.subtotalValidCount).toBe(2);
    expect(result.stats?.subtotalInvalidCount).toBe(1);
    expect(result.stats?.taxValidCount).toBe(2);
    expect(result.stats?.taxInvalidCount).toBe(0);
  });

  it("fails clearly when no recognizable header exists anywhere in the sheet", async () => {
    const matrix = [
      ["random", "data", "here"],
      ["more", "random", "stuff"],
    ];
    const file = fileFromMatrix("upl-no-header.xlsx", matrix);
    const result = await parseUplFile(file);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Header tidak ditemukan/);
  });

  it("does NOT treat a column literally named 'Subtotal' as the Day-Gros target, and shows the exact warning when Day-Gros is missing", async () => {
    // No Struk dan Tax ditemukan, tapi header "Day-Gros" tidak ada sama
    // sekali — hanya ada "Subtotal". Subtotal TIDAK BOLEH dipakai sebagai
    // fallback untuk target CEK UPL.
    const header = ["No Struk", "Subtotal", "Tax"];
    const matrix = [header, ["STR1", 90909, 9091]];
    const file = fileFromMatrix("upl-subtotal-only.xlsx", matrix);
    const result = await parseUplFile(file);

    expect(result.ok).toBe(true);
    const subtotalMapping = result.mappings.find((m) => m.field === "subtotal");
    expect(subtotalMapping).toBeUndefined();
    expect(result.summary?.subtotalTotal).toBe(0);
    expect(result.warnings).toContain("Kolom Day-Gros tidak ditemukan.");
  });
});


describe("parseUplFile report layout", () => {
  it("reads Description/Day-qty by header, skips section totals, and preserves parking quantity", async () => {
    const matrix = [
      ["Art", "Description", "Day-qty", "Day-Nett", "Service", "Tax", "Day-Gros"],
      ["1", "1 - PREGO", "", "", "", "", ""],
      ["10", "Food PREEGO", 4, 90000, 9000, 10000, 100000],
      ["21", "Activity Parking", 2, 18182, 0, 1818, 20000],
      ["", "T O T A L", "", "", "", 11818, 120000],
      ["", "GRAND TOTAL", 6, "", "", 11818, 120000],
    ];
    const result = await parseUplFile(fileFromMatrix("020926.xlsx", matrix));
    expect(result.ok).toBe(true);
    expect(result.workbook?.activeSheet).toBe("Sheet1");
    expect(result.workbook?.headerValues).toContain("Description");
    expect(result.workbook?.headerValues).toContain("Day-qty");
    expect(result.stats?.validTransactionRows).toBe(2);
    expect(result.summary?.transactionCount).toBe(6);
    expect(result.summary?.subtotalTotal).toBe(120000);
    expect(result.summary?.taxTotal).toBe(11818);
    expect(result.fullRows.find((row) => row.description === "Activity Parking")).toMatchObject({ qty: 2, subtotal: 20000, tax: 1818 });
  });
});


describe("parseUplFile multi-sheet hotel source", () => {
  it("includes only Kgallery hotel and Glamping from Sheet1 without importing a grand total", async () => {
    const main = XLSX.utils.aoa_to_sheet([
      ["Report"],
      ["Art", "Description", "Day-qty", "Day-Nett", "Service", "Tax", "Day-Gros"],
      ["21", "Activity Parking", 2, 18182, 0, 1818, 20000],
      ["", "GRAND TOTAL", 2, "", "", 1818, 20000],
    ]);
    const hotel = XLSX.utils.aoa_to_sheet([
      ["Nama Unit", "Day-qty", "Day-Nett", "Service", "Tax", "Day-Gros"],
      ["Kgallery hotel", 5, 3300826, 330083, 363091, 3994000],
      ["Glamping", 0, 0, 0, 0, 0],
      ["GRAND TOTAL", 5, 3300826, 330083, 363091, 3994000],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, main, "TO 020926");
    XLSX.utils.book_append_sheet(workbook, hotel, "Sheet1");
    const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    const result = await parseUplFile(new File([buffer], "020926.xlsx"));
    expect(result.summary?.transactionCount).toBe(7);
    expect(result.fullRows.filter((row) => row.sourceSheet === "Sheet1")).toHaveLength(2);
    expect(result.fullRows.find((row) => row.description === "Kgallery hotel")).toMatchObject({ qty: 5, subtotal: 3994000, tax: 363091 });
    expect(result.fullRows.find((row) => row.description === "Glamping")).toMatchObject({ qty: 0, subtotal: 0, tax: 0 });
    expect(result.fullRows.some((row) => row.description === "GRAND TOTAL")).toBe(false);
  });
});
