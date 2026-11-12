import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { FileReadError, openSourceExact } from "./compareTable";
import { allUnmatchedText, buildExportWorkbook, compareEsbVsFile, consistencyErrors, normalizeReceipt, readEsb, readFile, unmatchedToText } from "./esbVsFile";

const xlsxBuffer = (aoa: unknown[][], sheet = "Report"): ArrayBuffer => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa as never[][]), sheet);
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return out;
};
const esbSrc = (aoa: unknown[][], name = "esb.xlsx") => openSourceExact(xlsxBuffer(aoa), name);
const fileSrc = (aoa: unknown[][], name = "file.xlsx") => openSourceExact(xlsxBuffer(aoa, "Sheet1"), name);
const run = async (esbAoa: unknown[][], fileAoa: unknown[][]) => compareEsbVsFile(readEsb(await esbSrc(esbAoa)), readFile(await fileSrc(fileAoa)));

const ESB_HEAD = ["Sales Number", "Bill Number", "Sales Type"];
const esbRows = (pairs: Array<[string, string]>) => pairs.map(([bill, sales]) => [sales, bill, "Sales"]);
const fileRows = (vals: string[]) => vals.map((v) => ["2026-10-01", v, 1000]);
const FILE_HEAD = ["date_trans", "no_struk", "total"];

