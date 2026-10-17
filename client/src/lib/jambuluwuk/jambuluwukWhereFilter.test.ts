import { describe, expect, it } from "vitest";
import { parseDecimalScaled, type JambuluwukSource } from "./jambuluwukParser";
import { DEFAULT_QUERIES, runProfileQueryMulti, type JambuluwukProfile } from "./jambuluwukQueries";
import { sumResultColumn, valueToString, validateSql, type QueryResult } from "./jambuluwukSql";

// Filter tanggal CEK UPL · JAMBULUWUK hanya lewat klausa WHERE date_trans di query (tanpa UI filter tanggal).
// Fixture sintetis: 4 file harian; nilai dihitung manual di komentar.
const line = (sheetRow: number, folio: string, item: string, raw: string): JambuluwukSource["rows"][number] => ({
  sheetRow, folio, item, rawAmount: raw, invalid: false, amount: parseDecimalScaled(raw),
});
const src = (fileName: string, rows: JambuluwukSource["rows"]): JambuluwukSource => ({
  ok: true, fileName, dateTrans: null, sheetName: "Sheet 1", headerRow: 1, ignoredSheets: [], rows,
  stats: { dataRows: rows.length, blankRows: 0, repeatedHeaders: 0, summaryRows: 0, missingFolio: 0, usedRows: rows.length, unmatchedRows: 0 },
});
const SOURCES = [
  // 01.09: hotel folio 100 dpp 1000-100=900 (subtotal 1000), disc -100, service 90, tax 99 → total 900+90+99=1089; resto folio 200: 300 tanpa Tax → tax 30 → 330
  src("01.09.2026.xls", [line(2, "100", "Room Charge Deluxe", "1000"), line(3, "100", "Disc Room Charge Deluxe", "-100"), line(4, "100", "Service Room", "90"), line(5, "100", "Tax Room", "99"), line(6, "200", "Restaurant - Food", "300")]),
  // 15.09: hotel folio 101 500 → tax 50 → 550
  src("15.09.2026.xls", [line(2, "101", "Room Charge", "500")]),
  // 30.09: hotel folio 102 200 → 220; resto folio 202 100 + Tax 10 → 110
  src("30.09.2026.xls", [line(2, "102", "Room Charge", "200"), line(3, "202", "Dinner", "100"), line(4, "202", "Restaurant - Tax", "10")]),
  // 01.10: hotel folio 103 700 → 770
  src("01.10.2026.xls", [line(2, "103", "Room Charge", "700")]),
];
const ACTIVE_WHERE = "WHERE date_trans >= '2026-09-01'\n  AND date_trans < '2026-10-01'";
const withWhere = (p: JambuluwukProfile, where: string) => DEFAULT_QUERIES[p].replace(ACTIVE_WHERE, where);
const col = (r: QueryResult, name: string) => r.columns.indexOf(name);
const dates = (r: QueryResult) => r.rows.map((row) => valueToString(row[col(r, "date_trans")]));
const MONEY = ["subtotal", "service_charge", "discount", "dpp", "tax", "total"] as const;

/** Setiap total harus sama dengan jumlah baris tabel yang sedang tampil (kumpulan transaksi yang sama). */
const expectSummaryMatchesTable = (r: QueryResult) => {
  for (const k of MONEY) {
    const manual = r.rows.reduce((acc, row) => acc + Number(valueToString(row[col(r, k)])), 0);
    expect(Math.abs((sumResultColumn(r, k) ?? NaN) - manual) < 0.005).toBe(true);
  }
};

describe("query default memuat WHERE tanggal yang mudah diedit", () => {
  for (const p of ["HOTEL", "RESTO"] as const) {
    it(`${p}: WHERE ada di SELECT utama (setelah FROM hitung_tax), CTE utuh, dan query valid`, () => {
      const q = DEFAULT_QUERIES[p];
      expect(q).toContain(ACTIVE_WHERE);
      expect(q).toContain("WITH detail_transaksi AS (");
      expect(q.indexOf("FROM hitung_tax")).toBeLessThan(q.indexOf("WHERE date_trans"));
      expect(q).toContain("WHERE date_trans LIKE '2026-09-01'"); // contoh tanggal tertentu
      expect(q).toContain("WHERE date_trans LIKE '2026-09%'"); // contoh satu bulan
      expect(validateSql(q).ok).toBe(true);
    });
  }
});

