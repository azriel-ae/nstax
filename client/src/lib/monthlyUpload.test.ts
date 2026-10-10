import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseUplFile, parseUplFiles } from "./uplParser";
import { parseUplMonthly } from "./uplMonthly";
import { parsePointCoffeeCsv } from "./pointcoffeParser";
import { parsePointCoffeeMonthly } from "./pointcoffeMonthly";

function xlsxFile(name: string, sheets: Record<string, unknown[][]>, lastModified = 1): File {
  const wb = XLSX.utils.book_new();
  for (const [sheetName, matrix] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(matrix), sheetName);
  const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return new File([buffer], name, { lastModified });
}

// Posisi kolom sengaja berbeda antar file (shift) untuk memastikan header tiap file dideteksi sendiri.
function kland(name: string, shift: number, n: number, parking: number, glamping?: { qty: number; tax: number; gross: number }, lastModified = 1) {
  const pad = Array.from({ length: shift }, () => "");
  const header = [...pad, "Description", "Day-qty", "Tax", "Day-Gros"];
  const rows: unknown[][] = [];
  for (let i = 0; i < n; i++) rows.push([...pad, "Activity Parking", 1, parking * 0.1, parking]);
  rows.push([...pad, "GRAND TOTAL", n, n * parking * 0.1, n * parking]);
  const sheets: Record<string, unknown[][]> = { Data: [header, ...rows] };
  if (glamping) sheets.Sheet1 = [["Nama Unit", "Day-qty", "Tax", "Day-Gros"], ["Glamping", glamping.qty, glamping.tax, glamping.gross], ["Grand Total", glamping.qty, glamping.tax, glamping.gross]];
  return xlsxFile(name, sheets, lastModified);
}

describe("parseUplMonthly", () => {
  it("combines every row of every file, uses each file's own header & Sheet1, ignores grand totals", async () => {
    const files = [
      kland("01.xlsx", 0, 3, 1000, { qty: 1, tax: 100, gross: 1000 }),
      kland("02.xlsx", 2, 5, 2000, { qty: 2, tax: 400, gross: 4000 }),
      kland("10.xlsx", 4, 4, 500),
    ];
    const res = await parseUplMonthly([files[2], files[0], files[1]]);
    expect(res.ok).toBe(true);
    // 3+1, 5+1, 4 rows
    expect(res.allMonthlyRows.length).toBe(14);
    expect(res.validation.ok).toBe(true);
    expect(res.monthlySummary.rowCount).toBe(14);
    expect(res.monthlySummary.subtotalTotal).toBe(3 * 1000 + 1000 + 5 * 2000 + 4000 + 4 * 500);
    expect(res.monthlySummary.taxTotal).toBeCloseTo(3 * 100 + 100 + 5 * 200 + 400 + 4 * 50, 6);
    expect(res.monthlySummary.quantityTotal).toBe(3 + 1 + 5 + 2 + 4);
    expect(res.monthlySummary.perCategory["PARKIR"].count).toBe(12);
    expect(res.monthlySummary.perCategory["HOTEL — GLAMPING"].count).toBe(2);
    expect(res.monthlySummary.perCategory["Tidak Terpetakan"].count).toBe(0);
    expect(res.monthlyFileResults.map((r) => r.name)).toEqual(["01.xlsx", "02.xlsx", "10.xlsx"]);
    expect(res.monthlyFileResults.map((r) => r.rowCount)).toEqual([4, 6, 4]);
  });

  it("reports a broken file without failing the whole month and excludes its rows", async () => {
    const bad = xlsxFile("03.xlsx", { Data: [["Description", "Day-qty", "Tax"], ["Activity Parking", 1, 10]] });
    const res = await parseUplMonthly([kland("01.xlsx", 0, 2, 1000), bad]);
    expect(res.ok).toBe(true);
    expect(res.monthlySummary.successFiles).toBe(1);
    expect(res.monthlySummary.failedFiles).toBe(1);
    expect(res.monthlyFileResults[1]).toMatchObject({ name: "03.xlsx", status: "error", message: "Header Day-Gros tidak ditemukan." });
    expect(res.monthlySummary.rowCount).toBe(2);
  });

  it("warns about duplicate files and does not double count them", async () => {
    const a = kland("01.xlsx", 0, 2, 1000, undefined, 77);
    const b = kland("01.xlsx", 0, 2, 1000, undefined, 77);
    const res = await parseUplMonthly([a, b]);
    expect(res.monthlySummary.duplicateFiles).toBe(1);
    expect(res.monthlyFileResults[1].message).toContain("File kemungkinan duplikat.");
    expect(res.monthlySummary.rowCount).toBe(2);
  });

  it("fails clearly when no file can be processed", async () => {
    const res = await parseUplMonthly([new File(["x"], "a.txt")]);
    expect(res.ok).toBe(false);
  });
});