describe("ESB vs File", () => {
  it("kondisi normal: gabung Bill Number + ' - ' + Sales Number lalu exact match", async () => {
    const r = await run(
      [["Laporan"], [], ESB_HEAD, ...esbRows([["B1", "S1"], ["B2", "S2"], ["B3", "S3"]])],
      [FILE_HEAD, ...fileRows(["B1 - S1", "B2 - S2", "B4 - S4"])],
    );
    expect(r.esbValid).toBe(3); expect(r.fileValid).toBe(3); expect(r.matched).toBe(2);
    expect(r.notInEsb.map((u) => u.value)).toEqual(["B4 - S4"]);
    expect(r.notInFile.map((u) => u.value)).toEqual(["B3 - S3"]);
    expect(consistencyErrors(r)).toEqual([]);
  });

  it("urutan baris diacak tidak mengubah hasil", async () => {
    const pairs: Array<[string, string]> = [["B1", "S1"], ["B2", "S2"], ["B3", "S3"], ["B4", "S4"]];
    const a = await run([ESB_HEAD, ...esbRows(pairs)], [FILE_HEAD, ...fileRows(["B1 - S1", "B2 - S2", "B9 - S9"])]);
    const b = await run([ESB_HEAD, ...esbRows([...pairs].reverse())], [FILE_HEAD, ...fileRows(["B9 - S9", "B2 - S2", "B1 - S1"])]);
    expect(b.matched).toBe(a.matched);
    expect(b.notInEsb.map((u) => u.value).sort()).toEqual(a.notInEsb.map((u) => u.value).sort());
    expect(b.notInFile.map((u) => u.value).sort()).toEqual(a.notInFile.map((u) => u.value).sort());
  });

  it("urutan kolom berubah dan header di baris berbeda", async () => {
    const esb = [["x"], ["y"], ["z"], ["Bill Number", "Extra", "Sales Number"], ["B1", "q", "S1"], ["B2", "q", "S2"]];
    const file = [["total", "no_struk", "id"], [1, "B1 - S1", "a"], [2, "B2 - S2", "b"]];
    const r = await run(esb, file);
    expect(r.matched).toBe(2); expect(r.notInEsb).toHaveLength(0); expect(r.notInFile).toHaveLength(0);
    const r2 = await run([["Bill Number", "Sales Number"], ["B1", "S1"]], [[], [], [], ["no_struk"], ["B1 - S1"]]);
    expect(r2.matched).toBe(1);
  });

  it("duplikat dihitung per kemunculan (bukan Set)", async () => {
    const r = await run(
      [ESB_HEAD, ...esbRows([["B1", "S1"], ["B1", "S1"], ["B2", "S2"]])],
      [FILE_HEAD, ...fileRows(["B1 - S1", "B2 - S2", "B2 - S2", "B2 - S2"])],
    );
    expect(r.esbValid).toBe(3); expect(r.fileValid).toBe(4);
    expect(r.matched).toBe(2); // B1 dipasangkan 1×, B2 dipasangkan 1×
    expect(r.notInFile.map((u) => u.value)).toEqual(["B1 - S1"]);
    expect(r.notInEsb.map((u) => u.value)).toEqual(["B2 - S2", "B2 - S2"]);
    expect(r.esbDuplicates).toEqual([expect.objectContaining({ value: "B1 - S1", count: 2 })]);
    expect(r.fileDuplicates).toEqual([expect.objectContaining({ value: "B2 - S2", count: 3 })]);
    expect(consistencyErrors(r)).toEqual([]);
  });

  it("baris kosong / tidak valid diabaikan dan dilaporkan", async () => {
    const r = await run(
      [ESB_HEAD, ["S1", "B1", "x"], [null, null, null], ["S2", "", "x"], ["", "B3", "x"], ["Total", "", ""], ["S4", "B4", "x"]],
      [FILE_HEAD, ["d", "B1 - S1", 1], ["d", "", 1], [null, null, null], ["d", "   ", 1], ["d", "B4 - S4", 1]],
    );
    expect(r.esbValid).toBe(2); expect(r.fileValid).toBe(2); expect(r.matched).toBe(2);
    expect(r.esbSkipped.length).toBeGreaterThanOrEqual(3); expect(r.fileSkipped).toHaveLength(2);
    expect(consistencyErrors(r)).toEqual([]);
  });

  it("format nomor berbeda-beda, tanpa asumsi panjang/awalan; hanya trim tepi", async () => {
    const r = await run(
      [ESB_HEAD, ...esbRows([["00123", "A-9"], ["  INV/2026/7 ", " 5551 "], ["x y", "z.w"], ["0001", "1"]])],
      [FILE_HEAD, ...fileRows(["00123 - A-9", "INV/2026/7 - 5551", "x y - z.w", "1 - 0001"])],
    );
    expect(r.matched).toBe(3);
    expect(r.notInFile.map((u) => u.value)).toEqual(["0001 - 1"]); // urutan Bill - Sales dipertahankan
    expect(r.notInEsb.map((u) => u.value)).toEqual(["1 - 0001"]);
  });

  it("tidak ada pencocokan sebagian: prefix/substring/huruf besar-kecil/spasi dalam berbeda", async () => {
    const r = await run(
      [ESB_HEAD, ...esbRows([["B1", "S1"], ["B2", "S2"], ["B3", "S3"]])],
      [FILE_HEAD, ...fileRows(["B1 - S1 ", "B2 - S", "b3 - s3", "B1 - S1 - extra", "B 1 - S1"])],
    );
    expect(r.matched).toBe(1); // hanya "B1 - S1 " (setelah trim)
    expect(r.notInFile.map((u) => u.value)).toEqual(["B2 - S2", "B3 - S3"]);
    expect(r.notInEsb).toHaveLength(4);
  });

  it("normalizeReceipt: hanya trim tepi + hapus spasi di sekitar tanda hubung", () => {
    expect(normalizeReceipt("ABC123 - XYZ456")).toBe("ABC123-XYZ456");
    expect(normalizeReceipt("ABC123-XYZ456")).toBe("ABC123-XYZ456");
    expect(normalizeReceipt(" ABC123 - XYZ456 ")).toBe("ABC123-XYZ456");
    expect(normalizeReceipt("ABC123 -XYZ456")).toBe("ABC123-XYZ456");
    expect(normalizeReceipt("ABC123-  XYZ456")).toBe("ABC123-XYZ456");
    expect(normalizeReceipt("ABC123\u00A0-\tXYZ456")).toBe("ABC123-XYZ456");
    expect(normalizeReceipt("00123 - A-9")).toBe("00123-A-9");
    expect(normalizeReceipt("x y - z.w")).toBe("x y-z.w"); // spasi di dalam token tidak disentuh
    expect(normalizeReceipt("b3 - s3")).toBe("b3-s3"); // huruf besar-kecil tidak diubah
  });

  it("bug spasi di sekitar tanda hubung: format berbeda dianggap transaksi yang sama", async () => {
    const pairs: Array<[string, string]> = [
      ["PPD202610010008", "SPPD179085036596"], ["PPD202610010009", "SPPD179085036597"], ["PPD202610010010", "SPPD179085036598"],
      ["PPD202610010011", "SPPD179085036599"], ["PPD202610010012", "SPPD179085036600"], ["PPD202610010013", "SPPD179085036601"],
    ];
    const r = await run(
      [ESB_HEAD, ...esbRows(pairs)],
      [FILE_HEAD, ...fileRows([
        "PPD202610010008-SPPD179085036596", // tanpa spasi
        " PPD202610010009 - SPPD179085036597 ", // spasi tepi
        "PPD202610010010 -SPPD179085036598", // spasi sebelum saja
        "PPD202610010011-  SPPD179085036599", // spasi sesudah saja
        "PPD202610010012 - SPPD179085036600", // format sama dengan ESB
        "PPD202610019999-SPPD179085039999", // benar-benar berbeda
      ])],
    );
    expect(r.matched).toBe(5);
    expect(r.notInEsb.map((u) => u.value)).toEqual(["PPD202610019999-SPPD179085039999"]);
    expect(r.notInFile.map((u) => u.value)).toEqual(["PPD202610010013 - SPPD179085036601"]);
    expect(consistencyErrors(r)).toEqual([]);
    // nilai asli tidak diubah oleh normalisasi
    expect(r.matchedList.find((m) => m.fileRow === 2)?.value).toBe("PPD202610010008 - SPPD179085036596");
  });

  it("duplikat tetap dihitung per kemunculan walau format spasi berbeda", async () => {
    const r = await run(
      [ESB_HEAD, ...esbRows([["B1", "S1"], ["B1", "S1"], ["B2", "S2"]])],
      [FILE_HEAD, ...fileRows(["B1-S1", "B1 - S1", "B1 -S1", "B2-S2"])],
    );
    expect(r.matched).toBe(3);
    expect(r.notInEsb.map((u) => u.value)).toEqual(["B1 -S1"]); // kemunculan ke-3 tidak punya pasangan
    expect(r.notInFile).toHaveLength(0);
    expect(r.esbDuplicates).toEqual([expect.objectContaining({ value: "B1 - S1", count: 2 })]);
    expect(r.fileDuplicates).toEqual([expect.objectContaining({ count: 3 })]);
    expect(consistencyErrors(r)).toEqual([]);
  });

  it("nomor panjang & berawalan nol tersimpan sebagai teks tetap utuh", async () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([["Bill Number", "Sales Number"], ["000123", "641126010100002641"]]);
    ws.A2 = { t: "s", v: "000123" }; ws.B2 = { t: "s", v: "641126010100002641" };
    XLSX.utils.book_append_sheet(wb, ws, "R");
    const esb = readEsb(await openSourceExact(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer, "e.xlsx"));
    expect(esb.items[0].value).toBe("000123 - 641126010100002641");
  });

  it("error jelas bila header wajib tidak ditemukan", async () => {
    await expect(esbSrc([["Bill Number", "Other"], ["B1", "x"]]).then(readEsb)).rejects.toBeInstanceOf(Error);
    expect(() => readEsb({ format: "csv", fileName: "e.csv", size: 1, text: "Bill Number,Other\nB1,x\n", sheets: [] })).toThrow(/Sales Number/);
    expect(() => readFile({ format: "csv", fileName: "f.csv", size: 1, text: "id,total\n1,2\n", sheets: [] })).toThrow(FileReadError);
    expect(() => readFile({ format: "csv", fileName: "f.csv", size: 1, text: "id,total\n1,2\n", sheets: [] })).toThrow(/no_struk/);
  });

  it("CSV juga didukung (urutan kolom bebas)", () => {
    const e = readEsb({ format: "csv", fileName: "e.csv", size: 1, text: "junk\nSales Number,Bill Number\nS1,B1\nS2,B2\n", sheets: [] });
    const f = readFile({ format: "csv", fileName: "f.csv", size: 1, text: "no_struk,x\nB2 - S2,1\nB1 - S1,2\n", sheets: [] });
    const r = compareEsbVsFile(e, f);
    expect(r.matched).toBe(2); expect(r.notInEsb).toHaveLength(0); expect(r.notInFile).toHaveLength(0);
  });

  it("salin & ekspor menghasilkan data yang benar", async () => {
    const r = await run(
      [ESB_HEAD, ...esbRows([["B1", "S1"], ["00B2", "S2"]])],
      [FILE_HEAD, ...fileRows(["B1 - S1", "ZZ - 007"])],
    );
    expect(unmatchedToText(r.notInEsb)).toBe("ZZ - 007");
    expect(unmatchedToText(r.notInFile)).toBe("00B2 - S2");
    expect(allUnmatchedText(r)).toContain("TIDAK DITEMUKAN DI ESB (1)\nZZ - 007");
    const wb = buildExportWorkbook(r, { esb: "e.xlsx", file: "f.xlsx" });
    expect(wb.SheetNames).toEqual(["Summary", "Tidak Ditemukan di ESB", "Tidak Ditemukan di File", "Matched"]);
    const back = XLSX.read(XLSX.write(wb, { type: "array", bookType: "xlsx" }), { type: "array" });
    const aoa = (n: string) => XLSX.utils.sheet_to_json(back.Sheets[n], { header: 1, raw: true }) as unknown[][];
    expect(aoa("Tidak Ditemukan di ESB")[1][1]).toBe("ZZ - 007");
    expect(aoa("Tidak Ditemukan di File")[1].slice(1, 4)).toEqual(["00B2 - S2", "00B2", "S2"]);
    expect(aoa("Summary").find((x) => x[0] === "Jumlah transaksi cocok")?.[1]).toBe(1);
    expect(back.Sheets["Tidak Ditemukan di File"].B2.t).toBe("s");
  });
});