describe("filter WHERE membatasi tabel, jumlah transaksi, dan semua total", () => {
  it("default (rentang September 2026): file 01.10 tidak masuk", async () => {
    const r = await runProfileQueryMulti(DEFAULT_QUERIES.HOTEL, SOURCES);
    expect(dates(r)).toEqual(["2026-09-01", "2026-09-15", "2026-09-30"]);
    expect(sumResultColumn(r, "total")).toBe(1089 + 550 + 220);
    expectSummaryMatchesTable(r);
  });

  it("1. satu tanggal: LIKE '2026-09-01'", async () => {
    const r = await runProfileQueryMulti(withWhere("HOTEL", "WHERE date_trans LIKE '2026-09-01'"), SOURCES);
    expect(r.rows).toHaveLength(1);
    expect(dates(r)).toEqual(["2026-09-01"]);
    expect(sumResultColumn(r, "subtotal")).toBe(1000);
    expect(sumResultColumn(r, "discount")).toBe(-100);
    expect(sumResultColumn(r, "service_charge")).toBe(90);
    expect(sumResultColumn(r, "dpp")).toBe(900);
    expect(sumResultColumn(r, "tax")).toBe(99);
    expect(sumResultColumn(r, "total")).toBe(1089);
    expectSummaryMatchesTable(r);
  });

  it("2. satu bulan: LIKE '2026-09%' (Oktober tidak ikut) — HOTEL dan RESTO", async () => {
    const hotel = await runProfileQueryMulti(withWhere("HOTEL", "WHERE date_trans LIKE '2026-09%'"), SOURCES);
    expect(hotel.rows).toHaveLength(3);
    expect(sumResultColumn(hotel, "total")).toBe(1859);
    expectSummaryMatchesTable(hotel);
    const resto = await runProfileQueryMulti(withWhere("RESTO", "WHERE date_trans LIKE '2026-09%'"), SOURCES);
    expect(dates(resto)).toEqual(["2026-09-01", "2026-09-30"]);
    expect(sumResultColumn(resto, "total")).toBe(330 + 110); // folio 200 tanpa Tax → 300/10; folio 202 pakai baris Tax
    expectSummaryMatchesTable(resto);
    const oct = await runProfileQueryMulti(withWhere("HOTEL", "WHERE date_trans LIKE '2026-10%'"), SOURCES);
    expect(dates(oct)).toEqual(["2026-10-01"]);
    expect(sumResultColumn(oct, "total")).toBe(770);
  });

  it("3. rentang tanggal: batas akhir eksklusif, transaksi di luar rentang tidak dihitung", async () => {
    const r = await runProfileQueryMulti(withWhere("HOTEL", "WHERE date_trans >= '2026-09-02'\n  AND date_trans < '2026-10-01'"), SOURCES);
    expect(dates(r)).toEqual(["2026-09-15", "2026-09-30"]);
    expect(sumResultColumn(r, "total")).toBe(770);
    expectSummaryMatchesTable(r);
    const edge = await runProfileQueryMulti(withWhere("HOTEL", "WHERE date_trans >= '2026-09-30'\n  AND date_trans < '2026-10-01'"), SOURCES);
    expect(dates(edge)).toEqual(["2026-09-30"]);
    const between = await runProfileQueryMulti(withWhere("HOTEL", "WHERE date_trans BETWEEN '2026-09-15' AND '2026-10-01'"), SOURCES);
    expect(dates(between)).toEqual(["2026-09-15", "2026-09-30", "2026-10-01"]);
  });

  it("bentuk timestamp pada literal tetap cocok dengan date_trans bertipe tanggal", async () => {
    const day = await runProfileQueryMulti(withWhere("HOTEL", "WHERE date_trans >= '2026-09-01 00:00:00'\n  AND date_trans < '2026-09-02 00:00:00'"), SOURCES);
    expect(dates(day)).toEqual(["2026-09-01"]);
    const eq = await runProfileQueryMulti(withWhere("HOTEL", "WHERE date_trans = '2026-09-15 00:00:00'"), SOURCES);
    expect(dates(eq)).toEqual(["2026-09-15"]);
  });

  it("tidak ada transaksi yang cocok: 0 baris, kolom tetap ada, semua total 0 (bukan null)", async () => {
    const r = await runProfileQueryMulti(withWhere("HOTEL", "WHERE date_trans LIKE '2026-08%'"), SOURCES);
    expect(r.rows).toHaveLength(0);
    expect(r.columns).toContain("total");
    for (const k of MONEY) expect(sumResultColumn(r, k)).toBe(0);
  });

  it("mengganti tanggal di WHERE mengubah hasil (tidak ada filter tersembunyi)", async () => {
    const a = await runProfileQueryMulti(withWhere("HOTEL", "WHERE date_trans LIKE '2026-09-15'"), SOURCES);
    const b = await runProfileQueryMulti(withWhere("HOTEL", "WHERE date_trans LIKE '2026-09-30'"), SOURCES);
    expect(sumResultColumn(a, "total")).toBe(550);
    expect(sumResultColumn(b, "total")).toBe(220);
  });
});

describe("WHERE tidak valid → error jelas, bukan hasil", () => {
  it("kolom tidak dikenal di WHERE", async () => {
    let msg = "";
    try { await runProfileQueryMulti(withWhere("HOTEL", "WHERE tanggal_transaksi LIKE '2026-09%'"), SOURCES); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("tanggal_transaksi");
  });
  it("date_trans dipakai di WHERE dalam CTE (alias belum ada di tingkat itu) ditolak, bukan diam-diam kosong", async () => {
    const bad = DEFAULT_QUERIES.HOTEL.replace("WHERE\n        d.id_command = 'UPL0192'", "WHERE date_trans LIKE '2026-09%'\n        AND d.id_command = 'UPL0192'");
    expect(bad).not.toBe(DEFAULT_QUERIES.HOTEL);
    expect(validateSql(bad).ok).toBe(false);
  });
});
