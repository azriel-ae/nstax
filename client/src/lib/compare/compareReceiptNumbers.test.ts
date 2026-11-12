import { describe, expect, it } from "vitest";
import type { TableData } from "./compareTable";
import { autoDetectConfig, compareFiles, type CompareResult } from "./compareFilesEngine";

// Pengujian wajib FIX KRITIS: pencocokan nomor struk berdasarkan NILAI (bukan posisi baris), nomor 18 digit tetap utuh sebagai string.

const H = ["No Struk", "Total"];
const tbl = (receipts: string[], sourceRows?: number[]): TableData => ({
  headers: H, rows: receipts.map((n) => [n, "1000"]), sourceRows: sourceRows ?? receipts.map((_, i) => i + 2), headerRow: 1, headerAuto: true,
  sheetName: null, delimiter: ",", delimiterAuto: true, blankRows: 0, repeatedHeaders: 0, warnings: [],
});
const run = (a: TableData, b: TableData): Promise<CompareResult> => compareFiles(a, b, { ...autoDetectConfig(a, b), compareValues: false });
const statusOf = (r: CompareResult) => Object.fromEntries(r.records.map((x) => [x.key, x.status]));
// pengacak deterministik (LCG) agar tes dapat diulang
const shuffle = <T,>(items: T[], seed = 12345): T[] => {
  const a = [...items]; let s = seed;
  for (let i = a.length - 1; i > 0; i--) { s = (s * 1664525 + 1013904223) >>> 0; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

const R1 = "641126010100002641", R2 = "641126010100002642", R3 = "641126010100002643";

describe("Compare 2 File — nomor struk dicocokkan berdasarkan NILAI", () => {
  it("1. nomor sama di baris berbeda (File A baris 5/8/12, File B baris 127/3/85) → semuanya COCOK", async () => {
    const a = tbl([R1, R2, R3], [5, 8, 12]), b = tbl([R1, R3, R2], [127, 3, 85]);
    const r = await run(a, b);
    expect(statusOf(r)).toEqual({ [R1]: "COCOK", [R2]: "COCOK", [R3]: "COCOK" });
    expect(r.summary).toMatchObject({ cocok: 3, onlyA: 0, onlyB: 0, review: 0, reviewRows: 0 });
  });

  it("1b. nomor sama di indeks 4 (baris 5) dan indeks 126 (baris 127) di antara ratusan baris lain → COCOK", async () => {
    const fillA = Array.from({ length: 200 }, (_, i) => `700000000000${String(i).padStart(6, "0")}`);
    const fillB = Array.from({ length: 200 }, (_, i) => `800000000000${String(i).padStart(6, "0")}`);
    const ra = [...fillA]; ra[4] = R1;
    const rb = [...fillB]; rb[126] = R1;
    const r = await run(tbl(ra), tbl(rb));
    expect(statusOf(r)[R1]).toBe("COCOK");
    expect(r.summary.cocok).toBe(1);
    expect(r.summary.onlyA).toBe(199);
    expect(r.summary.onlyB).toBe(199);
  });

  it("2. urutan seluruh transaksi File A diacak → hasil sama", async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `6411260101${String(i * 7).padStart(8, "0")}`);
    const base = await run(tbl(ids), tbl(ids));
    for (const seed of [1, 2, 3]) {
      const r = await run(tbl(shuffle(ids, seed)), tbl(ids));
      expect(r.summary).toMatchObject({ cocok: 300, onlyA: 0, onlyB: 0, duplikat: 0, review: 0 });
      expect(statusOf(r)).toEqual(statusOf(base));
    }
  });

  it("3. urutan seluruh transaksi File B diacak → hasil sama", async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `6411260101${String(i * 7).padStart(8, "0")}`);
    const r = await run(tbl(ids), tbl(shuffle(ids, 99)));
    expect(r.summary).toMatchObject({ cocok: 300, onlyA: 0, onlyB: 0, duplikat: 0, review: 0 });
  });

  it("4. nomor struk 18 digit yang sama persis → COCOK dan tampil utuh", async () => {
    const r = await run(tbl([R1]), tbl([R1]));
    expect(r.summary.cocok).toBe(1);
    expect(r.records[0].key).toBe(R1);
    expect(r.records[0].key).toHaveLength(18);
  });

  it("5. dua nomor berbeda satu digit (…2641 vs …2642) → TIDAK cocok", async () => {
    const r = await run(tbl([R1]), tbl([R2]));
    expect(r.summary).toMatchObject({ cocok: 0, onlyA: 1, onlyB: 1 });
    expect(statusOf(r)).toEqual({ [R1]: "HANYA DI FILE A", [R2]: "HANYA DI FILE B" });
  });

  it("5b. nomor yang berbeda tidak menjadi sama (…2641, …2642, …2643 sebagai nilai double akan identik)", async () => {
    expect(Number(R1) === Number(R3)).toBe(true); // bukti masalah presisi Number — sebab nomor struk wajib string
    const r = await run(tbl([R1, R2, R3]), tbl([R3]));
    expect(statusOf(r)).toEqual({ [R1]: "HANYA DI FILE A", [R2]: "HANYA DI FILE A", [R3]: "COCOK" });
  });

  it("6. awalan sama, digit akhir berbeda → TIDAK cocok (tanpa startsWith/includes)", async () => {
    const r = await run(tbl(["64112601010000264"]), tbl([R1]));
    expect(r.summary).toMatchObject({ cocok: 0, onlyA: 1, onlyB: 1 });
  });

  it("7. nol di depan dipertahankan: 000123 ≠ 123, 000123 = 000123", async () => {
    const diff = await run(tbl(["000123"]), tbl(["123"]));
    expect(diff.summary).toMatchObject({ cocok: 0, onlyA: 1, onlyB: 1 });
    const same = await run(tbl(["000123"]), tbl(["000123"]));
    expect(same.summary.cocok).toBe(1);
    expect(same.records[0].key).toBe("000123");
  });

  it("8. duplikat dengan frekuensi sama → ditandai jumlah cocok", async () => {
    const r = await run(tbl([R1, R1, R2]), tbl([R2, R1, R1]));
    const rec = r.records.find((x) => x.key === R1)!;
    expect(rec.idxA).toHaveLength(2); expect(rec.idxB).toHaveLength(2);
    expect(rec.note).toContain("Jumlah kemunculan SAMA");
    expect(r.summary).toMatchObject({ dupSameCount: 1, dupDiffCount: 0, cocok: 1 });
  });

  it("9. duplikat dengan frekuensi berbeda → selisih jumlah terdeteksi", async () => {
    const r = await run(tbl([R1, R1, R1]), tbl([R1]));
    const rec = r.records.find((x) => x.key === R1)!;
    expect(rec.status).toBe("DUPLIKAT");
    expect(rec.note).toContain("TIDAK SESUAI");
    expect(r.summary).toMatchObject({ dupSameCount: 0, dupDiffCount: 1 });
    expect(r.review.filter((x) => x.source === "A")).toHaveLength(3);
  });

  it("10. nomor kosong / notasi ilmiah (digit sudah hilang) → PERLU DITINJAU, tidak pernah dicocokkan", async () => {
    const r = await run(tbl(["", "6.41126E+17", R1]), tbl(["", "6.41126E+17", R1]));
    expect(r.summary).toMatchObject({ cocok: 1, review: 4, reviewRows: 4 });
    expect(r.summary.emptyKeyA).toBe(2);
    expect(r.review.filter((x) => x.reasons.includes("KOSONG"))).toHaveLength(4);
    expect(r.notes.some((n) => n.includes("notasi ilmiah"))).toBe(true);
  });

  it("11. file besar (60.000 baris, urutan diacak) → benar dan cepat; hasil tidak bergantung posisi", async () => {
    const n = 60000;
    const ids = Array.from({ length: n }, (_, i) => `6411260101${String(i).padStart(8, "0")}`);
    const t0 = Date.now();
    const r = await run(tbl(shuffle(ids, 7)), tbl(shuffle(ids, 8)));
    const ms = Date.now() - t0;
    expect(r.summary).toMatchObject({ cocok: n, onlyA: 0, onlyB: 0, review: 0 });
    expect(ms).toBeLessThan(15000);
  });

  it("12. rekonsiliasi: valid + tanpa kunci = total; ringkasan membedakan baris, kemunculan, dan unik", async () => {
    const r = await run(tbl([R1, R1, R2, ""]), tbl([R1, R3]));
    const s = r.summary;
    expect(s.totalA).toBe(4); expect(s.validA).toBe(3); expect(s.uniqueKeysA).toBe(2); expect(s.emptyKeyA).toBe(1);
    expect(s.validA + s.emptyKeyA).toBe(s.totalA);
    expect(s.totalB).toBe(2); expect(s.validB).toBe(2); expect(s.uniqueKeysB).toBe(2);
    expect(r.notes.some((x) => x.includes("Rekonsiliasi TIDAK sesuai"))).toBe(false);
  });
});
