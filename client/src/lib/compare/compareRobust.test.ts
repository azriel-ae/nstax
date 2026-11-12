import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { FileReadError, loadTable, openSource, sniffFormat } from "./compareTable";
import { autoDetectConfig, compareFiles, keyOverlapInfo, normalizeKey, suggestKeyFixes, type CompareConfig } from "./compareFilesEngine";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const csv = (rows: string[][]) => rows.map((r) => r.join(",")).join("\n");
const load = (text: string, name: string) => loadTable(openSource(enc(text), name));
const xlsxBuf = (rows: unknown[][], sheets?: Record<string, unknown[][]>) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Data");
  for (const [n, r] of Object.entries(sheets ?? {})) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(r), n);
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return out;
};
const run = async (a: ReturnType<typeof loadTable>, b: ReturnType<typeof loadTable>, patch: Partial<CompareConfig> = {}) => {
  const cfg = { ...autoDetectConfig(a, b), ...patch };
  return compareFiles(a, b, cfg);
};
const H = ["Tanggal", "No Struk", "Total", "Tax"];

describe("Compare 2 File — akurasi identitas", () => {
  it("1. urutan baris berbeda tetap cocok", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ["2026-10-01", `S${100 + i}`, String(1000 + i), "100"]);
    const r = await run(load(csv([H, ...rows]), "a.csv"), load(csv([H, ...[...rows].reverse()]), "b.csv"));
    expect(r.summary.cocok).toBe(20);
    expect(r.summary.onlyA + r.summary.onlyB).toBe(0);
  });

  it("2-5. hanya di A, hanya di B, nominal beda, tax beda", async () => {
    const a = load(csv([H, ["2026-10-01", "S1", "1000", "100"], ["2026-10-01", "S2", "2000", "200"], ["2026-10-01", "S3", "3000", "300"], ["2026-10-01", "S4", "4000", "400"]]), "a.csv");
    const b = load(csv([H, ["2026-10-01", "S1", "1000", "100"], ["2026-10-01", "S2", "2500", "200"], ["2026-10-01", "S3", "3000", "350"], ["2026-10-01", "S9", "9000", "900"]]), "b.csv");
    const r = await run(a, b);
    expect(r.summary).toMatchObject({ cocok: 1, onlyA: 1, onlyB: 1, keysBoth: 3 });
    expect(r.records.find((x) => x.key === "S4")!.status).toBe("HANYA DI FILE A");
    expect(r.records.find((x) => x.key === "S9")!.status).toBe("HANYA DI FILE B");
    const s2 = r.records.find((x) => x.key === "S2")!;
    expect(s2.amountDiff).toBe(true); expect(s2.delta).toBe(500);
    const s3 = r.records.find((x) => x.key === "S3")!;
    expect(s3.taxDiff).toBe(true); expect(s3.kinds.tax!.delta).toBe(50);
    expect(r.summary.taxDiff).toBe(1);
  });

  it("6. duplikat tidak dianggap cocok & tidak menimpa", async () => {
    const a = load(csv([H, ["d", "S1", "100", "10"], ["d", "S1", "100", "10"], ["d", "S2", "200", "20"]]), "a.csv");
    const b = load(csv([H, ["d", "S1", "100", "10"], ["d", "S2", "200", "20"]]), "b.csv");
    const r = await run(a, b);
    const s1 = r.records.find((x) => x.key === "S1")!;
    expect(s1.status).toBe("DUPLIKAT"); expect(s1.idxA).toHaveLength(2);
    expect(r.summary.duplikat).toBe(1); expect(r.summary.cocok).toBe(1);
  });

  it("7. identitas kosong → PERLU DITINJAU, bukan hilang/cocok", async () => {
    const a = load(csv([H, ["d", "S1", "100", "10"], ["d", "", "200", "20"]]), "a.csv");
    const b = load(csv([H, ["d", "S1", "100", "10"]]), "b.csv");
    const r = await run(a, b);
    expect(r.summary.review).toBe(1); expect(r.summary.emptyKeyA).toBe(1);
  });

  it("8. nama kolom berbeda, makna sama (alias)", async () => {
    const a = load(csv([["Date", "Bill No", "Amount", "PPN"], ["d", "X1", "100", "10"]]), "a.csv");
    const b = load(csv([["Tanggal", "Nomor Struk", "Total", "Pajak"], ["d", "X1", "100", "10"]]), "b.csv");
    const r = await run(a, b);
    expect(r.summary.cocok).toBe(1);
  });

  it("9. nol di depan dipertahankan; tanda hubung disamakan (standar)", async () => {
    expect(normalizeKey("000123")).toBe("000123");
    expect(normalizeKey("INV-001")).toBe("inv001");
    expect(normalizeKey("INV-001", true, false, "strict")).toBe("inv-001");
    const a = load(csv([H, ["d", "000123", "100", "10"], ["d", "123", "200", "20"]]), "a.csv");
    const b = load(csv([H, ["d", "000123", "100", "10"], ["d", "123", "200", "20"]]), "b.csv");
    const r = await run(a, b);
    expect(r.summary.cocok).toBe(2); // 000123 dan 123 tetap dua identitas berbeda
    expect(r.summary.uniqueKeysA).toBe(2);
  });

  it("karakter tak terlihat (zero-width / NBSP / BOM) dibuang — akar masalah 0 cocok", async () => {
    expect(normalizeKey("\u200bS-1\u00a0", true, false, "strict")).toBe("s-1");
    expect(normalizeKey("\ufeffS-1", true, false, "strict")).toBe("s-1");
    expect(normalizeKey("\u200bS-1\u00a0")).toBe("s1");
    const a = load(csv([H, ["d", "S-1", "100", "10"], ["d", "S-2", "200", "20"]]), "a.csv");
    const b = load(csv([H, ["d", "\u200bS-1\u00a0", "100", "10"], ["d", "S-2\u200b", "200", "20"]]), "b.csv");
    const r = await run(a, b);
    expect(r.summary.cocok).toBe(2);
    expect(r.summary.onlyA + r.summary.onlyB).toBe(0);
  });

  it("format identitas beda (INV-1001 vs 1001): TIDAK dicocokkan (bukan sekadar beda penulisan); ada peringatan; tidak ada saran 'hanya digit'", async () => {
    const rowsA = Array.from({ length: 30 }, (_, i) => ["d", String(1001 + i), String(1000 + i), "10"]);
    const rowsB = Array.from({ length: 30 }, (_, i) => ["d", `INV-${1001 + i}`, String(1000 + i), "10"]);
    const a = load(csv([H, ...rowsA]), "a.csv"), b = load(csv([H, ...rowsB]), "b.csv");
    const strict = await run(a, b);
    expect(strict.summary.cocok).toBe(0);
    expect(strict.notes.some((n) => n.includes("Tidak ada satu pun identitas yang sama"))).toBe(true);
    const cfg = autoDetectConfig(a, b);
    const sug = suggestKeyFixes(a, b, { a: cfg.a.key, b: cfg.b.key });
    expect(sug).toHaveLength(0); // tidak ada aturan longgar (hanya-digit / digit terakhir) yang ditawarkan
    expect(strict.summary).toMatchObject({ onlyA: 30, onlyB: 30 });
    expect(strict.review).toHaveLength(60); // seluruh baris tanpa pasangan tetap tercatat di Perlu Ditinjau
  });

  it("notasi ilmiah Excel pada nomor struk diberi peringatan", async () => {
    const a = load(csv([["No Struk", "Total"], ["2.0261E+12", "1"], ["2.0261E+12", "2"]]), "a.csv");
    const b = load(csv([["No Struk", "Total"], ["2026100100001", "1"]]), "b.csv");
    const r = await run(a, b);
    expect(r.notes.some((n) => n.includes("notasi ilmiah"))).toBe(true);
  });

  it("14. nominal berformat lokal (1.234,50 vs 1234.5)", async () => {
    const a = load(csv([["No Struk", "Total"], ['S1', '"1.234,50"'], ['S2', '"10.000"']]), "a.csv");
    const b = load(csv([["No Struk", "Total"], ["S1", "1234.5"], ["S2", "10000"]]), "b.csv");
    const r = await run(a, b);
    expect(r.summary.cocok).toBe(2);
  });

  it("15. header tambahan di atas & footer TOTAL tidak dihitung sebagai transaksi", async () => {
    const a = load(["LAPORAN PENJUALAN", "Periode: Oktober 2026", "", "No Struk,Total,Tax", "S1,100,10", "S2,200,20", "TOTAL,300,30"].join("\n"), "a.csv");
    const b = load(["No Struk,Total,Tax", "S1,100,10", "S2,200,20", "Grand Total,300,30"].join("\n"), "b.csv");
    const r = await run(a, b);
    expect(r.summary.totalA).toBe(2); expect(r.summary.totalB).toBe(2);
    expect(r.summary.cocok).toBe(2);
  });
});

