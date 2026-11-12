import { describe, expect, it } from "vitest";
import type { TableData } from "./compareTable";
import { autoDetectConfig, buildExport, compareFiles, normalizeKey, toCsv, type CompareConfig, type CompareResult } from "./compareFilesEngine";

// Pencocokan nomor struk Compare 2 File: nomor dibandingkan UTUH. Hanya perbedaan PENULISAN (spasi, koma, tanda hubung/baca, huruf besar-kecil)
// yang disamakan. Tidak ada awalan/akhiran/digit terakhir/pembuangan nol di depan. Setiap baris transaksi harus dapat dijelaskan.

const tbl = (headers: string[], rows: string[][]): TableData => ({
  headers, rows, sourceRows: rows.map((_, i) => i + 2), headerRow: 1, headerAuto: true, sheetName: null, delimiter: ",", delimiterAuto: true,
  blankRows: 0, repeatedHeaders: 0, warnings: [],
});
const H = ["No Struk", "Total", "Tax"];
const mk = (receipts: string[], total = "1000", tax = "100") => tbl(H, receipts.map((n) => [n, total, tax]));
const run = async (a: TableData, b: TableData, patch: Partial<CompareConfig> = {}): Promise<CompareResult> =>
  compareFiles(a, b, { ...autoDetectConfig(a, b), compareValues: false, ...patch });

/** Invarian: setiap baris transaksi valid File A dan File B muncul tepat satu kali di hasil (tidak hilang, tidak ganda). */
const assertAccountedFor = (r: CompareResult, a: TableData, b: TableData) => {
  const seenA = r.records.flatMap((x) => x.idxA), seenB = r.records.flatMap((x) => x.idxB);
  expect(seenA.length).toBe(new Set(seenA).size);
  expect(seenB.length).toBe(new Set(seenB).size);
  expect(seenA.length).toBe(r.summary.totalA);
  expect(seenB.length).toBe(r.summary.totalB);
  expect(r.summary.totalA).toBe(a.rows.length - r.summary.summaryRowsA);
  expect(r.summary.totalB).toBe(b.rows.length - r.summary.summaryRowsB);
};
const reviewOf = (r: CompareResult, source: "A" | "B") => r.review.filter((x) => x.source === source);

