import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  computeInnaAmounts,
  countInnaByCategory,
  filterInnaRows,
  formatInnaMoney,
  formatInnaPeriod,
  innaToPlain,
  listInnaPeriods,
  mergeInnaSources,
  parseInnaDate,
  parseInnaDecimal,
  parseInnaTretesWorkbook,
  summarizeInnaRows,
  type InnaSource,
  type InnaTretesRow,
} from "./innaTretesParser";

// ---------- fixture ----------
// Fixture SINTETIS hanya untuk pengujian aturan; struktur kolom meniru file asli innatretes20261001.xlsx.
const HEADER = ["Class", "Folio", "Room", "Trn Date", "Trans ID", "Trn Code", "Trans Name", "Remark", "Reference", "Jrnl Code", "Shift", "Trans Nett"];
const TITLE: unknown[][] = [["Inna Tretes Hotel & Resort Pasuruan"], ["Detail Night Audit Report"], [], ["Transaction Date :", "01-Oct-26"], [], [46297.43], []];
const OCT_1 = 46296; // 2026-10-01
const SEP_30 = 46295; // 2026-09-30
const NOV_1 = 46327; // 2026-11-01

const tx = (code: unknown, folio: unknown, date: unknown, id: unknown, name: unknown, l: unknown): unknown[] =>
  [code, folio, "34", date, id, "R001", name, "", "", "NA", "3", l];

const book = (aoa: unknown[][], sheetName = "Report", bookType: XLSX.BookType = "xlsx") => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  return XLSX.write(wb, { type: "array", bookType }) as ArrayBuffer;
};
const parse = (rows: unknown[][], name = "x.xlsx") => parseInnaTretesWorkbook(book([...TITLE, HEADER, ...rows]), name);
const must = (source: InnaSource) => { expect(source.error).toBeUndefined(); expect(source.ok).toBe(true); return source; };

// ---------- file contoh ASLI ----------
const SAMPLE_PATH = fileURLToPath(new URL("./fixtures/innatretes20261001.xlsx", import.meta.url));
const sampleBuffer = () => { const b = readFileSync(SAMPLE_PATH); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };

describe("file contoh asli innatretes20261001.xlsx", () => {
  const source = must(parseInnaTretesWorkbook(sampleBuffer(), "innatretes20261001.xlsx"));
  const counts = countInnaByCategory(source.rows);

  it("membaca sheet Report, header di baris 8, tanpa baris bermasalah", () => {
    expect(source.sheetName).toBe("Report");
    expect(source.headerRow).toBe(8);
    expect(source.issues).toEqual([]);
    expect(source.unmapped).toEqual([]);
    expect(source.stats.validRows).toBe(52);
  });

  it("jumlah transaksi per kategori: ROOM 36 → HOTEL, FB 12 + FB POS 4 → RESTO, POOL 0 → HIBURAN", () => {
    expect(counts).toEqual({ HOTEL: 36, HIBURAN: 0, RESTO: 16 });
    expect(source.rows.filter((r) => r.sourceCode === "FB").length).toBe(12);
    expect(source.rows.filter((r) => r.sourceCode === "FB POS").length).toBe(4);
  });

  it("seluruh tanggal kolom D = 2026-10-01 → satu periode Oktober 2026", () => {
    expect(new Set(source.rows.map((r) => r.date_trans))).toEqual(new Set(["2026-10-01"]));
    expect(listInnaPeriods(source.rows)).toEqual([{ year: 2026, month: 10, count: 52 }]);
  });

  it("jumlah eksak sama dengan hitungan independen (Python Decimal) dari kolom L", () => {
    const hotel = summarizeInnaRows(filterInnaRows(source.rows, null, "HOTEL"));
    expect(innaToPlain(hotel.subtotal)).toBe("3732963.6361636365");
    expect(innaToPlain(hotel.tax)).toBe("410625.999978000015");
    expect(innaToPlain(hotel.dpp)).toBe("4106259.99978000015");
    expect(innaToPlain(hotel.service_charge)).toBe("-373296.36361636365");
    expect(innaToPlain(hotel.total)).toBe("4516885.999758000165");
    const resto = summarizeInnaRows(filterInnaRows(source.rows, null, "RESTO"));
    expect(innaToPlain(resto.subtotal)).toBe("652066.11570247898");
    expect(innaToPlain(resto.total)).toBe("788999.9999999995658");
    const all = summarizeInnaRows(source.rows);
    expect(all.count).toBe(52);
    expect(innaToPlain(all.subtotal)).toBe("4385029.75186611548");
    expect(innaToPlain(all.total)).toBe("5305885.9997579997308");
    expect(all.total).toBe(hotel.total + resto.total);
  });

  it("transaksi FB POS tanpa Folio tetap dihitung; no_struk mengikuti CONCAT(B, ' - ', E)", () => {
    expect(source.stats.missingFolioRows).toBe(4);
    const fbPos = source.rows.find((r) => r.sourceRow === 57)!;
    expect(fbPos.category).toBe("RESTO");
    expect(fbPos.no_struk).toBe(" - 62943");
    expect(fbPos.keterangan).toBe("Folio =  Trans Name= Restaurant");
    const room = source.rows.find((r) => r.sourceRow === 9)!;
    expect(room.id_agent).toBe("inna_room");
    expect(room.no_struk).toBe("145441 - 2207777");
    expect(room.keterangan).toBe("Folio = 145441 Trans Name= Room Charge");
    expect(room.date_trans).toBe("2026-10-01");
  });
});

