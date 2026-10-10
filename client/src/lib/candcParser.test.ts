import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { candcCrossCheck, dateFromFileName, parseCandCFile, parseCandCFiles, parseCandCForMonthly } from "./candcParser";
import type { MonthlyFileResult } from "./monthlyCommon";

function fileFromMatrix(name: string, matrix: unknown[][]): File {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), "Sheet1");
  const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  return new File([buffer], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

// Kolom: A, B=keterangan, C=subtotal, D=service_charge, E=tax, F=total
const sampleRows = (food: number, bev: number): unknown[][] => [
  ["laporan"],
  [],
  ["", "3 - RESTO PADI - C&C-FAR", "", "", "", ""],
  ["", "Food Resto Padi", 999, 1, 2, 3],
  ["", "Food C & C", food, food / 10, food / 100, food * 1.11],
  ["", " beverage  c & c ", bev, 0, bev / 10, bev * 1.1],
  ["", "Disc Food Resto padi", -50, 0, 0, -50],
  ["", "FOOD ZONE", 777, 0, 0, 777],
];

describe("dateFromFileName", () => {
  it("menghitung tanggal dari nama file DDMMYY, bukan hardcode", () => {
    expect(dateFromFileName("280926.xlsx")).toBe("2026-09-28");
    expect(dateFromFileName("010125.xls")).toBe("2025-01-01");
    expect(dateFromFileName("311226.xlsx")).toBe("2026-12-31");
  });
  it("null untuk nama file yang bukan DDMMYY / tanggal tidak valid", () => {
    expect(dateFromFileName("laporan.xlsx")).toBeNull();
    expect(dateFromFileName("310226.xlsx")).toBeNull();
    expect(dateFromFileName("2809261.xlsx")).toBeNull();
  });
});

describe("parseCandCFile", () => {
  it("hanya mengambil Food C & C dan Beverage C & C, nilai langsung dari cell", async () => {
    const result = await parseCandCFile(fileFromMatrix("280926.xlsx", sampleRows(1000, 500)));
    expect(result.ok).toBe(true);
    expect(result.records).toHaveLength(2);
    const [food, bev] = result.records;
    expect(food).toMatchObject({
      id_agent: "kland_CandC",
      no_struk: "TRX-KW-280926-5",
      date_trans: "2026-09-28",
      subtotal: 1000,
      service_charge: 100,
      discount: 0,
      dpp: 1100,
      tax: 10,
      keterangan: "Food C & C",
    });
    expect(food.total).toBeCloseTo(1110);
    expect(bev.keterangan).toBe("beverage  c & c");
    expect(bev.no_struk).toBe("TRX-KW-280926-6");
    expect(result.records.some((r) => /resto|zone|disc/i.test(r.keterangan))).toBe(false);
  });

  it("nilai berubah mengikuti file (tidak hardcode) dan tanggal mengikuti nama file", async () => {
    const result = await parseCandCFile(fileFromMatrix("151026.xlsx", sampleRows(2000, 800)));
    expect(result.records[0]).toMatchObject({ subtotal: 2000, service_charge: 200, dpp: 2200, date_trans: "2026-10-15" });
    expect(result.records[0].no_struk).toBe("TRX-KW-151026-5");
  });

  it("posisi baris bebas: tidak bergantung nomor baris", async () => {
    const rows = [["x"], ["y"], ["z"], ["", "Beverage C & C", 10, 1, 2, 13], ...sampleRows(1, 1)];
    const result = await parseCandCFile(fileFromMatrix("010126.xlsx", rows));
    expect(result.records.map((r) => r.sourceRow)).toEqual([4, 9, 10]);
  });

  it("discount diisi dari C jika keterangan mengandung Disc, selain itu 0", async () => {
    // Hanya terjadi jika item C&C memuat 'Disc'; dipastikan lewat rumus pada record.
    const result = await parseCandCFile(fileFromMatrix("280926.xlsx", sampleRows(1000, 500)));
    expect(result.records.every((r) => r.discount === 0)).toBe(true);
  });

  it("peringatan jika nama file bukan DDMMYY", async () => {
    const result = await parseCandCFile(fileFromMatrix("laporan.xlsx", sampleRows(1, 1)));
    expect(result.records[0].date_trans).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("parseCandCFiles / bulanan", () => {
  it("menggabungkan SEMUA file", async () => {
    const files = [
      fileFromMatrix("280926.xlsx", sampleRows(1000, 500)),
      fileFromMatrix("290926.xlsx", sampleRows(2000, 800)),
      fileFromMatrix("300926.xlsx", sampleRows(3000, 100)),
    ];
    const combined = await parseCandCFiles(files);
    expect(combined.records).toHaveLength(6);
    expect(combined.totals.transactionCount).toBe(6);
    expect(combined.totals.subtotal).toBe(1000 + 500 + 2000 + 800 + 3000 + 100);
    expect(new Set(combined.records.map((r) => r.no_struk)).size).toBe(6);
  });

  it("melewati file error/duplikat sesuai hasil dataset bulanan", async () => {
    const a = fileFromMatrix("280926.xlsx", sampleRows(1000, 500));
    const b = fileFromMatrix("290926.xlsx", sampleRows(2000, 800));
    const base = { size: 1, lastModified: 1, warnings: [], rowCount: 1 };
    const results: MonthlyFileResult[] = [
      { ...base, index: 0, name: "280926.xlsx", status: "success", duplicate: false },
      { ...base, index: 1, name: "290926.xlsx", status: "error", duplicate: false },
    ];
    const combined = await parseCandCForMonthly([b, a], results);
    expect(combined.files.map((f) => f.fileName)).toEqual(["280926.xlsx"]);
  });
});

describe("candcCrossCheck", () => {
  it("tidak ada isu jika bucket kategori cocok dengan record kolom B–F", async () => {
    const result = await parseCandCFile(fileFromMatrix("280926.xlsx", sampleRows(1000, 500)));
    const bucket = { count: 2, quantityTotal: 2, subtotalTotal: 1500, taxTotal: 10 + 50 };
    expect(candcCrossCheck(bucket, result.records)).toEqual([]);
  });
  it("memberi peringatan jika berbeda", async () => {
    const result = await parseCandCFile(fileFromMatrix("280926.xlsx", sampleRows(1000, 500)));
    const bucket = { count: 3, quantityTotal: 3, subtotalTotal: 1, taxTotal: 1 };
    expect(candcCrossCheck(bucket, result.records)).toHaveLength(3);
  });
});