describe("daily (1 file) path is untouched", () => {
  it("single-file parseUplFile / parseUplFiles give identical numbers to the monthly result for the same file", async () => {
    const f = kland("020926.xlsx", 3, 7, 1500, { qty: 1, tax: 150, gross: 1500 });
    const single = await parseUplFile(f);
    const viaFiles = await parseUplFiles([f]);
    const monthly = await parseUplMonthly([f]);
    expect(viaFiles.summary).toEqual(single.summary);
    expect(viaFiles.fullRows.length).toBe(single.fullRows.length);
    expect(monthly.monthlySummary.subtotalTotal).toBe(single.summary!.subtotalTotal);
    expect(monthly.monthlySummary.taxTotal).toBe(single.summary!.taxTotal);
    expect(monthly.monthlySummary.rowCount).toBe(single.fullRows.length);
  });
});

const HEADER = "TANGGAL|WAKTU|TOKO|NO_STRUK|SHIFT|STATION|DESKRIPSI_ITEM|DPP|PAJAK_RESTORAN";
const csv = (lines: string[], name: string, lastModified = 1) => new File([[HEADER, ...lines].join("\n")], name, { lastModified });

describe("parsePointCoffeeMonthly", () => {
  it("merges all CSV files, keeps the mapping, and makes rn globally unique", async () => {
    const f1 = csv(["2026-09-01|08:00:00|TCYN|1|1|A|Latte|10000|1000", "2026-09-01|09:00:00|TCYN|2|1|A|Tea|20000|2000"], "pc_01.csv");
    const f2 = csv(["2026-09-02|08:00:00|TCYN|1|1|A|Latte|30000|3000", "bad|row"], "pc_02.csv");
    const f3 = csv(["2026-09-03|08:00:00|TCYN|1|1|A|Latte|40000|4000"], "pc_03.csv");
    const res = await parsePointCoffeeMonthly([f3, f1, f2]);
    expect(res.ok).toBe(true);
    expect(res.allMonthlyRows.length).toBe(4);
    expect(res.monthlySummary).toMatchObject({ transactionCount: 4, subtotal: 100000, dpp: 100000, tax: 10000, total: 110000, totalFiles: 3, warningFiles: 1 });
    expect(res.validation.ok).toBe(true);
    expect(new Set(res.allMonthlyRows.map((r) => r.no_struk)).size).toBe(4);
    expect(res.allMonthlyRows[0]).toMatchObject({ no_struk: "TCYN_12026-09-0108:00:00_1", date_trans: "2026-09-01 08:00:00", keterangan: "CSV file" });
  });

  it("single-file behaviour keeps the local rn", () => {
    const r = parsePointCoffeeCsv([HEADER, "2026-09-02|08:00:00|TCYN|1|1|A|Latte|30000|3000"].join("\n"));
    expect(r.rows[0].no_struk).toBe("TCYN_12026-09-0208:00:00_1");
  });

  it("reports a file with a wrong delimiter as an error, other files still count", async () => {
    const bad = new File(["TANGGAL,WAKTU,TOKO"], "bad.csv");
    const res = await parsePointCoffeeMonthly([csv(["2026-09-01|08:00:00|TCYN|1|1|A|Latte|10000|1000"], "ok.csv"), bad]);
    expect(res.monthlySummary).toMatchObject({ successFiles: 1, failedFiles: 1, transactionCount: 1 });
  });
});
