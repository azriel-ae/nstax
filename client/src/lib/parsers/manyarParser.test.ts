import { describe, expect, it } from "vitest";
import { classifyManyarNoBill, filterManyarRows, formatManyarAmount, formatManyarRupiah, looksLikeManyarNoBill, manyarToCsv, parseManyar, parseManyarMoney, summarizeManyar } from "./manyarParser";

// Fixture SINTETIS. Nilai ekspektasi dihitung terpisah dari kode yang diuji:
// (a) fixture tulis-tangan dengan total yang dijumlahkan manual, (b) fixture besar dibangun dari integer sen biasa.
const rec = (noBill: unknown, gross: unknown, service: unknown, tax: unknown, nett: unknown, extra: Record<string, unknown> = {}) => ({ Date: "2026-08-02", Product: "MANYAR", NoBill: noBill, Gross: gross, Service: service, Tax: tax, Nett: nett, ...extra });

const H1 = rec("FL.26001775", "413584.00", "34180.50", "37598.55", "341804.95", { Product: "ROOM REVENUE", Date: "2026-08-03" });
const H2 = rec("FL-26001776", "100000.10", "8264.46", "9090.90", "82644.74", { Product: "ROOM REVENUE" });
const R1 = rec("SL-26RST0000587", "114000.00", "9421.46", "10363.69", "94214.85", { Product: "MANYAR RESTO" });
const R2 = rec("SL.26RST0000588", "50000.55", "4132.23", "4545.45", "41322.87", { Product: "MANYAR RESTO" });
// Selang-seling HOTEL / RESTO.
const MIXED = [H1, R1, H2, R2];

// Jumlah manual: HOTEL gross 413584.00+100000.10=513584.10 · service 42444.96 · tax 46689.45 · nett 424449.69
//                RESTO gross 114000.00+50000.55=164000.55 · service 13553.69 · tax 14909.14 · nett 135537.72
//                SEMUA gross 677584.65 · service 55998.65 · tax 61598.59 · nett 559987.41
const EXPECT = {
  HOTEL: { count: 2, gross: "513.584,10", service: "42.444,96", tax: "46.689,45", nett: "424.449,69" },
  RESTO: { count: 2, gross: "164.000,55", service: "13.553,69", tax: "14.909,14", nett: "135.537,72" },
  ALL: { count: 4, gross: "677.584,65", service: "55.998,65", tax: "61.598,59", nett: "559.987,41" },
} as const;

const run = (data: unknown) => parseManyar(JSON.stringify(data));
const fmt = (s: ReturnType<typeof summarizeManyar>) => ({ count: s.transactionCount, gross: formatManyarAmount(s.gross, s.decimals), service: formatManyarAmount(s.service, s.decimals), tax: formatManyarAmount(s.tax, s.decimals), nett: formatManyarAmount(s.nett, s.decimals) });

describe("klasifikasi NoBill", () => {
  it("FL → HOTEL, SL → RESTO", () => {
    expect(classifyManyarNoBill("FL.26001775")).toBe("HOTEL");
    expect(classifyManyarNoBill("SL-26RST0000587")).toBe("RESTO");
  });
  it("pemisah titik, tanda hubung, atau tanpa pemisah tidak berpengaruh", () => {
    for (const nb of ["FL.1", "FL-1", "FL1", "FL 1"]) expect(classifyManyarNoBill(nb)).toBe("HOTEL");
    for (const nb of ["SL.1", "SL-1", "SL1", "SL 1"]) expect(classifyManyarNoBill(nb)).toBe("RESTO");
  });
  it("trim dan kapitalisasi dinormalkan", () => {
    expect(classifyManyarNoBill("  fl.26001775  ")).toBe("HOTEL");
    expect(classifyManyarNoBill("\tsl-26rst1\n")).toBe("RESTO");
  });
  it("kosong / prefix lain / bukan string → UNKNOWN (tidak ditebak dari Product atau urutan)", () => {
    for (const nb of ["", "   ", null, undefined, "XX.1", "AB-FL", 12345, "RST-1"]) expect(classifyManyarNoBill(nb)).toBe("UNKNOWN");
  });
  it("pola deteksi lebih ketat daripada klasifikasi", () => {
    expect(looksLikeManyarNoBill("FL.26001775")).toBe(true);
    expect(looksLikeManyarNoBill("sl-26RST1")).toBe(true);
    expect(looksLikeManyarNoBill("FLOWER-1")).toBe(false);
    expect(looksLikeManyarNoBill(null)).toBe(false);
    expect(looksLikeManyarNoBill(123)).toBe(false);
  });
});

