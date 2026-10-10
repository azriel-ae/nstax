import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { computeJambuluwukCategory, dateFromFileName, parseDecimalScaled, parseJambuluwukWorkbook } from "./jambuluwukParser";

// Fixture sintetis hanya untuk menguji parser (bukan data hasil aplikasi).
const HEADER = ["FOLIO", "FODATE", "FOSHIFT", "CATEGORY", "NAME", "REMARK", "REFERENCE", "DEBIT", "CREDIT", "NETT"];
const line = (folio: unknown, name: unknown, nett: unknown) => [folio, 1, "1", "0101", name, "", "", 0, 0, nett];

const toBuffer = (sheets: Record<string, unknown[][]>, bookType: XLSX.BookType = "biff8"): ArrayBuffer => {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  const out = XLSX.write(wb, { type: "array", bookType }) as ArrayBuffer;
  return out;
};

const parse = (aoa: unknown[][], name = "01.09.2026.xls") => parseJambuluwukWorkbook(toBuffer({ "Sheet 1": aoa }), name);

describe("dateFromFileName", () => {
  it("DD.MM.YYYY.ext → YYYY-MM-DD tanpa ekstensi", () => {
    expect(dateFromFileName("01.09.2026.xls")).toEqual({ ok: true, date: "2026-09-01" });
    expect(dateFromFileName("15.12.2027.xlsx")).toEqual({ ok: true, date: "2027-12-15" });
    expect(dateFromFileName("C:\\x\\05.02.2030.xls")).toEqual({ ok: true, date: "2030-02-05" });
  });
  it("menolak format tidak sesuai atau tanggal mustahil (tidak menebak)", () => {
    expect(dateFromFileName("01_09_2026.xls").ok).toBe(false);
    expect(dateFromFileName("laporan.xls").ok).toBe(false);
    expect(dateFromFileName("31.02.2026.xls").ok).toBe(false);
    expect(dateFromFileName("01.09.2026 (1).xls").ok).toBe(false);
  });
});

describe("parseDecimalScaled (CAST AS DECIMAL(15,4))", () => {
  it("membulatkan ke 4 desimal, setengah menjauhi nol", () => {
    expect(parseDecimalScaled("20661.1570247934")).toBe(206611570n);
    expect(parseDecimalScaled("0.00005")).toBe(1n);
    expect(parseDecimalScaled("-0.00005")).toBe(-1n);
    expect(parseDecimalScaled("-20661.1570247934")).toBe(-206611570n);
    expect(parseDecimalScaled("5")).toBe(50000n);
  });
  it("menolak teks bukan angka dan nilai di luar DECIMAL(15,4)", () => {
    expect(parseDecimalScaled("abc")).toBeNull();
    expect(parseDecimalScaled("1,234")).toBeNull();
    expect(parseDecimalScaled("")).toBeNull();
    expect(parseDecimalScaled("100000000000")).toBeNull();
  });
});

describe("struktur file", () => {
  it("menemukan header walaupun bukan baris pertama dan membaca kolom A/E/J", () => {
    const source = parse([["LAPORAN FOLIO"], [], HEADER, line(10, "Room Charge", 1000)]);
    expect(source.ok).toBe(true);
    expect(source.headerRow).toBe(3);
    expect(source.rows).toHaveLength(1);
    expect(source.rows[0]).toMatchObject({ folio: "10", item: "Room Charge", amount: 10000000n, sheetRow: 4 });
  });
  it("error jika header A/E/J tidak sesuai", () => {
    const source = parse([["A", "B", "C"], [1, 2, 3]]);
    expect(source.ok).toBe(false);
    expect(source.error).toMatch(/FOLIO/);
  });
  it("error jika nama file tidak berformat tanggal", () => {
    const source = parse([HEADER], "01_09_2026.xls");
    expect(source.ok).toBe(false);
    expect(source.error).toMatch(/DD\.MM\.YYYY/);
  });
  it("mengabaikan header berulang, baris kosong, baris total, dan baris tanpa folio", () => {
    const source = parse([HEADER, line(1, "Room A", 100), [], HEADER, line("TOTAL", "Room A", 999), line(null, "Room A", 5), line(1, "Room B", 50)]);
    expect(source.ok).toBe(true);
    expect(source.rows.map((r) => r.item)).toEqual(["Room A", "Room B"]);
    expect(source.stats).toMatchObject({ blankRows: 1, repeatedHeaders: 1, summaryRows: 1, missingFolio: 1 });
    expect(computeJambuluwukCategory(source, "HOTEL").summary.count).toBe(1);
  });
  it("menolak workbook dengan lebih dari satu sheet transaksi (anti double counting)", () => {
    const source = parseJambuluwukWorkbook(toBuffer({ S1: [HEADER, line(1, "Room", 1)], S2: [HEADER, line(1, "Room", 1)] }), "01.09.2026.xls");
    expect(source.ok).toBe(false);
    expect(source.error).toMatch(/lebih dari satu sheet/i);
  });
  it("sheet tanpa header transaksi diabaikan jika ada satu sheet valid", () => {
    const source = parseJambuluwukWorkbook(toBuffer({ Ringkasan: [["x"]], Data: [HEADER, line(1, "Room", 1)] }), "01.09.2026.xls");
    expect(source.ok).toBe(true);
    expect(source.sheetName).toBe("Data");
    expect(source.ignoredSheets).toEqual(["Ringkasan"]);
  });
  it("format .xlsx juga terbaca", () => {
    const source = parseJambuluwukWorkbook(toBuffer({ "Sheet 1": [HEADER, line(1, "Room", 1)] }, "xlsx"), "01.09.2026.xlsx");
    expect(source.ok).toBe(true);
  });
});