// ---------- rumus ----------
describe("rumus transaksi (sama untuk ketiga kategori)", () => {
  it("L = 1000 → subtotal 1000, service_charge −100, discount 0, dpp 1100, tax 110, total 1210", () => {
    const l = parseInnaDecimal("1000")!;
    const a = computeInnaAmounts(l);
    expect(innaToPlain(a.subtotal)).toBe("1000");
    expect(innaToPlain(a.service_charge)).toBe("-100");
    expect(innaToPlain(a.discount)).toBe("0");
    expect(innaToPlain(a.dpp)).toBe("1100");
    expect(innaToPlain(a.tax)).toBe("110");
    expect(innaToPlain(a.total)).toBe("1210");
  });

  it("nilai pecahan panjang dihitung eksak tanpa pembulatan dasar L (hasil sama dengan Decimal)", () => {
    const a = computeInnaAmounts(parseInnaDecimal("-69453.7685950413")!);
    expect(innaToPlain(a.subtotal)).toBe("-69453.7685950413");
    expect(innaToPlain(a.total)).toBe("-84039.059999999973");
    expect(innaToPlain(a.tax)).toBe("-7639.914545454543");
    expect(innaToPlain(a.dpp)).toBe("-76399.14545454543");
    expect(innaToPlain(a.service_charge)).toBe("6945.37685950413"); // L − dpp = L − 1,1·L, dicatat sebagai temuan
  });

  it("id_agent, no_struk, keterangan, tanggal per kategori", () => {
    const s = must(parse([
      tx("ROOM", 100, OCT_1, 1, "Room Charge", 1000),
      tx("POOL", 200, OCT_1, 2, "Pool Ticket", 500),
      tx("FB", 300, OCT_1, 3, "Food", 250),
    ]));
    expect(s.rows.map((r) => [r.id_agent, r.category])).toEqual([["inna_room", "HOTEL"], ["inna_pool", "HIBURAN"], ["inna_resto", "RESTO"]]);
    expect(s.rows[1].no_struk).toBe("200 - 2");
    expect(s.rows[1].keterangan).toBe("Folio = 200 Trans Name= Pool Ticket");
    expect(s.rows[1].date_trans).toBe("2026-10-01");
    expect(innaToPlain(s.rows[1].total)).toBe("605");
  });

  it("tampilan uang: 2 desimal, pemisah id-ID, negatif, tanpa −0", () => {
    expect(formatInnaMoney(parseInnaDecimal("1234567.891")! * 100n)).toBe("Rp1.234.567,89");
    expect(formatInnaMoney(computeInnaAmounts(parseInnaDecimal("-69453.7685950413")!).total)).toBe("Rp-84.039,06");
    expect(formatInnaMoney(0n)).toBe("Rp0,00");
    expect(formatInnaMoney(-1n)).toBe("Rp0,00");
    expect(formatInnaMoney(computeInnaAmounts(parseInnaDecimal("0.005")!).subtotal)).toBe("Rp0,01");
  });
});

