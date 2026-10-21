import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  combineRoyalMonthly,
  computeRoyalAmounts,
  failRoyalSource,
  countRoyalByCategory,
  filterRoyalRows,
  formatRoyalMoney,
  parseCsvRecords,
  parseRoyalDate,
  parseRoyalDecimal,
  parseRoyalSenyiurCsv,
  classifyRoyalReceipt,
  groupRoyalLines,
  ROYAL_CATEGORIES,
  royalToPlain,
  summarizeRoyalRows,
  type RoyalRow,
  type RoyalSource,
} from "./royalSenyiurParser";

const SAMPLE = readFileSync(fileURLToPath(new URL("../fixtures/royalSenyiur20260901.csv", import.meta.url)), "utf8");

const must = (s: RoyalSource) => { expect(s.error).toBeUndefined(); expect(s.ok).toBe(true); return s; };
const plain = (r: RoyalRow) => [r.id_agent, r.no_struk, r.date_trans, royalToPlain(r.subtotal), royalToPlain(r.service_charge), royalToPlain(r.discount), royalToPlain(r.dpp), royalToPlain(r.tax), royalToPlain(r.total), r.keterangan];
const csv = (...lines: string[]) => lines.join("\r\n") + "\r\n";

// Nilai acuan: dihasilkan dengan menjalankan SQL HOTEL/RESTO dari permintaan (apa adanya, CONCAT → ||) pada file nyata
// RSP20260901.csv di SQLite, terpisah dari kode parser. Urutan RESTO = urutan kemunculan pertama nomor struk.
// HOTEL: SQL tanpa agregat; untuk PC-00144565 (dua baris: kode 110 dan 210) SQLite mengembalikan baris PERTAMA (kode 110).
const SQL_HOTEL: Array<[string, string, string, string, string, string, string, string, string, string]> = [
  ["hotel_senyiur", "PC-00144559", "2026-09-01", "450237", "45024", "0", "495261", "49526", "544787", "310-110-311"],
  ["hotel_senyiur", "PC-00144560", "2026-09-01", "429752", "42975", "0", "472727", "47273", "520000", "310-110-311"],
  ["hotel_senyiur", "PC-00144561", "2026-09-01", "415435", "41543", "0", "456978", "45698", "502676", "310-110-311"],
  ["hotel_senyiur", "PC-00144562", "2026-09-01", "429752", "42975", "0", "472727", "47273", "520000", "310-110-311"],
  ["hotel_senyiur", "PC-00144563", "2026-09-01", "446280", "44628", "0", "490908", "49091", "539999", "310-110-311"],
  ["hotel_senyiur", "PC-00144564", "2026-09-01", "396695", "39669", "0", "436364", "43636", "480000", "310-110-311"],
  ["hotel_senyiur", "PC-00144565", "2026-09-01", "433887", "43388", "0", "477275", "47727", "525002", "310-110-311"],
  ["hotel_senyiur", "PC-00144566", "2026-09-01", "429752", "42975", "0", "472727", "47273", "520000", "310-110-311"],
];
const SQL_RESTO: Array<[string, string, string, string, string, string, string, string, string, string]> = [
  ["resto_senyiur", "230-1788238197218-24572", "2026-09-01", "64000", "6400", "0", "70400", "7040", "77440", "2 struk"],
  ["resto_senyiur", "230-1788266531882-24573", "2026-09-01", "116000", "11600", "0", "127600", "12760", "140360", "2 struk"],
  ["resto_senyiur", "230-1788268273911-24574", "2026-09-01", "158000", "15800", "0", "173800", "17380", "191180", "2 struk"],
  ["resto_senyiur", "280-1788233892722-22243", "2026-09-01", "175000", "17500", "0", "192500", "19250", "211750", "3 struk"],
  ["resto_senyiur", "280-1788247771431-22244", "2026-09-01", "268000", "26800", "0", "294800", "29480", "324280", "5 struk"],
];

