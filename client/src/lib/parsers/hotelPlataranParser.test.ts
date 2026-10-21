import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  buildPlataranNoStruk,
  computePlataranAmounts,
  findDuplicatePlataranNoStruk,
  formatPlataranMoney,
  mergePlataranSources,
  parseHotelPlataranWorkbook,
  parsePlataranDecimal,
  parsePlataranFilenameDate,
  plataranToPlain,
  summarizePlataranByCategory,
  summarizePlataranRows,
  PLATARAN_HOTEL_AGENT_ID,
  PLATARAN_PAMIRANTI_AGENT_ID,
  PLATARAN_SYAILENDRA_AGENT_ID,
  PLATARAN_TERAS_BROMO_AGENT_ID,
  type PlataranSource,
} from "./hotelPlataranParser";

const must = (source: PlataranSource) => { expect(source.error).toBeUndefined(); expect(source.ok).toBe(true); return source; };
const plain = (value: bigint) => plataranToPlain(value);

/** Workbook sintetis: sheet pengganggu (MACRO, DRR) + sheet BODY EMAIL yang meniru struktur asli (statistik, header TODAY, baris kategori). */
type Body = Array<[string | null, unknown]>;
const bodySheet = (body: Body, reportDate = "30/09/2026"): unknown[][] => [
  [null, "Daily Revenue Report Plataran Bromo Resorts & Venue"],
  [null, null, reportDate],
  [null, "ROOM STATISTICS", "TODAY"],
  ...body.map(([b, c]) => [null, b, c]),
];
const book = (rows: unknown[][], sheetName = "BODY EMAIL") => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[null, "DECOY"], [null, "ROOM REVENUE", 123456789]]), "MACRO");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[null, "DECOY"], [null, "BANQUET", 987654321]]), "DRR");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
};
const BODY: Body = [
  ["NO OF GUESTS", 77], // di luar kategori
  ["ROOM REVENUE", 66418497.52],
  ["FB STATISTICS (SYAILENDRA & KINANDARI)", "TODAY"], // di luar kategori
  ["FOOD REVENUE", 28394500], // di luar kategori
  ["FB REVENUE SYAILENDRA & KINANDARI", 33845000],
  ["FB REVENUE TERAS BROMO", 2903000], // di luar kategori
  ["FB STATISTICS (PAMIRANTI)", "TODAY"], // di luar kategori
  ["FB REVENUE PAMIRANTI", 3333471.07],
  ["BANQUET", "TODAY"], // header blok
  ["BANQUET", 1250000.5],
  ["SPA REVENUE", 4102272.73], // di luar kategori
  ["ENCOUNTERS REVENUE", 13400000],
  [" m.o.d  revenue ", 2959934.71], // huruf kecil / spasi: tetap dikenali
  ["TOTAL HOTEL REVENUE", 126962176.03], // di luar kategori
];
const SAMPLE = "DRR_PLBR_300926- Tax.xlsx";
const synthetic = (name = SAMPLE, body: Body = BODY) => parseHotelPlataranWorkbook(book(bodySheet(body)), name);

describe("tanggal dari nama file (SQL STR_TO_DATE)", () => {
  const date = (name: string) => { const r = parsePlataranFilenameDate(name); return r.ok ? r.date : "ERROR"; };

  it("nama file sampel: spasi setelah tanda hubung, underscore, atau persis -Tax", () => {
    expect(date("DRR_PLBR_300926- Tax.xlsx")).toBe("2026-09-30");
    expect(date("DRR_PLBR_300926-_Tax.xlsx")).toBe("2026-09-30");
    expect(date("DRR_PLBR_300926-Tax.xlsx")).toBe("2026-09-30");
    expect(date("DRR_PLBR_010126-tax.xlsx")).toBe("2026-01-01");
  });
  it("tanpa penanda -Tax tetap mengikuti SUBSTRING_INDEX; DDMMYYYY 8 digit; sufiks (1) diabaikan", () => {
    expect(date("DRR_PLBR_300926.xlsx")).toBe("2026-09-30");
    expect(date("DRR_PLBR_30092026- Tax.xlsx")).toBe("2026-09-30");
    expect(date("DRR_PLBR_300926- Tax (1).xlsx")).toBe("2026-09-30");
    expect(date("DRR_PLBR_290224- Tax.xlsx")).toBe("2024-02-29");
  });
  it("tidak valid → error (tidak pernah memakai tanggal hari ini)", () => {
    for (const name of ["DRR_PLBR_310226- Tax.xlsx", "DRR_PLBR_011326- Tax.xlsx", "DRR_PLBR_- Tax.xlsx", "DRR_PLBR_30926- Tax.xlsx", "DRR_PLBR_3009260- Tax.xlsx", "laporan.xlsx"]) expect(date(name)).toBe("ERROR");
    const r = parsePlataranFilenameDate("laporan.xlsx");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("laporan.xlsx");
  });
  it("no_struk = B + '-' + nama file tanpa .xlsx; bagian lain nama file tidak dihapus", () => {
    expect(buildPlataranNoStruk("Laundry", SAMPLE)).toBe("Laundry-DRR_PLBR_300926- Tax");
    expect(buildPlataranNoStruk("A", "DRR_PLBR_300926- Tax (1).xlsx")).toBe("A-DRR_PLBR_300926- Tax (1)");
  });
});