describe("Compare 2 File — format file", () => {
  const rows = [["Tanggal", "No Struk", "Total", "Tax"], ["2026-10-01", "S1", 1000, 100], ["2026-10-01", "S2", 2000, 200], ["2026-10-01", "S3", 3000, 300]];
  const csvText = csv(rows.map((r) => r.map(String)));

  it("10. CSV vs XLSX", async () => {
    const a = load(csvText, "a.csv");
    const b = loadTable(openSource(xlsxBuf(rows), "b.xlsx"));
    expect((await run(a, b)).summary.cocok).toBe(3);
  });

  it("11. XLSX vs JSON (array objek, nama kolom beda, objek bersarang)", async () => {
    const a = loadTable(openSource(xlsxBuf(rows), "a.xlsx"));
    const json = JSON.stringify({ status: "ok", data: [
      { date: "2026-10-01", bill_no: "S1", amount: 1000, tax: 100 },
      { date: "2026-10-01", bill_no: "S2", amount: 2000, tax: 250 },
      { date: "2026-10-01", bill_no: "S9", amount: 9000, tax: 900 },
    ] });
    const b = load(json, "b.json");
    const r = await run(a, b);
    expect(r.summary).toMatchObject({ cocok: 1, onlyA: 1, onlyB: 1 });
    expect(r.records.find((x) => x.key === "S2")!.taxDiff).toBe(true);
    const nested = load(JSON.stringify([{ trx: { no: "S1" }, total: 5 }]), "n.json");
    expect(nested.headers).toContain("trx.no");
  });

  it("TXT berpemisah pipe / tab dan CSV titik koma", () => {
    expect(load("No Struk|Total\nS1|10\nS2|20", "a.txt").headers).toEqual(["No Struk", "Total"]);
    expect(load("No Struk\tTotal\nS1\t10\nS2\t20", "a.txt").delimiter).toBe("\t");
    expect(load("No Struk;Total\nS1;10\nS2;20", "a.csv").delimiter).toBe(";");
  });

  it("Excel dengan banyak sheet: pilih sheet", () => {
    const src = openSource(xlsxBuf(rows, { Lain: [["No Struk", "Total"], ["Z1", 1]] }), "m.xlsx");
    expect(src.sheets).toEqual(["Data", "Lain"]);
    expect(loadTable(src, { sheet: "Lain" }).rows[0][0]).toBe("Z1");
  });

  it("13. file kosong, JSON salah struktur, JSON rusak", () => {
    expect(() => openSource(new ArrayBuffer(0), "x.csv")).toThrow(FileReadError);
    expect(() => openSource(enc("   \n  "), "x.csv")).toThrow(FileReadError);
    expect(() => openSource(enc('{"a":1,"b":"x"}'), "x.json")).toThrow(/tidak dikenali/);
    expect(() => openSource(enc("{rusak"), "x.json")).toThrow(/bukan JSON/);
    expect(() => openSource(enc("[1,2,3]"), "x.json")).toThrow(FileReadError);
  });

  it("deteksi dari isi, bukan ekstensi", () => {
    expect(sniffFormat(xlsxBuf(rows))).toBe("xlsx");
    expect(sniffFormat(enc('[{"a":1}]'))).toBe("json");
    expect(sniffFormat(enc("a,b\n1,2"))).toBe("text");
    expect(sniffFormat(enc("%PDF-1.4 ..."))).toBe("pdf");
    expect(() => openSource(enc("a,b\n1,2"), "palsu.xlsx")).toThrow(/bukan format Excel/);
    expect(openSource(xlsxBuf(rows), "salah.csv").format).toBe("xlsx"); // isi Excel, ekstensi CSV → dibaca sebagai Excel
    expect(openSource(enc('[{"No Struk":"S1"}]'), "data.txt").format).toBe("json");
    expect(() => openSource(new Uint8Array([0, 1, 2, 3, 0, 0, 9, 0]).buffer as ArrayBuffer, "x.bin")).toThrow(FileReadError);
  });
});

