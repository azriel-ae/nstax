import { describe, expect, it } from "vitest";
import {
  cleanOmalaTotal,
  computeOmalaAmounts,
  detectOmalaStructure,
  formatOmalaMoney,
  parseDelimited,
  parseHotelDate,
  parseOmalaFiles,
  parseOmalaText,
  parseRestoFilenameDate,
  summarizeOmalaRows,
} from "./omalaParser";

// Isi kedua file referensi asli (20261006_FO Transaction Journal.csv & 20261006_Cashier Sales Report.csv).
const HOTEL_CSV = "﻿THE OMALA HOTEL;;;;;;;;;;;;;Date: 07/10/2026;;;;;;;;;;;;;;;;;\r\nJl. Wilis; Semeru; Kec. Prigen;;;;;;;;;;;;;;;;;;;;;;;;;;;;\r\nTel 0821 77787988;;;;;;;;;;;;;Period: From Date: 06/10/2026 - To Date: 06/10/2026;;;;;;;;;;;;;;;;;\r\n;;;;;;;;;;;;;From Article: 100 Lodging (Room Revenue) - To Article: 100 Lodging (Room Revenue);;;;;;;;;;;;;;;;;\r\n;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;\r\nFO Transaction Journal ;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;\r\n;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;\r\nDate;Room Number;Non Stay;Master Bill;Shift;Bill Number;Article Number;Description;Voucher Number;Department;Outlet;Quantity;Amount;Foreign Amount;Exchange Rate;Tax;Tax (%);Service;Service (%);Other Vat;Other Vat (%);Nett Amount;Guest Name;;;;;;;;\r\n06/10/2026;203; ;*;  ;4784;100;Lodging (Room Revenue)                            ;                                        ;Front Office;      ;1;480,265.00;0.00;0.00;43,660.45;10;39,691.32;10;0.00;;396,913.22;Thalia Muthia,   MRS     ;;;;;;;;\r\n06/10/2026;205; ;*;  ;4786;100;Lodging (Room Revenue)                            ;                                        ;Front Office;      ;1;480,265.00;0.00;0.00;43,660.45;10;39,691.32;10;0.00;;396,913.22;Nazilaturrochmah, Emilia ;;;;;;;;\r\n06/10/2026;207; ; ;  ;4787;100;Lodging (Room Revenue)                            ;                                        ;Front Office;      ;1;500,000.00;0.00;0.00;45,454.55;10;41,322.31;10;0.00;;413,223.14;Perdana, Bayu Fitra  MR  ;;;;;;;;\r\n06/10/2026;210; ;*;  ;4785;100;Lodging (Room Revenue)                            ;                                        ;Front Office;      ;1;530,376.00;0.00;0.00;48,216.00;10;43,832.73;10;0.00;;438,327.27;no surname, zakiyyah MR  ;;;;;;;;\r\n06/10/2026;216; ;*;  ;4788;100;Lodging (Room Revenue)                            ;                                        ;Front Office;      ;1;537,531.00;0.00;0.00;48,866.45;10;44,424.05;10;0.00;;444,240.50;habibah mareta firalexa, ;;;;;;;;\r\n;      ; ; ;  ;;;                                                  ;                                        ;T O T A L   ;      ;5;2,528,437.00;0.00;0.00;229,857.91;;208,961.74;;0.00;;2,089,617.36;;;;;;;;;\r\n;      ; ; ;  ;;;                                                  ;                                        ;Grand TOTAL ;      ;5;2,528,437.00;;;229,857.91;0;208,961.74;0;0.00;;2,089,617.36;;;;;;;;;\r\n";
const RESTO_CSV = "﻿THE OMALA HOTEL;;;;;;;;;;Date: 07/10/2026\r\nJl. Wilis; Semeru; Kec. Prigen;;;;;;;;\r\nTel 0821 77787988;;;;;;;;;;Period: Period: 06/10/26 - 06/10/26\r\nOutlet : 1 - ARJUNA RESTO;;;;;;;;;;\r\nCashier : All;;;;;;;;;;\r\nShift : 0 - All;;;;;;;;;;\r\n;;;;;;;;;;\r\nCashier Sales Report;;;;;;;;;;\r\n;;;;;;;;;;\r\nBill Number;Pax;Food ARJUNA RESTAURANT;Beverage ARJUNA RESTAURANT;B'fast RESTAURANT;Other RESTAURANT;Banquet MICE;Disc Food RESTAURANT;Service;Tax;Total\r\nG-TOTAL;0;0.00;0.00;0.00;0.00;0.00;0.00;0.00;0.00;0.00\r\nR-TOTAL;0;0.00;0.00;0.00;0.00;0.00;0.00;0.00;0.00;0.00\r\n";
const HOTEL_NAME = "20261006_FO Transaction Journal.csv";
const RESTO_NAME = "20261006_Cashier Sales Report.csv";