describe("rumus PLATARAN (desimal eksak)", () => {
  it("C=100 → SC 10, DPP 110, tax 11, total 121", () => {
    const a = computePlataranAmounts(parsePlataranDecimal("100")!);
    expect([a.subtotal, a.service_charge, a.discount, a.dpp, a.tax, a.total].map(plain)).toEqual(["100", "10", "0", "110", "11", "121"]);
  });
  it("C=66418497.52 tanpa pembulatan antara", () => {
    const a = computePlataranAmounts(parsePlataranDecimal("66418497.52")!);
    expect([a.service_charge, a.dpp, a.tax, a.total].map(plain)).toEqual(["6641849.752", "73060347.272", "7306034.7272", "80366381.9992"]);
  });
  it("C negatif (diskon) menghasilkan semua nilai negatif; 0.3 tanpa noise floating point", () => {
    const a = computePlataranAmounts(parsePlataranDecimal("-150500")!);
    expect([a.subtotal, a.service_charge, a.dpp, a.tax, a.total].map(plain)).toEqual(["-150500", "-15050", "-165550", "-16555", "-182105"]);
    expect(plain(computePlataranAmounts(parsePlataranDecimal("0.3")!).total)).toBe("0.363");
  });
  it("TERAS BROMO: SQL C*1.1, C*1.1*0.1, C*1.1*1.1 → total identik dengan dpp + tax (C=2903000 → 3193300 / 319330 / 3512630)", () => {
    const a = computePlataranAmounts(parsePlataranDecimal("2903000")!);
    expect([a.service_charge, a.dpp, a.tax, a.total].map(plain)).toEqual(["290300", "3193300", "319330", "3512630"]);
    expect(a.total).toBe(a.dpp + a.tax);
    const b = computePlataranAmounts(parsePlataranDecimal("66418497.52")!);
    expect(plain(b.total)).toBe("80366381.9992"); // 66418497.52 * 1.1 * 1.1 tanpa pembulatan antara
  });
  it("pembulatan hanya saat tampilan", () => {
    expect(formatPlataranMoney(computePlataranAmounts(parsePlataranDecimal("66418497.52")!).total)).toBe("Rp80.366.382,00");
    expect(formatPlataranMoney(0n)).toBe("Rp0,00");
    expect(parsePlataranDecimal("abc")).toBeNull();
    expect(parsePlataranDecimal("")).toBeNull();
  });
});

const SAMPLE_PATH = fileURLToPath(new URL("../fixtures/hotelPlataranDRR300926.xlsx", import.meta.url));
const sampleBuffer = () => { const b = readFileSync(SAMPLE_PATH); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };

describe("file contoh asli DRR_PLBR_300926- Tax.xlsx (sheet BODY EMAIL)", () => {
  const src = must(parseHotelPlataranWorkbook(sampleBuffer(), SAMPLE));
  const by = (cat: string) => src.rows.filter((r) => r.category === cat);

  it("membaca sheet BODY EMAIL; HOTEL 3, SYAILENDRA 2, PAMIRANTI 1, TERAS BROMO 1 record dari satu file", () => {
    expect(src.sheetName).toBe("BODY EMAIL");
    expect(by("HOTEL").map((r) => r.keterangan)).toEqual(["ROOM REVENUE", "ENCOUNTERS REVENUE", "M.O.D REVENUE"]);
    expect(by("SYAILENDRA").map((r) => r.keterangan)).toEqual(["FB REVENUE SYAILENDRA & KINANDARI", "BANQUET"]);
    expect(by("PAMIRANTI").map((r) => r.keterangan)).toEqual(["FB REVENUE PAMIRANTI"]);
    expect(by("TERAS_BROMO").map((r) => r.keterangan)).toEqual(["FB REVENUE TERAS BROMO"]);
    expect(src.rows).toHaveLength(7);
    expect(src.stats).toMatchObject({ hotelRows: 3, syailendraRows: 2, pamirantiRows: 1, terasBromoRows: 1, validRows: 7, headerRows: 1, invalidAmountRows: 0, zeroRows: 1, files: 1 });
    expect(src.stats.sourceRows).toBe(src.stats.validRows + src.stats.headerRows + src.stats.ignoredRows + src.stats.invalidAmountRows);
    expect(src.issues).toEqual([]);
    expect(src.warnings).toEqual([]);
  });
  it("id_agent, no_struk, date_trans, keterangan per kategori", () => {
    expect(by("HOTEL").every((r) => r.id_agent === PLATARAN_HOTEL_AGENT_ID && r.id_agent === "hotel_plataran")).toBe(true);
    expect(by("SYAILENDRA").every((r) => r.id_agent === PLATARAN_SYAILENDRA_AGENT_ID && r.id_agent === "syailendra_venue_and_dining")).toBe(true);
    expect(by("PAMIRANTI").every((r) => r.id_agent === PLATARAN_PAMIRANTI_AGENT_ID && r.id_agent === "resto_pamiranti_lounge")).toBe(true);
    expect(by("TERAS_BROMO").every((r) => r.id_agent === PLATARAN_TERAS_BROMO_AGENT_ID && r.id_agent === "resto_teras_bromo")).toBe(true);
    expect(src.rows.some((r) => r.id_agent === "resto_plataran")).toBe(false);
    expect(src.rows.every((r) => r.date_trans === "2026-09-30" && r.no_struk === `${r.keterangan}-DRR_PLBR_300926- Tax`)).toBe(true);
  });
  it("kategori di luar tujuh label (SPA, statistik, TOTAL) tidak ikut; PAMIRANTI dan TERAS BROMO hanya di kategorinya sendiri", () => {
    const labels = src.rows.map((r) => r.keterangan);
    for (const bad of ["SPA REVENUE", "TOTAL HOTEL REVENUE", "FOOD REVENUE", "NO OF GUESTS", "FB STATISTICS (PAMIRANTI)"]) expect(labels).not.toContain(bad);
    expect(by("SYAILENDRA").some((r) => r.keterangan === "FB REVENUE PAMIRANTI")).toBe(false);
    expect(by("PAMIRANTI").some((r) => r.keterangan === "BANQUET" || r.keterangan === "FB REVENUE SYAILENDRA & KINANDARI" || r.keterangan === "FB REVENUE TERAS BROMO")).toBe(false);
    expect(by("SYAILENDRA").some((r) => r.keterangan === "FB REVENUE TERAS BROMO")).toBe(false);
    expect(by("TERAS_BROMO").every((r) => r.keterangan === "FB REVENUE TERAS BROMO")).toBe(true);
    expect(new Set(src.rows.map((r) => r.no_struk)).size).toBe(src.rows.length); // tidak ada transaksi ganda
    expect(src.stats.ignoredRows).toBeGreaterThan(30);
  });
  it("nilai per baris cocok dengan sheet; BANQUET (blok header TODAY dilewati) = 0 tetap record", () => {
    const sub = Object.fromEntries(src.rows.map((r) => [r.keterangan, plain(r.subtotal)]));
    expect(sub).toEqual({
      "ROOM REVENUE": "66418497.52", "ENCOUNTERS REVENUE": "13400000", "M.O.D REVENUE": "2959934.71",
      "FB REVENUE SYAILENDRA & KINANDARI": "33845000", BANQUET: "0", "FB REVENUE PAMIRANTI": "3333471.0700000003", "FB REVENUE TERAS BROMO": "2903000",
    });
    expect(src.rows.find((r) => r.keterangan === "BANQUET")!.notes).toContain("Nominal 0");
  });
  it("ringkasan per kategori = hitung independen (Decimal) dan jumlah = ringkasan keseluruhan", () => {
    const s = summarizePlataranByCategory(src.rows);
    expect(s.HOTEL.count).toBe(3);
    expect(s.SYAILENDRA.count).toBe(2);
    expect(s.PAMIRANTI.count).toBe(1);
    expect(s.TERAS_BROMO.count).toBe(1);
    expect([s.HOTEL.subtotal, s.HOTEL.service_charge, s.HOTEL.dpp, s.HOTEL.tax, s.HOTEL.total].map(plain)).toEqual(["82778432.23", "8277843.223", "91056275.453", "9105627.5453", "100161902.9983"]);
    expect([s.SYAILENDRA.subtotal, s.SYAILENDRA.service_charge, s.SYAILENDRA.dpp, s.SYAILENDRA.tax, s.SYAILENDRA.total].map(plain)).toEqual(["33845000", "3384500", "37229500", "3722950", "40952450"]);
    // C sel Excel = 3333471.0700000003 (angka float di file); hasil dihitung eksak dari nilai itu, tampilan dibulatkan 2 desimal.
    expect([s.PAMIRANTI.subtotal, s.PAMIRANTI.service_charge, s.PAMIRANTI.dpp, s.PAMIRANTI.tax, s.PAMIRANTI.total].map(plain)).toEqual(["3333471.0700000003", "333347.10700000003", "3666818.17700000033", "366681.817700000033", "4033499.994700000363"]);
    expect(formatPlataranMoney(s.PAMIRANTI.subtotal)).toBe("Rp3.333.471,07");
    expect([s.TERAS_BROMO.subtotal, s.TERAS_BROMO.service_charge, s.TERAS_BROMO.dpp, s.TERAS_BROMO.tax, s.TERAS_BROMO.total].map(plain)).toEqual(["2903000", "290300", "3193300", "319330", "3512630"]);
    const all = summarizePlataranRows(src.rows);
    expect(all.total).toBe(s.HOTEL.total + s.SYAILENDRA.total + s.PAMIRANTI.total + s.TERAS_BROMO.total);
    expect(all.count).toBe(s.HOTEL.count + s.SYAILENDRA.count + s.PAMIRANTI.count + s.TERAS_BROMO.count);
    expect(plain(all.total)).toBe("148660482.993000000363");
  });
});

