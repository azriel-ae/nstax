import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { buildTable, FileReadError, loadTable, openSource, type TableData } from "./compareTable";
import { autoDetectConfig, buildExport, compareFiles, normalizeDateText, parseNumber, toCsv, validateConfig, type CompareConfig, type CompareResult } from "./compareFilesEngine";

// Semua fixture dibuat di dalam tes (terpisah dari data produksi).
const buf = (s: string) => { const u = new TextEncoder().encode(s); return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer; };
const csvTable = (s: string, delimiter?: string) => loadTable(openSource(buf(s), "x.csv"), { delimiter });
const A = "No Struk,Tanggal,Total\nS1,2026-08-01,10000\nS2,2026-08-01,20000\nS3,2026-08-02,30000";
const run = async (a: TableData, b: TableData, tweak: (c: CompareConfig) => void = () => {}): Promise<CompareResult> => {
  const cfg = autoDetectConfig(a, b); tweak(cfg);
  return compareFiles(a, b, cfg);
};
const status = (r: CompareResult, key: string) => r.records.find((x) => x.key === key)!;

describe("parsing file", () => {
  it("CSV koma, titik koma, pipe terdeteksi otomatis", () => {
    for (const d of [",", ";", "|"]) {
      const t = csvTable(A.split(",").join(d));
      expect(t.headers).toEqual(["No Struk", "Tanggal", "Total"]);
      expect(t.rows).toHaveLength(3);
      expect(t.delimiter).toBe(d);
      expect(t.delimiterAuto).toBe(true);
    }
  });
  it("delimiter dapat dipilih manual", () => {
    const t = csvTable("a;b\n1;2", ";");
    expect(t.delimiterAuto).toBe(false);
    expect(t.headers).toEqual(["a", "b"]);
  });
  it("field berkutip berisi delimiter, kutip ganda ter-escape, newline di dalam field, BOM", () => {
    const t = csvTable('\ufeffNo Struk,Nama,Total\nS1,"Budi, S.",1000\nS2,"Ia berkata ""halo""",2000\nS3,"baris1\nbaris2",3000');
    expect(t.headers[0]).toBe("No Struk");
    expect(t.rows[0]).toEqual(["S1", "Budi, S.", "1000"]);
    expect(t.rows[1][1]).toBe('Ia berkata "halo"');
    expect(t.rows[2][1]).toBe("baris1\nbaris2");
    expect(t.rows).toHaveLength(3);
  });
  it("kutip tidak seimbang → error yang menjelaskan sebabnya", () => {
    expect(() => csvTable('a,b\n1,"x\n2,3')).toThrow(/tanda kutip/);
  });
  it("file kosong / tidak valid → pesan error spesifik", () => {
    expect(() => openSource(new ArrayBuffer(0), "a.csv")).toThrow(/kosong/);
    expect(() => openSource(buf("   \n  "), "a.csv")).toThrow(/tidak berisi data/);
    expect(() => openSource(buf("x"), "a.txt")).toThrow(/tidak didukung/);
    expect(() => openSource(buf("bukan excel"), "a.xlsx")).toThrow(FileReadError);
    expect(() => loadTable(openSource(buf("a,b\n"), "a.csv"))).toThrow(/tidak ada baris data/);
  });
  const xlsx = () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Ringkasan"], ["tidak relevan"]]), "Info");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["LAPORAN PENJUALAN"], [], ["No Struk", "Tanggal", "Total"], ["X1", "01/08/2026", 1500.5], ["X2", "02/08/2026", 2000], [], ["TOTAL", "", 3500.5]]), "Data");
    const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    return openSource(out, "w.xlsx");
  };
  it("Excel multi-sheet: daftar sheet, pilih sheet, header tidak di baris 1 terdeteksi, baris kosong dilewati", () => {
    const src = xlsx();
    expect(src.sheets).toEqual(["Info", "Data"]);
    const t = loadTable(src, { sheet: "Data" });
    expect(t.sheetName).toBe("Data");
    expect(t.headerRow).toBe(3);
    expect(t.headers).toEqual(["No Struk", "Tanggal", "Total"]);
    expect(t.rows.map((r) => r[0])).toEqual(["X1", "X2", "TOTAL"]);
    expect(t.sourceRows).toEqual([4, 5, 7]);
    expect(t.blankRows).toBe(1);
    expect(t.rows[0][2]).toBe("1500.5");
  });
  it("baris header dapat ditentukan manual", () => {
    const t = loadTable(xlsx(), { sheet: "Data", headerRow: 3 });
    expect(t.headerAuto).toBe(false);
    expect(() => loadTable(xlsx(), { sheet: "Info", headerRow: 2 })).toThrow(/tidak ada baris data/);
  });
  it("header ganda/kosong diberi nama unik", () => {
    const t = buildTable([["a", "", "a"], ["1", "2", "3"]]);
    expect(t.headers).toEqual(["a", "Kolom B", "a (2)"]);
  });
});

