import { describe, expect, it } from "vitest";
import {
  FAMILY_MART_ALL,
  FAMILY_MART_ERRORS,
  buildFamilyMartRows,
  extractFamilyMartPrefixes,
  extractFamilyMartRecords,
  familyMartPrefixOf,
  filterFamilyMartRows,
  formatFamilyMartDate,
  formatFamilyMartRupiah,
  parseFamilyMartAmount,
  splitFamilyMartNoStruk,
  summarizeFamilyMartRows,
} from "./familyMartParser";

// Struktur uji sintetis (bukan data transaksi asli).
const rec = (no_struk: unknown, extra: Record<string, unknown> = {}) => ({ id_agent: "agent_x", no_struk, date_trans: "2026-01-05 10:00:00", nama_usaha: "Usaha X", total: 1000, ...extra });

describe("extractFamilyMartRecords", () => {
  it("menerima array langsung", () => {
    const result = extractFamilyMartRecords(JSON.stringify([rec("1-1"), rec("2-2")]));
    expect(result.ok && result.records.length).toBe(2);
  });
  it("menerima object dengan data[] dan tidak memakai count", () => {
    const result = extractFamilyMartRecords(JSON.stringify({ status: "ok", count: 99, data: [rec("1-1")] }));
    expect(result.ok && result.records.length).toBe(1);
  });
  it("input kosong", () => {
    expect(extractFamilyMartRecords("   ")).toEqual({ ok: false, error: FAMILY_MART_ERRORS.empty });
  });
  it("JSON tidak valid", () => {
    const result = extractFamilyMartRecords("{bad");
    expect(!result.ok && result.error.startsWith("Gagal membaca JSON:")).toBe(true);
  });
  it("struktur tidak dikenali (object tanpa data array, null, angka)", () => {
    for (const text of ['{"data":"x"}', '{"a":1}', "null", "5"]) {
      expect(extractFamilyMartRecords(text)).toEqual({ ok: false, error: FAMILY_MART_ERRORS.format });
    }
  });
  it("array kosong", () => {
    expect(extractFamilyMartRecords("[]")).toEqual({ ok: false, error: FAMILY_MART_ERRORS.noData });
    expect(extractFamilyMartRecords('{"data":[]}')).toEqual({ ok: false, error: FAMILY_MART_ERRORS.noData });
  });
});

describe("prefix & filter", () => {
  const records = [rec("2134-111"), rec("5581-222"), rec("2134-333"), rec("9-1-2"), rec(null), rec(12345), rec(undefined), null, "teks", rec("")];
  const rows = buildFamilyMartRows(records);

  it("semua elemen dihitung termasuk yang tidak valid", () => {
    expect(rows).toHaveLength(10);
  });
  it("prefix = teks sebelum '-' pertama, unik dan terurut", () => {
    expect(extractFamilyMartPrefixes(rows)).toEqual(["2134", "5581", "9"]);
    expect(familyMartPrefixOf("9-1-2")).toBe("9");
    expect(familyMartPrefixOf(12345)).toBeNull();
  });
  it("Semua Kode menampilkan seluruh baris", () => {
    expect(filterFamilyMartRows(rows, FAMILY_MART_ALL)).toHaveLength(10);
  });
  it("filter prefix hanya baris yang cocok dan tidak error pada record tidak valid", () => {
    expect(filterFamilyMartRows(rows, "2134").map((r) => r.noStruk)).toEqual(["2134-111", "2134-333"]);
    expect(filterFamilyMartRows(rows, "9")).toHaveLength(1);
    expect(filterFamilyMartRows(rows, "nope")).toHaveLength(0);
  });
  it("data asli tidak dimodifikasi", () => {
    const source = [rec("2134-1", { extra: { a: 1 } })];
    const snapshot = JSON.stringify(source);
    const built = buildFamilyMartRows(source);
    filterFamilyMartRows(built, "2134");
    expect(JSON.stringify(source)).toBe(snapshot);
    expect(built[0].raw).toBe(source[0]);
  });
  it("split no_struk untuk penekanan prefix", () => {
    expect(splitFamilyMartNoStruk("2134-19273879")).toEqual({ prefix: "2134", rest: "19273879" });
    expect(splitFamilyMartNoStruk("9-1-2")).toEqual({ prefix: "9", rest: "1-2" });
    expect(splitFamilyMartNoStruk("tanpa")).toBeNull();
    expect(splitFamilyMartNoStruk(5)).toBeNull();
  });
});

describe("formatter", () => {
  it("Rupiah", () => {
    expect(formatFamilyMartRupiah(null)).toBe("-");
    expect(formatFamilyMartRupiah(undefined)).toBe("-");
    expect(formatFamilyMartRupiah(32000).replace(/\s/g, " ")).toBe("Rp 32.000");
    expect(formatFamilyMartRupiah("32000").replace(/\s/g, " ")).toBe("Rp 32.000");
    expect(formatFamilyMartRupiah("abc")).toBe("abc");
  });
  it("Tanggal", () => {
    expect(formatFamilyMartDate(null)).toBe("-");
    expect(formatFamilyMartDate("bukan tanggal")).toBe("bukan tanggal");
    expect(formatFamilyMartDate("2026-09-30 10:15:00")).toMatch(/2026/);
  });
});