describe("struktur sheet BODY EMAIL", () => {
  it("memakai BODY EMAIL, bukan MACRO/DRR yang juga punya label kategori", () => {
    const src = must(synthetic());
    expect(src.rows.map((r) => plain(r.subtotal))).toEqual(["66418497.52", "33845000", "2903000", "1250000.5", "3333471.07", "13400000", "2959934.71"]);
    expect(src.rows.map((r) => r.category)).toEqual(["HOTEL", "SYAILENDRA", "TERAS_BROMO", "SYAILENDRA", "PAMIRANTI", "HOTEL", "HOTEL"]);
    expect(src.stats).toMatchObject({ hotelRows: 3, syailendraRows: 2, pamirantiRows: 1, terasBromoRows: 1, headerRows: 1, ignoredRows: 9, sourceRows: 17 /* 3 baris judul + 14 baris isi */ });
  });
  it("urutan baris kategori tidak menentukan: ketiga kategori bercampur tetap masuk kategori yang benar", () => {
    const src = must(synthetic(SAMPLE, [["BANQUET", 10], ["FB REVENUE PAMIRANTI", 60], ["FB REVENUE TERAS BROMO", 70], ["ROOM REVENUE", 20], ["M.O.D REVENUE", 30], ["FB REVENUE SYAILENDRA & KINANDARI", 40], ["ENCOUNTERS REVENUE", 50]]));
    expect(src.rows.map((r) => `${r.category}:${r.keterangan}`)).toEqual(["SYAILENDRA:BANQUET", "PAMIRANTI:FB REVENUE PAMIRANTI", "TERAS_BROMO:FB REVENUE TERAS BROMO", "HOTEL:ROOM REVENUE", "HOTEL:M.O.D REVENUE", "SYAILENDRA:FB REVENUE SYAILENDRA & KINANDARI", "HOTEL:ENCOUNTERS REVENUE"]);
  });
  it("label mirip tapi bukan persis tidak ikut (ROOM REVENUES, TOTAL ROOM REVENUE, BANQUET REVENUE, FB REVENUE PAMIRANTI LOUNGE, TERAS BROMO, FB REVENUE TERAS)", () => {
    const src = must(synthetic(SAMPLE, [["ROOM REVENUES", 1], ["TOTAL ROOM REVENUE", 2], ["BANQUET REVENUE", 3], ["FB REVENUE PAMIRANTI LOUNGE", 5], ["TERAS BROMO", 6], ["FB REVENUE TERAS", 7], ["ROOM REVENUE", 4]]));
    expect(src.rows).toHaveLength(1);
    expect(src.stats.ignoredRows).toBe(6 + 3); // 3 label mirip + 3 baris pembuka helper (judul, tanggal, ROOM STATISTICS)
  });
  it("sheet BODY EMAIL tidak ada → error, tidak mengambil sheet lain", () => {
    const r = parseHotelPlataranWorkbook(book(bodySheet(BODY), "DRR2"), SAMPLE);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('"BODY EMAIL"');
    expect(r.error).toContain("MACRO");
  });
  it("tidak ada satu pun label kategori → error jelas", () => {
    const r = synthetic(SAMPLE, [["NO OF GUESTS", 5]]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ROOM REVENUE");
  });
  it("sebagian kategori hilang → peringatan, file tetap diproses", () => {
    const src = must(synthetic(SAMPLE, [["ROOM REVENUE", 100]]));
    expect(src.rows).toHaveLength(1);
    expect(src.warnings.join("\n")).toContain("SYAILENDRA VENUE AND DINING");
    expect(src.warnings.join("\n")).toContain("RESTO PAMIRANTI LOUNGE");
    expect(src.warnings.join("\n")).toContain("BANQUET");
    expect(src.warnings.join("\n")).toContain("FB REVENUE PAMIRANTI");
    expect(src.warnings.join("\n")).toContain("RESTO TERAS BROMO");
    expect(src.warnings.join("\n")).toContain("FB REVENUE TERAS BROMO");
    expect(src.warnings.join("\n")).toContain("ENCOUNTERS REVENUE");
  });
  it("nama file tanpa tanggal valid → file gagal tanpa record", () => {
    const r = synthetic("laporan.xlsx");
    expect(r.ok).toBe(false);
    expect(r.rows).toEqual([]);
    expect(r.error).toContain("laporan.xlsx");
  });
  it("bukan workbook → error jelas", () => {
    const r = parseHotelPlataranWorkbook(new TextEncoder().encode("bukan excel").buffer as ArrayBuffer, SAMPLE);
    expect(r.ok).toBe(false);
    expect(r.rows).toEqual([]);
  });
  it("tanggal laporan di dalam sheet berbeda → peringatan; tanggal tetap dari nama file", () => {
    const r = must(parseHotelPlataranWorkbook(book(bodySheet(BODY, "29/09/2026")), SAMPLE));
    expect(r.rows.every((x) => x.date_trans === "2026-09-30")).toBe(true);
    expect(r.warnings.join("\n")).toContain("2026-09-29");
  });
  it("C kosong / teks / error pada baris kategori → dilaporkan, TIDAK dijadikan 0; angka teks polos diterima, format ribuan ditolak", () => {
    const r = must(synthetic(SAMPLE, [["ROOM REVENUE", null], ["ENCOUNTERS REVENUE", "abc"], ["M.O.D REVENUE", "1.234,56"], ["BANQUET", "2500.5"], ["FB REVENUE SYAILENDRA & KINANDARI", 5]]));
    expect(r.rows.map((x) => x.keterangan)).toEqual(["BANQUET", "FB REVENUE SYAILENDRA & KINANDARI"]);
    expect(plain(r.rows[0].subtotal)).toBe("2500.5");
    expect(r.stats.invalidAmountRows).toBe(3);
    expect(r.issues.map((i) => i.label)).toEqual(["ROOM REVENUE", "ENCOUNTERS REVENUE", "M.O.D REVENUE"]);
    expect(r.issues[0].message).toContain("kosong");
    expect(r.issues[1].message).toContain("bukan angka");
  });
  it("sel error Excel (#DIV/0!) dilaporkan sebagai nominal tidak valid", () => {
    const ws = XLSX.utils.aoa_to_sheet([[null, "ROOM REVENUE", 1], [null, "BANQUET", 2]]);
    ws.C1 = { t: "e", v: 7, w: "#DIV/0!" } as XLSX.CellObject;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "BODY EMAIL");
    const r = must(parseHotelPlataranWorkbook(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer, SAMPLE));
    expect(r.rows.map((x) => x.keterangan)).toEqual(["BANQUET"]);
    expect(r.issues[0].value).toBe("#DIV/0!");
  });
  it("nilai negatif dipertahankan (tidak dihapus / diubah) dan semua turunannya negatif", () => {
    const r = must(synthetic(SAMPLE, [["ROOM REVENUE", -1000]]));
    expect(r.rows).toHaveLength(1);
    expect([r.rows[0].subtotal, r.rows[0].service_charge, r.rows[0].dpp, r.rows[0].tax, r.rows[0].total].map(plain)).toEqual(["-1000", "-100", "-1100", "-110", "-1210"]);
    expect(r.rows[0].notes).toContain("Nominal negatif");
  });
  it("label kategori bernilai angka dua kali → dua record, ditandai no_struk ganda (sesuai SQL tanpa GROUP BY)", () => {
    const r = must(synthetic(SAMPLE, [["BANQUET", 10], ["BANQUET", 20]]));
    expect(r.rows).toHaveLength(2);
    expect([...findDuplicatePlataranNoStruk(r.rows)]).toEqual(["BANQUET-DRR_PLBR_300926- Tax"]);
  });
});

