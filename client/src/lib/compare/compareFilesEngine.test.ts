import { describe, expect, it } from "vitest";
import type { TableData } from "./compareTable";
import {
  autoDetectConfig, buildExport, classifyAmount, compareFiles, normalizeKey, pairKeyColumns, rankKeyColumns, readStats, toCsv,
  type CompareConfig, type CompareResult,
} from "./compareFilesEngine";

// Fixture dibuat langsung sebagai TableData (tanpa file) sehingga tes ini murni menguji engine pencocokan.
const tbl = (headers: string[], rows: string[][]): TableData => ({
  headers, rows, sourceRows: rows.map((_, i) => i + 2), headerRow: 1, headerAuto: true, sheetName: null, delimiter: ",", delimiterAuto: true,
  blankRows: 0, repeatedHeaders: 0, warnings: [],
});
const H1 = ["No Struk", "Tanggal", "Subtotal", "DPP", "Tax", "Service Charge", "Discount", "Total"];
const row = (id: string, sub: number, tax: number, extra: Partial<Record<"dpp" | "svc" | "disc" | "total" | "date", string>> = {}): string[] => [
  id, extra.date ?? "2026-08-01", String(sub), extra.dpp ?? String(sub), String(tax), extra.svc ?? "0", extra.disc ?? "0", extra.total ?? String(sub + tax),
];
const BASE = [row("TRX001", 100000, 11000), row("TRX002", 200000, 22000), row("TRX003", 300000, 33000)];
const run = async (a: TableData, b: TableData, tweak: (c: CompareConfig) => void = () => {}): Promise<CompareResult> => {
  const cfg = autoDetectConfig(a, b); tweak(cfg);
  return compareFiles(a, b, cfg);
};
const rec = (r: CompareResult, key: string) => r.records.find((x) => x.key === key)!;

describe("klasifikasi kolom nominal", () => {
  it("mengenali tax/pajak/ppn, dpp, service, discount/diskon, subtotal, total", () => {
    expect(["Tax", "Pajak", "PPN", "Tax Amount", "Pajak PB1"].map(classifyAmount)).toEqual(["tax", "tax", "tax", "tax", "tax"]);
    expect(["DPP", "Dasar Pengenaan Pajak"].map(classifyAmount)).toEqual(["dpp", "dpp"]);
    expect(["Service Charge", "Service"].map(classifyAmount)).toEqual(["service", "service"]);
    expect(["Discount", "Diskon", "Potongan"].map(classifyAmount)).toEqual(["discount", "discount", "discount"]);
    expect(["Subtotal", "Sub Total"].map(classifyAmount)).toEqual(["subtotal", "subtotal"]);
    expect(["Total", "Grand Total", "Total Bayar"].map(classifyAmount)).toEqual(["total", "total", "total"]);
    expect(["No Struk", "Nama Outlet", "Tanggal"].map(classifyAmount)).toEqual(["other", "other", "other"]);
  });
});