describe("parseCsvRecords (tanpa header)", () => {
  it("baris pertama adalah data, bukan header", () => {
    const { records } = parseCsvRecords("110,2026-09-01,PC-1,1,2,3,X\r\n210,2026-09-01,PC-2,4,5,6,Y\r\n");
    expect(records).toHaveLength(2);
    expect(records[0].fields).toEqual(["110", "2026-09-01", "PC-1", "1", "2", "3", "X"]);
    expect(records[0].line).toBe(1);
    expect(records[1].line).toBe(2);
  });
  it("mendukung CRLF, LF, BOM, tanpa newline akhir, baris kosong, dan kutip berisi koma", () => {
    const { records, blankLines } = parseCsvRecords('\uFEFFa,"b,c",d\n\n"e ""q""",f,g');
    expect(records.map((r) => r.fields)).toEqual([["a", "b,c", "d"], ['e "q"', "f", "g"]]);
    expect(records.map((r) => r.line)).toEqual([1, 3]);
    expect(blankLines).toBe(1);
  });
  it("kolom kosong di tengah dipertahankan sebagai kolom", () => {
    expect(parseCsvRecords("a,,c\n").records[0].fields).toEqual(["a", "", "c"]);
  });
});

describe("klasifikasi berdasarkan nomor struk (kolom C), bukan kode kolom A", () => {
  it("awalan PC → HOTEL (huruf besar/kecil, spasi tepi diabaikan); selain itu → RESTO; kosong → tidak masuk", () => {
    expect(classifyRoyalReceipt("PC-1")).toBe("HOTEL");
    expect(classifyRoyalReceipt("pc-1")).toBe("HOTEL");
    expect(classifyRoyalReceipt(" PC-9 ")).toBe("HOTEL");
    expect(classifyRoyalReceipt("230-1788238197218-24572")).toBe("RESTO");
    expect(classifyRoyalReceipt("XPC-1")).toBe("RESTO"); // PC harus awalan
    expect(classifyRoyalReceipt("")).toBeNull();
    expect(classifyRoyalReceipt("   ")).toBeNull();
  });
  it("kode kolom A apa pun tidak menentukan kategori", () => {
    const s = must(parseRoyalSenyiurCsv(csv(
      "999,2026-09-01,PC-A,10,1,1,h", // kode asing tetapi PC → HOTEL
      "110,2026-09-01,R-1,10,1,1,r", // kode HOTEL lama tetapi bukan PC → RESTO
      "210,2026-09-01,R-2,10,1,1,r", // kode 210 non-PC → RESTO
    ), "k.csv"));
    expect(filterRoyalRows(s.rows, "HOTEL").map((r) => r.no_struk)).toEqual(["PC-A"]);
    expect(filterRoyalRows(s.rows, "RESTO").map((r) => r.no_struk)).toEqual(["R-1", "R-2"]);
    expect(s.excluded).toHaveLength(0);
  });
  it("tidak ada nomor struk yang masuk dua kategori", () => {
    const s = must(parseRoyalSenyiurCsv(SAMPLE, "RSP20260901.csv"));
    const h = new Set(filterRoyalRows(s.rows, "HOTEL").map((r) => r.no_struk));
    const r = new Set(filterRoyalRows(s.rows, "RESTO").map((x) => x.no_struk));
    expect([...h].every((n) => /^PC/i.test(n))).toBe(true);
    expect([...r].some((n) => /^PC/i.test(n))).toBe(false);
    expect([...h].filter((n) => r.has(n))).toEqual([]);
  });
});