// ---------- kategori ----------
describe("pemetaan kategori dari kolom A", () => {
  it("ROOM → HOTEL, POOL → HIBURAN, FB dan FB POS → RESTO", () => {
    const s = must(parse([
      tx("ROOM", 1, OCT_1, 11, "a", 1), tx("POOL", 2, OCT_1, 12, "b", 1), tx("FB", 3, OCT_1, 13, "c", 1), tx("FB POS", 4, OCT_1, 14, "d", 1),
    ]));
    expect(s.rows.map((r) => r.category)).toEqual(["HOTEL", "HIBURAN", "RESTO", "RESTO"]);
    expect(countInnaByCategory(s.rows)).toEqual({ HOTEL: 1, HIBURAN: 1, RESTO: 2 });
  });

  it("spasi tidak sengaja dan huruf kecil dinormalisasi tanpa mengubah kategori", () => {
    const s = must(parse([tx(" room ", 1, OCT_1, 21, "a", 1), tx("fb  pos", 2, OCT_1, 22, "b", 1), tx("Pool", 3, OCT_1, 23, "c", 1)]));
    expect(s.rows.map((r) => r.category)).toEqual(["HOTEL", "RESTO", "HIBURAN"]);
    expect(s.rows[1].sourceCode).toBe("FB POS");
  });

  it("kode tidak dikenal tidak dipaksakan ke kategori mana pun dan dilaporkan dengan nomor baris", () => {
    const s = must(parse([tx("ROOM", 1, OCT_1, 31, "a", 1), tx("SPA", 2, OCT_1, 32, "Spa Treatment", 700), tx("ROOMS", 3, OCT_1, 33, "x", 1), tx("FBX", 4, OCT_1, 34, "y", 1), tx(null, 5, OCT_1, 35, "z", 1)]));
    expect(s.rows).toHaveLength(1);
    expect(s.stats.unmappedRows).toBe(4);
    expect(s.unmapped.map((u) => [u.row, u.code, u.transId])).toEqual([[10, "SPA", "32"], [11, "ROOMS", "33"], [12, "FBX", "34"], [13, "", "35"]]);
  });
});

// ---------- validasi E ----------
describe("validasi transaksi berdasarkan kolom E", () => {
  it("E kosong atau hanya spasi diabaikan; baris total laporan tidak dihitung", () => {
    const s = must(parse([
      tx("ROOM", 1, OCT_1, 41, "ok", 100),
      tx("ROOM", 1, OCT_1, null, "tanpa id", 100),
      tx("ROOM", 1, OCT_1, "   ", "spasi", 100),
      ["Total", null, null, null, null, null, null, null, null, null, null, 99999],
      ["GRAND TOTAL", null, null, null, 777, null, null, null, null, null, null, 99999],
    ]));
    expect(s.rows).toHaveLength(1);
    expect(s.stats.nonTransactionRows).toBe(4);
    expect(summarizeInnaRows(s.rows).count).toBe(1);
  });

  it("header berulang (E = 'Trans ID') diabaikan", () => {
    const s = must(parse([tx("ROOM", 1, OCT_1, 51, "a", 10), HEADER, tx("FB", 2, OCT_1, 52, "b", 10), [], HEADER, tx("POOL", 3, OCT_1, 53, "c", 10)]));
    expect(s.rows).toHaveLength(3);
    expect(s.stats.repeatedHeaders).toBe(2);
    expect(s.stats.blankRows).toBe(1);
  });

  it("transaksi dengan Trans Name kosong tetap dihitung dan dicatat", () => {
    const s = must(parse([tx("ROOM", 1, OCT_1, 61, null, 10)]));
    expect(s.rows).toHaveLength(1);
    expect(s.stats.missingNameRows).toBe(1);
    expect(s.rows[0].keterangan).toBe("Folio = 1 Trans Name= ");
  });
});