describe("rumus HOTEL dan RESTO", () => {
  const data = [
    HEADER,
    line(100, "Room Charge Deluxe", 1000),
    line(100, "Disc Room Charge Deluxe", -100),
    line(100, "Service Room", 90),
    line(100, "Tax Room", 99),
    line(100, "Laundry Express", 50),
    line(100, "Breakfast Package", 200),
    line(100, "Restaurant - Service", 20),
    line(100, "Restaurant - Tax", 22),
    line(200, "Restaurant - Food", 300),
    line(200, "FO City Ledger", 777),
  ];
  const source = parse(data);

  it("HOTEL: filter HOTEL, tax = baris Tax, total = dpp + service + tax", () => {
    const result = computeJambuluwukCategory(source, "HOTEL");
    expect(result.rows).toHaveLength(1); // folio 200 tidak punya item HOTEL
    const row = result.rows[0];
    expect(row).toMatchObject({
      id_agent: "hotel_jambuluwuk", no_struk: "100-2026-09-01", date_trans: "2026-09-01",
      dpp: 950, subtotal: 1050, discount: -100, service_charge: 90, tax: 99, total: 1139,
      keterangan: "no folio = 100", namaFile: "01.09.2026.xls",
    });
  });

  it("RESTO: filter RESTO, tax = semua 'Tax' (folio tanpa baris Tax: (dpp + service) / 10), tanpa item HOTEL", () => {
    const result = computeJambuluwukCategory(source, "RESTO");
    expect(result.rows.map((r) => r.no_struk).sort()).toEqual(["100-2026-09-01", "200-2026-09-01"]);
    const row = result.rows.find((r) => r.folio === "100")!;
    expect(row).toMatchObject({ id_agent: "resto_jambuluwuk", dpp: 200, subtotal: 200, discount: 0, service_charge: 20, tax: 22, total: 242 });
    expect(result.rows.find((r) => r.folio === "200")).toMatchObject({ dpp: 300, tax: 30, total: 330 }); // tidak ada baris Tax → tax = 300 / 10
    expect(result.summary).toMatchObject({ count: 2, dpp: 500, subtotal: 500, service_charge: 20, tax: 52, total: 572 });
  });

  it("pajak HOTEL dan RESTO sama-sama dikenali dari nama 'Tax' ('Room Tax' dan 'Tax Room' dihitung)", () => {
    const s = parse([HEADER, line(1, "Room Tax", 10), line(1, "Room Charge", 100), line(2, "Restaurant - Tax Room", 7), line(2, "Restaurant - Food", 70)]);
    const hotel = computeJambuluwukCategory(s, "HOTEL").rows;
    // "Room Tax" lolos filter Room, dikeluarkan dari dpp (cocok Tax) DAN sekarang masuk tax (sebelumnya hilang dari total)
    expect(hotel.find((r) => r.folio === "1")).toMatchObject({ dpp: 100, tax: 10, total: 110 });
    // "Restaurant - Tax Room" juga lolos filter Room (SQL HOTEL) dan cocok 'Tax'
    expect(hotel.find((r) => r.folio === "2")).toMatchObject({ tax: 7, dpp: 0 });
    const resto = computeJambuluwukCategory(s, "RESTO").rows;
    expect(resto.find((r) => r.folio === "2")).toMatchObject({ dpp: 70, tax: 7 });
  });

  it("folio tanpa baris Tax: tax = (dpp + service) / 10; ada baris Tax (walau bernilai 0) dipakai apa adanya", () => {
    const s = parse([HEADER, line(1, "Room Charge", 1000), line(1, "Service Room", 100), line(2, "Room Charge", 1000), line(2, "Service Room", 100), line(2, "Room Tax", 0)]);
    const hotel = computeJambuluwukCategory(s, "HOTEL").rows;
    expect(hotel.find((r) => r.folio === "1")).toMatchObject({ dpp: 1000, service_charge: 100, tax: 110, total: 1210 });
    expect(hotel.find((r) => r.folio === "2")).toMatchObject({ tax: 0, total: 1100 });
  });

  it("pencocokan REGEXP case-insensitive seperti MySQL, dengan whitespace dinormalisasi", () => {
    const s = parse([HEADER, line(1, "  room   charge ", 10), line(1, "TAX  ROOM", 1)]);
    expect(computeJambuluwukCategory(s, "HOTEL").rows[0]).toMatchObject({ dpp: 10, tax: 1 });
  });

  it("berganti kategori memakai dataset sumber yang sama dan tidak mengubah sumber", () => {
    const before = JSON.stringify(source.rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    const a = computeJambuluwukCategory(source, "HOTEL");
    const b = computeJambuluwukCategory(source, "RESTO");
    const a2 = computeJambuluwukCategory(source, "HOTEL");
    expect(a2).toEqual(a);
    expect(a.rows.every((r) => r.id_agent === "hotel_jambuluwuk")).toBe(true);
    expect(b.rows.every((r) => r.id_agent === "resto_jambuluwuk")).toBe(true);
    expect(JSON.stringify(source.rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(before);
  });

  it("nilai J dibulatkan 4 desimal per baris sebelum dijumlah; total memakai jumlah belum dibulatkan", () => {
    // 0.00444 → 0.0044 per baris; dpp/service/tax masing-masing 0.0044 → 0.00, namun total = ROUND(0.0132, 2) = 0.01
    const s = parse([HEADER, line(1, "Room Charge", 0.00444), line(1, "Service Room", 0.00444), line(1, "Tax Room", 0.00444)]);
    const row = computeJambuluwukCategory(s, "HOTEL").rows[0];
    expect(row).toMatchObject({ dpp: 0, service_charge: 0, tax: 0, total: 0.01 });
  });

  it("pembulatan 2 desimal setengah menjauhi nol (positif dan negatif)", () => {
    const s = parse([HEADER, line(1, "Room Charge", 10.005), line(2, "Room Charge", -10.005)]);
    const rows = computeJambuluwukCategory(s, "HOTEL").rows;
    expect(rows.find((r) => r.folio === "1")!.dpp).toBe(10.01);
    expect(rows.find((r) => r.folio === "2")!.dpp).toBe(-10.01);
  });

  it("nilai J tidak valid ditandai dan tidak dihitung diam-diam; J kosong dihitung 0", () => {
    const s = parse([HEADER, line(1, "Room Charge", "12x"), line(1, "Room Extra", 10), line(2, "Room Charge", null)]);
    const result = computeJambuluwukCategory(s, "HOTEL");
    expect(result.invalidRows).toBe(1);
    expect(result.issues[0].message).toMatch(/12x/);
    expect(result.rows.find((r) => r.folio === "1")!.dpp).toBe(10);
    expect(result.emptyAmountRows).toBe(1);
    expect(result.rows.find((r) => r.folio === "2")!.dpp).toBe(0);
  });

  it("tanpa transaksi valid → hasil kosong, tanpa data pengganti", () => {
    const s = parse([HEADER, line(1, "FO City Ledger", 100)]);
    expect(computeJambuluwukCategory(s, "HOTEL").rows).toEqual([]);
    expect(computeJambuluwukCategory(s, "RESTO").summary).toMatchObject({ count: 0, total: 0 });
  });

  it("summary dihitung dari seluruh dataset (>100 folio)", () => {
    const aoa = [HEADER];
    for (let i = 1; i <= 250; i++) aoa.push(line(i, "Room Charge", 100));
    const result = computeJambuluwukCategory(parse(aoa), "HOTEL");
    expect(result.rows).toHaveLength(250);
    expect(result.summary).toMatchObject({ count: 250, dpp: 25000, tax: 2500, total: 27500 });
  });
});
