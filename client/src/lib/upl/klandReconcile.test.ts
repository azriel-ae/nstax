import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseUplFile } from "./uplParser";
import { categorizeAllRows, createBuiltInKategoriResult, detectTransactionKategoriColumns, summarizeByCategory } from "./kategoriMapper";
import { candcCrossCheck, parseCandCFile } from "./candcParser";
import { parseRestoFile, restoCrossCheck } from "./restoParser";
import { locateRecordColumns } from "./klandColumns";

function fileFromMatrix(name: string, matrix: unknown[][]): File {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), "TO 280926");
  const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  return new File([buffer], name);
}

// Layout laporan nyata: Art | Description | Day-qty | Day-Nett | Service | Tax | Day-Gros.
// `shift` menggeser seluruh kolom ke kanan (posisi kolom antar file bisa berbeda).
function report(shift: number, k: number): unknown[][] {
  const pad = Array.from({ length: shift }, () => "");
  const r = (...cells: unknown[]) => [...pad, ...cells];
  return [
    r("LAPORAN HARIAN"),
    r(),
    r("Art", "Description", "Day-qty", "Day-Nett", "Service", "Tax", "Day-Gros"),
    r("1", "1 - PREGO", "", "", "", "", ""),
    r("10", "Food PREEGO", 4 * k, 90000 * k, 9000 * k, 10000 * k, 109000 * k),
    r("11", "Beverage PREEGO", 2 * k, 40000 * k, 4000 * k, 4400 * k, 48400 * k),
    r("", "2 - KFOOD-HANBOK-CANTEEN", "", "", "", "", ""),
    r("", "Food OPPA KFOOD", 3 * k, 60000 * k, 0, 6000 * k, 66000 * k),
    r("", "Disc Food Resto padi", 1, -5000 * k, 0, 0, -5000 * k),
    r("", "3 - RESTO PADI - C&C-FAR", "", "", "", "", ""),
    r("", "Food C & C", 5 * k, 100000 * k, 10000 * k, 11000 * k, 121000 * k),
    r("", "Beverage C & C", 2 * k, 30000 * k, 3000 * k, 3300 * k, 36300 * k),
    r("", "4 - ACTIVITY & GATE", "", "", "", "", ""),
    r("21", "Activity Parking", 2, 18182, 0, 1818, 20000),
    // qty kosong tetapi membawa nilai uang: item nyata, bukan judul seksi
    r("21", "Activity Parking", "", 9091, 0, 909, 10000),
    r("20", "Activity Entry Gate", 6, 54545, 0, 5455, 60000),
    r("", "T O T A L", "", "", "", 99999, 999999),
    r("", "GRAND TOTAL", 99, "", "", 99999, 999999),
  ];
}

async function analyse(name: string, matrix: unknown[][]) {
  const file = fileFromMatrix(name, matrix);
  const parsed = await parseUplFile(file);
  const cats = categorizeAllRows(parsed.fullRows, createBuiltInKategoriResult(), detectTransactionKategoriColumns(parsed.workbook!.headerValues));
  return { parsed, per: summarizeByCategory(cats), file };
}


for (const [label, shift] of [["kolom mulai A", 0], ["kolom bergeser 3", 3]] as const) {
  describe(`rekonsiliasi ringkasan vs detail (${label})`, () => {
    it("header record ditemukan per file", () => {
      const located = locateRecordColumns(report(shift, 1));
      expect(located?.headerIndex).toBe(2);
      expect(located?.cols).toMatchObject({ keterangan: shift + 1, qty: shift + 2, subtotal: shift + 3, service_charge: shift + 4, tax: shift + 5, total: shift + 6 });
    });

    it("C&C: ringkasan (Day-Gros, tax, qty, row) = agregasi record, tanpa isu cross-check", async () => {
      const { per, file } = await analyse("280926.xlsx", report(shift, 1));
      const res = await parseCandCFile(file);
      expect(res.columnSource).toBe("header");
      expect(res.records).toHaveLength(2);
      expect(res.records[0]).toMatchObject({ subtotal: 100000, service_charge: 10000, dpp: 110000, tax: 11000, total: 121000, qty: 5 });
      expect(per["C&C"]).toMatchObject({ count: 2, quantityTotal: 7, subtotalTotal: 157300, taxTotal: 14300 });
      expect(candcCrossCheck(per["C&C"], res.records)).toEqual([]);
    });

    it("PREGO dan KFOOD: ringkasan = record, disc masuk discount, section header tidak jadi record", async () => {
      const { per, file } = await analyse("280926.xlsx", report(shift, 1));
      const prego = await parseRestoFile(file, "PREGO");
      const kfood = await parseRestoFile(file, "KFOOD");
      expect(prego.records.map((x) => x.keterangan)).toEqual(["Food PREEGO", "Beverage PREEGO"]);
      expect(kfood.records.map((x) => x.keterangan)).toEqual(["Food OPPA KFOOD", "Disc Food Resto padi"]);
      expect(restoCrossCheck("PREGO", per["RESTO PREGO"], prego.records)).toEqual([]);
      expect(restoCrossCheck("KFOOD", per["K FOOD"], kfood.records)).toEqual([]);
      expect(kfood.records[1]).toMatchObject({ discount: -5000, subtotal: -5000 });
    });

    it("PARKIR dan WATER SLIDE: baris dengan qty kosong tapi bernilai tidak hilang", async () => {
      const { per, parsed } = await analyse("280926.xlsx", report(shift, 1));
      expect(per["PARKIR"]).toMatchObject({ count: 2, subtotalTotal: 30000, taxTotal: 2727 });
      expect(per["HIBURAN — WATER SLIDE"]).toMatchObject({ count: 1, quantityTotal: 6, subtotalTotal: 60000 });
      expect(per["Tidak Terpetakan"].count).toBe(0);
      expect(parsed.fullRows.some((row) => /grand total|t o t a l/i.test(row.description))).toBe(false);
      // judul seksi tetap dilewati
      expect(parsed.fullRows.some((row) => /^\d+\s*-\s/.test(row.description))).toBe(false);
    });
  });
}

