import { describe, expect, it } from "vitest";
import type { TableData } from "./compareTable";
import { autoDetectConfig, buildExport, compareFiles, toCsv } from "./compareFilesEngine";
import {
  LIST_CATEGORIES, buildCategoryExport, buildCategoryList, categoryToCsv, columnWidths, csvCell, exportDataToCsv, forceTextCells, isTextDigits, receiptsToText,
} from "./compareCategoryLists";

const tbl = (headers: string[], rows: string[][]): TableData => ({
  headers, rows, sourceRows: rows.map((_, i) => i + 2), headerRow: 1, headerAuto: true, sheetName: null, delimiter: ",", delimiterAuto: true,
  blankRows: 0, repeatedHeaders: 0, warnings: [],
});
const H = ["No Struk", "Tanggal", "Total"];
const r = (id: string, total: number) => [id, "2026-10-01", String(total)];

// A: S1, S2, S3, D1, D1(dup), (kosong)   B: S1, S2, S4, D1, X9, X9(dup)
const A = tbl(H, [r("S1", 100), r("S2", 200), r("S3", 300), r("D1", 400), r("D1", 400), r("", 50)]);
const B = tbl(H, [r("S1", 100), r("S2", 200), r("S4", 500), r("D1", 400), r("X9", 70), r("X9", 70)]);

const run = async () => { const cfg = autoDetectConfig(A, B); return compareFiles(A, B, cfg); };