const num = (value: string) => Number(value.replace(/,/g, ""));

// Fixture RESTO KHUSUS TEST (file referensi tidak berisi transaksi) untuk memverifikasi aturan SQL.
const RESTO_HEADER = "Bill Number;Pax;Food;Beverage;B'fast;Other;Banquet;Disc;Service;Tax;Total";
const restoCsv = (...lines: string[]) => ["THE OMALA HOTEL;;;;;;;;;;", "Cashier Sales Report;;;;;;;;;;", RESTO_HEADER, ...lines].join("\r\n") + "\r\n";

describe("CSV & angka", () => {
  it("memisahkan delimiter ; dan mempertahankan nomor baris termasuk baris kosong", () => {
    const rows = parseDelimited("a;b;c\r\n\r\nx;;z\r\n");
    expect(rows).toEqual([["a", "b", "c"], [""], ["x", "", "z"]]);
  });
  it("mendukung field ber-kutip yang berisi ;", () => {
    expect(parseDelimited('"a;b";c')).toEqual([["a;b", "c"]]);
  });
  it("membersihkan angka sesuai SQL", () => {
    const ok = (raw: string) => { const r = cleanOmalaTotal(raw); return r.ok ? Number(r.value) : r.reason; };
    expect(ok("480,265.00")).toBe(480265);
    expect(ok("1.234.567,00")).toBe(1234567);
    expect(ok("1,234,567.00")).toBe(1234567);
    expect(ok("  500,000.00 ")).toBe(500000);
    expect(ok("0.00")).toBe(0);
    expect(ok("-1,000.00")).toBe(-1000);
    expect(ok("2528437")).toBe(2528437);
  });
  it("tidak menebak nilai kosong, huruf, atau pecahan non-nol", () => {
    expect(cleanOmalaTotal("").ok).toBe(false);
    expect(cleanOmalaTotal(undefined).ok).toBe(false);
    expect(cleanOmalaTotal("abc").ok).toBe(false);
    expect(cleanOmalaTotal("480,265.50").ok).toBe(false);
    expect(cleanOmalaTotal("480.265,5").ok).toBe(false);
  });
  it("tanggal HOTEL dari DD/MM/YYYY dan tanggal RESTO dari 8 karakter nama file", () => {
    expect(parseHotelDate("06/10/2026")).toBe("2026-10-06");
    expect(parseHotelDate("31/02/2026")).toBeNull();
    expect(parseHotelDate("2026-10-06")).toBeNull();
    expect(parseRestoFilenameDate(RESTO_NAME)).toBe("2026-10-06");
    expect(parseRestoFilenameDate("20261306_x.csv")).toBeNull();
    expect(parseRestoFilenameDate("Cashier.csv")).toBeNull();
  });
});

describe("rumus SQL", () => {
  it("HOTEL membulatkan 2 desimal", () => {
    const a = computeOmalaAmounts(480265n, "HOTEL");
    expect(a).toEqual({ subtotal: 396913.22, service_charge: 39691.32, discount: 0, dpp: 436604.55, tax: 43660.45, total: 480265 });
  });
  it("RESTO membulatkan 0 desimal", () => {
    const a = computeOmalaAmounts(1234567n, "RESTO");
    expect(a).toEqual({ subtotal: 1020303, service_charge: 102030, discount: 0, dpp: 1122334, tax: 112233, total: 1234567 });
  });
  it("total 0 menghasilkan semua 0", () => {
    expect(computeOmalaAmounts(0n, "RESTO")).toEqual({ subtotal: 0, service_charge: 0, discount: 0, dpp: 0, tax: 0, total: 0 });
  });
});

