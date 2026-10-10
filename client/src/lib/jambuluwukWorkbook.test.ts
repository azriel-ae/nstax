import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseJambuluwukWorkbook } from "./jambuluwukParser";
import { DEFAULT_QUERIES, runProfileQuery } from "./jambuluwukQueries";
import { sumResultColumn, valueToString } from "./jambuluwukSql";

// End-to-end: workbook .xls/.xlsx sungguhan (dibuat dengan SheetJS) → parser → tabel virtual → query default.
// Fixture sintetis hanya untuk pengujian.
const HEADER = ["FOLIO", "FODATE", "FOSHIFT", "CATEGORY", "NAME", "REMARK", "REFERENCE", "DEBIT", "CREDIT", "NETT"];
const line = (folio: unknown, name: string, nett: unknown) => [folio, 1, "1", "0101", name, "", "", 0, 0, nett];
const book = (aoa: unknown[][], bookType: XLSX.BookType) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Sheet 1");
  return XLSX.write(wb, { type: "array", bookType }) as ArrayBuffer;
};
const AOA = [["LAPORAN FOLIO"], [], HEADER, line(100, "Room Charge Deluxe", 1000), line(100, "Disc Room Charge Deluxe", -100), line(100, "Service Room", 90), line(100, "Tax Room", 99), line(200, "Restaurant - Food", 300), ["TOTAL", null, null, null, "Room Charge", null, null, null, null, 9999]];

describe("workbook Excel asli → query", () => {
  for (const [name, type] of [["01.09.2026.xls", "biff8"], ["01.09.2026.xlsx", "xlsx"]] as const) {
    it(`${name}: tanggal 2026-09-01, baris total laporan tidak dihitung, HOTEL dan RESTO dari file yang sama`, async () => {
      const source = parseJambuluwukWorkbook(book(AOA, type), name);
      expect(source.ok).toBe(true);
      const hotel = await runProfileQuery(DEFAULT_QUERIES.HOTEL, source);
      expect(hotel.rows).toHaveLength(1);
      expect(valueToString(hotel.rows[0][hotel.columns.indexOf("date_trans")])).toBe("2026-09-01");
      expect(sumResultColumn(hotel, "total")).toBe(1139);
      const resto = await runProfileQuery(DEFAULT_QUERIES.RESTO, source);
      expect(sumResultColumn(resto, "total")).toBe(330); // folio 200 tanpa baris Tax → tax = 300 / 10
    });
  }
});