describe("file contoh RSP20260901.csv (data nyata)", () => {
  const s = must(parseRoyalSenyiurCsv(SAMPLE, "RSP20260901.csv"));
  const hotel = filterRoyalRows(s.rows, "HOTEL");
  const resto = filterRoyalRows(s.rows, "RESTO");

  it("tidak kehilangan baris pertama dan semua 23 baris terbaca", () => {
    expect(s.stats.sourceRecords).toBe(23);
    expect(hotel[0].sourceRows).toEqual([1]);
    expect(hotel[0].no_struk).toBe("PC-00144559");
  });
  it("tujuh kolom terpetakan berdasarkan posisi", () => {
    const r = hotel[0];
    expect([r.no_struk, r.date_trans, royalToPlain(r.subtotal), royalToPlain(r.service_charge), royalToPlain(r.tax), r.keterangan])
      .toEqual(["PC-00144559", "2026-09-01", "450237", "45024", "49526", "310-110-311"]);
  });
  it("jumlah: 9 baris PC → 8 struk HOTEL (GROUP BY C), 14 baris → 5 struk RESTO; semua baris terhitung tepat sekali", () => {
    expect(hotel).toHaveLength(8);
    expect(resto).toHaveLength(5);
    expect(s.stats.hotelSourceRows).toBe(9);
    expect(s.stats.hotelRecords).toBe(8);
    expect(s.stats.hotelIgnoredRows).toBe(1);
    expect(s.stats.restoSourceRows).toBe(14);
    expect(s.excluded).toHaveLength(0);
    expect(s.issues).toHaveLength(0);
    expect(s.stats.hotelSourceRows + s.stats.restoSourceRows + s.stats.excludedRows + s.stats.issueRows).toBe(s.stats.sourceRecords);
    expect(countRoyalByCategory(s.rows)).toEqual({ HOTEL: 8, RESTO: 5 });
  });
  it("HOTEL sama dengan hasil SQL (dijalankan di SQLite) untuk setiap kolom", () => {
    expect(hotel.map(plain)).toEqual(SQL_HOTEL);
  });
  it("RESTO sama dengan hasil SQL (dijalankan di SQLite) untuk setiap kolom", () => {
    expect(resto.map(plain)).toEqual(SQL_RESTO);
  });
  it("tidak ada nomor struk ganda pada output (HOTEL maupun RESTO)", () => {
    expect(new Set(hotel.map((r) => r.no_struk)).size).toBe(hotel.length);
    expect(new Set(resto.map((r) => r.no_struk)).size).toBe(resto.length);
  });
  it("ringkasan HOTEL dan RESTO sesuai jumlah SQL dan sama dengan penjumlahan baris yang ditampilkan", () => {
    const h = summarizeRoyalRows(hotel);
    expect([h.count, h.sourceRows].map(String)).toEqual(["8", "8"]);
    expect([h.subtotal, h.dpp, h.tax, h.total].map(royalToPlain)).toEqual(["3431790", "3774967", "377497", "4152464"]);
    expect(h.dpp).toBe(h.subtotal + h.service_charge); // dpp = D + E
    expect(h.total).toBe(h.dpp + h.tax); // total = dpp + tax
    const r = summarizeRoyalRows(resto);
    expect([r.count, r.sourceRows].map(String)).toEqual(["5", "14"]);
    expect([r.subtotal, r.service_charge, r.dpp, r.tax, r.total].map(royalToPlain)).toEqual(["781000", "78100", "859100", "85910", "945010"]);
    expect(r.total).toBe(r.dpp + r.tax);
  });
  it("PC-00144565 (baris 7 kode 110 dan baris 9 kode 210): baris pertama dipakai, baris 9 TIDAK dijumlahkan dan dilaporkan sebagai ambigu", () => {
    expect(s.hotelMulti).toHaveLength(1);
    const m = s.hotelMulti[0];
    expect(m.noStruk).toBe("PC-00144565");
    expect(m.used).toEqual({ fileName: "RSP20260901.csv", line: 7 });
    expect(m.ignored.map((x) => [x.line, x.code])).toEqual([[9, "210"]]);
    expect(m.conflicting).toBe(true);
    expect(royalToPlain(m.ignoredTotal)).toBe("49999"); // 41322 + 4132 + 4545
    const row = hotel.find((r) => r.no_struk === "PC-00144565")!;
    expect(row.sourceRows).toEqual([7]);
    expect(royalToPlain(row.subtotal)).toBe("433887"); // bukan 433887 + 41322
  });
  it("baris identik pada struk RESTO yang sama tetap dijumlahkan (tidak di-dedup)", () => {
    const g = resto.find((r) => r.no_struk === "230-1788266531882-24573")!;
    expect(g.sourceRows).toEqual([12, 13]);
    expect(royalToPlain(g.subtotal)).toBe("116000"); // 58000 + 58000
  });
});

describe("rumus", () => {
  it("memakai penjumlahan numerik, bukan penggabungan string", () => {
    const a = computeRoyalAmounts(450237n * 10n ** 6n, 45024n * 10n ** 6n, 49526n * 10n ** 6n);
    expect(royalToPlain(a.dpp)).toBe("495261"); // bukan "45023745024"
    expect(royalToPlain(a.total)).toBe("544787");
    expect(a.discount).toBe(0n);
  });
  it("desimal eksak tanpa floating point", () => {
    expect(royalToPlain(parseRoyalDecimal("0.1")! + parseRoyalDecimal("0.2")!)).toBe("0.3");
    expect(royalToPlain(parseRoyalDecimal("-12.5")!)).toBe("-12.5");
    expect(parseRoyalDecimal("abc")).toBeNull();
    expect(parseRoyalDecimal("")).toBeNull();
    expect(parseRoyalDecimal("1,5")).toBeNull();
  });
  it("format Rupiah hanya membulatkan saat tampilan", () => {
    expect(formatRoyalMoney(1234567n * 10n ** 6n)).toBe("Rp1.234.567,00");
    expect(formatRoyalMoney(parseRoyalDecimal("1234.565")!)).toBe("Rp1.234,57");
    expect(formatRoyalMoney(parseRoyalDecimal("-5")!)).toBe("Rp-5,00");
  });
  it("nilai negatif (retur) ikut dihitung", () => {
    const s = must(parseRoyalSenyiurCsv(csv("110,2026-09-01,PC-1,-1000,-100,-110,x"), "n.csv"));
    expect(plain(s.rows[0]).slice(3, 9)).toEqual(["-1000", "-100", "0", "-1100", "-110", "-1210"]);
  });
});