describe("parseManyar — pemisahan dan total", () => {
  it("memisahkan HOTEL dan RESTO pada array campuran selang-seling (kategori dari NoBill, bukan Product/urutan)", () => {
    const r = run(MIXED);
    expect(r.ok).toBe(true);
    expect(r.rows.map((x) => x.category)).toEqual(["HOTEL", "RESTO", "HOTEL", "RESTO"]);
    // Product HOTEL "ROOM REVENUE" dan RESTO "MANYAR RESTO" tidak dipakai; ganti Product → kategori tetap.
    const swapped = run(MIXED.map((x) => ({ ...x, Product: "X" })));
    expect(swapped.rows.map((x) => x.category)).toEqual(["HOTEL", "RESTO", "HOTEL", "RESTO"]);
  });

  it("total Gross/Service/Tax/Nett sama dengan penjumlahan manual untuk Semua, HOTEL, RESTO", () => {
    const r = run(MIXED);
    expect(fmt(summarizeManyar(r.rows, "HOTEL", r.maxDecimals))).toEqual(EXPECT.HOTEL);
    expect(fmt(summarizeManyar(r.rows, "RESTO", r.maxDecimals))).toEqual(EXPECT.RESTO);
    expect(fmt(summarizeManyar(r.rows, "ALL", r.maxDecimals))).toEqual(EXPECT.ALL);
  });

  it("Semua = HOTEL + RESTO dan mengganti filter berulang tidak mengubah hasil maupun data sumber", () => {
    const original = JSON.stringify(MIXED);
    const r = run(JSON.parse(original));
    const before = JSON.stringify(r.rows.map((x) => x.raw));
    const a1 = summarizeManyar(r.rows, "ALL");
    for (const f of ["HOTEL", "RESTO", "ALL", "HOTEL", "ALL"] as const) summarizeManyar(r.rows, f);
    const a2 = summarizeManyar(r.rows, "ALL");
    const h = summarizeManyar(r.rows, "HOTEL");
    const s = summarizeManyar(r.rows, "RESTO");
    expect(a2).toEqual(a1);
    expect(a2.gross).toBe(h.gross + s.gross);
    expect(a2.nett).toBe(h.nett + s.nett);
    expect(a2.transactionCount).toBe(h.transactionCount + s.transactionCount);
    expect(JSON.stringify(r.rows.map((x) => x.raw))).toBe(before);
    expect(before).toBe(JSON.stringify(JSON.parse(original)));
  });

  it("filter tabel: ALL = semua record, HOTEL/RESTO hanya kategorinya", () => {
    const r = run([...MIXED, rec("ZZ-1", "1.00", "0", "0", "1.00")]);
    expect(filterManyarRows(r.rows, "ALL")).toHaveLength(5);
    expect(filterManyarRows(r.rows, "HOTEL").map((x) => x.noBill)).toEqual(["FL.26001775", "FL-26001776"]);
    expect(filterManyarRows(r.rows, "RESTO").map((x) => x.noBill)).toEqual(["SL-26RST0000587", "SL.26RST0000588"]);
  });

  it("urutan properti JSON tidak berpengaruh", () => {
    const shuffled = MIXED.map((x) => Object.fromEntries(Object.entries(x).reverse()));
    expect(fmt(summarizeManyar(run(shuffled).rows, "ALL", 2))).toEqual(EXPECT.ALL);
  });
});

