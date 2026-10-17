import { describe, expect, it } from "vitest";
import { computeJambuluwukCategory, parseDecimalScaled, type JambuluwukSource } from "./jambuluwukParser";
import { buildVirtualRows, DEFAULT_QUERIES, runProfileQuery } from "./jambuluwukQueries";
import { sumResultColumn, valueToNumber, valueToString } from "./jambuluwukSql";

// Parity: hasil query default (mesin SQL) harus identik dengan perhitungan lama jambuluwukParser pada data yang sama.
// Fixture sintetis; baris dibuat langsung (tanpa membaca file Excel).
const line = (sheetRow: number, folio: string, item: string, raw: string): JambuluwukSource["rows"][number] => ({
  sheetRow, folio, item, rawAmount: raw, invalid: false, amount: raw === "" ? null : parseDecimalScaled(raw),
});

const source = (rows: JambuluwukSource["rows"], fileName = "01.09.2026.xls"): JambuluwukSource => ({
  ok: true, fileName, dateTrans: "2026-09-01", sheetName: "Sheet 1", headerRow: 1, ignoredSheets: [], rows,
  stats: { dataRows: rows.length, blankRows: 0, repeatedHeaders: 0, summaryRows: 0, missingFolio: 0, usedRows: rows.length, unmatchedRows: 0 },
});

describe("buildVirtualRows", () => {
  it("memetakan A/E/J ke folio/item/nett, filename ke nama file unggahan, dan sel kosong ke NULL", () => {
    const rows = buildVirtualRows(source([line(5, "10", "Room Charge", "1000"), line(6, "10", "Laundry", "")], "02.10.2026.xlsx"));
    expect(rows).toEqual([
      { n: 5, A: "10", E: "Room Charge", J: "1000", filename: "02.10.2026.xlsx", id_command: "UPL0192" },
      { n: 6, A: "10", E: "Laundry", J: null, filename: "02.10.2026.xlsx", id_command: "UPL0192" },
    ]);
  });
});

describe("parity dengan perhitungan lama", () => {
  const raws: Array<[string, string, string]> = [
    ["100", "Room Charge Deluxe", "1000"], ["100", "Disc Room Charge Deluxe", "-100"], ["100", "Service Room", "90"],
    ["100", "Tax Room", "99"], ["100", "Laundry Express", "50"], ["100", "Breakfast Package", "200"],
    ["100", "Restaurant - Service", "20"], ["100", "Restaurant - Tax", "22"], ["200", "Restaurant - Food", "300"],
    ["200", "FO City Ledger", "777"], ["300", "Room Tax", "10"], ["300", "Room Charge", "100"],
    ["301", "Restaurant - Tax Room", "7"], ["301", "Restaurant - Food", "70"],
    ["400", "Room Charge", "0.00444"], ["400", "Service Room", "0.00444"], ["400", "Tax Room", "0.00444"],
    ["500", "Room Charge", "10.005"], ["501", "Room Charge", "-10.005"], ["502", "Room Charge", "20661.1570247934"],
    ["503", "Room Charge", ""], ["503", "Room Extra", "12.34"],
  ];
  const src = source(raws.map(([f, i, a], idx) => line(idx + 2, f, i, a)));

  for (const category of ["HOTEL", "RESTO"] as const) {
    it(`${category}: setiap folio dan seluruh ringkasan sama dengan perhitungan lama`, async () => {
      const old = computeJambuluwukCategory(src, category);
      const result = await runProfileQuery(DEFAULT_QUERIES[category], src);
      expect(result.rows).toHaveLength(old.rows.length);
      const idx = (n: string) => result.columns.indexOf(n);
      for (const o of old.rows) {
        const row = result.rows.find((r) => valueToString(r[idx("keterangan")]) === o.keterangan)!;
        expect(row).toBeDefined();
        expect(valueToString(row[idx("id_agent")])).toBe(o.id_agent);
        expect(valueToString(row[idx("no_struk")])).toBe(o.no_struk);
        expect(valueToString(row[idx("date_trans")])).toBe(o.date_trans);
        // folio 503 punya sel J kosong pada satu baris: lama = 0, SQL = SUM abaikan NULL → nilai sama karena ada baris lain
        for (const k of ["dpp", "subtotal", "discount", "service_charge", "tax", "total"] as const) {
          expect(valueToNumber(row[idx(k)])).toBe(o[k]);
        }
      }
      for (const k of ["subtotal", "discount", "service_charge", "dpp", "tax", "total"] as const) {
        expect(sumResultColumn(result, k)).toBe(old.summary[k]);
      }
    });
  }
});
