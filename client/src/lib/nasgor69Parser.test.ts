import { describe, expect, it } from "vitest";
import { extractNasgor69Records, formatNasgor69Rupiah, nasgor69ToCsv, paginateNasgor69, parseNasgor69, summarizeNasgor69 } from "./nasgor69Parser";

const sample = [
  {
    id: 387508,
    id_agent: "hangry_sda",
    no_struk: "H103260919QIRW",
    date_trans: "2026-09-20 00:42:08",
    subtotal: 15100,
    service_charge: null,
    discount: null,
    dpp: 15100,
    tax: 1510,
    total: 16605,
    log_time: "2026-09-21 00:30:18",
    keterangan: null,
    pos_tipe: null,
    nama_usaha: "Hangry Sidoarjo",
    id_server: "S04",
    void: 0,
    id_outlet: "H103",
    outlet_name: "",
  },
  {
    id: 387507,
    id_agent: "hangry_sda",
    no_struk: "H103260919LFKJ",
    date_trans: "2026-09-20 00:38:37",
    subtotal: 25710,
    service_charge: null,
    discount: null,
    dpp: 25710,
    tax: 2571,
    total: 28280,
    log_time: "2026-09-21 00:30:18",
    keterangan: null,
    pos_tipe: null,
    nama_usaha: "Hangry Sidoarjo",
    id_server: "S04",
    void: 0,
    id_outlet: "H103",
    outlet_name: "",
  },
];

const wrap = (data: unknown[], count: unknown = data.length, status: unknown = "ok") => JSON.stringify({ status, count, data });

// Membuat N transaksi sintetis dengan tax/total yang sengaja TIDAK mengikuti rumus
// (total != subtotal + tax) untuk memastikan parser tidak menghitung ulang.
function makeTransactions(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    ...sample[i % 2],
    id: 1_000_000 + i,
    no_struk: `H103260919${String(i).padStart(6, "0")}`,
    subtotal: 10_000 + (i % 7) * 100,
    dpp: 10_000 + (i % 7) * 100,
    tax: 1_000 + (i % 7) * 10,
    total: 11_111 + (i % 7) * 111,
    service_charge: i % 5 === 0 ? null : 500,
    discount: i % 3 === 0 ? null : 250,
  }));
}

describe("parseNasgor69", () => {
  it("reads NASGOR 69 fields directly from the JSON array", () => {
    const result = parseNasgor69(JSON.stringify(sample));
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(2);
    expect(result.validRows).toBe(2);
    expect(result.invalidRows).toBe(0);
    expect(result.rows[0]).toMatchObject({ noStruk: "H103260919QIRW", idAgent: "hangry_sda", namaUsaha: "Hangry Sidoarjo", idOutlet: "H103", status: "Valid" });
    expect(result.rows[1]).toMatchObject({ noStruk: "H103260919LFKJ" });
  });

  it("matches the totals from the brief without recomputing tax/total", () => {
    const result = parseNasgor69(JSON.stringify(sample));
    const summary = summarizeNasgor69(result.rows);
    expect(summary.transactionCount).toBe(2);
    expect(summary.subtotal).toBe(40810);
    expect(summary.dpp).toBe(40810);
    expect(summary.tax).toBe(4081);
    expect(summary.total).toBe(44885);
    expect(formatNasgor69Rupiah(summary.total)).toBe("Rp 44.885");
  });

  it("rejects non-array JSON, empty arrays, and mismatched formats", () => {
    expect(parseNasgor69("").ok).toBe(false);
    expect(parseNasgor69(JSON.stringify({ foo: "bar" })).error).toBe("Format NASGOR 69 tidak valid: field data tidak ditemukan atau bukan array.");
    expect(parseNasgor69(JSON.stringify([])).error).toMatch(/kosong/);
    expect(parseNasgor69(JSON.stringify([{ billing_id: "x", pajak: 1 }])).error).toMatch(/tidak sesuai/);
  });

  it("stays safe with null optional fields and never crashes", () => {
    const result = parseNasgor69(JSON.stringify([{ ...sample[0], service_charge: null, discount: null, keterangan: null, pos_tipe: null, outlet_name: "" }]));
    expect(result.ok).toBe(true);
    expect(result.rows[0].status).toBe("Valid");
    expect(result.rows[0].serviceCharge).toBeNull();
    expect(result.rows[0].discount).toBeNull();
  });

  it("marks rows Invalid when a core field is missing, without dropping them", () => {
    const result = parseNasgor69(JSON.stringify([{ ...sample[0], total: null }]));
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].status).toBe("Invalid");
    expect(result.invalidRows).toBe(1);
    // Total transaksi = seluruh baris di data; null dihitung 0 pada agregasi.
    const summary = summarizeNasgor69(result.rows);
    expect(summary.transactionCount).toBe(1);
    expect(summary.total).toBe(0);
    expect(summary.subtotal).toBe(15100);
  });

  it("keeps void as provided without excluding voided rows by default", () => {
    const result = parseNasgor69(JSON.stringify([{ ...sample[0], void: 1 }, sample[1]]));
    expect(result.voidRows).toBe(1);
    expect(summarizeNasgor69(result.rows).transactionCount).toBe(2);
  });

  it("exports a CSV with a header row and one line per transaction", () => {
    const result = parseNasgor69(JSON.stringify(sample));
    const csv = nasgor69ToCsv(result.rows);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/No Struk/);
  });
});