describe("deteksi identitas transaksi", () => {
  it("memilih kolom identitas dari nama + isi; 'id' generik hanya jika hampir unik", () => {
    const t = tbl(["id", "No Struk", "Total"], [["1", "S1", "10"], ["1", "S2", "20"], ["1", "S3", "30"]]);
    expect(rankKeyColumns(t)[0].header).toBe("No Struk");
    expect(rankKeyColumns(t).some((c) => c.header === "id")).toBe(false);
  });
  it("identitas beda nama di kedua file dipasangkan dan diyakini bila nilainya beririsan", () => {
    const a = tbl(["No Struk", "Total"], [["S1", "1"], ["S2", "2"], ["S3", "3"]]);
    const b = tbl(["Receipt No", "Amount"], [["S3", "3"], ["S1", "1"], ["S9", "9"]]);
    const pk = pairKeyColumns(a, b);
    expect([pk.a, pk.b, pk.confidence, pk.matched]).toEqual([0, 0, "high", 2]);
  });
  it("kolom identitas bernama tak lazim dikenali dari isinya (unik, terisi) dan dipasangkan lewat irisan nilai", () => {
    const a = tbl(["No Struk", "Total"], [["S1", "1"], ["S2", "2"], ["S3", "3"]]);
    const b = tbl(["Tanggal", "Nominal", "Kode"], [["2026-08-01", "1", "S1"], ["2026-08-01", "2", "S2"], ["2026-08-02", "3", "S3"]]);
    const pk = pairKeyColumns(a, b);
    expect([pk.a, pk.b, pk.confidence]).toEqual([0, 2, "high"]);
  });
  it("tidak ada irisan nilai sama sekali → keyakinan rendah (user diminta memastikan kolom)", () => {
    const a = tbl(["No Struk", "Total"], [["S1", "1"], ["S2", "2"]]);
    const b = tbl(["No Struk", "Total"], [["X1", "1"], ["X2", "2"]]);
    expect(pairKeyColumns(a, b).confidence).toBe("low");
  });
  it("tidak ada kandidat sama sekali → none", () => {
    const a = tbl(["Total", "Tanggal"], [["1", "2026-08-01"]]);
    expect(pairKeyColumns(a, a).confidence).toBe("none");
  });
  it("normalisasi kunci: spasi & huruf besar/kecil & '.0' Excel; angka nol di depan dan tanda hubung dipertahankan", () => {
    expect(normalizeKey(" TRX-001 ")).toBe("trx-001");
    expect(normalizeKey("0012")).toBe("0012");
    expect(normalizeKey("12345.0")).toBe("12345");
    expect(normalizeKey("0012")).not.toBe(normalizeKey("12"));
    expect(normalizeKey("null")).toBe("");
  });
});

describe("pemetaan kolom nominal otomatis", () => {
  it("mendeteksi subtotal, dpp, tax, service, discount, total; total menjadi nominal utama", () => {
    const t = tbl(H1, BASE);
    const cfg = autoDetectConfig(t, t);
    expect(cfg.amounts.map((p) => p.label)).toEqual(["Total", "Subtotal", "DPP", "Tax", "Service Charge", "Discount"]);
  });
  it("nama berbeda tetapi arti sama: Tax ↔ Pajak, Diskon ↔ Discount, Service ↔ Service Charge", () => {
    const a = tbl(["No Struk", "Tax", "Discount", "Service Charge", "Total"], [["S1", "1100", "0", "500", "11600"]]);
    const b = tbl(["Receipt", "Pajak", "Diskon", "Service", "Total Bayar"], [["S1", "1000", "0", "500", "11500"]]);
    const cfg = autoDetectConfig(a, b);
    const pair = (label: string) => cfg.amounts.find((p) => p.label === label)!;
    expect([pair("Tax").a, pair("Tax").b]).toEqual([1, 1]);
    expect([pair("Discount").a, pair("Discount").b]).toEqual([2, 2]);
    expect([pair("Service Charge").a, pair("Service Charge").b]).toEqual([3, 3]);
    expect([pair("Total").a, pair("Total").b]).toEqual([4, 4]);
  });
  it("kolom teks bernama mirip nominal (mis. 'Tax Name') tidak dipasangkan sebagai nominal", () => {
    const a = tbl(["No Struk", "Tax Name", "Total"], [["S1", "PPN 11%", "100"], ["S2", "PPN 11%", "200"]]);
    const cfg = autoDetectConfig(a, a);
    expect(cfg.amounts.map((p) => p.label)).toEqual(["Total"]);
  });
});