// ---------- tanggal ----------
describe("tanggal kolom D", () => {
  it("serial Excel dan berbagai format teks dibaca dengan benar", () => {
    expect(parseInnaDate(OCT_1)).toBe("2026-10-01");
    expect(parseInnaDate(SEP_30)).toBe("2026-09-30");
    expect(parseInnaDate("01-Oct-26")).toBe("2026-10-01");
    expect(parseInnaDate("15-Sep-2026")).toBe("2026-09-15");
    expect(parseInnaDate("15/09/2026")).toBe("2026-09-15");
    expect(parseInnaDate("15-09-2026")).toBe("2026-09-15");
    expect(parseInnaDate("2026-09-15")).toBe("2026-09-15");
    expect(parseInnaDate("1.9.2026")).toBe("2026-09-01");
  });

  it("tanggal tidak valid → null (bukan tanggal hari ini)", () => {
    for (const bad of ["", "abc", "31/02/2026", "32-Oct-26", "2026-13-01", "01-Foo-26", null, undefined, 0, -5, NaN]) expect(parseInnaDate(bad)).toBeNull();
  });

  it("baris dengan tanggal tidak valid ditandai, tidak masuk bulan mana pun", () => {
    const s = must(parse([tx("ROOM", 1, OCT_1, 71, "ok", 10), tx("ROOM", 2, "bukan tanggal", 72, "rusak", 10), tx("ROOM", 3, null, 73, "kosong", 10)]));
    expect(s.rows).toHaveLength(1);
    expect(s.stats.invalidDateRows).toBe(2);
    expect(s.issues.filter((i) => i.kind === "date").map((i) => [i.row, i.transId, i.value])).toEqual([[10, "72", "bukan tanggal"], [11, "73", ""]]);
    expect(listInnaPeriods(s.rows)).toEqual([{ year: 2026, month: 10, count: 1 }]);
  });
});

// ---------- nilai L ----------
describe("nilai transaksi kolom L", () => {
  it("nilai tidak valid atau kosong tidak diam-diam menjadi nol; baris sumber dilaporkan", () => {
    const s = must(parse([tx("ROOM", 1, OCT_1, 81, "ok", 100), tx("ROOM", 2, OCT_1, 82, "teks", "seratus"), tx("FB", 3, OCT_1, 83, "kosong", null), tx("POOL", 4, OCT_1, 84, "koma", "1,5"), tx("ROOM", 5, OCT_1, 85, "nol", 0)]));
    expect(s.rows.map((r) => r.sourceRow)).toEqual([9, 13]); // baris 0 yang sah tetap dihitung
    expect(s.stats.invalidAmountRows).toBe(3);
    expect(s.issues.filter((i) => i.kind === "amount").map((i) => [i.row, i.transId, i.value])).toEqual([[10, "82", "seratus"], [11, "83", ""], [12, "84", "1,5"]]);
    expect(summarizeInnaRows(s.rows).count).toBe(2);
  });

  it("angka berbentuk teks dengan titik desimal diterima", () => {
    const s = must(parse([tx("ROOM", 1, OCT_1, 91, "txt", "1000.5")]));
    expect(innaToPlain(s.rows[0].subtotal)).toBe("1000.5");
  });
});