describe("RESTO: agregasi per nomor struk", () => {
  it("MAX(B) memakai tanggal terbesar walaupun urutan baris acak", () => {
    const s = must(parseRoyalSenyiurCsv(csv(
      "230,2026-09-02,S1,100,10,11,a",
      "230,2026-09-05,S1,100,10,11,b",
      "230,2026-09-03,S1,100,10,11,c",
      "230,2026-09-01,S2,50,5,5,d",
    ), "r.csv"));
    const resto = filterRoyalRows(s.rows, "RESTO");
    expect(resto.map((r) => [r.no_struk, r.date_trans, r.keterangan])).toEqual([["S1", "2026-09-05", "3 struk"], ["S2", "2026-09-01", "1 struk"]]);
    expect(royalToPlain(resto[0].subtotal)).toBe("300");
    expect(royalToPlain(resto[0].dpp)).toBe("330");
    expect(royalToPlain(resto[0].total)).toBe("363");
  });
  it("struk berbeda tidak digabung dan seluruh file tidak dijadikan satu transaksi", () => {
    const s = must(parseRoyalSenyiurCsv(csv("230,2026-09-01,A,1,0,0,x", "230,2026-09-01,B,1,0,0,x", "280,2026-09-01,C,1,0,0,x"), "r.csv"));
    expect(filterRoyalRows(s.rows, "RESTO")).toHaveLength(3);
  });
});

describe("HOTEL: GROUP BY C tanpa agregat", () => {
  it("struk sama → satu record dari baris pertama; baris lain tidak dijumlahkan dan dilaporkan", () => {
    const s = must(parseRoyalSenyiurCsv(csv("110,2026-09-01,PC-1,10,1,1,a", "110,2026-09-02,PC-1,20,2,2,b"), "h.csv"));
    const hotel = filterRoyalRows(s.rows, "HOTEL");
    expect(hotel).toHaveLength(1);
    expect(plain(hotel[0])).toEqual(["hotel_senyiur", "PC-1", "2026-09-01", "10", "1", "0", "11", "1", "12", "a"]);
    expect(s.hotelMulti[0]).toMatchObject({ noStruk: "PC-1", conflicting: true });
    expect(royalToPlain(s.hotelMulti[0].ignoredTotal)).toBe("24");
    expect(s.stats.hotelSourceRows).toBe(2);
    expect(s.stats.hotelRecords).toBe(1);
    expect(s.stats.hotelIgnoredRows).toBe(1);
  });
  it("struk sama dengan isi identik: satu record, tidak ditandai ambigu", () => {
    const s = must(parseRoyalSenyiurCsv(csv("110,2026-09-01,PC-1,10,1,1,a", "110,2026-09-01,PC-1,10,1,1,a"), "h.csv"));
    expect(filterRoyalRows(s.rows, "HOTEL")).toHaveLength(1);
    expect(s.hotelMulti).toHaveLength(1);
    expect(s.hotelMulti[0].conflicting).toBe(false);
  });
  it("tax diambil dari kolom F, bukan dihitung ulang dari persentase", () => {
    const s = must(parseRoyalSenyiurCsv(csv("110,2026-09-01,PC-1,1000,100,5,a"), "h.csv"));
    const r = filterRoyalRows(s.rows, "HOTEL")[0];
    expect([royalToPlain(r.dpp), royalToPlain(r.tax), royalToPlain(r.total)]).toEqual(["1100", "5", "1105"]);
  });
});