describe("daftar kategori (hanya A / hanya B / duplikat / perlu ditinjau)", () => {
  it("Hanya di File A memuat nomor struk yang tidak ada di File B", async () => {
    const res = await run();
    const l = buildCategoryList(res, A, B, "ONLY_A");
    expect(l.receipts).toEqual(["S3"]);
    expect(l.items.every((i) => i.source === "A")).toBe(true);
    expect(receiptsToText(l)).toBe("S3");
  });

  it("Hanya di File B memuat nomor struk yang tidak ada di File A", async () => {
    const res = await run();
    const l = buildCategoryList(res, A, B, "ONLY_B");
    // X9 muncul 2× hanya di File B → masuk "Hanya di File B" sekaligus "Duplikat" (tumpang tindih, sama seperti kartu hasil)
    expect(l.receipts).toEqual(["S4", "X9"]);
    expect(l.items.every((i) => i.source === "B")).toBe(true);
  });

  it("Duplikat: nomor struk unik disalin sekali, semua kemunculan ada di daftar ekspor", async () => {
    const res = await run();
    const l = buildCategoryList(res, A, B, "DUP");
    expect([...l.receipts].sort()).toEqual(["D1", "X9"]);
    expect(receiptsToText(l).split("\n").sort()).toEqual(["D1", "X9"]);
    // D1: 2 baris di A + 1 di B, X9: 2 baris di B
    expect(l.items.length).toBe(5);
  });

  it("Perlu ditinjau = persis daftar res.review (jumlah baris sama dengan ringkasan)", async () => {
    const res = await run();
    const l = buildCategoryList(res, A, B, "REVIEW");
    expect(l.items.length).toBe(res.review.length);
    expect(l.items.length).toBe(res.summary.reviewRows);
    expect(l.emptyReceiptRows).toBe(1); // baris dengan nomor struk kosong tetap ada di daftar, tapi tidak disalin
    expect(l.receipts).not.toContain("");
    for (const it of l.items) expect(it.index).toBeGreaterThanOrEqual(0);
  });

  it("jumlah nomor struk unik di daftar sama dengan angka kartu (tabel hasil) untuk Hanya A, Hanya B, Duplikat", async () => {
    const res = await run();
    expect(buildCategoryList(res, A, B, "ONLY_A").receipts.length).toBe(res.records.filter((x) => !x.noKey && x.idxA.length > 0 && x.idxB.length === 0).length);
    expect(buildCategoryList(res, A, B, "ONLY_B").receipts.length).toBe(res.records.filter((x) => !x.noKey && x.idxB.length > 0 && x.idxA.length === 0).length);
    expect(buildCategoryList(res, A, B, "DUP").receipts.length).toBe(res.summary.duplikat);
  });

  it("tidak mengubah hasil perbandingan (read-only)", async () => {
    const res = await run();
    const before = JSON.stringify(res);
    for (const c of LIST_CATEGORIES) { const l = buildCategoryList(res, A, B, c); buildCategoryExport(l, A, B); }
    expect(JSON.stringify(res)).toBe(before);
  });

  it("ekspor = satu tabel rapi: kolom pengantar + seluruh kolom asli baris sumber", async () => {
    const res = await run();
    const l = buildCategoryList(res, A, B, "ONLY_A");
    const ex = buildCategoryExport(l, A, B);
    expect(ex.header).toEqual(["No", "Nomor Struk", "Sumber File", "Baris Sumber", "Alasan", ...H]);
    expect(ex.rows).toEqual([[1, "S3", "File A", 4, "Tidak ditemukan di File B", "S3", "2026-10-01", "300"]]);
    const csv = categoryToCsv(ex);
    const lines = csv.replace("\ufeff", "").split("\r\n");
    expect(lines.length).toBe(2); // judul kolom + 1 baris data; tanpa blok/baris tambahan
    expect(lines[0]).toBe('"No","Nomor Struk","Sumber File","Baris Sumber","Alasan","No Struk","Tanggal","Total"');
    expect(new Set(lines.map((x) => x.split('","').length)).size).toBe(1); // jumlah kolom sama di setiap baris
  });

  it("daftar campuran A+B (Duplikat): kolom bernama sama digabung, nomor sama berdampingan", async () => {
    const res = await run();
    const l = buildCategoryList(res, A, B, "DUP");
    const ex = buildCategoryExport(l, A, B);
    expect(ex.header.slice(5)).toEqual(H); // header A dan B sama → tidak digandakan
    expect(l.items.map((i) => i.receipt)).toEqual(["D1", "D1", "D1", "X9", "X9"]);
    expect(ex.rows.map((r) => r[0])).toEqual([1, 2, 3, 4, 5]);
    expect(ex.rows.every((r) => r.length === ex.header.length)).toBe(true);
  });

  it("header A dan B berbeda: kolom digabung, sel milik file lain dikosongkan; kolom file yang tidak muncul tidak ditampilkan", async () => {
    const A6 = tbl(["No Struk", "Total"], [["Q1", "10"]]); const B6 = tbl(["No Struk", "Outlet"], [["Q1", "10"], ["Q2", "20"]]);
    const cfg6 = { ...autoDetectConfig(A6, B6), compareValues: false }; // sama seperti halaman: pencocokan murni berdasarkan identitas
    const res = await compareFiles(A6, B6, cfg6);
    const onlyB = buildCategoryExport(buildCategoryList(res, A6, B6, "ONLY_B"), A6, B6);
    expect(onlyB.header.slice(5)).toEqual(["No Struk", "Outlet"]); // kolom "Total" milik File A tidak ikut
    const rev = buildCategoryExport(buildCategoryList(res, A6, B6, "REVIEW"), A6, B6);
    expect(rev.header).toContain("Keterangan");
    expect(rev.rows.every((r) => r.length === rev.header.length)).toBe(true);
  });

  it("nama kolom kembar dalam satu file dibuat unik; lebar kolom dihitung dari isi", () => {
    const T = tbl(["Total", "Total"], [["1", "2"]]);
    const l = { category: "ONLY_A" as const, label: "Hanya di File A", items: [{ category: "ONLY_A" as const, source: "A" as const, row: 2, index: 0, receipt: "1", reason: "x", detail: "" }], receipts: ["1"], emptyReceiptRows: 0 };
    expect(buildCategoryExport(l, T, T).header.slice(5)).toEqual(["Total", "Total (2)"]);
    const w = columnWidths([["a", "panjang sekali isinya"], ["bb", "x"]]);
    expect(w[0]).toBe(8);
    expect(w[1]).toBe(23);
  });

  it("CSV menetralkan nilai yang diawali rumus (=, @)", () => {
    const A2 = tbl(H, [r("=CMD()", 1)]); const B2 = tbl(H, [r("Z1", 1)]);
    return compareFiles(A2, B2, autoDetectConfig(A2, B2)).then((res) => {
      const l = buildCategoryList(res, A2, B2, "ONLY_A");
      const csv = categoryToCsv(buildCategoryExport(l, A2, B2));
      expect(csv).toContain("\"'=CMD()\"");
    });
  });

  it("tidak ada kategori yang kosong menghasilkan teks kosong tanpa error", async () => {
    const same = tbl(H, [r("Q1", 1), r("Q2", 2)]);
    const res = await compareFiles(same, same, autoDetectConfig(same, same));
    for (const c of LIST_CATEGORIES) { const l = buildCategoryList(res, same, same, c); expect(receiptsToText(l)).toBe(""); expect(l.items.length).toBe(0); }
  });
});