describe("tafsir angka & tanggal", () => {
  const v = (s: string, l: "id" | "en" | "unknown" = "unknown") => { const p = parseNumber(s, l); return p.state === "ok" ? p.value : p.state; };
  it("format Indonesia, internasional, mata uang, negatif", () => {
    expect(v("1.234.567,89")).toBe(1234567.89);
    expect(v("1,234,567.89")).toBe(1234567.89);
    expect(v("Rp 150.000")).toBe(150000);
    expect(v("Rp. 1.500,50")).toBe(1500.5);
    expect(v("-25.000")).toBe(-25000);
    expect(v("(25.000)")).toBe(-25000);
    expect(v("1234.56")).toBe(1234.56);
    expect(v("12,5")).toBe(12.5);
    expect(v("0.125")).toBe(0.125);
    expect(v("1.234", "en")).toBe(1.234);
  });
  it("kosong ≠ nol dan nilai ambigu tidak diubah menjadi nol", () => {
    expect(v("")).toBe("empty");
    expect(v("  ")).toBe("empty");
    expect(v("abc")).toBe("ambiguous");
    expect(v("1.2.3")).toBe("ambiguous");
    expect(v("12,3.4")).toBe("ambiguous");
    expect(v("12.")).toBe("ambiguous");
    expect(v("10 USD ekstra")).toBe("ambiguous");
  });
  it("tanggal dinormalisasi", () => {
    expect(normalizeDateText("01/08/2026")).toBe("2026-08-01");
    expect(normalizeDateText("2026-08-01")).toBe("2026-08-01");
    expect(normalizeDateText("1-Agustus-2026")).toBe("2026-08-01");
    expect(normalizeDateText("2026-08-01 10:30:00")).toBe("2026-08-01");
    expect(normalizeDateText("31/02/2026")).toBeNull();
  });
});