describe("file referensi HOTEL (FO Transaction Journal)", () => {
  const parsed = parseOmalaText(HOTEL_CSV, HOTEL_NAME, "HOTEL");
  it("menemukan header di baris 8 dan 5 transaksi; T O T A L / Grand TOTAL tidak masuk", () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.headerRow).toBe(8);
    expect(parsed.rows).toHaveLength(5);
    expect(parsed.issues).toHaveLength(0);
    expect(parsed.skipped.total).toBe(2);
    expect(parsed.rows.map((r) => r.no_struk)).toEqual(["4784-203", "4786-205", "4787-207", "4785-210", "4788-216"]);
    expect(new Set(parsed.rows.map((r) => r.date_trans))).toEqual(new Set(["2026-10-06"]));
    expect(new Set(parsed.rows.map((r) => r.id_agent))).toEqual(new Set(["omala_hotel"]));
    expect(parsed.rows.map((r) => r.total)).toEqual([480265, 480265, 500000, 530376, 537531]);
    expect(parsed.rows.every((r) => r.keterangan?.trim() === "Lodging (Room Revenue)")).toBe(true);
    expect(parsed.rows.every((r) => r.discount === 0 && r.filename === HOTEL_NAME)).toBe(true);
  });
  it("hasil per baris sama dengan kolom Nett Amount / Tax / Service yang tercetak di file", () => {
    if (!parsed.ok) throw new Error("parse gagal");
    const dataLines = parseDelimited(HOTEL_CSV).slice(8, 13);
    parsed.rows.forEach((row, i) => {
      const cols = dataLines[i];
      expect(row.tax).toBe(num(cols[15]));
      expect(row.service_charge).toBe(num(cols[17]));
      expect(row.subtotal).toBe(num(cols[21]));
    });
  });
  it("summary dihitung dari seluruh baris valid", () => {
    if (!parsed.ok) throw new Error("parse gagal");
    const s = summarizeOmalaRows(parsed.rows, 1, "HOTEL");
    expect(s.transactionCount).toBe(5);
    expect(s.total).toBe(2528437); // sama dengan baris T O T A L pada file
    expect(s.discount).toBe(0);
    expect(s.subtotal).toBeCloseTo(parsed.rows.reduce((a, r) => a + r.subtotal, 0), 2);
    expect(formatOmalaMoney(396913.22, "HOTEL")).toBe("Rp396.913,22");
  });
});

describe("file referensi RESTO (Cashier Sales Report)", () => {
  it("header di baris 10; hanya G-TOTAL & R-TOTAL → hasil kosong, bukan transaksi", () => {
    const parsed = parseOmalaText(RESTO_CSV, RESTO_NAME, "RESTO");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.headerRow).toBe(10);
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.issues).toHaveLength(0);
    expect(parsed.skipped.total).toBe(2);
  });
  it("nama file dengan underscore (hasil upload) tetap terbaca", () => {
    expect(parseOmalaText(RESTO_CSV, "20261006_Cashier_Sales_Report.csv", "RESTO").ok).toBe(true);
  });
});

describe("aturan RESTO dengan baris transaksi (fixture khusus test)", () => {
  const csv = restoCsv(
    "1001;2;0;0;0;0;0;0;0;0;1.234.567,00",
    "1002;1;0;0;0;0;0;0;0;0;110.000,00",
    "Subtotal;;;;;;;;;;999.999,00",
    "Outlet : 1 - ARJUNA RESTO;;;;;;;;;;",
    "G-TOTAL;3;0;0;0;0;0;0;0;0;1.344.567,00",
    "1003;1;0;0;0;0;0;0;0;0;",
    "1004;1;0;0;0;0;0;0;0;0;12.345,50",
    "",
  );
  const parsed = parseOmalaText(csv, "20261006_Cashier Sales Report.csv", "RESTO");
  it("hanya kolom A numerik yang menjadi transaksi dan dihitung 0 desimal", () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows.map((r) => r.no_struk)).toEqual(["1001-4", "1002-5"]);
    expect(parsed.rows[0]).toMatchObject({ id_agent: "omala_resto", date_trans: "2026-10-06", subtotal: 1020303, service_charge: 102030, dpp: 1122334, tax: 112233, total: 1234567, discount: 0 });
    expect(parsed.rows[0].keterangan).toBeUndefined();
    expect(parsed.rows[1]).toMatchObject({ subtotal: 90909, service_charge: 9091, dpp: 100000, tax: 10000, total: 110000 });
    expect(parsed.skipped.total).toBe(2); // "Subtotal" dan "G-TOTAL"
    expect(parsed.skipped.other).toBe(1); // "Outlet : ..." (kolom A bukan angka)
  });
  it("baris K kosong / pecahan non-nol dilaporkan, tidak diubah jadi transaksi", () => {
    if (!parsed.ok) throw new Error("parse gagal");
    expect(parsed.issues.map((i) => i.sourceRow)).toEqual([9, 10]);
  });
  it("nama file tanpa tanggal valid → error jelas", () => {
    const bad = parseOmalaText(csv, "Cashier Sales Report.csv", "RESTO");
    expect(bad.ok).toBe(false);
  });
});

