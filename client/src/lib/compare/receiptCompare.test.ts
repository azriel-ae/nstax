import { describe, expect, it } from "vitest";
import { compareReceiptRows, compareReceiptTotals } from "./receiptCompare";
import { parseReceiptCsv, type ReceiptRow } from "./receiptParser";
const row = (no_struk: string, paid_amount: string): ReceiptRow => ({ id_agent: "", no_struk, date_trans: "01-Aug-2026", subtotal: "65000", service_charge: "0", discount: "0", dpp: "", tax: "6500", paid_amount, total: "", keterangan: "", status: "NORMAL", sourceIndex: 1 });
describe("receipt compare full parsed dataset", () => {
  it("compares every no_struk and uses paid amount as effective total", () => {
    const result = compareReceiptRows([row("A", "71500"), row("B", "100")], [row("A", "72000"), row("B", "100")]);
    expect(result.rows).toHaveLength(2);
    expect(result.summary).toMatchObject({ file1: 2, file2: 2, same: 1, different: 1 });
    expect(result.rows.find((item) => item.no_struk === "A")?.differences).toContain("paid_amount");
    expect(result.rows.find((item) => item.no_struk === "A")?.differences).toContain("total");
  });
});


const rec = (no_struk: string, subtotal: string, tax: string, total: string, extra: Partial<ReceiptRow> = {}): ReceiptRow => ({
  id_agent: "", no_struk, date_trans: "2026-08-01", subtotal, service_charge: "", discount: "", dpp: "", tax, paid_amount: "", total, keterangan: "", status: "NORMAL", sourceIndex: 1, ...extra,
});
const line = (result: ReturnType<typeof compareReceiptTotals>, metric: string) => result.lines.find((item) => item.metric === metric)!;

describe("compareReceiptTotals — berbasis jumlah transaksi, subtotal, tax, total (tanpa no_struk)", () => {
  it("SAMA walau nomor struk berbeda total, selama angkanya sama", () => {
    const result = compareReceiptTotals(
      [rec("A1", "10000", "1000", "11000"), rec("A2", "20000", "2000", "22000")],
      [rec("ZZ-9", "20000", "2000", "22000"), rec("QQ-7", "10000", "1000", "11000")],
    );
    expect(result.allMatch).toBe(true);
    expect(result.differentCount).toBe(0);
    expect(result.lines.map((item) => item.metric)).toEqual(["count", "subtotal", "tax", "total"]);
    expect(line(result, "count")).toMatchObject({ file1: 2, file2: 2, difference: 0, status: "SAMA" });
    expect(line(result, "subtotal")).toMatchObject({ file1: 30000, file2: 30000 });
    expect(line(result, "tax")).toMatchObject({ file1: 3000, file2: 3000 });
    expect(line(result, "total")).toMatchObject({ file1: 33000, file2: 33000 });
  });

  it("BERBEDA walau nomor struknya identik, bila angkanya berbeda", () => {
    const result = compareReceiptTotals([rec("A1", "10000", "1000", "11000")], [rec("A1", "10000", "1100", "11100")]);
    expect(result.allMatch).toBe(false);
    expect(line(result, "subtotal").status).toBe("SAMA");
    expect(line(result, "tax")).toMatchObject({ difference: 100, status: "BERBEDA" });
    expect(line(result, "total")).toMatchObject({ difference: 100, status: "BERBEDA" });
    expect(result.differentCount).toBe(2);
  });

  it("menghitung jumlah transaksi dari seluruh baris dan melaporkan selisihnya", () => {
    const result = compareReceiptTotals([rec("A", "1", "0", "1"), rec("B", "1", "0", "1"), rec("C", "1", "0", "1")], [rec("A", "1", "0", "1")]);
    expect(line(result, "count")).toMatchObject({ file1: 3, file2: 1, difference: -2, status: "BERBEDA" });
  });

  it("baris tanpa no_struk tetap dihitung", () => {
    const result = compareReceiptTotals([rec("", "5000", "500", "5500"), rec("", "5000", "500", "5500")], [rec("X", "10000", "1000", "11000")]);
    expect(line(result, "count")).toMatchObject({ file1: 2, file2: 1 });
    expect(line(result, "subtotal").status).toBe("SAMA");
    expect(line(result, "total").status).toBe("SAMA");
  });

  it("memakai Paid Amount sebagai total bila kolomnya ada (aturan sama dengan CEK STRUK)", () => {
    const withPaid = (paid: string) => rec("A", "65000", "6500", "", { paid_amount: paid });
    const result = compareReceiptTotals([withPaid("71500")], [withPaid("72000")]);
    expect(line(result, "total")).toMatchObject({ file1: 71500, file2: 72000, difference: 500, status: "BERBEDA" });
  });

  it("membaca format angka Indonesia dan tidak terjebak selisih floating point", () => {
    const result = compareReceiptTotals(
      [rec("A", "Rp 1.000,10", "0,1", "1"), rec("B", "Rp 2.000,20", "0,2", "1")],
      [rec("C", "3000,3", "0,3", "1"), rec("D", "0", "0", "1")],
    );
    expect(line(result, "subtotal")).toMatchObject({ file1: 3000.3, file2: 3000.3, status: "SAMA" });
    expect(line(result, "tax")).toMatchObject({ file1: 0.3, file2: 0.3, difference: 0, status: "SAMA" });
  });

  it("memproses seluruh baris pada data besar (10.000 transaksi)", () => {
    const make = (prefix: string) => Array.from({ length: 10000 }, (_, i) => rec(`${prefix}${i}`, "10000", "1000", "11000"));
    const result = compareReceiptTotals(make("L"), make("R"));
    expect(result.allMatch).toBe(true);
    expect(line(result, "count").file1).toBe(10000);
    expect(line(result, "subtotal").file2).toBe(100_000_000);
  });

  it("bekerja dari file CSV yang tidak punya kolom no_struk sama sekali", () => {
    const csv1 = "tanggal,subtotal,pajak,total\n2026-08-01,10000,1000,11000\n2026-08-02,20000,2000,22000";
    const csv2 = "tanggal,subtotal,pajak,total\n2026-08-05,20000,2000,22000\n2026-08-06,10000,1000,11000";
    const parsed1 = parseReceiptCsv(csv1), parsed2 = parseReceiptCsv(csv2);
    expect(parsed1.rows).toHaveLength(2);
    const result = compareReceiptTotals(parsed1.rows, parsed2.rows);
    expect(result.allMatch).toBe(true);
    expect(line(result, "count")).toMatchObject({ file1: 2, file2: 2 });
    expect(line(result, "total").file1).toBe(33000);
  });
});