// ---------- periode & kategori ----------
describe("filter bulan + tahun dan kategori", () => {
  const s = must(parse([
    tx("ROOM", 1, SEP_30, 101, "sep-room", 100),
    tx("FB", 2, SEP_30, 102, "sep-fb", 200),
    tx("ROOM", 3, OCT_1, 103, "okt-room", 1000),
    tx("POOL", 4, OCT_1, 104, "okt-pool", 2000),
    tx("FB POS", 5, OCT_1, 105, "okt-fbpos", 4000),
    tx("FB", 6, NOV_1, 106, "nov-fb", 8000),
  ]));
  const sep = { year: 2026, month: 9 };
  const oct = { year: 2026, month: 10 };
  const nov = { year: 2026, month: 11 };

  it("hanya bulan yang punya transaksi yang tersedia", () => {
    expect(listInnaPeriods(s.rows)).toEqual([{ ...sep, count: 2 }, { ...oct, count: 3 }, { ...nov, count: 1 }]);
    expect(formatInnaPeriod(oct)).toBe("Oktober 2026");
  });

  it("berpindah bulan tidak mencampur transaksi periode lain", () => {
    expect(filterInnaRows(s.rows, sep, "ALL").map((r) => r.keterangan.split("= ")[2])).toEqual(["sep-room", "sep-fb"]);
    expect(filterInnaRows(s.rows, oct, "ALL").map((r) => r.keterangan.split("= ")[2])).toEqual(["okt-room", "okt-pool", "okt-fbpos"]);
    expect(filterInnaRows(s.rows, nov, "ALL")).toHaveLength(1);
    expect(filterInnaRows(s.rows, { year: 2027, month: 10 }, "ALL")).toEqual([]); // tahun berbeda → kosong
  });

  it("berpindah kategori tidak mencampur kategori lain, periode tetap berlaku", () => {
    expect(filterInnaRows(s.rows, oct, "HOTEL").map((r) => r.no_struk)).toEqual(["3 - 103"]);
    expect(filterInnaRows(s.rows, oct, "HIBURAN").map((r) => r.no_struk)).toEqual(["4 - 104"]);
    expect(filterInnaRows(s.rows, oct, "RESTO").map((r) => r.no_struk)).toEqual(["5 - 105"]);
    expect(filterInnaRows(s.rows, sep, "HIBURAN")).toEqual([]);
  });

  it("Semua Kategori = gabungan ketiga kategori tanpa duplikasi", () => {
    const all = filterInnaRows(s.rows, oct, "ALL");
    const parts = (["HOTEL", "HIBURAN", "RESTO"] as const).flatMap((c) => filterInnaRows(s.rows, oct, c));
    expect(all).toHaveLength(parts.length);
    expect(new Set(all.map((r) => r.sourceRow)).size).toBe(all.length);
    expect(new Set(parts.map((r) => r.sourceRow))).toEqual(new Set(all.map((r) => r.sourceRow)));
  });

  it("ringkasan cocok dengan penjumlahan tabel dari filter yang sama dan tidak bergantung pada paging", () => {
    for (const p of [sep, oct, nov, null]) for (const c of ["ALL", "HOTEL", "HIBURAN", "RESTO"] as const) {
      const rows = filterInnaRows(s.rows, p, c);
      const sum = summarizeInnaRows(rows);
      expect(sum.count).toBe(rows.length);
      expect(sum.total).toBe(rows.reduce((acc, r) => acc + r.total, 0n));
      expect(sum.subtotal).toBe(rows.reduce((acc, r) => acc + r.subtotal, 0n));
      expect(sum.service_charge).toBe(rows.reduce((acc, r) => acc + r.service_charge, 0n));
      expect(sum.dpp).toBe(rows.reduce((acc, r) => acc + r.dpp, 0n));
      expect(sum.tax).toBe(rows.reduce((acc, r) => acc + r.tax, 0n));
      expect(sum.discount).toBe(0n);
    }
    const oktAll = summarizeInnaRows(filterInnaRows(s.rows, oct, "ALL"));
    expect(innaToPlain(oktAll.subtotal)).toBe("7000");
    expect(innaToPlain(oktAll.total)).toBe("8470");
  });

  it("hasil filter kosong menghasilkan ringkasan nol (UI menampilkan status kosong)", () => {
    const sum = summarizeInnaRows(filterInnaRows(s.rows, sep, "HIBURAN"));
    expect(sum.count).toBe(0);
    expect(sum.total).toBe(0n);
  });
});