describe("perbandingan transaksi satu per satu", () => {
  it("1. dua file identik → semua COCOK, tanpa selisih", async () => {
    const r = await run(tbl(H1, BASE), tbl(H1, BASE));
    expect(r.summary).toMatchObject({ totalA: 3, totalB: 3, cocok: 3, berbeda: 0, onlyA: 0, onlyB: 0, duplikat: 0, review: 0, amountDiff: 0, taxDiff: 0, keysBoth: 3, uniqueKeysA: 3, uniqueKeysB: 3 });
  });
  it("2/3. hanya di File A dan hanya di File B (identitas, bukan jumlah baris)", async () => {
    const r = await run(tbl(H1, [...BASE, row("TRX004", 1, 0)]), tbl(H1, [...BASE, row("TRX009", 2, 0)]));
    expect(rec(r, "TRX004").status).toBe("HANYA DI FILE A");
    expect(rec(r, "TRX009").status).toBe("HANYA DI FILE B");
    expect(r.summary).toMatchObject({ cocok: 3, onlyA: 1, onlyB: 1, keysOnlyA: 1, keysOnlyB: 1, keysBoth: 3 });
    expect(rec(r, "TRX004").kinds.tax?.b).toBeNull(); // sisi tanpa baris = null, bukan 0
  });
  it("jumlah baris sama tetapi identitas berbeda tidak dianggap cocok", async () => {
    const r = await run(tbl(H1, BASE), tbl(H1, [BASE[0], BASE[1], row("TRX777", 300000, 33000)]));
    expect(r.summary).toMatchObject({ totalA: 3, totalB: 3, cocok: 2, onlyA: 1, onlyB: 1 });
  });
  it("4. duplikat: identitas muncul 2× di File A; tidak dihitung sebagai identitas unik tambahan", async () => {
    const r = await run(tbl(H1, [...BASE, BASE[1]]), tbl(H1, BASE));
    const d = rec(r, "TRX002");
    expect(d.status).toBe("DUPLIKAT");
    expect(d.idxA).toHaveLength(2);
    expect(r.summary).toMatchObject({ totalA: 4, uniqueKeysA: 3, dupKeysA: 1, dupRowsA: 1, duplikat: 1, keysBoth: 3 });
  });
  it("duplikat yang hanya ada di satu file tetap terhitung 'hanya di File A' pada hitungan identitas", async () => {
    const r = await run(tbl(H1, [...BASE, row("TRX050", 5, 0), row("TRX050", 5, 0)]), tbl(H1, BASE));
    expect(rec(r, "TRX050").status).toBe("DUPLIKAT");
    expect(r.summary).toMatchObject({ keysOnlyA: 1, onlyA: 0, duplikat: 1 });
  });
  it("5. identitas sama, tax berbeda → NOMINAL BERBEDA + flag taxDiff + selisih tax per transaksi", async () => {
    const b = [row("TRX001", 100000, 10000, { total: "111000" }), BASE[1], BASE[2]];
    const r = await run(tbl(H1, BASE), tbl(H1, b));
    const x = rec(r, "TRX001");
    expect(x.status).toBe("NOMINAL BERBEDA");
    expect(x.taxDiff).toBe(true);
    expect(x.kinds.tax).toMatchObject({ a: "11000", b: "10000", delta: -1000 });
    expect(x.kinds.total).toMatchObject({ a: "111000", b: "111000", delta: 0 });
    expect(x.diffColumns).toEqual(["Tax"]);
    expect(x.note).toMatch(/Tax berbeda/);
    expect(r.summary).toMatchObject({ berbeda: 1, taxDiff: 1, amountDiff: 1, cocok: 2 });
  });
  it("6. subtotal / DPP / service / discount / total berbeda masing-masing terdeteksi; tax tetap sama", async () => {
    const b = [
      row("TRX001", 100001, 11000, { total: "111000", dpp: "100000" }), // subtotal
      row("TRX002", 200000, 22000, { dpp: "199000" }), // dpp
      row("TRX003", 300000, 33000, { svc: "100", disc: "5" }), // service + discount
    ];
    const r = await run(tbl(H1, BASE), tbl(H1, b));
    expect(rec(r, "TRX001").diffColumns).toEqual(["Subtotal"]);
    expect(rec(r, "TRX002").diffColumns).toEqual(["DPP"]);
    expect(rec(r, "TRX003").diffColumns.sort()).toEqual(["Discount", "Service Charge"]);
    expect(r.summary).toMatchObject({ berbeda: 3, amountDiff: 3, taxDiff: 0 });
    const tot = r.records.map((x) => x.taxDiff);
    expect(tot).toEqual([false, false, false]);
  });
  it("7/8. nama kolom identitas berbeda dan urutan baris berbeda tetap cocok", async () => {
    const a = tbl(H1, BASE);
    const b = tbl(["Receipt", "Date", "Sub Total", "DPP", "Pajak", "Service", "Diskon", "Grand Total"], [BASE[2], BASE[0], BASE[1]]);
    const r = await run(a, b);
    expect(r.summary).toMatchObject({ cocok: 3, berbeda: 0, onlyA: 0, onlyB: 0 });
    expect(r.config.amounts).toHaveLength(6);
  });
  it("selisih tax terdeteksi walau kolom bernama Tax di File A dan Pajak di File B", async () => {
    const a = tbl(["No Struk", "Tax", "Total"], [["S1", "1100", "11100"], ["S2", "2200", "22200"]]);
    const b = tbl(["Receipt", "Pajak", "Total"], [["S1", "1000", "11100"], ["S2", "2200", "22200"]]);
    const r = await run(a, b);
    expect(rec(r, "S1").taxDiff).toBe(true);
    expect(rec(r, "S2").status).toBe("COCOK");
    expect(r.totals.find((t) => t.label === "Tax")).toMatchObject({ sumA: 3300, sumB: 3200 });
  });
  it("11. format angka Indonesia vs internasional, pemisah ribuan & desimal dianggap sama bila nilainya sama", async () => {
    const a = tbl(["No Struk", "Tax", "Total"], [["S1", "1.100,50", "Rp 11.100"], ["S2", "(2.200)", "-1.000,00"]]);
    const b = tbl(["No Struk", "Tax", "Total"], [["S1", "1,100.50", "11100"], ["S2", "-2200", "-1,000.00"]]);
    const r = await run(a, b);
    expect(r.summary).toMatchObject({ cocok: 2, berbeda: 0, review: 0 });
  });
  it("13. sel kosong ≠ 0 pada tax: tetap dilaporkan sebagai selisih tax; angka nol vs nol cocok", async () => {
    const a = tbl(["No Struk", "Tax", "Total"], [["S1", "", "100"], ["S2", "0", "100"], ["S3", "", "100"]]);
    const b = tbl(["No Struk", "Tax", "Total"], [["S1", "0", "100"], ["S2", "0", "100"], ["S3", "", "100"]]);
    const r = await run(a, b);
    expect(rec(r, "S1").taxDiff).toBe(true);
    expect(rec(r, "S1").kinds.tax?.delta).toBeNull(); // tidak ada selisih angka karena salah satu sisi kosong
    expect(rec(r, "S2").status).toBe("COCOK");
    expect(rec(r, "S3").status).toBe("COCOK");
  });
  it("14. identitas kosong tidak dicocokkan, tidak dihitung sebagai identitas, dan tidak ikut hitungan selisih", async () => {
    const a = tbl(["No Struk", "Tax", "Total"], [["S1", "1", "10"], ["", "5", "50"]]);
    const b = tbl(["No Struk", "Tax", "Total"], [["S1", "1", "10"], ["", "9", "50"]]);
    const r = await run(a, b);
    expect(r.summary).toMatchObject({ emptyKeyA: 1, emptyKeyB: 1, review: 2, keysBoth: 1, keysOnlyA: 0, keysOnlyB: 0, taxDiff: 0, uniqueKeysA: 1 });
    expect(r.records.filter((x) => x.noKey)).toHaveLength(2);
  });
  it("kombinasi kolom: mode kunci+tanggal memisahkan transaksi dengan nomor sama pada tanggal berbeda", async () => {
    const a = tbl(["No Order", "Tanggal", "Total"], [["O1", "2026-08-01", "10"], ["O1", "2026-08-02", "20"]]);
    const b = tbl(["No Order", "Tanggal", "Total"], [["O1", "2026-08-01", "10"], ["O1", "2026-08-02", "25"]]);
    const r = await run(a, b, (c) => { c.mode = "key_date"; });
    expect(r.summary).toMatchObject({ cocok: 1, berbeda: 1, duplikat: 0 });
  });
  it("total per kolom nominal: tiap file dijumlahkan dari seluruh baris; baris TOTAL laporan tidak ikut", async () => {
    const withTotal = [...BASE, ["TOTAL", "", "600000", "600000", "66000", "0", "0", "666000"]];
    const r = await run(tbl(H1, withTotal), tbl(H1, BASE));
    const tax = r.totals.find((t) => t.label === "Tax")!;
    expect([tax.sumA, tax.sumB]).toEqual([66000, 66000]);
    expect(r.summary.summaryRowsA).toBe(1);
  });
  it("baris TOTAL laporan dikenali walau banyak kolom terisi; identitas seperti TOTAL-001 tetap transaksi", async () => {
    const r = await run(tbl(H1, [...BASE, row("TOTAL-001", 7, 0), ["Total Penjualan", "", "1", "1", "1", "0", "0", "2"]]), tbl(H1, [...BASE, row("TOTAL-001", 7, 0)]));
    expect(r.summary).toMatchObject({ totalA: 4, summaryRowsA: 1, cocok: 4, onlyA: 0 });
  });
  it("invarian: jumlah record = cocok + berbeda + hanya A + hanya B + duplikat + review", async () => {
    const r = await run(tbl(H1, [...BASE, BASE[0], row("X", 1, 0)]), tbl(H1, [BASE[0], BASE[1], row("Y", 1, 0)]));
    const s = r.summary;
    expect(s.cocok + s.berbeda + s.onlyA + s.onlyB + s.duplikat + s.review).toBe(r.records.length);
    expect(s.keysBoth + s.keysOnlyA + s.keysOnlyB).toBe(r.records.filter((x) => !x.noKey).length);
  });
  it("dataset besar dibandingkan penuh (12.000 baris), bukan preview", async () => {
    const rows = Array.from({ length: 12000 }, (_, i) => row(`T${i}`, i * 10, i));
    const rowsB = rows.map((x, i) => (i === 11999 ? row("T11999", 119990, 5) : x));
    const r = await run(tbl(H1, rows), tbl(H1, rowsB));
    expect(r.summary).toMatchObject({ totalA: 12000, totalB: 12000, cocok: 11999, berbeda: 1, taxDiff: 1 });
  });
});