describe("validasi dan filter WHERE", () => {
  it("C kosong tidak masuk HOTEL maupun RESTO dan dilaporkan sebagai dikecualikan filter", () => {
    const s = must(parseRoyalSenyiurCsv(csv("230,2026-09-01,,1,1,1,z", "110,2026-09-01,,1,1,1,z"), "e.csv"));
    expect(s.rows).toHaveLength(0);
    expect(s.excluded.map((x) => [x.row, x.reason])).toEqual([[1, "receipt_empty"], [2, "receipt_empty"]]);
    expect(s.issues).toHaveLength(0);
  });
  it("RESTO dengan F kosong dikecualikan (F != ''), tidak diubah menjadi 0, dan dilaporkan", () => {
    const s = must(parseRoyalSenyiurCsv(csv("230,2026-09-01,R1,100,10,,a", "230,2026-09-01,R1,100,10,11,b"), "f.csv"));
    const resto = filterRoyalRows(s.rows, "RESTO");
    expect(resto).toHaveLength(1);
    expect(resto[0].keterangan).toBe("1 struk"); // COUNT(*) hanya baris yang lolos filter
    expect(royalToPlain(resto[0].subtotal)).toBe("100");
    expect(s.excluded.map((x) => [x.row, x.reason, x.noStruk])).toEqual([[1, "tax_empty", "R1"]]);
  });
  it("HOTEL dengan F kosong dilaporkan sebagai masalah dan tidak dihitung (tidak diganti 0)", () => {
    const s = must(parseRoyalSenyiurCsv(csv("110,2026-09-01,PC-1,100,10,,a"), "f.csv"));
    expect(s.rows).toHaveLength(0);
    expect(s.issues.map((i) => [i.kind, i.row])).toEqual([["amount", 1]]);
  });
  it("tanggal tidak valid dan angka kosong/bukan angka dilaporkan, baris tidak dihitung, tidak ada nilai pengganti", () => {
    const s = must(parseRoyalSenyiurCsv(csv(
      "110,2026-13-45,PC-A,1,1,1,z",
      "110,2026-09-01,PC-B,,1,1,z",
      "110,2026-09-01,PC-C,1,x1,1,z",
      "110,2026-09-01,PC-D,1,1,1,ok",
    ), "i.csv"));
    expect(s.rows.map((r) => r.no_struk)).toEqual(["PC-D"]);
    expect(s.issues.map((i) => [i.row, i.kind])).toEqual([[1, "date"], [2, "amount"], [3, "amount"]]);
    expect(s.stats.issueRows).toBe(3);
    expect(s.stats.hotelSourceRows + s.stats.restoSourceRows + s.stats.excludedRows + s.stats.issueRows).toBe(s.stats.sourceRecords);
  });
  it("jumlah kolom salah dilaporkan sebagai masalah struktur", () => {
    const s = must(parseRoyalSenyiurCsv(csv("110,2026-09-01,PC-A,1,1,1", "110,2026-09-01,PC-B,1,1,1,z,extra"), "c.csv"));
    expect(s.rows).toHaveLength(0);
    expect(s.issues.map((i) => i.kind)).toEqual(["structure", "structure"]);
  });
  it("koma di ujung baris ditoleransi", () => {
    const s = must(parseRoyalSenyiurCsv(csv("110,2026-09-01,PC-A,1,1,1,z,"), "t.csv"));
    expect(s.rows).toHaveLength(1);
  });
  it("nilai numerik besar dan desimal dibaca sebagai angka eksak (bukan string)", () => {
    const s = must(parseRoyalSenyiurCsv(csv("230,2026-09-01,R,1234567890123.45,0.1,0.2,x", "230,2026-09-01,R,0.55,0,0,x"), "n.csv"));
    const r = filterRoyalRows(s.rows, "RESTO")[0];
    expect([royalToPlain(r.subtotal), royalToPlain(r.service_charge), royalToPlain(r.tax), royalToPlain(r.total)]).toEqual(["1234567890124", "0.1", "0.2", "1234567890124.3"]);
  });
  it("file kosong menghasilkan error, bukan hasil nol", () => {
    expect(parseRoyalSenyiurCsv("", "e.csv").ok).toBe(false);
    expect(parseRoyalSenyiurCsv("\r\n\r\n", "e.csv").ok).toBe(false);
  });
  it("tanggal: format yang didukung dan penolakan tanggal mustahil", () => {
    expect(parseRoyalDate("2026-09-01")).toBe("2026-09-01");
    expect(parseRoyalDate("01/09/2026")).toBe("2026-09-01");
    expect(parseRoyalDate("2026-02-30")).toBeNull();
    expect(parseRoyalDate("")).toBeNull();
  });
  it("kategori yang diekspor hanya HOTEL dan RESTO", () => {
    expect(ROYAL_CATEGORIES).toEqual(["HOTEL", "RESTO"]);
  });
});