// ---------- dataset penuh & struktur ----------
describe("dataset penuh dan struktur file", () => {
  it("seluruh transaksi diproses, bukan hanya preview 100 baris", () => {
    const many = Array.from({ length: 1500 }, (_, i) => tx(["ROOM", "POOL", "FB"][i % 3], 1000 + i, OCT_1, 5000 + i, `item ${i}`, i + 1));
    const s = must(parse(many));
    expect(s.rows).toHaveLength(1500);
    expect(summarizeInnaRows(filterInnaRows(s.rows, { year: 2026, month: 10 }, "ALL")).count).toBe(1500);
    expect(countInnaByCategory(s.rows)).toEqual({ HOTEL: 500, HIBURAN: 500, RESTO: 500 });
  });

  it("file berbeda menghasilkan hasil sendiri (tidak ada state yang terbawa)", () => {
    const a = must(parse([tx("ROOM", 1, OCT_1, 1, "a", 100)], "a.xlsx"));
    const b = must(parse([tx("FB", 2, NOV_1, 2, "b", 5)], "b.xlsx"));
    expect(a.fileName).toBe("a.xlsx");
    expect(b.fileName).toBe("b.xlsx");
    expect(listInnaPeriods(a.rows)).toEqual([{ year: 2026, month: 10, count: 1 }]);
    expect(listInnaPeriods(b.rows)).toEqual([{ year: 2026, month: 11, count: 1 }]);
  });

  it("header tidak ditemukan → error jelas, tanpa baris hasil", () => {
    const s = parseInnaTretesWorkbook(book([["Judul"], ["A", "B", "C"], ["ROOM", 1, 2]]), "salah.xlsx");
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/header transaksi/);
    expect(s.rows).toEqual([]);
  });

  it("header kolom tidak sesuai posisi → error menyebut kolom yang salah", () => {
    const bad = [...HEADER]; bad[11] = "Amount"; bad[3] = "Tanggal";
    const s = parseInnaTretesWorkbook(book([...TITLE, bad, tx("ROOM", 1, OCT_1, 1, "a", 1)]), "salah.xlsx");
    expect(s.ok).toBe(false);
    expect(s.error).toMatch(/kolom D seharusnya "Trn Date" tetapi berisi "Tanggal"/);
    expect(s.error).toMatch(/kolom L seharusnya "Trans Nett" tetapi berisi "Amount"/);
    expect(s.rows).toEqual([]);
  });

  it("dua sheet sama-sama berheader → ditolak agar tidak terhitung dua kali; sheet tanpa header diabaikan", () => {
    const aoa = [...TITLE, HEADER, tx("ROOM", 1, OCT_1, 1, "a", 1)];
    const two = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(two, XLSX.utils.aoa_to_sheet(aoa), "S1");
    XLSX.utils.book_append_sheet(two, XLSX.utils.aoa_to_sheet(aoa), "S2");
    const dup = parseInnaTretesWorkbook(XLSX.write(two, { type: "array", bookType: "xlsx" }) as ArrayBuffer, "dua.xlsx");
    expect(dup.ok).toBe(false);
    expect(dup.error).toMatch(/Lebih dari satu sheet/);

    const one = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(one, XLSX.utils.aoa_to_sheet(aoa), "Report");
    XLSX.utils.book_append_sheet(one, XLSX.utils.aoa_to_sheet([["catatan"]]), "Catatan");
    const ok = must(parseInnaTretesWorkbook(XLSX.write(one, { type: "array", bookType: "xlsx" }) as ArrayBuffer, "satu.xlsx"));
    expect(ok.rows).toHaveLength(1);
    expect(ok.ignoredSheets).toEqual(["Catatan"]);
  });

  it("file bukan Excel → error, bukan laporan palsu", () => {
    const s = parseInnaTretesWorkbook(new TextEncoder().encode("bukan excel").buffer as ArrayBuffer, "teks.xlsx");
    expect(s.ok === false || s.rows.length === 0).toBe(true);
  });

  it("file berformat .xls juga terbaca", () => {
    const buf = book([...TITLE, HEADER, tx("ROOM", 1, OCT_1, 1, "a", 100)], "Report", "biff8");
    const s = must(parseInnaTretesWorkbook(buf, "x.xls"));
    expect(s.rows).toHaveLength(1);
    expect(innaToPlain(s.rows[0].total)).toBe("121");
  });

  it("workbook tanpa transaksi valid → ok tetapi tidak ada periode", () => {
    const s = must(parse([]));
    expect(s.rows).toEqual([]);
    expect(listInnaPeriods(s.rows)).toEqual([]);
    const row: InnaTretesRow[] = [];
    expect(summarizeInnaRows(row).count).toBe(0);
  });
});

