import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseRestoFile, parseRestoFiles, parseRestoForMonthly, restoCrossCheck } from "./restoParser";
import type { MonthlyFileResult } from "./monthlyCommon";

function fileFromMatrix(name: string, matrix: unknown[][]): File {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), "Sheet1");
  const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  return new File([buffer], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

// Kolom: A, B=keterangan, C=(day-qty, BUKAN subtotal), D=subtotal, E=service_charge, F=tax, G=total
const sampleRows = (food: number, kfood: number): unknown[][] => [
  ["laporan"],
  [],
  ["", "1 - PREGO", "", "", "", "", ""],
  ["", "Food PREEGO", 7, food, food / 10, food / 100, food * 1.11],
  ["", " Beverage  PREEGO ", 3, 500, 50, 5, 555],
  ["", "911 Disc Food PREEGO", 1, -100, 0, 0, -100],
  ["", "2 - KFOOD-HANBOK-CANTEEN", "", "", "", "", ""],
  ["", "Food OPPA KFOOD", 9, kfood, 0, kfood / 10, kfood * 1.1],
  ["", "Disc Food Resto padi", 1, -20, 0, 0, -20],
  ["", "Food C & C", 5, 9999, 1, 2, 3],
];

describe("parseRestoFile PREGO", () => {
  it("memakai kolom B, D, E, F, G (bukan C) dan hanya item PREGO", async () => {
    const result = await parseRestoFile(fileFromMatrix("280926.xlsx", sampleRows(1000, 400)), "PREGO");
    expect(result.ok).toBe(true);
    expect(result.records.map((r) => r.keterangan)).toEqual(["Food PREEGO", "Beverage  PREEGO", "911 Disc Food PREEGO"]);
    const [food, bev, disc] = result.records;
    expect(food).toMatchObject({
      id_agent: "resto_kland_prego",
      no_struk: "TRX-KW-280926-4",
      date_trans: "2026-09-28",
      subtotal: 1000,
      service_charge: 100,
      discount: 0,
      dpp: 1100,
      tax: 10,
    });
    expect(food.total).toBeCloseTo(1110);
    expect(bev).toMatchObject({ subtotal: 500, tax: 5, total: 555 });
    expect(disc).toMatchObject({ subtotal: -100, discount: -100, dpp: -100 });
  });

  it("baris judul seksi tidak menjadi record", async () => {
    const result = await parseRestoFile(fileFromMatrix("280926.xlsx", sampleRows(1, 1)), "PREGO");
    expect(result.records.some((r) => /^\d+\s*-\s/.test(r.keterangan))).toBe(false);
  });

  it("nilai & tanggal mengikuti file, bukan hardcode", async () => {
    const result = await parseRestoFile(fileFromMatrix("151026.xlsx", sampleRows(2000, 1)), "PREGO");
    expect(result.records[0]).toMatchObject({ subtotal: 2000, service_charge: 200, dpp: 2200, date_trans: "2026-10-15", no_struk: "TRX-KW-151026-4" });
  });

  it("peringatan jika nama file bukan DDMMYY", async () => {
    const result = await parseRestoFile(fileFromMatrix("laporan.xlsx", sampleRows(1, 1)), "PREGO");
    expect(result.records[0].date_trans).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("parseRestoFile KFOOD", () => {
  it("memakai kolom B, D, E, F, G dan hanya item KFOOD (C&C & PREGO tidak ikut)", async () => {
    const result = await parseRestoFile(fileFromMatrix("280926.xlsx", sampleRows(1000, 400)), "KFOOD");
    expect(result.records.map((r) => r.keterangan)).toEqual(["Food OPPA KFOOD", "Disc Food Resto padi"]);
    const [food, disc] = result.records;
    expect(food).toMatchObject({ id_agent: "resto_kland_kfood", no_struk: "TRX-KW-280926-8", subtotal: 400, service_charge: 0, dpp: 400, tax: 40, discount: 0 });
    expect(food.total).toBeCloseTo(440);
    expect(disc).toMatchObject({ subtotal: -20, discount: -20 });
  });
});

describe("parseRestoFiles / bulanan", () => {
  it("menggabungkan SEMUA file dengan tanggal & id masing-masing", async () => {
    const files = [
      fileFromMatrix("280926.xlsx", sampleRows(1000, 1)),
      fileFromMatrix("290926.xlsx", sampleRows(2000, 1)),
      fileFromMatrix("300926.xlsx", sampleRows(3000, 1)),
    ];
    const combined = await parseRestoFiles(files, "PREGO");
    expect(combined.records).toHaveLength(9);
    expect(new Set(combined.records.map((r) => r.no_struk)).size).toBe(9);
    expect(new Set(combined.records.map((r) => r.date_trans))).toEqual(new Set(["2026-09-28", "2026-09-29", "2026-09-30"]));
    expect(combined.totals.subtotal).toBe(1000 + 500 - 100 + 2000 + 500 - 100 + 3000 + 500 - 100);
  });

  it("melewati file error/duplikat sesuai hasil dataset bulanan", async () => {
    const a = fileFromMatrix("280926.xlsx", sampleRows(1000, 1));
    const b = fileFromMatrix("290926.xlsx", sampleRows(2000, 1));
    const base = { size: 1, lastModified: 1, warnings: [], rowCount: 1 };
    const results: MonthlyFileResult[] = [
      { ...base, index: 0, name: "280926.xlsx", status: "success", duplicate: false },
      { ...base, index: 1, name: "290926.xlsx", status: "error", duplicate: false },
    ];
    const combined = await parseRestoForMonthly([b, a], results, "KFOOD");
    expect(combined.files.map((f) => f.fileName)).toEqual(["280926.xlsx"]);
  });
});

describe("restoCrossCheck", () => {
  it("tidak ada isu jika bucket cocok, ada peringatan jika berbeda", async () => {
    const result = await parseRestoFile(fileFromMatrix("280926.xlsx", sampleRows(1000, 400)), "PREGO");
    const ok = { count: 3, quantityTotal: 11, subtotalTotal: 1400, taxTotal: 15 };
    expect(restoCrossCheck("PREGO", ok, result.records)).toEqual([]);
    const bad = { count: 1, quantityTotal: 1, subtotalTotal: 1, taxTotal: 1 };
    expect(restoCrossCheck("PREGO", bad, result.records)).toHaveLength(3);
  });
});