// ---------- BULANAN ----------
// Catatan: hanya SATU file nyata (RSP20260901.csv) yang tersedia. File hari lain di bawah ini SINTETIS (dibuat untuk uji),
// bukan data produksi. Nilai harapan dihitung ulang terpisah dari teks mentah (Number + split), bukan memakai kode parser.

const DAY2 = csv(
  "110,2026-09-02,PC-00144600,100000,10000,11000,310-110-311",
  "110,2026-09-02,PC-00144600,50000,5000,5500,310-110-311", // nomor struk HOTEL sama, nilai beda: satu record (baris pertama)
  "230,2026-09-02,230-1788266531882-24573,40000,4000,4400,lanjutan", // struk RESTO yang sama dengan file hari 1
  "280,2026-09-02,280-NEW-1,20000,2000,2200,x",
  "999,2026-09-02,,1,1,1,x", // C kosong → dikecualikan filter
);
const DAY3 = csv(
  "230,2026-09-03,280-NEW-1,10000,1000,1100,y",
  "110,2026-09-03,PC-00144700,70000,7000,7700,z",
  "230,2026-09-03,BAD,abc,1,1,x", // nominal tidak numerik
  "110,2026-09-01,PC-00144559,450237,45024,49526,310-110-311", // struk HOTEL hari 1, isi identik (termasuk tanggal)
  "210,2026-09-03,PC-00144560,1,1,1,x", // struk HOTEL hari 1, isi berbeda
);

/** Hitung ulang mandiri dari teks mentah (tanpa parser). File harus diberikan dalam urutan nama file. */
function independent(texts: string[]) {
  const hotel = new Map<string, { b: string; d: number; e: number; f: number }>();
  let hotelRows = 0;
  const groups = new Map<string, { d: number; e: number; f: number; n: number; max: string }>();
  for (const t of texts) {
    for (const line of t.split(/\r?\n/).filter(Boolean)) {
      const [, b, c, d, e, f] = line.split(",");
      if (c === "" || Number.isNaN(Number(d)) || f === "") continue;
      if (c.toUpperCase().startsWith("PC")) {
        hotelRows++;
        if (!hotel.has(c)) hotel.set(c, { b, d: +d, e: +e, f: +f }); // baris pertama
        continue;
      }
      const g = groups.get(c) ?? { d: 0, e: 0, f: 0, n: 0, max: "" };
      g.d += +d; g.e += +e; g.f += +f; g.n++; if (b > g.max) g.max = b;
      groups.set(c, g);
    }
  }
  return { hotel, hotelRows, groups };
}