describe("validasi struktur", () => {
  it("mendeteksi jenis file dari struktur", () => {
    expect(detectOmalaStructure(parseDelimited(HOTEL_CSV))).toBe("HOTEL");
    expect(detectOmalaStructure(parseDelimited(RESTO_CSV))).toBe("RESTO");
    expect(detectOmalaStructure(parseDelimited("a;b\r\n1;2"))).toBeNull();
  });
  it("kategori salah → pesan error menyebut jenis sebenarnya", () => {
    const r = parseOmalaText(RESTO_CSV, RESTO_NAME, "HOTEL");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("RESTO");
    const h = parseOmalaText(HOTEL_CSV, HOTEL_NAME, "RESTO");
    expect(h.ok).toBe(false);
    if (!h.ok) expect(h.error).toContain("HOTEL");
  });
  it("kolom tidak sesuai query → error menyebut kolom bermasalah (tidak menebak)", () => {
    const moved = HOTEL_CSV.replace("Amount;Foreign Amount", "Nilai;Foreign Amount");
    const r = parseOmalaText(moved, HOTEL_NAME, "HOTEL");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("kolom M");
    const resto = parseOmalaText(RESTO_CSV.replace(";Total", ";Jumlah"), RESTO_NAME, "RESTO");
    expect(resto.ok).toBe(false);
    if (!resto.ok) expect(resto.error).toContain("kolom K");
  });
  it("pemisah koma (bukan ;) ditolak karena header tidak ditemukan", () => {
    const r = parseOmalaText(RESTO_CSV.replace(/;/g, ","), RESTO_NAME, "RESTO");
    expect(r.ok).toBe(false);
  });
  it("file kosong → error", () => {
    expect(parseOmalaText("", HOTEL_NAME, "HOTEL").ok).toBe(false);
  });
});

describe("upload banyak file", () => {
  const file = (text: string, name: string, lastModified = 1) => new File([text], name, { lastModified });
  const hotel2 = HOTEL_CSV.replace(/06\/10\/2026/g, "07/10/2026");

  it("1 file tetap berfungsi", async () => {
    const r = await parseOmalaFiles([file(HOTEL_CSV, HOTEL_NAME)], "HOTEL");
    expect(r.ok).toBe(true);
    expect(r.summary).toMatchObject({ fileCount: 1, transactionCount: 5, total: 2528437 });
  });
  it("menggabungkan seluruh file kategori sama dan tanggal dihitung per file", async () => {
    const r = await parseOmalaFiles([file(HOTEL_CSV, HOTEL_NAME), file(hotel2, "20261007_FO Transaction Journal.csv")], "HOTEL");
    expect(r.summary).toMatchObject({ fileCount: 2, transactionCount: 10, total: 2 * 2528437 });
    expect(new Set(r.rows.map((x) => x.date_trans))).toEqual(new Set(["2026-10-06", "2026-10-07"]));
    expect(new Set(r.rows.map((x) => x.filename)).size).toBe(2);
  });
  it("satu file gagal tidak menghentikan file valid; HOTEL & RESTO tidak dicampur", async () => {
    const r = await parseOmalaFiles([file(HOTEL_CSV, HOTEL_NAME), file(RESTO_CSV, RESTO_NAME), file("x;y", "20261006_FO rusak.csv"), file("x", "catatan.txt")], "HOTEL");
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(5);
    expect(r.files.map((f) => f.status)).toEqual(["success", "error", "error", "error"]);
    expect(r.files[1].message).toContain("RESTO");
    expect(r.rows.every((x) => x.id_agent === "omala_hotel")).toBe(true);
  });
  it("RESTO: file tanpa transaksi → ok dengan hasil kosong & pesan jelas", async () => {
    const r = await parseOmalaFiles([file(RESTO_CSV, RESTO_NAME)], "RESTO");
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(0);
    expect(r.summary.transactionCount).toBe(0);
    expect(r.files[0].status).toBe("warning");
    expect(r.files[0].message).toContain("Tidak ada baris transaksi");
  });
  it("file identik hanya dihitung sekali", async () => {
    const r = await parseOmalaFiles([file(HOTEL_CSV, HOTEL_NAME, 5), file(HOTEL_CSV, HOTEL_NAME, 5)], "HOTEL");
    expect(r.rows).toHaveLength(5);
    expect(r.files[1].duplicate).toBe(true);
  });
  it("semua file gagal → ok=false dengan alasan", async () => {
    const r = await parseOmalaFiles([file(RESTO_CSV, RESTO_NAME)], "HOTEL");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
