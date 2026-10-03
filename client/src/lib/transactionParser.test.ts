import { describe, expect, it } from "vitest";
import {
  calculateSummary,
  formatAverageMinor,
  formatRupiahMinor,
  parseTransactionJson,
} from "./transactionParser";

const transaction = {
  transaction_no: "BMN-PASR-260801031302-8155",
  movie_title: "Spider-Man: Brand New Day",
  date: "2026-08-01",
  show_time: "13:00:00",
  show_studio_id: "43",
  total_orders: 15,
  selected_orders: 5,
  total: 560000,
  total_seat: 16,
};

const secondTransaction = {
  ...transaction,
  transaction_no: "BMN-PASR-260801031303-8156",
  show_time: "16:00:00",
  show_studio_id: "44",
  total_orders: 10,
  selected_orders: 4,
  total: 450000,
  total_seat: 12,
};

describe("nstax transaction parser", () => {
  it("parses a single object and calculates exact totals", () => {
    const result = parseTransactionJson(JSON.stringify(transaction));
    expect(result.validTransactions).toHaveLength(1);
    const summary = calculateSummary(result.validTransactions);
    expect(summary.totalMinor).toBe(BigInt(56000000));
    expect(summary.totalOrders).toBe(BigInt(15));
    expect(summary.selectedOrders).toBe(BigInt(5));
    expect(summary.totalSeat).toBe(BigInt(16));
    expect(formatRupiahMinor(summary.totalMinor)).toBe("Rp560.000");
  });

  it("parses arrays and nested arrays without dummy records", () => {
    const arrayResult = parseTransactionJson(JSON.stringify([transaction, secondTransaction]));
    const nestedResult = parseTransactionJson(JSON.stringify({ data: [transaction, secondTransaction] }));
    expect(arrayResult.validTransactions).toHaveLength(2);
    expect(nestedResult.validTransactions.map((item) => item.transactionNo)).toEqual([
      transaction.transaction_no,
      secondTransaction.transaction_no,
    ]);
    const summary = calculateSummary(arrayResult.validTransactions);
    expect(formatRupiahMinor(summary.totalMinor)).toBe("Rp1.010.000");
    expect(formatAverageMinor(summary.totalMinor, 2)).toBe("Rp505.000");
  });

  it("accepts numeric strings but rejects invalid numeric fields", () => {
    const stringResult = parseTransactionJson(JSON.stringify({ ...transaction, total: "560000" }));
    const invalidResult = parseTransactionJson(JSON.stringify({ ...transaction, total: "not-a-number" }));
    expect(stringResult.validTransactions).toHaveLength(1);
    expect(invalidResult.validTransactions).toHaveLength(0);
    expect(invalidResult.issues.some((issue) => issue.field === "total")).toBe(true);
  });

  it("handles malformed JSON, empty arrays, and missing totals clearly", () => {
    expect(parseTransactionJson("{ malformed").error).toMatch(/JSON tidak valid/);
    expect(parseTransactionJson("[]").warning).toMatch(/tidak ditemukan/);
    const missingTotal = parseTransactionJson(JSON.stringify({ ...transaction, total: undefined }));
    expect(missingTotal.validTransactions).toHaveLength(0);
    expect(missingTotal.issues.some((issue) => issue.field === "total")).toBe(true);
  });

  it("keeps duplicate rows and marks each occurrence", () => {
    const result = parseTransactionJson(JSON.stringify([transaction, transaction]));
    expect(result.validTransactions).toHaveLength(2);
    expect(result.duplicateCount).toBe(2);
    expect(result.validTransactions.every((item) => item.isDuplicate)).toBe(true);
  });

  it("calculates 10% tax on top of subtotal and grand total correctly", () => {
    const result = parseTransactionJson(JSON.stringify(transaction));
    const [row] = result.validTransactions;
    expect(row.totalMinor).toBe(BigInt(56000000)); // Rp560.000 subtotal
    expect(row.taxMinor).toBe(BigInt(5600000)); // 10% = Rp56.000
    expect(row.grandTotalMinor).toBe(BigInt(61600000)); // Rp616.000

    const summary = calculateSummary(result.validTransactions);
    expect(formatRupiahMinor(summary.taxMinor)).toBe("Rp56.000");
    expect(formatRupiahMinor(summary.grandTotalMinor)).toBe("Rp616.000");
  });

  it("does not divide by zero for empty results", () => {
    const summary = calculateSummary([]);
    expect(summary.count).toBe(0);
    expect(formatAverageMinor(summary.totalMinor, summary.count)).toBe("Rp0");
  });
});