describe("mergeInnaSources (banyak file)", () => {
  const SEP_1 = 46266; // 2026-09-01
  const SEP_2 = 46267;
  const day = (date: number, id: string, l: number, name = "x.xlsx") => parse([tx("ROOM", "F1", date, id, "Room Charge", l)], name);

  it("satu file → dikembalikan apa adanya", () => {
    const one = must(day(OCT_1, "T1", 1000, "a.xlsx"));
    expect(mergeInnaSources([one])).toBe(one);
  });

  it("beberapa file harian digabung: jumlah transaksi dan total = jumlah masing-masing file", () => {
    const a = must(day(SEP_1, "T1", 1000, "01.xlsx"));
    const b = must(day(SEP_2, "T2", 2000, "02.xlsx"));
    const c = must(day(OCT_1, "T3", 3000, "03.xlsx"));
    const merged = mergeInnaSources([a, b, c]);
    expect(merged.ok).toBe(true);
    expect(merged.rows).toHaveLength(3);
    expect(merged.stats.validRows).toBe(3);
    const sep = filterInnaRows(merged.rows, { year: 2026, month: 9 }, "ALL");
    expect(sep).toHaveLength(2);
    const sepTotal = summarizeInnaRows(sep).total;
    expect(sepTotal).toBe(summarizeInnaRows(a.rows).total + summarizeInnaRows(b.rows).total);
    expect(listInnaPeriods(merged.rows).map((p) => `${p.year}-${p.month}`)).toEqual(["2026-9", "2026-10"]);
  });

  it("baris membawa nama file asal; baris Excel yang sama di dua file tidak bertabrakan", () => {
    const a = must(day(SEP_1, "T1", 1000, "01.xlsx"));
    const b = must(day(SEP_2, "T2", 2000, "02.xlsx"));
    expect(a.rows[0].sourceRow).toBe(b.rows[0].sourceRow);
    const merged = mergeInnaSources([a, b]);
    expect(merged.rows.map((r) => `${r.sourceFile}#${r.sourceRow}`)).toEqual(["01.xlsx#" + a.rows[0].sourceRow, "02.xlsx#" + b.rows[0].sourceRow]);
    expect(a.rows[0].sourceFile).toBeUndefined(); // sumber asli tidak dimutasi
  });

  it("file gagal tidak ikut digabung dan tidak menyumbang transaksi", () => {
    const good = must(day(SEP_1, "T1", 1000, "ok.xlsx"));
    const bad = parseInnaTretesWorkbook(book([["bukan", "format"]], "Lain"), "salah.xlsx");
    expect(bad.ok).toBe(false);
    const merged = mergeInnaSources([bad, good]);
    expect(merged.rows).toHaveLength(1);
  });

  it("semua file gagal → sumber gagal dengan alasan per file", () => {
    const bad1 = parseInnaTretesWorkbook(book([["x"]], "A"), "a.xlsx");
    const bad2 = parseInnaTretesWorkbook(book([["y"]], "B"), "b.xlsx");
    const merged = mergeInnaSources([bad1, bad2]);
    expect(merged.ok).toBe(false);
    expect(merged.error).toContain("a.xlsx");
    expect(merged.error).toContain("b.xlsx");
  });
});