describe("Compare 2 File — pencocokan nomor struk menyeluruh", () => {
  it("1. nomor identik di File A dan File B → cocok", async () => {
    const a = mk(["INV0001", "INV0002", "INV0003"]), b = mk(["INV0003", "INV0001", "INV0002"]);
    const r = await run(a, b);
    expect(r.summary).toMatchObject({ cocok: 3, onlyA: 0, onlyB: 0, duplikat: 0, review: 0, reviewRows: 0 });
    expect(r.review).toHaveLength(0);
    assertAccountedFor(r, a, b);
  });

  it("2. nomor sama tetapi beda spasi → cocok; nomor asli tetap ditampilkan", async () => {
    const a = mk(["ABC 12345", "  ABC 12346  ", "ABC\u00a012347"]), b = mk(["ABC12345", "ABC12346", "ABC12347"]);
    const r = await run(a, b);
    expect(r.summary).toMatchObject({ cocok: 3, onlyA: 0, onlyB: 0 });
    expect(r.records.map((x) => x.key).sort()).toEqual(["ABC 12345", "ABC 12346", "ABC\u00a012347".trim()].sort());
    assertAccountedFor(r, a, b);
  });

  it("3. nomor sama tetapi beda koma / tanda baca → cocok", async () => {
    const a = mk(["ABC,12345", "ABC-12346", "ABC/12347", "ABC.12348"]), b = mk(["ABC12345", "ABC12346", "ABC12347", "ABC12348"]);
    const r = await run(a, b);
    expect(r.summary).toMatchObject({ cocok: 4, onlyA: 0, onlyB: 0 });
    assertAccountedFor(r, a, b);
  });

  it("4. prefix berbeda → TIDAK cocok (masuk Perlu Ditinjau dari kedua sisi)", async () => {
    const a = mk(["ABC12345"]), b = mk(["XYZ12345"]);
    const r = await run(a, b);
    expect(r.summary).toMatchObject({ cocok: 0, onlyA: 1, onlyB: 1 });
    expect(reviewOf(r, "A")[0]).toMatchObject({ receipt: "ABC12345", normalized: "abc12345", row: 2, reasons: ["HANYA_A"] });
    expect(reviewOf(r, "B")[0]).toMatchObject({ receipt: "XYZ12345", normalized: "xyz12345", row: 2, reasons: ["HANYA_B"] });
    assertAccountedFor(r, a, b);
  });

  it("5. hanya beda pada digit terakhir → TIDAK cocok", async () => {
    const a = mk(["ABC12345", "ABC22221"]), b = mk(["ABC12346", "ABC22222"]);
    const r = await run(a, b);
    expect(r.summary).toMatchObject({ cocok: 0, onlyA: 2, onlyB: 2 });
    assertAccountedFor(r, a, b);
  });

  it("6. nomor lebih panjang dengan awalan yang sama → TIDAK cocok (tanpa prefix matching, dua arah)", async () => {
    const a = mk(["ABC12345", "ABC1234501"]), b = mk(["ABC1234501", "ABC123"]);
    const r = await run(a, b);
    // ABC1234501 ada di kedua file → cocok. ABC12345 (A) dan ABC123 (B) tidak punya pasangan walau awalan/potongannya sama.
    expect(r.summary).toMatchObject({ cocok: 1, onlyA: 1, onlyB: 1 });
    expect(reviewOf(r, "A").map((x) => x.receipt)).toEqual(["ABC12345"]);
    expect(reviewOf(r, "B").map((x) => x.receipt)).toEqual(["ABC123"]);
    const only = await run(mk(["ABC1234501"]), mk(["ABC12345"]));
    expect(only.summary).toMatchObject({ cocok: 0, onlyA: 1, onlyB: 1 });
  });

  it("7. nol di depan: 00012345 ≠ 12345; 00012345 = 00012345", async () => {
    const r = await run(mk(["00012345"]), mk(["12345"]));
    expect(r.summary).toMatchObject({ cocok: 0, onlyA: 1, onlyB: 1 });
    expect(normalizeKey("00012345")).toBe("00012345");
    const same = await run(mk(["00012345", "00000999"]), mk(["00012345", "00000999"]));
    expect(same.summary.cocok).toBe(2);
    expect(same.records.map((x) => x.key).sort()).toEqual(["00000999", "00012345"]); // angka nol tidak hilang pada tampilan
  });

  it("8. nomor struk duplikat di File A → DUPLIKAT, tidak dihapus diam-diam, satu baris tidak dipasangkan berulang", async () => {
    const a = mk(["S1", "S1", "S2"]), b = mk(["S1", "S2"]);
    const r = await run(a, b);
    const rec = r.records.find((x) => x.normKey === "s1")!;
    expect(rec).toMatchObject({ status: "DUPLIKAT" });
    expect(rec.idxA).toHaveLength(2);
    expect(rec.pairs.filter((p) => p.outcome === "COCOK")).toHaveLength(1);
    expect(rec.pairs.filter((p) => p.outcome === "HANYA DI FILE A")).toHaveLength(1);
    expect(new Set(rec.pairs.map((p) => p.b).filter((x) => x !== null)).size).toBe(1); // baris B dipakai tepat sekali
    expect(r.summary).toMatchObject({ dupKeysA: 1, dupRowsA: 1, cocok: 1, duplikat: 1 });
    expect(reviewOf(r, "A").filter((x) => x.reasons.includes("DUPLIKAT"))).toHaveLength(2);
    expect(reviewOf(r, "B").filter((x) => x.reasons.includes("DUPLIKAT"))).toHaveLength(1); // pasangannya pun ikut ditinjau
    assertAccountedFor(r, a, b);
  });

  it("9. nomor struk duplikat di File B", async () => {
    const a = mk(["S1", "S2"]), b = mk(["S1", "S2", "S2", "S2"]);
    const r = await run(a, b);
    const rec = r.records.find((x) => x.normKey === "s2")!;
    expect(rec.status).toBe("DUPLIKAT");
    expect(rec.idxB).toHaveLength(3);
    expect(rec.pairs.filter((p) => p.outcome === "HANYA DI FILE B")).toHaveLength(2);
    expect(r.summary).toMatchObject({ dupKeysB: 1, dupRowsB: 2 });
    assertAccountedFor(r, a, b);
  });

  it("10. transaksi hanya ada di File A", async () => {
    const a = mk(["S1", "S2", "S3"]), b = mk(["S1", "S2"]);
    const r = await run(a, b);
    expect(r.summary).toMatchObject({ cocok: 2, onlyA: 1, onlyB: 0 });
    expect(r.review).toHaveLength(1);
    expect(r.review[0]).toMatchObject({ source: "A", receipt: "S3", row: 4, reasons: ["HANYA_A"] });
    expect(r.review[0].detail).toContain("File B");
    assertAccountedFor(r, a, b);
  });

  it("11. transaksi hanya ada di File B", async () => {
    const a = mk(["S1"]), b = mk(["S1", "S9", "S8"]);
    const r = await run(a, b);
    expect(r.summary).toMatchObject({ cocok: 1, onlyA: 0, onlyB: 2 });
    expect(reviewOf(r, "B").map((x) => x.receipt)).toEqual(["S9", "S8"]);
    expect(reviewOf(r, "B").every((x) => x.reasons[0] === "HANYA_B" && x.detail.includes("File A"))).toBe(true);
    assertAccountedFor(r, a, b);
  });

  it("12. nomor struk kosong / tidak valid → Perlu Ditinjau, tidak hilang dari hitungan", async () => {
    const a = mk(["S1", "S2", "S3", "S4", "S5", "", "   ", "null"]), b = mk(["S1", "S2", "S3", "S4", "S5", "NaN"]);
    const r = await run(a, b);
    expect(r.summary).toMatchObject({ cocok: 5, emptyKeyA: 3, emptyKeyB: 1, review: 4 });
    expect(r.summary.totalA).toBe(8);
    expect(r.summary.totalB).toBe(6);
    const empties = r.review.filter((x) => x.reasons.includes("KOSONG"));
    expect(empties).toHaveLength(4);
    expect(empties.every((x) => x.normalized === "")).toBe(true);
    expect(empties.map((x) => `${x.source}${x.row}`).sort()).toEqual(["A7", "A8", "A9", "B7"]);
    expect(r.review).toHaveLength(4); // tidak ada baris lain yang ikut masuk
    assertAccountedFor(r, a, b);
  });

  it("13. dua nomor berbeda menjadi identik setelah normalisasi (dalam satu file) → benturan + Perlu Ditinjau", async () => {
    const a = mk(["12-345", "1-2345", "S2"]), b = mk(["12345", "S2"]);
    const r = await run(a, b);
    const rec = r.records.find((x) => x.normKey === "12345")!;
    expect(rec.collisionA.sort()).toEqual(["1-2345", "12-345"]);
    expect(rec.status).toBe("DUPLIKAT");
    expect(rec.note).toContain("Benturan normalisasi");
    expect(r.summary.collisionKeys).toBe(1);
    const coll = r.review.filter((x) => x.reasons.includes("BENTURAN"));
    expect(coll.map((x) => x.receipt).sort()).toEqual(["1-2345", "12-345"]);
    expect(coll.every((x) => x.source === "A" && x.normalized === "12345")).toBe(true);
    // Beda penulisan antar file (A "ABC 1" vs B "ABC1") BUKAN benturan.
    const ok = await run(mk(["ABC 1"]), mk(["ABC1"]));
    expect(ok.summary).toMatchObject({ cocok: 1, collisionKeys: 0 });
    assertAccountedFor(r, a, b);
  });

  it("14. file besar: semua baris diproses, nomor panjang tidak dipotong (beda hanya di ujung akhir tetap terdeteksi)", async () => {
    const N = 30000;
    const num = (i: number) => `TRX-OUTLET-2026-10-${String(i).padStart(12, "0")}`; // ±34 karakter, bagian unik di ujung
    const aRows: string[] = Array.from({ length: N }, (_, i) => num(i));
    const bRows: string[] = Array.from({ length: N }, (_, i) => num(i));
    bRows[N - 1] = `${num(N - 1)}9`; // hanya beda di karakter paling akhir
    bRows[12345] = num(12345).replace("TRX-OUTLET", "TRX OUTLET"); // beda penulisan saja → tetap cocok
    const a = mk(aRows), b = mk(bRows);
    const t0 = Date.now();
    const r = await run(a, b);
    expect(Date.now() - t0).toBeLessThan(20000);
    expect(r.summary.totalA).toBe(N);
    expect(r.summary.totalB).toBe(N);
    expect(r.summary).toMatchObject({ cocok: N - 1, onlyA: 1, onlyB: 1, duplikat: 0 });
    expect(reviewOf(r, "A")[0]).toMatchObject({ receipt: num(N - 1), row: N + 1 });
    expect(reviewOf(r, "B")[0].receipt).toBe(`${num(N - 1)}9`);
    expect(r.records).toHaveLength(N + 1);
    assertAccountedFor(r, a, b);
  });

  it("15. selisih nominal / pajak pada struk yang berhasil dicocokkan tetap terdeteksi (mekanisme lama tidak berubah)", async () => {
    const a = tbl(H, [["ABC 100", "1000", "100"], ["ABC-101", "2000", "200"], ["ABC102", "3000", "300"]]);
    const b = tbl(H, [["ABC100", "1000", "100"], ["ABC101", "2500", "200"], ["ABC102", "3000", "250"]]);
    const r = await compareFiles(a, b, { ...autoDetectConfig(a, b), compareValues: true });
    const byKey = (k: string) => r.records.find((x) => x.normKey === k)!;
    expect(byKey("abc100").status).toBe("COCOK");
    expect(byKey("abc101")).toMatchObject({ status: "NOMINAL BERBEDA", amountDiff: true, taxDiff: false });
    expect(byKey("abc102")).toMatchObject({ status: "NOMINAL BERBEDA", amountDiff: true, taxDiff: true });
    expect(r.summary).toMatchObject({ cocok: 1, berbeda: 2, amountDiff: 2, taxDiff: 1, onlyA: 0, onlyB: 0 });
    const total = r.totals.find((t) => t.kind === "total")!;
    expect([total.sumA, total.sumB]).toEqual([6000, 6500]);
    expect(r.review).toHaveLength(0); // beda nominal punya mekanisme sendiri; bukan "tanpa pasangan"
    assertAccountedFor(r, a, b);
  });

  it("ekspor memuat bagian Perlu Ditinjau lengkap (nomor asli, ternormalisasi, baris, alasan)", async () => {
    const a = mk(["ABC 1", "ONLYA 9"]), b = mk(["ABC1", "ONLYB 7"]);
    const r = await run(a, b);
    const data = buildExport(r, a, b, { a: "a.csv", b: "b.csv" });
    expect(data.reviewHeader).toEqual(["Sumber", "Nomor Struk Asli", "Nomor Struk Ternormalisasi", "Baris Sumber", "Alasan", "Keterangan"]);
    expect(data.reviewRows).toHaveLength(2);
    expect(data.reviewRows[0].slice(0, 4)).toEqual(["File A", "ONLYA 9", "onlya9", 3]);
    expect(data.reviewRows[1].slice(0, 4)).toEqual(["File B", "ONLYB 7", "onlyb7", 3]);
    const csv = toCsv(data);
    expect(csv).toContain("PERLU DITINJAU (TRANSAKSI TANPA PASANGAN");
    expect(csv).toContain("ONLYA 9");
  });

  it("aturan 'Persis' (opsional) tidak menyamakan spasi/tanda baca; tidak ada aturan awalan/akhiran yang tersedia", async () => {
    const r = await run(mk(["ABC 12345"]), mk(["ABC12345"]), { keyRule: "strict" });
    expect(r.summary).toMatchObject({ cocok: 0, onlyA: 1, onlyB: 1 });
    expect(normalizeKey("ABC1234501", true, false, "alnum")).not.toBe(normalizeKey("ABC12345", true, false, "alnum"));
  });
});