describe("pencocokan transaksi", () => {
  it("1. dua file identik → semua COCOK dan jumlah konsisten", async () => {
    const r = await run(csvTable(A), csvTable(A));
    expect(r.summary).toMatchObject({ totalA: 3, totalB: 3, cocok: 3, berbeda: 0, onlyA: 0, onlyB: 0, duplikat: 0, review: 0 });
  });
  it("2. nominal berubah pada satu transaksi → NOMINAL BERBEDA dengan selisih", async () => {
    const r = await run(csvTable(A), csvTable(A.replace("20000", "21000")));
    expect(r.summary).toMatchObject({ cocok: 2, berbeda: 1 });
    const s2 = status(r, "S2");
    expect(s2.status).toBe("NOMINAL BERBEDA");
    expect(s2.delta).toBe(1000);
    expect(s2.diffColumns).toEqual(["Total"]);
  });
  it("3/4. hanya di File A / hanya di File B; sisi kosong tampil null (bukan 0)", async () => {
    const r = await run(csvTable(A + "\nS4,2026-08-03,5000"), csvTable(A + "\nS9,2026-08-03,7000"));
    const s4 = status(r, "S4"), s9 = status(r, "S9");
    expect(s4.status).toBe("HANYA DI FILE A"); expect(s4.amountB).toBeNull(); expect(s4.amountA).toBe("5000"); expect(s4.delta).toBeNull();
    expect(s9.status).toBe("HANYA DI FILE B"); expect(s9.amountA).toBeNull();
    expect(r.summary).toMatchObject({ onlyA: 1, onlyB: 1, cocok: 3 });
  });
  it("5. nomor struk duplikat tidak ditimpa; status DUPLIKAT tetap tampil walau nominal cocok", async () => {
    const dupA = A + "\nS2,2026-08-01,20000";
    const r = await run(csvTable(dupA), csvTable(A));
    const s2 = status(r, "S2");
    expect(s2.status).toBe("DUPLIKAT");
    expect(s2.idxA).toHaveLength(2);
    expect(s2.pairs.map((p) => p.outcome).sort()).toEqual(["COCOK", "HANYA DI FILE A"]);
    expect(s2.ambiguousPairing).toBe(true);
    expect(r.summary).toMatchObject({ totalA: 4, totalB: 3, dupKeysA: 1, dupRowsA: 1, duplikat: 1, cocok: 2 });
  });
  it("duplikat di kedua file dengan nilai identik dipasangkan tanpa ambigu", async () => {
    const d = A + "\nS2,2026-08-01,20000";
    const r = await run(csvTable(d), csvTable(d));
    const s2 = status(r, "S2");
    expect(s2.status).toBe("DUPLIKAT");
    expect(s2.ambiguousPairing).toBe(false);
    expect(s2.pairs.every((p) => p.outcome === "COCOK")).toBe(true);
  });
  it("pemasangan duplikat memakai nilai identik lebih dulu (deterministik)", async () => {
    const a = "No Struk,Total\nD,100\nD,200";
    const b = "No Struk,Total\nD,200\nD,300";
    const r = await run(csvTable(a), csvTable(b));
    const d = status(r, "D");
    expect(d.pairs.map((p) => [p.a, p.b, p.outcome])).toEqual([[0, 1, "NOMINAL BERBEDA"], [1, 0, "COCOK"]]);
    expect(d.ambiguousPairing).toBe(true);
  });
  it("6. urutan transaksi berbeda tidak berpengaruh", async () => {
    const rev = "No Struk,Tanggal,Total\nS3,2026-08-02,30000\nS1,2026-08-01,10000\nS2,2026-08-01,20000";
    const r = await run(csvTable(A), csvTable(rev));
    expect(r.summary.cocok).toBe(3);
  });
  it("7. nama header berbeda antar file: pemetaan manual dipakai", async () => {
    const b = "Receipt;Date;Amount\nS1;2026-08-01;10000\nS2;2026-08-01;20000\nS3;2026-08-02;30000";
    const ta = csvTable(A), tb = csvTable(b);
    const auto = autoDetectConfig(ta, tb);
    expect(auto.a.key).toBe(0); expect(auto.b.key).toBe(0); // terdeteksi dari alias nama
    const r = await compareFiles(ta, tb, { ...auto, amounts: [{ a: 2, b: 2, label: "Total" }] });
    expect(r.summary.cocok).toBe(3);
    // kunci di kolom berbeda posisi
    const tc = csvTable("Tanggal,Nominal,Kode\n2026-08-01,10000,S1\n2026-08-01,20000,S2\n2026-08-02,30000,S3");
    const r2 = await compareFiles(ta, tc, { ...auto, b: { key: 2, receipt: 2, date: 0 }, amounts: [{ a: 2, b: 1, label: "Total" }] });
    expect(r2.summary).toMatchObject({ cocok: 3, onlyA: 0, onlyB: 0 });
  });
  it("12. format angka Indonesia vs internasional dianggap sama bila nilainya sama", async () => {
    const a = 'No Struk,Total\nS1,"1.234.567,50"\nS2,"Rp 10.000"\nS3,-500';
    const b = 'No Struk,Total\nS1,"1,234,567.50"\nS2,10000\nS3,"(500)"';
    const r = await run(csvTable(a), csvTable(b));
    expect(r.summary).toMatchObject({ cocok: 3, berbeda: 0, review: 0 });
  });
  it("13. sel kosong ≠ 0; nilai ambigu → PERLU DITINJAU (bukan nol); kunci kosong tidak dicocokkan", async () => {
    const a = "No Struk,Total\nS1,\nS2,abc\nS3,100\n,500";
    const b = "No Struk,Total\nS1,0\nS2,100\nS3,100\n,500";
    const r = await run(csvTable(a), csvTable(b));
    expect(status(r, "S1").status).toBe("NOMINAL BERBEDA"); // kosong vs 0
    expect(status(r, "S2").status).toBe("PERLU DITINJAU");
    expect(status(r, "S2").note).toMatch(/ambigu/);
    expect(status(r, "S3").status).toBe("COCOK");
    expect(r.summary).toMatchObject({ emptyKeyA: 1, emptyKeyB: 1, review: 3 });
    expect(r.summary.totalA).toBe(4); // transaksi tanpa kunci tetap dihitung, bukan header/kosong
    expect(r.totals[0].ambiguousA).toBe(1);
  });
  it("spasi di awal/akhir diabaikan sesuai opsi; opsi huruf besar/kecil", async () => {
    const a = "No Struk,Total\n S1 ,10000\nabc,5";
    const b = "No Struk,Total\nS1,10000\nABC,5";
    expect((await run(csvTable(a), csvTable(b))).summary).toMatchObject({ cocok: 2 });
    expect((await run(csvTable(a), csvTable(b), (c) => { c.caseSensitive = true; })).summary).toMatchObject({ cocok: 1, onlyA: 1, onlyB: 1 });
    expect((await run(csvTable(a), csvTable(b), (c) => { c.trim = false; })).summary.cocok).toBe(1);
  });
  it("tanggal beda format tapi nilai sama → tidak dianggap berbeda; normalisasi dimatikan → berbeda", async () => {
    const a = "No Struk,Tanggal,Total\nS1,01/08/2026,100";
    const b = "No Struk,Tanggal,Total\nS1,2026-08-01,100";
    expect((await run(csvTable(a), csvTable(b))).summary.cocok).toBe(1);
    const off = await run(csvTable(a), csvTable(b), (c) => { c.normalizeDate = false; });
    expect(off.summary.berbeda).toBe(1);
    expect(off.records[0].diffColumns).toEqual(["Tanggal"]);
  });
  it("toleransi nominal default 0 (eksak); toleransi > 0 menerima selisih kecil", async () => {
    const b = A.replace("10000", "10000.5");
    expect((await run(csvTable(A), csvTable(b))).summary.berbeda).toBe(1);
    expect((await run(csvTable(A), csvTable(b), (c) => { c.tolerance = 1; })).summary.berbeda).toBe(0);
  });
  it("mode kunci+tanggal: tanggal berbeda → terpisah; mode kunci+nominal: nominal berbeda → terpisah", async () => {
    const b = A.replace("2026-08-02", "2026-08-09");
    const d = await run(csvTable(A), csvTable(b), (c) => { c.mode = "key_date"; });
    expect(d.summary).toMatchObject({ cocok: 2, onlyA: 1, onlyB: 1, berbeda: 0 });
    const m = await run(csvTable(A), csvTable(A.replace("20000", "21000")), (c) => { c.mode = "key_amount"; });
    expect(m.summary).toMatchObject({ cocok: 2, onlyA: 1, onlyB: 1 });
  });
  it("baris ringkasan (TOTAL) tidak dihitung sebagai transaksi", async () => {
    const withTotal = A + "\nTOTAL,,60000";
    const r = await run(csvTable(withTotal), csvTable(withTotal));
    expect(r.summary).toMatchObject({ totalA: 3, summaryRowsA: 1, cocok: 3, onlyA: 0 });
    expect(r.totals[0]).toMatchObject({ sumA: 60000, sumB: 60000 });
  });
  it("invarian: total transaksi tiap file = jumlah baris yang tercakup pada seluruh record", async () => {
    const r = await run(csvTable(A + "\nS2,2026-08-01,1\n,2026-08-01,5"), csvTable(A + "\nS8,2026-08-01,2"));
    expect(r.records.reduce((s, x) => s + x.idxA.length, 0)).toBe(r.summary.totalA);
    expect(r.records.reduce((s, x) => s + x.idxB.length, 0)).toBe(r.summary.totalB);
    expect(r.summary.cocok + r.summary.berbeda + r.summary.onlyA + r.summary.onlyB + r.summary.duplikat + r.summary.review).toBe(r.records.length);
  });
  it("validasi konfigurasi: kunci belum dipilih / tidak ada kolom dibandingkan", async () => {
    const ta = csvTable(A), tb = csvTable(A);
    const c = autoDetectConfig(ta, tb);
    expect(validateConfig({ ...c, a: { ...c.a, key: -1 } }, ta, tb)[0]).toMatch(/File A/);
    expect(validateConfig({ ...c, amounts: [], a: { ...c.a, date: -1 }, b: { ...c.b, date: -1 } }, ta, tb).join(" ")).toMatch(/Tidak ada kolom/);
    await expect(compareFiles(ta, tb, { ...c, b: { ...c.b, key: -1 } })).rejects.toThrow(/File B/);
  });
  it("dataset besar dibandingkan penuh (bukan preview)", async () => {
    const rows = Array.from({ length: 12000 }, (_, i) => `S${i},${i * 10}`);
    const a = csvTable("No Struk,Total\n" + rows.join("\n"));
    const b = csvTable("No Struk,Total\n" + rows.map((x, i) => (i === 11999 ? "S11999,1" : x)).join("\n"));
    const r = await run(a, b);
    expect(r.summary).toMatchObject({ totalA: 12000, totalB: 12000, cocok: 11999, berbeda: 1 });
  });
});