describe("mode BULANAN: banyak file, tanggal berbeda", () => {
  const f1 = must(synthetic("DRR_PLBR_290926- Tax.xlsx", [["ROOM REVENUE", 100000], ["BANQUET", 50000], ["FB REVENUE PAMIRANTI", 200000], ["FB REVENUE TERAS BROMO", 100000]]));
  const f2 = must(synthetic("DRR_PLBR_300926- Tax.xlsx", [["ROOM REVENUE", 721000], ["BANQUET", 0], ["FB REVENUE SYAILENDRA & KINANDARI", 2400000], ["FB REVENUE PAMIRANTI", 300000], ["FB REVENUE TERAS BROMO", 400000]]));
  const f3 = must(synthetic("DRR_PLBR_011026- Tax.xlsx", [["M.O.D REVENUE", 33333.33], ["ENCOUNTERS REVENUE", 4000]]));
  const merged = mergePlataranSources([f1, f2, f3]);

  it("menggabungkan 3 file; jumlah record = jumlah record per file; ketiga kategori tidak tercampur", () => {
    expect(merged.ok).toBe(true);
    expect(merged.stats.files).toBe(3);
    expect(merged.rows).toHaveLength(11);
    expect(merged.stats.hotelRows).toBe(4);
    expect(merged.stats.syailendraRows).toBe(3);
    expect(merged.stats.pamirantiRows).toBe(2);
    expect(merged.stats.terasBromoRows).toBe(2);
    expect(merged.stats.validRows).toBe(merged.rows.length);
    expect(merged.rows.filter((r) => r.category === "HOTEL").every((r) => r.id_agent === "hotel_plataran")).toBe(true);
    expect(merged.rows.filter((r) => r.category === "SYAILENDRA").every((r) => r.id_agent === "syailendra_venue_and_dining")).toBe(true);
    expect(merged.rows.filter((r) => r.category === "PAMIRANTI").every((r) => r.id_agent === "resto_pamiranti_lounge")).toBe(true);
    expect(merged.rows.filter((r) => r.category === "TERAS_BROMO").every((r) => r.id_agent === "resto_teras_bromo")).toBe(true);
    expect(merged.dates).toEqual(["2026-09-29", "2026-09-30", "2026-10-01"]);
  });
  it("setiap record memakai nama file, tanggal, dan no_struk file asalnya (bukan file pertama / hari ini)", () => {
    const expectations: Array<[PlataranSource, string, string]> = [
      [f1, "2026-09-29", "DRR_PLBR_290926- Tax"],
      [f2, "2026-09-30", "DRR_PLBR_300926- Tax"],
      [f3, "2026-10-01", "DRR_PLBR_011026- Tax"],
    ];
    for (const [src, date, stem] of expectations) {
      const mine = merged.rows.filter((r) => r.filename === src.fileName);
      expect(mine).toHaveLength(src.rows.length);
      expect(mine.every((r) => r.date_trans === date && r.no_struk === `${r.keterangan}-${stem}`)).toBe(true);
    }
    expect(new Set(merged.rows.map((r) => r.no_struk)).size).toBe(11); // tidak ada duplikasi
  });
  it("HARIAN (tiap file sendiri) dan BULANAN (gabungan) konsisten: record, ringkasan per kategori", () => {
    const parts = [f1, f2, f3].map((s) => summarizePlataranByCategory(s.rows));
    const m = summarizePlataranByCategory(merged.rows);
    for (const cat of ["HOTEL", "SYAILENDRA", "PAMIRANTI", "TERAS_BROMO"] as const) {
      expect(m[cat].count).toBe(parts.reduce((n, p) => n + p[cat].count, 0));
      for (const key of ["subtotal", "service_charge", "dpp", "tax", "total"] as const) expect(m[cat][key]).toBe(parts.reduce((n, p) => n + p[cat][key], 0n));
    }
    expect(plain(m.HOTEL.subtotal)).toBe("858333.33"); // 100000 + 721000 + 33333.33 + 4000
    expect(plain(m.SYAILENDRA.subtotal)).toBe("2450000"); // 50000 + 0 + 2400000
    expect(plain(m.PAMIRANTI.subtotal)).toBe("500000"); // 200000 + 300000
    expect(plain(m.HOTEL.total)).toBe("1038583.3293"); // 858333.33 * 1.21
    expect(plain(m.SYAILENDRA.total)).toBe("2964500"); // 2450000 * 1.21
    expect(plain(m.PAMIRANTI.total)).toBe("605000"); // 500000 * 1.21
    expect(plain(m.TERAS_BROMO.subtotal)).toBe("500000"); // 100000 + 400000
    expect(plain(m.TERAS_BROMO.total)).toBe("605000"); // 500000 * 1.1 * 1.1
    expect(plain(summarizePlataranRows(merged.rows).total)).toBe("5213083.3293");
  });
  it("file gagal tidak ikut dihitung dan terlaporkan; semua gagal → hasil gagal", () => {
    const bad = synthetic("tanpa-tanggal.xlsx");
    expect(bad.ok).toBe(false);
    const m = mergePlataranSources([f1, bad, f2]);
    expect(m.stats.files).toBe(2);
    expect(m.rows).toHaveLength(9);
    expect(bad.error).toContain("tanpa-tanggal.xlsx");
    const allBad = mergePlataranSources([synthetic("a.xlsx"), synthetic("b.xlsx")]);
    expect(allBad.ok).toBe(false);
    expect(allBad.rows).toEqual([]);
  });
  it("satu file tanpa sheet BODY EMAIL tidak menggagalkan file lain", () => {
    const noSheet = parseHotelPlataranWorkbook(book(bodySheet(BODY), "LAIN"), "DRR_PLBR_020926- Tax.xlsx");
    expect(noSheet.ok).toBe(false);
    const m = mergePlataranSources([f1, noSheet, f3]);
    expect(m.rows).toHaveLength(6);
    expect(m.stats.files).toBe(2);
  });
  it("peringatan per file diberi awalan nama file; urutan file dipertahankan", () => {
    const warned = must(synthetic("DRR_PLBR_020926- Tax.xlsx", [["ROOM REVENUE", 100]]));
    const m = mergePlataranSources([warned, f2]);
    expect(m.warnings[0].startsWith("DRR_PLBR_020926- Tax.xlsx:")).toBe(true);
    expect(mergePlataranSources([f3, f1]).dates).toEqual(["2026-10-01", "2026-09-29"]);
  });
  it("file sampel asli yang sama dengan nama/tanggal berbeda tetap memakai tanggalnya sendiri", () => {
    const real = (name: string) => must(parseHotelPlataranWorkbook(sampleBuffer(), name));
    const m = mergePlataranSources([real("DRR_PLBR_290926- Tax.xlsx"), real("DRR_PLBR_300926- Tax.xlsx")]);
    expect(m.rows).toHaveLength(14);
    expect(m.stats).toMatchObject({ hotelRows: 6, syailendraRows: 4, pamirantiRows: 2, terasBromoRows: 2, files: 2 });
    expect(m.rows.filter((r) => r.date_trans === "2026-09-29")).toHaveLength(7);
    expect(m.rows.filter((r) => r.date_trans === "2026-09-30")).toHaveLength(7);
    expect(plain(summarizePlataranRows(m.rows).total)).toBe("297320965.986000000726"); // 2 × 148660482.993000000363
  });
});
