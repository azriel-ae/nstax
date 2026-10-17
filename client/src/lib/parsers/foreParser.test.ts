import { describe, expect, it } from "vitest";
import { calculateForeSummary, formatForeRupiah, parseForeJson } from "./foreParser";

const fore = { tgl: "2026-08-01T03:42:04.000Z", counter_id: 480, counter_name: "Panglima Sudirman Pasuruan", billing_id: "260824800017", total: 29000, pajak: 2636 };
const second = { ...fore, billing_id: "260814800012", total: 49600, pajak: 4509 };

describe("FORE parser", () => {
  it("parses arrays and calculates actual total and pajak", () => {
    const result = parseForeJson(JSON.stringify([fore, second]));
    expect(result.validTransactions).toHaveLength(2);
    expect(calculateForeSummary(result.validTransactions)).toMatchObject({ count: 2, total: 78600, pajak: 7145, uniqueCounters: 1 });
    expect(formatForeRupiah(78600)).toBe("Rp78.600");
  });
  it("rejects NSC-shaped data instead of processing it as FORE", () => {
    const result = parseForeJson(JSON.stringify({ transaction_no: "NSC-1", movie_title: "Movie", total: 560000, total_seat: 16 }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/tidak sesuai/);
    expect(result.validTransactions).toHaveLength(0);
  });
  it("reports incomplete FORE records", () => {
    const result = parseForeJson(JSON.stringify({ ...fore, pajak: undefined }));
    expect(result.ok).toBe(true);
    expect(result.validTransactions).toHaveLength(0);
    expect(result.issues).toHaveLength(1);
  });
});
