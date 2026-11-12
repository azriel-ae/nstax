import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { candcCrossCheck, dateFromFileName, parseCandCFile, parseCandCFiles, parseCandCForMonthly, sumCandCRecords } from "./candcParser";
import type { MonthlyFileResult } from "../shared/monthlyCommon";
import { BUILT_IN_CATEGORY_CRITERIA, createBuiltInKategoriResult } from "./kategoriMapper";

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
    // Ringkasan (Day-Gros) dibandingkan dengan record.total, bukan subtotal.
    const bucket = { count: 2, quantityTotal: 2, subtotalTotal: 1000 * 1.11 + 500 * 1.1, taxTotal: 10 + 50 };
    expect(candcCrossCheck(bucket, result.records)).toEqual([]);
  });
  it("memberi peringatan jika berbeda", async () => {
    const result = await parseCandCFile(fileFromMatrix("280926.xlsx", sampleRows(1000, 500)));
    const bucket = { count: 3, quantityTotal: 3, subtotalTotal: 1, taxTotal: 1 };
    expect(candcCrossCheck(bucket, result.records)).toHaveLength(3);
  });
});

// Kolom: A, B=Description, C=Day-Nett, D=Service, E=Tax, F=Day-Gros (mode kolom tetap, tanpa header)
const discRows = (disc: unknown): unknown[][] => [
  ["laporan"],
  ["", "Food C & C", 1000, 100, 10, 1110],
  ["", "Beverage C & C", 500, 0, 50, 550],
  ["", "Disc food C & C", disc, 0, 0, disc],
  ["", "Disc Food Resto padi", -50, 0, 0, -50],
  ["", "Food Resto Padi", 999, 0, 0, 999],
];

describe("C&C — Disc food C & C", () => {
  it("terpetakan ke C&C saja; diskon K FOOD tidak berubah kategori", () => {
    const map = createBuiltInKategoriResult().subkategoriMap;
    expect(BUILT_IN_CATEGORY_CRITERIA["C&C"]).toContain("Disc food C & C");
    expect(map.get("disc food c & c")).toBe("C&C");
    expect(map.get(" DISC  FOOD  C & C ".toLowerCase().replace(/\s+/g, " ").trim())).toBe("C&C");
    expect(map.get("disc food resto padi")).toBe("K FOOD");
    expect(map.get("food resto padi")).toBe("K FOOD");
    expect(BUILT_IN_CATEGORY_CRITERIA["K FOOD"].some((x) => /c & c/i.test(x))).toBe(false);
  });

  it("diskon terisi: record dibuat sekali, discount = nilai baris diskon, tidak terhitung dua kali", async () => {
    const res = await parseCandCFile(fileFromMatrix("280926.xlsx", discRows(-200)));
    expect(res.records.map((r) => r.keterangan)).toEqual(["Food C & C", "Beverage C & C", "Disc food C & C"]);
    const disc = res.records[2];
    expect(disc).toMatchObject({ subtotal: -200, discount: -200, dpp: -200, total: -200, tax: 0 });
    // item non-diskon: discount tetap 0
    expect(res.records[0].discount).toBe(0);
    expect(res.records[1].discount).toBe(0);
    const t = sumCandCRecords(res.records);
    expect(t.transactionCount).toBe(3);
    expect(t.discount).toBe(-200); // hanya satu kali
    expect(t.subtotal).toBe(1000 + 500 - 200); // Day-Nett sudah memuat diskon; kolom discount hanya tampilan terpisah
    expect(t.total).toBeCloseTo(1110 + 550 - 200);
    // Tidak ada baris K FOOD yang ikut
    expect(res.records.some((r) => /resto/i.test(r.keterangan))).toBe(false);
  });

  it("diskon nol atau sel kosong → discount 0 dan tidak merusak total", async () => {
    for (const v of [0, ""]) {
      const res = await parseCandCFile(fileFromMatrix("280926.xlsx", discRows(v)));
      expect(res.records).toHaveLength(3);
      expect(res.records[2]).toMatchObject({ subtotal: 0, discount: 0, total: 0 });
      expect(sumCandCRecords(res.records).discount).toBe(0);
      expect(sumCandCRecords(res.records).total).toBeCloseTo(1110 + 550);
    }
  });

  it("format angka teks: ribuan/desimal Indonesia, kurung, minus", async () => {
    const cases: Array<[string, number]> = [["-1.234,50", -1234.5], ["(2.500)", -2500], ["-300", -300], ["Rp 1.000", 1000]];
    for (const [text, expected] of cases) {
      const res = await parseCandCFile(fileFromMatrix("280926.xlsx", discRows(text)));
      expect(res.records[2].discount).toBeCloseTo(expected);
      expect(sumCandCRecords(res.records).discount).toBeCloseTo(expected);
    }
  });

  it("file tanpa baris Disc food C & C: hasil C&C sama seperti sebelumnya", async () => {
    const before = await parseCandCFile(fileFromMatrix("280926.xlsx", sampleRows(1000, 500)));
    expect(before.records).toHaveLength(2);
    expect(sumCandCRecords(before.records).discount).toBe(0);
    expect(sumCandCRecords(before.records).subtotal).toBe(1500);
  });
});