describe("parseNasgor69 — root { status, count, data }", () => {
  it("reads the sample from the brief: 9 transactions from parsed.data", () => {
    const nine = makeTransactions(9);
    const result = parseNasgor69(wrap(nine));
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(9);
    expect(result.rows).toHaveLength(9);
    expect(result.declaredCount).toBe(9);
  });

  it("reads the two-row sample wrapped in the API root and matches the known totals", () => {
    const result = parseNasgor69(wrap(sample));
    expect(result.ok).toBe(true);
    expect(result.rows.map((r) => r.noStruk)).toEqual(["H103260919QIRW", "H103260919LFKJ"]);
    const summary = summarizeNasgor69(result.rows);
    expect(summary).toEqual({ transactionCount: 2, subtotal: 40810, dpp: 40810, tax: 4081, total: 44885 });
  });

  it("does not use count as the dataset: count < data.length keeps every row", () => {
    const result = parseNasgor69(wrap(makeTransactions(150), 100));
    expect(result.totalRows).toBe(150);
    expect(result.rows).toHaveLength(150);
    expect(result.declaredCount).toBe(100);
    expect(summarizeNasgor69(result.rows).transactionCount).toBe(150);
  });

  it("does not use count as the dataset: count > data.length does not invent rows", () => {
    const result = parseNasgor69(wrap(makeTransactions(5), 1000));
    expect(result.totalRows).toBe(5);
    expect(summarizeNasgor69(result.rows).transactionCount).toBe(5);
  });

  it("works when count is missing or not a number", () => {
    expect(parseNasgor69(JSON.stringify({ status: "ok", data: sample })).totalRows).toBe(2);
    const weird = parseNasgor69(wrap(sample, "abc"));
    expect(weird.ok).toBe(true);
    expect(weird.declaredCount).toBeNull();
    expect(weird.totalRows).toBe(2);
  });

  it("shows the exact error when data is missing or not an array", () => {
    const message = "Format NASGOR 69 tidak valid: field data tidak ditemukan atau bukan array.";
    expect(parseNasgor69(JSON.stringify({ status: "ok", count: 0 })).error).toBe(message);
    expect(parseNasgor69(JSON.stringify({ status: "ok", count: 1, data: { a: 1 } })).error).toBe(message);
    expect(parseNasgor69(JSON.stringify({ status: "ok", count: 1, data: "x" })).error).toBe(message);
    expect(parseNasgor69(JSON.stringify({ status: "ok", count: 1, data: null })).error).toBe(message);
  });

  it("rejects non-object roots and a non-ok status", () => {
    expect(parseNasgor69("123").error).toBe("Format NASGOR 69 tidak valid");
    expect(parseNasgor69("null").error).toBe("Format NASGOR 69 tidak valid");
    expect(parseNasgor69(wrap(sample, 2, "error")).ok).toBe(false);
    expect(parseNasgor69(wrap(sample, 2, "OK")).ok).toBe(true);
  });

  it("still accepts a bare array of transactions (backward compatible)", () => {
    const result = parseNasgor69(JSON.stringify(sample));
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(2);
    expect(result.declaredCount).toBeNull();
  });

  it("treats an empty data array as an error instead of an empty dataset", () => {
    expect(parseNasgor69(wrap([])).ok).toBe(false);
  });

  it("keeps every field untouched on the row and in raw, and does not recompute tax/total", () => {
    const [first] = parseNasgor69(wrap(sample)).rows;
    expect(first).toMatchObject({ id: "387508", subtotal: 15100, dpp: 15100, tax: 1510, total: 16605, idServer: "S04", isVoid: false, logTime: "2026-09-21 00:30:18" });
    expect(first.total).not.toBe(first.subtotal + (first.tax ?? 0)); // 16605 != 16610
    expect(first.raw).toEqual(sample[0]);
    expect(Object.keys(first.raw)).toEqual(Object.keys(sample[0]));
  });

  it("treats null as 0 only in aggregation and keeps null on rows", () => {
    const rows = parseNasgor69(wrap([{ ...sample[0], service_charge: null, discount: null, keterangan: null, pos_tipe: null }])).rows;
    expect(rows[0].serviceCharge).toBeNull();
    expect(rows[0].discount).toBeNull();
    expect(rows[0].keterangan).toBeNull();
    expect(rows[0].posTipe).toBeNull();
    expect(summarizeNasgor69(rows).total).toBe(16605);
  });

  it("uses one code path for paste and upload (same input text => identical result)", () => {
    const text = wrap(makeTransactions(300));
    const paste = parseNasgor69(text);
    const upload = parseNasgor69(text);
    expect(upload).toEqual(paste);
    const extracted = extractNasgor69Records(text);
    expect(extracted.ok && extracted.records.length).toBe(300);
  });
});