describe("Compare 2 File — skala & indeks", () => {
  it("12. 6.000 vs 6.050 transaksi (urutan acak, sebagian hanya di salah satu) cepat & akurat", async () => {
    const N = 6000;
    const ids = Array.from({ length: N + 50 }, (_, i) => `TRX-${String(i).padStart(6, "0")}`);
    const rowsA = ids.slice(0, N).map((id, i) => ["2026-10-01", id, String(1000 + i), String(100 + (i % 7))]);
    const rowsB = ids.slice(50).map((id, i) => ["2026-10-01", id, String(1000 + i + 50), String(100 + ((i + 50) % 7))]).reverse();
    const t0 = Date.now();
    const r = await run(load(csv([H, ...rowsA]), "a.csv"), load(csv([H, ...rowsB]), "b.csv"));
    expect(r.summary.onlyA).toBe(50); expect(r.summary.onlyB).toBe(50);
    expect(r.summary.cocok).toBe(N - 50);
    expect(r.summary.keysBoth).toBe(N - 50);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("indeks identitas: kecocokan tidak bergantung urutan", () => {
    const a = load(csv([["No Struk", "Total"], ["A", "1"], ["B", "2"]]), "a.csv"), b = load(csv([["No Struk", "Total"], ["B", "2"], ["A", "1"]]), "b.csv");
    expect(keyOverlapInfo(a, b, 0, 0).matched).toBe(2);
  });
});

import { autoIdentity } from "./identityDetect";
describe("Deteksi identitas otomatis (semua kolom)", () => {
  const T = (rows: string[][]) => loadTable(openSource(enc(rows.map((r) => r.join(",")).join("\n")), "x.csv"));
  const N = 400;
  it("menemukan kolom kunci yang namanya tidak dikenal & posisinya berbeda (nilai identik utuh)", async () => {
    const a = T([["Tanggal", "Kasir", "Kode Nota", "Total"], ...Array.from({ length: N }, (_, i) => ["2026-10-01", "k1", `OUT1-${100000 + i}`, String(5000 + i)])]);
    const b = T([["Waktu", "Ref", "Total Bayar", "Outlet"], ...Array.from({ length: N }, (_, i) => ["2026-10-01", `OUT1${100000 + i}`, String(5000 + i), "OUT1"])]);
    const id = autoIdentity(a, b);
    expect(id.kind).toBe("column");
    expect(id.matched).toBe(N);
    expect(id.rule).toBe("alnum");
  });
  it("nomor yang hanya sama di bagian akhir/awalan TIDAK dicocokkan sebagai kolom identitas", () => {
    const a = T([["No Struk", "Total"], ...Array.from({ length: N }, (_, i) => [`A-${String(i).padStart(7, "0")}`, String(1000 + i)])]);
    const b = T([["No Struk", "Total"], ...Array.from({ length: N }, (_, i) => [`OUTLET9${String(i).padStart(7, "0")}`, String(1000 + i)])]);
    const id = autoIdentity(a, b);
    expect(id.matched).toBe(0);
    expect(id.kind).not.toBe("column");
  });
  it("tanpa nomor struk sama → identitas alternatif tanggal+jam+total, dan perbandingan berjalan", async () => {
    const mk = (pref: string, shift = 0) => T([["Tanggal", "Bill", "Total", "Tax"], ...Array.from({ length: N }, (_, i) => [`2026-10-01 ${String(8 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00`, `${pref}${pref === "X" ? (i * 7919) % 100003 : (i * 104729 + 55555) % 1000193}`, String(10000 + (i + shift) * 13), "100"])]);
    const a = mk("X"), b = mk("Q");
    const id = autoIdentity(a, b);
    expect(id.kind).toBe("composite");
    const cfg = { ...autoDetectConfig(id.tableA!, id.tableB!), };
    cfg.a = { ...cfg.a, key: id.a, receipt: id.a }; cfg.b = { ...cfg.b, key: id.b, receipt: id.b };
    const r = await compareFiles(id.tableA!, id.tableB!, cfg);
    expect(r.summary.cocok).toBe(N);
  });
  it("kolom total tidak pernah dijadikan identitas", () => {
    const a = T([["Tanggal", "Total"], ...Array.from({ length: N }, (_, i) => ["d", String(1000 + i)])]);
    const b = T([["Tanggal", "Total"], ...Array.from({ length: N }, (_, i) => ["d", String(1000 + i)])]);
    expect(autoIdentity(a, b).kind).not.toBe("column");
  });
});

describe("Mode identitas saja (compareValues=false)", () => {
  it("nominal/tax berbeda tidak memunculkan status beda; total per file tetap dihitung; ekspor tanpa kolom selisih", async () => {
    const a = load(csv([H, ["d", "S1", "1000", "100"], ["d", "S2", "2000", "200"], ["d", "S4", "4000", "400"]]), "a.csv");
    const b = load(csv([H, ["d", "S1", "1500", "150"], ["d", "S2", "2000", "200"], ["d", "S9", "9000", "900"]]), "b.csv");
    const r = await run(a, b, { compareValues: false });
    expect(r.summary).toMatchObject({ cocok: 2, berbeda: 0, onlyA: 1, onlyB: 1, amountDiff: 0, taxDiff: 0 });
    expect(r.totals.find((t) => t.kind === "total")!.sumA).toBe(7000);
    const { buildExport } = await import("./compareFilesEngine");
    const ex = buildExport(r, a, b, { a: "a", b: "b" });
    expect(ex.header.some((h) => /Tax|Selisih/.test(h))).toBe(false);
    expect(ex.summary.some(([k]) => /NOMINAL BERBEDA|transaksi dengan selisih/i.test(String(k)))).toBe(false);
  });
});
