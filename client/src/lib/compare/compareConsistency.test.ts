import { describe, expect, it } from "vitest";
import { cellText, type TableData } from "./compareTable";
import { autoDetectConfig, compareFiles, isRowIndexColumn, normalizeKey, type CompareConfig, type CompareResult } from "./compareFilesEngine";
import { autoIdentity } from "./identityDetect";

// Dataset sintetis (tidak memakai data produksi). Tabel dibuat langsung agar tes ini murni menguji pencocokan.
const T = (headers: string[], rows: string[][]): TableData => ({ headers, rows, sourceRows: rows.map((_, i) => i + 2), headerRow: 1, headerAuto: true, sheetName: null, delimiter: null, delimiterAuto: false, blankRows: 0, repeatedHeaders: 0, warnings: [] });
const H = ["No Struk", "Tanggal", "Total", "Tax"];
const run = async (a: TableData, b: TableData, patch: Partial<CompareConfig> = {}): Promise<CompareResult> => compareFiles(a, b, { ...autoDetectConfig(a, b), ...patch });
const keysOf = (r: CompareResult, s: string) => r.records.filter((x) => x.status === s).map((x) => x.key).sort();
const shuffle = <X,>(xs: X[], seed = 7) => { const a = [...xs]; let s = seed; for (let i = a.length - 1; i > 0; i--) { s = (s * 1664525 + 1013904223) >>> 0; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

describe("identitas: kolom penomoran baris bukan identitas transaksi", () => {
  const N = 300;
  const rowsA = Array.from({ length: N }, (_, i) => [String(i + 1), `INV-${1000 + i}`, "2026-01-01", String(1000 + i)]);
  const rowsB = Array.from({ length: N }, (_, i) => [String(i + 1), i % 30 === 0 ? `INV-X${i}` : `INV-${1000 + i}`, "2026-01-01", String(1000 + i)]);
  const a = T(["No", "No Struk", "Tanggal", "Total"], rowsA), b = T(["No", "Nomor Struk", "Tanggal", "Total"], rowsB);
  it("kolom 'No' 1..N dikenali sebagai penomoran baris, 'No Struk' tidak", () => {
    expect(isRowIndexColumn(a, 0)).toBe(true);
    expect(isRowIndexColumn(a, 1)).toBe(false);
    expect(isRowIndexColumn(T(["No Struk"], [["1001"], ["1002"], ["1003"], ["1004"]]), 0)).toBe(false); // bernama kunci → tetap identitas walau berurutan
    expect(isRowIndexColumn(T(["Index"], [["A"], ["B"], ["C"]]), 0)).toBe(true); // dikenali dari nama
  });
  it("autoIdentity memilih No Struk ↔ Nomor Struk, bukan No ↔ No (posisi baris)", () => {
    const id = autoIdentity(a, b);
    expect([a.headers[id.a], b.headers[id.b]]).toEqual(["No Struk", "Nomor Struk"]);
  });
  it("hasil perbandingan: tepat 10 hanya di A dan 10 hanya di B (bukan semua 'cocok' karena posisi)", async () => {
    const id = autoIdentity(a, b);
    const cfg = autoDetectConfig(a, b);
    cfg.a = { ...cfg.a, key: id.a, receipt: id.a }; cfg.b = { ...cfg.b, key: id.b, receipt: id.b }; cfg.keyRule = id.rule; cfg.compareValues = false;
    const r = await compareFiles(a, b, cfg);
    expect(r.summary).toMatchObject({ cocok: 290, onlyA: 10, onlyB: 10, duplikat: 0, review: 0 });
    expect(keysOf(r, "HANYA DI FILE A")).toEqual(Array.from({ length: 10 }, (_, k) => `INV-${1000 + k * 30}`).sort());
  });
});

describe("identitas: nomor struk berulang (satu struk banyak baris item)", () => {
  it("No Struk tetap dipilih walau berulang; kolom Item tidak dipasangkan lewat 'hanya digit'", async () => {
    const a = T(["No Struk", "Item", "Total"], Array.from({ length: 300 }, (_, i) => [`S${Math.floor(i / 3)}`, `item${i}`, "100"]));
    const b = T(["No Struk", "Total"], Array.from({ length: 100 }, (_, i) => [`S${i}`, "300"]));
    const id = autoIdentity(a, b);
    expect([a.headers[id.a], b.headers[id.b]]).toEqual(["No Struk", "No Struk"]);
    const r = await run(a, b, { compareValues: false });
    expect(r.summary.duplikat).toBe(100); // dilaporkan sebagai duplikat, tidak ditimpa diam-diam
    expect(r.summary.onlyA + r.summary.onlyB).toBe(0);
  });
});

describe("normalisasi identitas", () => {
  it("tanda hubung unicode, huruf lebar-penuh, karakter tak terlihat, spasi & huruf besar-kecil disamakan", () => {
    const canon = normalizeKey("INV-001");
    for (const v of ["INV–001", "INV‑001", "INV−001", "ＩＮＶ-００１", "\u200bINV-001\u00a0", " inv-001 ", "INV-001\ufeff"]) expect(normalizeKey(v)).toBe(canon);
  });
  it("nol di depan tidak dibuang; tanda hubung hanya disamakan pada aturan standar, tetap berbeda pada aturan 'strict'", () => {
    expect(normalizeKey("000123")).not.toBe(normalizeKey("123"));
    expect(normalizeKey("INV-001")).toBe(normalizeKey("INV001")); // standar: perbedaan format saja
    expect(normalizeKey("INV-001", true, false, "strict")).not.toBe(normalizeKey("INV001", true, false, "strict"));
  });
  it("angka Excel '12345.0' = '12345'", () => { expect(normalizeKey("12345.0")).toBe("12345"); });
  it("kosong / null / nan → kosong", () => { for (const v of ["", "  ", "null", "NaN", "undefined"]) expect(normalizeKey(v)).toBe(""); });
});

describe("pembacaan angka sel Excel", () => {
  it("noise floating-point dibulatkan; bilangan bulat dan desimal wajar tidak berubah", () => {
    expect(cellText(150000.00000000003)).toBe("150000");
    expect(cellText(0.1 + 0.2)).toBe("0.3");
    expect(cellText(1234.56)).toBe("1234.56");
    expect(cellText(20260123001234)).toBe("20260123001234");
    expect(cellText(123456789012345680)).toBe(String(123456789012345680));
    expect(cellText("abc")).toBe("abc");
    expect(cellText(null)).toBe("");
  });
});

describe("10 skenario Compare 2 File (mode lengkap: nominal & tax dibandingkan)", () => {
  const base = [["2026-01-01", "S1", "1.000", "100"], ["2026-01-01", "S2", "2.000", "200"], ["2026-01-02", "S3", "3.000", "300"], ["2026-01-02", "S4", "4.000", "400"], ["2026-01-03", "S5", "5.000", "500"]];
  const H2 = ["Tanggal", "No Struk", "Total", "Tax"];
  it("1. urutan baris berbeda → semua cocok", async () => {
    const r = await run(T(H2, base), T(H2, shuffle(base)));
    expect(r.summary).toMatchObject({ cocok: 5, berbeda: 0, onlyA: 0, onlyB: 0, duplikat: 0, review: 0 });
  });
  it("2/3. hanya di A dan hanya di B dilaporkan benar", async () => {
    const r = await run(T(H2, [...base, ["2026-01-04", "S6", "6.000", "600"]]), T(H2, [...base, ["2026-01-04", "S7", "7.000", "700"]]));
    expect(keysOf(r, "HANYA DI FILE A")).toEqual(["S6"]); expect(keysOf(r, "HANYA DI FILE B")).toEqual(["S7"]); expect(r.summary.cocok).toBe(5);
  });
  it("4. nominal berbeda (tax sama)", async () => {
    const b = base.map((x) => (x[1] === "S2" ? [x[0], x[1], "2.500", x[3]] : x));
    const r = await run(T(H2, base), T(H2, b));
    expect(keysOf(r, "NOMINAL BERBEDA")).toEqual(["S2"]); expect(r.summary).toMatchObject({ amountDiff: 1, taxDiff: 0, cocok: 4 });
  });
  it("5. tax berbeda (total sama)", async () => {
    const b = base.map((x) => (x[1] === "S3" ? [x[0], x[1], x[2], "310"] : x));
    const r = await run(T(H2, base), T(H2, b));
    expect(keysOf(r, "NOMINAL BERBEDA")).toEqual(["S3"]); expect(r.summary).toMatchObject({ taxDiff: 1, cocok: 4 });
    expect(r.records.find((x) => x.key === "S3")!.kinds.tax!.delta).toBe(10);
  });
  it("6. nomor struk duplikat dilaporkan, tidak ditimpa", async () => {
    const r = await run(T(H2, [...base, ["2026-01-01", "S1", "1.000", "100"]]), T(H2, base));
    expect(keysOf(r, "DUPLIKAT")).toEqual(["S1"]);
    const rec = r.records.find((x) => x.key === "S1")!;
    expect(rec.idxA).toHaveLength(2); expect(rec.idxB).toHaveLength(1);
    expect(r.summary).toMatchObject({ dupKeysA: 1, dupRowsA: 1, cocok: 4 });
  });
  it("7. nomor struk kosong / tidak valid → PERLU DITINJAU, bukan dianggap tidak cocok", async () => {
    const a = T(H2, [...base, ["2026-01-04", "", "9.000", "900"], ["2026-01-04", "null", "9.100", "910"]]);
    const r = await run(a, T(H2, base));
    expect(r.summary).toMatchObject({ review: 2, cocok: 5, onlyA: 0 });
    expect(r.records.filter((x) => x.noKey)).toHaveLength(2);
  });
  it("8. nama kolom berbeda (Nomor Order/Pajak/Grand Total) dipetakan otomatis", async () => {
    const b = T(["Tgl", "Nomor Order", "Grand Total", "Pajak"], base.map((x) => [x[0], x[1], x[2], x[3]]));
    const r = await run(T(H2, base), b);
    expect(r.summary).toMatchObject({ cocok: 5, berbeda: 0, onlyA: 0, onlyB: 0 });
  });
  it("9. format angka berbeda antar file (Indonesia 1.000,50 / Rp vs Inggris 1,000.50) dianggap sama", async () => {
    const a = T(H2, [["2026-01-01", "S1", "1.000,50", "100,00"], ["2026-01-01", "S2", "Rp 2.000,00", "200"]]);
    const b = T(H2, [["2026-01-01", "S1", "1,000.50", "100.00"], ["2026-01-01", "S2", "2,000.00", "200"]]);
    const r = await run(a, b, { numberFormat: "auto" });
    expect(r.summary).toMatchObject({ cocok: 2, berbeda: 0, review: 0 });
  });
  it("9b. nilai yang benar-benar berbeda tetap terdeteksi walau formatnya berbeda", async () => {
    const a = T(H2, [["2026-01-01", "S1", "1.000,50", "100,00"]]);
    const b = T(H2, [["2026-01-01", "S1", "1,000.60", "100.00"]]);
    const r = await run(a, b, { numberFormat: "auto" });
    expect(r.summary).toMatchObject({ cocok: 0, berbeda: 1 });
    expect(r.records[0].kinds.total!.delta).toBe(0.1);
  });
  it("10. ribuan transaksi acak: hasil tepat dan cepat", async () => {
    const N = 6000;
    const rows = Array.from({ length: N }, (_, i) => ["2026-01-01", `T${100000 + i}`, String(1000 + (i % 97)), String(100 + (i % 11))]);
    const bRows = shuffle(rows.filter((_, i) => i % 50 !== 0).concat([["2026-01-01", "Z1", "1", "0"], ["2026-01-01", "Z2", "2", "0"]]));
    const bMod = bRows.map((x, i) => (i % 400 === 5 ? [x[0], x[1], String(Number(x[2]) + 1), x[3]] : x));
    const t0 = Date.now();
    const r = await run(T(H2, rows), T(H2, bMod));
    const onlyA = Array.from({ length: N }, (_, i) => i).filter((i) => i % 50 === 0).length;
    expect(r.summary.onlyA).toBe(onlyA); expect(r.summary.onlyB).toBe(2);
    const expectedDiff = bMod.filter((x, i) => i % 400 === 5 && !x[1].startsWith("Z")).length;
    expect(r.summary.berbeda).toBe(expectedDiff);
    expect(r.summary.cocok + r.summary.berbeda + r.summary.onlyA + r.summary.onlyB).toBe(r.records.length);
    expect(r.summary.totalA).toBe(N); expect(Date.now() - t0).toBeLessThan(5000);
  });
});