describe("statistik pembacaan", () => {
  it("menghitung baris terbaca, valid, ringkasan, dan tanpa identitas", () => {
    const t = { ...tbl(["No Struk", "Total"], [["S1", "1"], ["S2", "2"], ["", "3"], ["TOTAL", "6"]]), blankRows: 2, repeatedHeaders: 1 };
    expect(readStats(t, 0)).toEqual({ rowsRead: 7, blank: 2, repeatedHeaders: 1, summaryRows: 1, emptyKey: 1, valid: 3, columns: 2 });
  });
});

describe("ekspor", () => {
  it("memuat seluruh hasil, kolom tax/total per file, flag, dan detail selisih per kolom", async () => {
    const b = [row("TRX001", 100000, 10000, { total: "111000" }), BASE[1], BASE[2]];
    const ta = tbl(H1, BASE), tb = tbl(H1, b);
    const r = await run(ta, tb);
    const data = buildExport(r, ta, tb, { a: "a.csv", b: "b.csv" });
    expect(data.rows).toHaveLength(r.records.length);
    const first = data.rows.find((x) => x[1] === "TRX001")!;
    expect(first.slice(13)).toEqual(["11000", "10000", -1000, "111000", "111000", 0, "YA", "YA"]);
    expect(data.diffRows).toEqual([["TRX001", "NOMINAL BERBEDA", "Tax", "11000", "10000", -1000, 2, 2]]);
    const csv = toCsv(data);
    expect(csv).toContain("DETAIL SELISIH PER KOLOM");
    expect(csv).toContain('"Transaksi dengan selisih tax/pajak","1"');
  });
});