describe("parseManyar — ribuan record", () => {
  // Dibangun dari integer sen; ekspektasi dijumlahkan sebagai Number integer (aman < 2^53), jalur berbeda dari BigInt parser.
  const toDec = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
  const groupId = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const expectedAmount = (cents: number) => `${groupId(Math.floor(cents / 100))},${String(cents % 100).padStart(2, "0")}`;

  it("5.000 record campuran: tidak ada yang hilang, total persis", () => {
    let seed = 2463534242; // xorshift32 berbasis integer (tanpa perkalian yang melewati 2^53)
    const next = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed; };
    const N = 5000;
    const data: unknown[] = [];
    const tot = { HOTEL: { n: 0, g: 0, s: 0, t: 0, nt: 0 }, RESTO: { n: 0, g: 0, s: 0, t: 0, nt: 0 } };
    for (let i = 0; i < N; i++) {
      const hotel = next() % 3 !== 0; // pola acak, bukan selang-seling tetap
      const g = 1000 + (next() % 90000000);
      const s = next() % 5000000;
      const t = next() % 5000000;
      const nt = next() % 80000000;
      const sep = next() % 2 ? "." : "-";
      data.push(rec(`${hotel ? "FL" : "SL"}${sep}26${String(i).padStart(7, "0")}`, toDec(g), toDec(s), toDec(t), toDec(nt)));
      const b = hotel ? tot.HOTEL : tot.RESTO;
      b.n++; b.g += g; b.s += s; b.t += t; b.nt += nt;
    }
    expect(tot.HOTEL.n).toBeGreaterThan(2000); // fixture benar-benar campuran, bukan satu kategori
    expect(tot.RESTO.n).toBeGreaterThan(1000);
    const r = run(data);
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(N);
    expect(r.validation).toMatchObject({ totalRecords: N, hotelRecords: tot.HOTEL.n, restoRecords: tot.RESTO.n, unknownCategory: 0, invalidValues: 0, includedRecords: N });
    for (const cat of ["HOTEL", "RESTO"] as const) {
      const b = tot[cat];
      expect(fmt(summarizeManyar(r.rows, cat, r.maxDecimals))).toEqual({ count: b.n, gross: expectedAmount(b.g), service: expectedAmount(b.s), tax: expectedAmount(b.t), nett: expectedAmount(b.nt) });
    }
    const all = { n: N, g: tot.HOTEL.g + tot.RESTO.g, s: tot.HOTEL.s + tot.RESTO.s, t: tot.HOTEL.t + tot.RESTO.t, nt: tot.HOTEL.nt + tot.RESTO.nt };
    expect(fmt(summarizeManyar(r.rows, "ALL", r.maxDecimals))).toEqual({ count: N, gross: expectedAmount(all.g), service: expectedAmount(all.s), tax: expectedAmount(all.t), nett: expectedAmount(all.nt) });
  });

  it("memproses 20.000 record dalam waktu wajar", () => {
    const data = Array.from({ length: 20000 }, (_, i) => rec(`${i % 2 ? "FL" : "SL"}.${i}`, "100.00", "8.00", "9.00", "83.00"));
    const t0 = Date.now();
    const r = run(data);
    const s = summarizeManyar(r.rows, "ALL");
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.rows).toHaveLength(20000);
    expect(formatManyarAmount(s.gross, 2)).toBe("2.000.000,00");
  });
});

describe("aritmetika desimal", () => {
  it("nilai desimal berbentuk string tidak kehilangan titik desimal dan tidak dijumlahkan sebagai string", () => {
    const p = parseManyarMoney("114000.00");
    expect(p).not.toBeNull();
    expect(formatManyarAmount(p!.scaled, 2)).toBe("114.000,00");
    const r = run([rec("FL.1", "0.10", "0.10", "0.10", "0.10"), rec("FL.2", "0.20", "0.20", "0.20", "0.20")]);
    expect(formatManyarAmount(summarizeManyar(r.rows, "ALL").gross, 2)).toBe("0,30"); // float biasa: 0.30000000000000004
  });

  it("10.000 × 0,01 = 100,00 persis (tanpa drift float)", () => {
    const r = run(Array.from({ length: 10000 }, (_, i) => rec(`SL.${i}`, "0.01", "0.01", "0.01", "0.01")));
    const s = summarizeManyar(r.rows, "ALL");
    expect(formatManyarAmount(s.gross, 2)).toBe("100,00");
    expect(formatManyarAmount(s.nett, 2)).toBe("100,00");
  });

  it("tanpa pembulatan per record: presisi lebih dari 2 desimal dijaga dan ditampilkan", () => {
    const r = run([rec("FL.1", "1.005", "0", "0", "1.005"), rec("FL.2", "1.005", "0", "0", "1.005")]);
    expect(r.maxDecimals).toBe(3);
    const s = summarizeManyar(r.rows, "ALL", r.maxDecimals);
    expect(formatManyarAmount(s.gross, s.decimals)).toBe("2,010");
  });

  it("menerima angka (number) dan nilai bulat; menolak teks sampah", () => {
    expect(formatManyarAmount(parseManyarMoney(114000.5)!.scaled, 2)).toBe("114.000,50");
    expect(formatManyarAmount(parseManyarMoney("250000")!.scaled, 2)).toBe("250.000,00");
    expect(formatManyarAmount(parseManyarMoney("-1500.25")!.scaled, 2)).toBe("-1.500,25");
    expect(formatManyarRupiah(parseManyarMoney("1,234.50")!.scaled, 2)).toBe("Rp 1.234,50");
    for (const bad of ["", "   ", "abc", "12abc", "1.2.3", null, undefined, NaN, Infinity, {}, [], true, "1e5", ".", "-"]) expect(parseManyarMoney(bad as unknown)).toBeNull();
    expect(parseManyarMoney("0.123456789")).toBeNull(); // > 8 desimal: ditolak, bukan dipotong diam-diam
  });
});

