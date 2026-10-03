import { describe, expect, it } from "vitest";
import { parseReceiptCsv } from "./receiptParser";
import { compareTables, detectKeys, normalizeKey, valuesEqual } from "./receiptCompareEngine";

const csv = (header: string, lines: string[]) => parseReceiptCsv([header, ...lines].join("\n")).table!;
const H = "no_struk,date_trans,subtotal,tax,total";
const run = async (a: ReturnType<typeof csv>, b: ReturnType<typeof csv>) => { const k = detectKeys(a, b); return compareTables(a, b, k.key1, k.key2); };
const status = (r: Awaited<ReturnType<typeof run>>, key: string) => r.records.find((x) => x.key === key)?.status;

describe("BANDINGKAN 2 FILE — engine", () => {
  it("TEST 1: STR003 hanya di File 1", async () => {
    const r = await run(csv(H, ["STR001,2026-09-20,10000,1000,11000", "STR002,2026-09-20,1,0,1", "STR003,2026-09-20,2,0,2"]), csv(H, ["STR001,2026-09-20,10000,1000,11000", "STR002,2026-09-20,1,0,1"]));
    expect(status(r, "STR001")).toBe("SAMA"); expect(status(r, "STR002")).toBe("SAMA"); expect(status(r, "STR003")).toBe("HANYA DI FILE 1");
    expect(r.summary).toMatchObject({ total1: 3, total2: 2, same: 2, only1: 1, only2: 0 });
  });
  it("TEST 2: subtotal berbeda + detail", async () => {
    const r = await run(csv(H, ["STR001,2026-09-20,10000,1000,11000"]), csv(H, ["STR001,2026-09-20,12000,1000,11000"]));
    const rec = r.records[0];
    expect(rec.status).toBe("BERBEDA");
    expect(rec.diffs).toEqual([{ field: "subtotal", label: "subtotal", v1: "10000", v2: "12000" }]);
  });
  it("TEST 3: STR002 hanya di File 2", async () => {
    const r = await run(csv(H, ["STR001,2026-09-20,1,0,1"]), csv(H, ["STR001,2026-09-20,1,0,1", "STR002,2026-09-20,1,0,1"]));
    expect(status(r, "STR002")).toBe("HANYA DI FILE 2");
  });
  it("TEST 4: duplikat tidak dihapus diam-diam", async () => {
    const r = await run(csv(H, ["STR001,2026-09-20,1,0,1", "STR001,2026-09-20,1,0,1", "STR002,2026-09-20,1,0,1"]), csv(H, ["STR001,2026-09-20,1,0,1", "STR002,2026-09-20,1,0,1"]));
    const rec = r.records.find((x) => x.key === "STR001")!;
    expect(rec.status).toBe("DUPLIKAT"); expect(rec.idx1).toHaveLength(2);
    expect(r.summary).toMatchObject({ dupKeys1: 1, dupRows1: 1, dupKeys2: 0, total1: 3 });
  });
  it("TEST 5: urutan berbeda tetap MATCH berdasarkan key", async () => {
    const r = await run(csv(H, ["STR001,2026-09-20,1,0,1", "STR002,2026-09-20,2,0,2", "STR003,2026-09-20,3,0,3"]), csv(H, ["STR003,2026-09-20,3,0,3", "STR001,2026-09-20,1,0,1", "STR002,2026-09-20,2,0,2"]));
    expect(r.summary).toMatchObject({ same: 3, different: 0, only1: 0, only2: 0 });
  });
  it("key beda nama (no_struk vs no_order) terdeteksi otomatis & key dinormalisasi", async () => {
    const a = csv(H, [" STR001 ,2026-09-20,10000,1000,11000"]);
    const b = csv("no_order,date_trans,subtotal,tax,total", ["STR001,2026-09-20,10000.00,1000,11000"]);
    const k = detectKeys(a, b);
    expect(k).toMatchObject({ detected: true, sameName: false });
    expect(status(await run(a, b), "STR001")).toBe("SAMA");
  });
  it("normalisasi key & nilai: angka vs string, null ≠ 0", () => {
    expect(normalizeKey(" 12345 ")).toBe("12345"); expect(normalizeKey("12345.0")).toBe("12345"); expect(normalizeKey(null)).toBe("");
    expect(valuesEqual("subtotal", "10000", "10000.00")).toBe(true);
    expect(valuesEqual("subtotal", "10000", "10000.50")).toBe(false);
    expect(valuesEqual("discount", "", "0")).toBe(false);
    expect(valuesEqual("id_agent", "0012", "12")).toBe(false);
  });
  it("10.000 vs 9.800 transaksi semuanya dibandingkan", async () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `S${i},2026-09-20,1000,100,1100`);
    const r = await run(csv(H, lines(10000)), csv(H, lines(9800).reverse()));
    expect(r.summary).toMatchObject({ total1: 10000, total2: 9800, same: 9800, only1: 200 });
  });
});