describe("ekspor", () => {
  it("17. ekspor memuat SELURUH hasil (bukan halaman pertama), ringkasan, dan karakter khusus ter-escape", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => `S${i},"nama, ""x""",${i}`);
    const a = csvTable("No Struk,Nama,Total\n" + rows.join("\n"));
    const b = csvTable("No Struk,Nama,Total\n" + rows.slice(0, 250).join("\n") + "\n=HYPERLINK(1),y,5");
    const r = await run(a, b);
    const data = buildExport(r, a, b, { a: "a.csv", b: "b.csv" });
    expect(data.rows).toHaveLength(r.records.length);
    expect(data.rows.length).toBe(300 + 1);
    const csv = toCsv(data);
    expect(csv.startsWith("\ufeff")).toBe(true);
    expect(csv).toContain('"RINGKASAN HASIL"');
    expect(csv).toContain('"Total transaksi File A","300"');
    expect(csv).toContain("HANYA DI FILE A");
    expect(csv).toContain("'=HYPERLINK(1)"); // formula injection dinetralkan
    expect(data.rows.filter((row) => row[0] === "HANYA DI FILE A")).toHaveLength(50);
  });
  it("detail pemasangan duplikat ikut diekspor", async () => {
    const ta = csvTable(A + "\nS2,2026-08-01,20000"), tb = csvTable(A);
    const r = await run(ta, tb);
    const data = buildExport(r, ta, tb, { a: "a", b: "b" });
    expect(data.pairRows.length).toBeGreaterThanOrEqual(2);
    expect(toCsv(data)).toContain("DETAIL PEMASANGAN");
  });
});

describe("16. hasil kedaluwarsa saat file/konfigurasi berubah", () => {
  it("signature berubah bila versi tabel (file diganti/sheet/header/delimiter) atau konfigurasi berubah", async () => {
    const { inputSignature } = await import("./compareFilesEngine");
    const ta = csvTable(A), tb = csvTable(A);
    const c = autoDetectConfig(ta, tb);
    const base = inputSignature(1, 1, c);
    expect(inputSignature(1, 1, { ...c })).toBe(base);
    expect(inputSignature(2, 1, c)).not.toBe(base); // File A diganti
    expect(inputSignature(1, 3, c)).not.toBe(base); // File B diganti
    expect(inputSignature(1, 1, { ...c, tolerance: 5 })).not.toBe(base); // konfigurasi diubah
    expect(inputSignature(1, 1, null)).not.toBe(base);
  });
});