describe("validasi", () => {
  it("NoBill kosong / prefix tidak dikenal: dicatat sebagai UNKNOWN dan tidak masuk total HOTEL/RESTO/Semua", () => {
    const r = run([H1, R1, rec("", "999.00", "1", "1", "997.00"), rec(null, "999.00", "1", "1", "997.00"), rec("XX.5", "999.00", "1", "1", "997.00")]);
    expect(r.validation).toMatchObject({ totalRecords: 5, hotelRecords: 1, restoRecords: 1, unknownCategory: 3, invalidValues: 0, includedRecords: 2 });
    const all = summarizeManyar(r.rows, "ALL", 2);
    expect(all.transactionCount).toBe(2);
    expect(formatManyarAmount(all.gross, 2)).toBe("527.584,00");
    expect(r.rows.filter((x) => x.category === "UNKNOWN").every((x) => x.status === "Kategori tidak dikenal" && x.errors.length > 0)).toBe(true);
  });

  it("nilai wajib kosong/invalid: ditandai, tidak dianggap nol, tidak masuk total", () => {
    const bad = [rec("FL.9", "", "1", "1", "1"), rec("SL.9", "1", null, "1", "1"), rec("FL.8", "1", "1", "abc", "1"), rec("SL.8", "1", "1", "1", undefined)];
    const r = run([H1, R1, ...bad]);
    expect(r.validation).toMatchObject({ totalRecords: 6, invalidValues: 4, invalidKnownCategory: 4, invalidUnknownCategory: 0, includedRecords: 2 });
    expect(r.rows.slice(2).every((x) => x.status === "Nilai invalid" && x.valuesValid === false)).toBe(true);
    expect(r.rows[2].category).toBe("HOTEL"); // kategori asal tetap dikenali
    expect(r.rows[2].errors.join()).toMatch(/Gross/);
    const all = summarizeManyar(r.rows, "ALL", 2);
    expect(all.transactionCount).toBe(2);
    expect(formatManyarAmount(all.gross, 2)).toBe("527.584,00");
    expect(summarizeManyar(r.rows, "HOTEL", 2).transactionCount).toBe(1); // bukan 2 (FL.9, FL.8 tidak ikut)
  });

  it("membedakan: kategori tidak dikenal vs kategori dikenal tapi nilai invalid vs keduanya", () => {
    const r = run([rec("ZZ.1", "1", "1", "1", "1"), rec("FL.1", "x", "1", "1", "1"), rec("ZZ.2", "x", "1", "1", "1"), H1]);
    expect(r.validation).toMatchObject({ unknownCategory: 2, invalidValues: 2, invalidKnownCategory: 1, invalidUnknownCategory: 1, includedRecords: 1 });
    expect(r.rows.map((x) => x.status)).toEqual(["Kategori tidak dikenal", "Nilai invalid", "Nilai invalid", "Valid"]);
  });

  it("item bukan object ditandai invalid, bukan dilewati", () => {
    const r = run([H1, 5, null, "teks", [1]]);
    expect(r.ok).toBe(true);
    expect(r.validation).toMatchObject({ totalRecords: 5, invalidValues: 4, unknownCategory: 4, includedRecords: 1 });
  });

  it("JSON rusak, bukan array, dan array kosong → pesan jelas", () => {
    expect(parseManyar("{rusak").error).toMatch(/JSON tidak valid/);
    expect(parseManyar("").error).toMatch(/kosong/i);
    expect(parseManyar(JSON.stringify({ data: [H1] })).error).toMatch(/array/);
    const empty = parseManyar("[]");
    expect(empty.ok).toBe(false);
    expect(empty.error).toMatch(/Array kosong/);
    expect(parseManyar("[]").rows).toEqual([]);
  });

  it("tidak ada batas jumlah record dan input tidak dimodifikasi", () => {
    const input = JSON.stringify(Array.from({ length: 3 }, (_, i) => ({ ...H1, NoBill: `FL.${i}` })));
    const copy = input.slice();
    const r = parseManyar(input);
    expect(input).toBe(copy);
    expect(r.rows).toHaveLength(3);
  });
});

describe("CSV", () => {
  it("mengekspor baris yang diminta dengan kategori dan status, desimal polos", () => {
    const r = run(MIXED);
    const csv = manyarToCsv(filterManyarRows(r.rows, "HOTEL"));
    expect(csv.split("\n")).toHaveLength(3);
    expect(csv).toContain('"HOTEL"');
    expect(csv).toContain('"413584.00"');
    expect(csv).not.toContain("SL-26RST0000587");
  });
});