describe("mode BULANAN: gabungan banyak file", () => {
  const files = [
    parseRoyalSenyiurCsv(SAMPLE, "RSP20260901.csv"),
    parseRoyalSenyiurCsv(DAY2, "RSP20260902.csv"),
    parseRoyalSenyiurCsv(DAY3, "RSP20260903.csv"),
  ];
  const m = combineRoyalMonthly(files);
  const hotel = filterRoyalRows(m.rows, "HOTEL");
  const resto = filterRoyalRows(m.rows, "RESTO");

  it("satu file bulanan sama persis dengan hasil harian (kolom per kolom)", () => {
    const solo = combineRoyalMonthly([parseRoyalSenyiurCsv(SAMPLE, "RSP20260901.csv")]);
    const daily = parseRoyalSenyiurCsv(SAMPLE, "RSP20260901.csv");
    expect(filterRoyalRows(solo.rows, "HOTEL").map(plain)).toEqual(SQL_HOTEL);
    expect(filterRoyalRows(solo.rows, "RESTO").map(plain)).toEqual(SQL_RESTO);
    expect(solo.rows.map(plain)).toEqual(daily.rows.map(plain));
    expect(solo.complete).toBe(true);
  });
  it("satu file dipecah dua lalu digabung = hasil SQL atas file utuh (struk RESTO dan HOTEL lintas file), urutan pilih bebas", () => {
    const lines = SAMPLE.split("\r\n").filter(Boolean);
    const a = parseRoyalSenyiurCsv(csv(...lines.slice(0, 10)), "A-1.csv"); // sampai baris 10 (struk 24572 baru separuh)
    const b = parseRoyalSenyiurCsv(csv(...lines.slice(10)), "A-2.csv");
    for (const order of [[a, b], [b, a]]) {
      const r = combineRoyalMonthly(order);
      expect(filterRoyalRows(r.rows, "HOTEL").map(plain)).toEqual(SQL_HOTEL);
      expect(filterRoyalRows(r.rows, "RESTO").map(plain)).toEqual(SQL_RESTO);
      expect(r.restoReceiptsAcrossFiles).toBe(1);
    }
  });
  it("HOTEL: GROUP BY C atas gabungan seluruh file (struk sama, di file sama maupun beda → satu record, baris pertama)", () => {
    expect(hotel).toHaveLength(10);
    expect(new Set(hotel.map((r) => r.no_struk)).size).toBe(10);
    const h600 = hotel.find((r) => r.no_struk === "PC-00144600")!;
    expect(royalToPlain(h600.subtotal)).toBe("100000"); // bukan 150000
    const h559 = hotel.find((r) => r.no_struk === "PC-00144559")!;
    expect(h559.sourceFiles).toEqual(["RSP20260901.csv"]); // file pertama (urut nama) dipakai
    expect(royalToPlain(h559.total)).toBe("544787"); // tidak digandakan oleh file hari 3
    const h560 = hotel.find((r) => r.no_struk === "PC-00144560")!;
    expect(royalToPlain(h560.subtotal)).toBe("429752"); // bukan nilai baris 210 hari 3
  });
  it("HOTEL: ambiguitas dilaporkan (di file sama dan lintas file); duplikat identik tidak dianggap ambigu", () => {
    const by = new Map(m.hotelMulti.map((x) => [x.noStruk, x]));
    expect([...by.keys()].sort()).toEqual(["PC-00144559", "PC-00144560", "PC-00144565", "PC-00144600"]);
    expect(by.get("PC-00144559")!.conflicting).toBe(false);
    expect(by.get("PC-00144560")!.conflicting).toBe(true);
    expect(by.get("PC-00144565")!.conflicting).toBe(true);
    expect(by.get("PC-00144600")!.conflicting).toBe(true);
    expect(m.hotelReceiptsAcrossFiles).toBe(2); // 559 dan 560
  });
  it("RESTO: dikelompokkan atas gabungan seluruh file (COUNT dan MAX(B) lintas file benar)", () => {
    const g = resto.find((r) => r.no_struk === "230-1788266531882-24573")!;
    expect(plain(g)).toEqual(["resto_senyiur", "230-1788266531882-24573", "2026-09-02", "156000", "15600", "0", "171600", "17160", "188760", "3 struk"]);
    expect(g.sourceFiles).toEqual(["RSP20260901.csv", "RSP20260902.csv"]);
    const n = resto.find((r) => r.no_struk === "280-NEW-1")!;
    expect(plain(n)).toEqual(["resto_senyiur", "280-NEW-1", "2026-09-03", "30000", "3000", "0", "33000", "3300", "36300", "2 struk"]);
  });
  it("menjumlahkan ringkasan harian akan SALAH; hasil bulanan tidak melakukannya", () => {
    const perFile = files.flatMap((f) => filterRoyalRows(f.rows, "RESTO"));
    expect(perFile.length).toBe(5 + 2 + 1);
    expect(resto.length).toBeLessThan(perFile.length);
    const perFileHotel = files.flatMap((f) => filterRoyalRows(f.rows, "HOTEL"));
    expect(hotel.length).toBeLessThan(perFileHotel.length); // 8 + 1 + 3 = 12 jika dijumlahkan per file
  });
  it("tidak ada struk HOTEL di RESTO dan sebaliknya; tanggal transaksi dari data, bukan tanggal upload", () => {
    expect(hotel.every((r) => /^PC/i.test(r.no_struk))).toBe(true);
    expect(resto.some((r) => /^PC/i.test(r.no_struk))).toBe(false);
    expect(m.dateMin).toBe("2026-09-01");
    expect(m.dateMax).toBe("2026-09-03");
    expect(m.rows.every((r) => r.date_trans.startsWith("2026-09-0"))).toBe(true);
  });
  it("cocok dengan hitung ulang mandiri dari data sumber (HOTEL dan setiap grup RESTO) + ringkasan = jumlah baris", () => {
    const ind = independent([SAMPLE, DAY2, DAY3]); // urutan = urutan nama file
    expect(hotel).toHaveLength(ind.hotel.size);
    for (const r of hotel) {
      const g = ind.hotel.get(r.no_struk)!;
      expect([r.date_trans, Number(royalToPlain(r.subtotal)), Number(royalToPlain(r.service_charge)), Number(royalToPlain(r.tax)), Number(royalToPlain(r.dpp)), Number(royalToPlain(r.total))])
        .toEqual([g.b, g.d, g.e, g.f, g.d + g.e, g.d + g.e + g.f]);
    }
    expect(resto).toHaveLength(ind.groups.size);
    for (const r of resto) {
      const g = ind.groups.get(r.no_struk)!;
      expect([Number(royalToPlain(r.subtotal)), Number(royalToPlain(r.service_charge)), Number(royalToPlain(r.tax)), Number(royalToPlain(r.dpp)), Number(royalToPlain(r.total)), r.date_trans, r.keterangan])
        .toEqual([g.d, g.e, g.f, g.d + g.e, g.d + g.e + g.f, g.max, `${g.n} struk`]);
    }
    const h = summarizeRoyalRows(hotel);
    const hs = [...ind.hotel.values()];
    expect(Number(royalToPlain(h.total))).toBe(hs.reduce((n, x) => n + x.d + x.e + x.f, 0));
    expect(h.dpp).toBe(h.subtotal + h.service_charge);
    expect(h.total).toBe(h.dpp + h.tax);
    const r = summarizeRoyalRows(resto);
    expect(r.total).toBe(r.dpp + r.tax);
    expect(r.sourceRows).toBe(m.stats.restoSourceRows);
  });
  it("statistik gabungan: baris sumber, struk unik (bukan jumlah per file), dikecualikan, bermasalah", () => {
    expect(m.okFiles).toBe(3);
    expect(m.failedFiles).toBe(0);
    expect(m.stats.hotelSourceRows).toBe(9 + 2 + 3);
    expect(m.stats.hotelRecords).toBe(10);
    expect(m.stats.hotelIgnoredRows).toBe(4);
    expect(m.stats.restoSourceRows).toBe(14 + 2 + 1);
    expect(m.stats.restoGroups).toBe(resto.length);
    expect(m.stats.restoGroups).toBe(6);
    expect(m.stats.excludedRows).toBe(1);
    expect(m.excluded.map((u) => [u.fileName, u.row, u.reason])).toEqual([["RSP20260902.csv", 5, "receipt_empty"]]);
    expect(m.stats.issueRows).toBe(1);
    expect(m.issues.map((i) => [i.fileName, i.row, i.kind])).toEqual([["RSP20260903.csv", 3, "amount"]]);
    expect(m.restoReceiptsAcrossFiles).toBe(2);
    expect(m.stats.hotelSourceRows + m.stats.restoSourceRows + m.stats.excludedRows + m.stats.issueRows).toBe(m.stats.sourceRecords);
  });
  it("urutan pemilihan file tidak mengubah hasil (Ctrl + A tidak menjamin urutan)", () => {
    const rev = combineRoyalMonthly([...files].reverse());
    expect(rev.rows.map(plain)).toEqual(m.rows.map(plain));
  });
  it("groupRoyalLines: fungsi yang sama menghasilkan keluaran identik untuk harian dan bulanan", () => {
    const daily = files[0];
    const direct = groupRoyalLines(daily.hotelLines, daily.restoLines);
    expect(direct.rows.map(plain)).toEqual(daily.rows.map(plain));
  });
  it("file gagal dilaporkan, file valid tetap masuk, periode tidak dinyatakan lengkap", () => {
    const bad = failRoyalSource("RSP20260904.csv", "File kosong: tidak ada baris data.");
    const r = combineRoyalMonthly([files[0], bad, files[1]]);
    expect(r.complete).toBe(false);
    expect(r.failedFiles).toBe(1);
    expect(r.files.find((f) => !f.ok)).toMatchObject({ fileName: "RSP20260904.csv", error: "File kosong: tidak ada baris data." });
    expect(filterRoyalRows(r.rows, "HOTEL")).toHaveLength(9); // 8 (hari 1) + PC-00144600
    expect(parseRoyalSenyiurCsv("", "x.csv").ok).toBe(false);
  });
  it("tanpa file berhasil: tidak ada record dan tidak lengkap", () => {
    const r = combineRoyalMonthly([failRoyalSource("a.csv", "x")]);
    expect(r.rows).toHaveLength(0);
    expect(r.complete).toBe(false);
    expect(r.dateMin).toBeNull();
  });
  it("memproses ulang hasil yang sama tidak mengubah angka (combine tidak memutasi sumber)", () => {
    const a = combineRoyalMonthly(files);
    const b = combineRoyalMonthly(files);
    expect(b.rows.map(plain)).toEqual(a.rows.map(plain));
    expect(b.stats.restoGroups).toBe(a.stats.restoGroups);
    expect(b.stats.hotelRecords).toBe(a.stats.hotelRecords);
  });
});