describe("dua file dengan posisi kolom berbeda digabung (bulanan)", () => {
  it("setiap file memakai kolomnya sendiri sehingga total gabungan = jumlah per file", async () => {
    const a = await parseCandCFile(fileFromMatrix("280926.xlsx", report(0, 1)));
    const b = await parseCandCFile(fileFromMatrix("290926.xlsx", report(3, 2)));
    expect(a.columns?.total).toBe("G");
    expect(b.columns?.total).toBe("J");
    expect(a.records[0].total + b.records[0].total).toBe(121000 + 242000);
  });
});

describe("tanpa header: huruf kolom tetap sebagai cadangan, dengan peringatan", () => {
  it("memberi warning dan columnSource=fixed", async () => {
    const res = await parseCandCFile(fileFromMatrix("280926.xlsx", [["", "Food C & C", 1000, 100, 10, 1110]]));
    expect(res.columnSource).toBe("fixed");
    expect(res.warnings.some((w) => /Header/.test(w))).toBe(true);
    expect(res.records[0]).toMatchObject({ subtotal: 1000, qty: null });
  });
});

// File laporan KLAND NYATA (010926.xlsx): header Day-qty/Day-Nett/Service/Tax/Day-Gros + kolom MTD/YTD di kanan.
describe("file nyata 010926.xlsx", () => {
  it("detail C&C, PREGO, KFOOD sama dengan ringkasan kategori dan nilai kolom Day", async () => {
    const { readFileSync } = await import("node:fs");
    const buf = readFileSync(new URL("../fixtures/kland010926.xlsx", import.meta.url));
    const file = new File([buf], "010926.xlsx");
    const parsed = await parseUplFile(file);
    const cats = categorizeAllRows(parsed.fullRows, createBuiltInKategoriResult(), detectTransactionKategoriColumns(parsed.workbook!.headerValues));
    const per = summarizeByCategory(cats);

    const candc = await parseCandCFile(file);
    expect(candc.columnSource).toBe("header");
    expect(candc.records.map((r) => [r.keterangan, r.qty, r.subtotal, r.service_charge, r.tax, r.total])).toEqual([
      ["Food C & C", 5, 160173, 8009, 16818, 185000],
      ["Beverage C & C", 4, 41558, 2078, 4364, 48000],
    ]);
    expect(per["C&C"]).toMatchObject({ count: 2, quantityTotal: 9, subtotalTotal: 233000, taxTotal: 21182 });
    expect(candcCrossCheck(per["C&C"], candc.records)).toEqual([]);

    const prego = await parseRestoFile(file, "PREGO");
    const kfood = await parseRestoFile(file, "KFOOD");
    expect(restoCrossCheck("PREGO", per["RESTO PREGO"], prego.records)).toEqual([]);
    expect(restoCrossCheck("KFOOD", per["K FOOD"], kfood.records)).toEqual([]);
    expect(per["PARKIR"]).toMatchObject({ count: 1, quantityTotal: 6, subtotalTotal: 60000, taxTotal: 5455 });
    expect(per["HIBURAN — WATER SLIDE"]).toMatchObject({ quantityTotal: 24, subtotalTotal: 600000, taxTotal: 54545 });
  });
});