describe.each([1000, 5000, 10000])("parseNasgor69 — large dataset (%i transactions)", (n) => {
  const data = makeTransactions(n);
  const text = wrap(data);

  it("reads every transaction, none lost, in order", () => {
    const result = parseNasgor69(text);
    expect(result.ok).toBe(true);
    expect(result.totalRows).toBe(n);
    expect(result.rows).toHaveLength(n);
    expect(result.validRows).toBe(n);
    expect(result.rows[0].noStruk).toBe(data[0].no_struk);
    expect(result.rows[n - 1].noStruk).toBe(data[n - 1].no_struk);
    expect(new Set(result.rows.map((r) => r.id)).size).toBe(n);
  });

  it("summary equals the sum over ALL rows and ignores count and pagination", () => {
    const expected = data.reduce((acc, r) => ({ subtotal: acc.subtotal + r.subtotal, dpp: acc.dpp + r.dpp, tax: acc.tax + r.tax, total: acc.total + r.total }), { subtotal: 0, dpp: 0, tax: 0, total: 0 });
    const withWrongCount = parseNasgor69(wrap(data, 10));
    const summary = summarizeNasgor69(withWrongCount.rows);
    expect(summary).toEqual({ transactionCount: n, ...expected });

    // Summary tidak berubah walau tampilan hanya satu halaman.
    const page = paginateNasgor69(withWrongCount.rows, 1, 10);
    expect(page.visible).toHaveLength(10);
    expect(summarizeNasgor69(withWrongCount.rows)).toEqual(summary);
    expect(summarizeNasgor69(page.visible).transactionCount).toBe(10);
  });

  it("exports CSV for every row", () => {
    const csv = nasgor69ToCsv(parseNasgor69(text).rows);
    expect(csv.split("\n")).toHaveLength(n + 1);
  });

  it("parses fast enough to stay responsive", () => {
    const started = performance.now();
    parseNasgor69(text);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe("paginateNasgor69", () => {
  const rows = Array.from({ length: 105 }, (_, i) => i);

  it("slices only for display and reports the range", () => {
    expect(paginateNasgor69(rows, 1, 50)).toMatchObject({ activePage: 1, totalPages: 3, startIndex: 0, endIndex: 50 });
    expect(paginateNasgor69(rows, 3, 50).visible).toEqual([100, 101, 102, 103, 104]);
    expect(paginateNasgor69(rows, 3, 50)).toMatchObject({ startIndex: 100, endIndex: 105 });
  });

  it("clamps out-of-range pages and handles empty input", () => {
    expect(paginateNasgor69(rows, 99, 10).activePage).toBe(11);
    expect(paginateNasgor69(rows, 0, 10).activePage).toBe(1);
    expect(paginateNasgor69([], 1, 25)).toMatchObject({ visible: [], activePage: 1, totalPages: 1, startIndex: 0, endIndex: 0 });
  });

  it("supports all page-size options: 10 / 25 / 50 / 100", () => {
    for (const size of [10, 25, 50, 100]) {
      expect(paginateNasgor69(rows, 1, size).visible).toHaveLength(Math.min(size, rows.length));
    }
  });
});