describe("nomor struk panjang tidak berubah jadi 6.41126E+17 di Excel", () => {
  const LONG = "641126010100002641";
  it("isTextDigits: angka ≥11 digit dan angka berawalan nol dilindungi; angka biasa tidak", () => {
    expect(isTextDigits(LONG)).toBe(true);
    expect(isTextDigits("00123")).toBe(true);
    expect(isTextDigits("12345")).toBe(false);
    expect(isTextDigits("S0001")).toBe(false);
    expect(isTextDigits("100000.50")).toBe(false);
  });
  it("csvCell menulis format teks untuk nomor panjang, sel biasa tetap seperti semula", () => {
    expect(csvCell(LONG)).toBe(`="${LONG}"`);
    expect(csvCell("S1")).toBe('"S1"');
    expect(csvCell(300)).toBe('"300"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell("=CMD()")).toBe("\"'=CMD()\"");
  });
  it("CSV daftar kategori memuat nomor 18 digit UTUH sebagai teks, di kolom nomor struk maupun kolom sumber", async () => {
    const A3 = tbl(H, [r(LONG, 10), r("641126010100002642", 20)]); const B3 = tbl(H, [r("641126010100002642", 20)]);
    const res = await compareFiles(A3, B3, autoDetectConfig(A3, B3));
    const l = buildCategoryList(res, A3, B3, "ONLY_A");
    expect(l.receipts).toEqual([LONG]);
    const csv = categoryToCsv(buildCategoryExport(l, A3, B3));
    expect(csv).toContain(`="${LONG}"`);
    expect(csv).not.toContain("E+17");
  });
  it("exportDataToCsv sama dengan toCsv engine untuk data biasa, dan hanya beda pada nomor panjang", async () => {
    const A4 = tbl(H, [r("S1", 1), r("S2", 2)]); const B4 = tbl(H, [r("S1", 1)]);
    const res4 = await compareFiles(A4, B4, autoDetectConfig(A4, B4));
    expect(exportDataToCsv(buildExport(res4, A4, B4, { a: "a", b: "b" }))).toBe(toCsv(buildExport(res4, A4, B4, { a: "a", b: "b" })));
    const A5 = tbl(H, [r(LONG, 1)]); const B5 = tbl(H, [r("Z", 1)]);
    const res5 = await compareFiles(A5, B5, autoDetectConfig(A5, B5));
    const csv5 = exportDataToCsv(buildExport(res5, A5, B5, { a: "a", b: "b" }));
    expect(csv5).toContain(`="${LONG}"`);
  });
  it("forceTextCells memaksa sel teks-angka bertipe teks berformat @", () => {
    const ws: Record<string, unknown> = { "!ref": "A1:A2", A1: { t: "s", v: LONG }, A2: { t: "n", v: 5 } };
    forceTextCells(ws);
    expect(ws.A1).toEqual({ t: "s", v: LONG, z: "@" });
    expect(ws.A2).toEqual({ t: "n", v: 5 });
  });
});