describe("summarizeFamilyMartRows", () => {
  // Struktur uji sintetis terisolasi (bukan data transaksi asli, tidak dipakai aplikasi).
  const records = [
    rec("2134-1", { total: 1000, tax: 100 }),
    rec("2134-2", { total: "2000", tax: "200" }),
    rec("2134-2", { total: 500, tax: 50 }), // no_struk duplikat tetap dihitung sebagai transaksi
    rec("21340-1", { total: 7000, tax: 700 }), // prefix 21340 tidak boleh masuk ke 2134
    rec("5581-1", { total: 300 }), // tanpa tax
    rec(null, { total: "abc", tax: null }),
    null,
  ];
  const rows = buildFamilyMartRows(records);

  it("mengikuti filter prefix dengan kecocokan tepat", () => {
    const s = summarizeFamilyMartRows(filterFamilyMartRows(rows, "2134"));
    expect(s.transactionCount).toBe(3);
    expect(s.uniqueReceiptCount).toBe(2);
    expect(s.total).toEqual({ validCount: 3, missingCount: 0, sum: 3500 });
    expect(s.tax).toEqual({ validCount: 3, missingCount: 0, sum: 350 });
  });
  it("Semua Kode menghitung seluruh record dan menandai nilai tidak valid tanpa menganggapnya 0", () => {
    const s = summarizeFamilyMartRows(filterFamilyMartRows(rows, FAMILY_MART_ALL));
    expect(s.transactionCount).toBe(7);
    expect(s.uniqueReceiptCount).toBe(4);
    expect(s.total).toEqual({ validCount: 5, missingCount: 2, sum: 10800 });
    expect(s.tax).toEqual({ validCount: 4, missingCount: 3, sum: 1050 });
  });
  it("tax tidak tersedia pada sumber -> tidak ada nilai valid, tidak diturunkan dari total", () => {
    const noTax = buildFamilyMartRows([rec("1-1", { total: 1100 }), rec("1-2", { total: 2200 })]);
    const s = summarizeFamilyMartRows(noTax);
    expect(s.tax).toEqual({ validCount: 0, missingCount: 2, sum: 0 });
    expect(s.total.sum).toBe(3300);
  });
  it("hasil filter kosong", () => {
    const s = summarizeFamilyMartRows(filterFamilyMartRows(rows, "nope"));
    expect(s).toEqual({ transactionCount: 0, uniqueReceiptCount: 0, total: { validCount: 0, missingCount: 0, sum: 0 }, tax: { validCount: 0, missingCount: 0, sum: 0 } });
  });
  it("tidak memutasi data sumber", () => {
    const source = [rec("2134-1", { total: 10, tax: 1 })];
    const snapshot = JSON.stringify(source);
    summarizeFamilyMartRows(buildFamilyMartRows(source));
    expect(JSON.stringify(source)).toBe(snapshot);
  });
  it("parseFamilyMartAmount menolak nilai nonnumerik", () => {
    expect(parseFamilyMartAmount(5)).toBe(5);
    expect(parseFamilyMartAmount(" 12 ")).toBe(12);
    for (const v of [null, undefined, "", "  ", "abc", NaN, Infinity, {}, [], true]) expect(parseFamilyMartAmount(v)).toBeNull();
  });
});

// Data FAMILY MART asli (id_agent familymart_sda): banyak outlet dalam satu file, dibedakan lewat prefix no_struk.
describe("FAMILY MART: sampel asli multi-outlet", () => {
  const real = [
    { id: 482153, id_agent: "familymart_sda", no_struk: "2154-9126101700190578", date_trans: "2026-10-18 00:00:00", subtotal: 18180, service_charge: null, discount: null, dpp: 18180, tax: 1818, total: 20000, nama_usaha: "Family Mart Sidoarjo", void: 0, id_outlet: "", outlet_name: "" },
    { id: 482152, id_agent: "familymart_sda", no_struk: "2134-9126101800190952", date_trans: "2026-10-18 00:00:00", subtotal: 84550, service_charge: null, discount: null, dpp: 84550, tax: 8455, total: 93000, nama_usaha: "Family Mart Sidoarjo", void: 0, id_outlet: "", outlet_name: "" },
    { id: 482151, id_agent: "familymart_sda", no_struk: "2154-9126101700190579", date_trans: "2026-10-18 00:00:00", subtotal: 10000, service_charge: null, discount: null, dpp: 10000, tax: 1000, total: 11000, nama_usaha: "Family Mart Sidoarjo", void: 0, id_outlet: "", outlet_name: "" },
  ];
  it("prefix no_struk menjadi kunci pemilihan outlet, dan ringkasan mengikuti filter", () => {
    const extracted = extractFamilyMartRecords(JSON.stringify({ status: "ok", count: 3, data: real }));
    if (!extracted.ok) throw new Error(extracted.error);
    const rows = buildFamilyMartRows(extracted.records);
    expect(extractFamilyMartPrefixes(rows)).toEqual(["2134", "2154"]);
    const p2154 = summarizeFamilyMartRows(filterFamilyMartRows(rows, "2154"));
    expect(p2154.transactionCount).toBe(2);
    expect(p2154.total.sum).toBe(31000);
    expect(p2154.tax.sum).toBe(2818);
    const p2134 = summarizeFamilyMartRows(filterFamilyMartRows(rows, "2134"));
    expect([p2134.transactionCount, p2134.total.sum, p2134.tax.sum]).toEqual([1, 93000, 8455]);
    const all = summarizeFamilyMartRows(filterFamilyMartRows(rows, "all"));
    expect([all.transactionCount, all.total.sum]).toEqual([3, 124000]);
  });
});
