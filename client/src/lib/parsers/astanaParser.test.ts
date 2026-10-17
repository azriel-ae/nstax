import { describe, expect, it } from "vitest";
import { astanaToCsv, formatAstanaRupiah, parseAstana, summarizeAstana } from "./astanaParser";

const sample = [
  { Date: "2026-07-01", Product: "AST-BREAKFAST", NoBill: null, Gross: "510400.00", Service: "26400.00", Tax: "44000.00", Nett: "440000.00" },
  { Date: "2026-07-01", Product: "ROOM REVENUE", NoBill: null, Gross: "4986178.00", Service: "257905.76", Tax: "429842.93", Nett: "4298429.31" },
];

describe("parseAstana", () => {
  it("reads ASTANA fields by name and preserves decimal values", () => {
    const result = parseAstana(JSON.stringify(sample));
    expect(result.ok).toBe(true);
    expect(result.validRows).toBe(2);
    expect(result.rows[0]).toMatchObject({ noBill: null, gross: 510400, service: 26400, tax: 44000, nett: 440000, status: "Valid" });
    expect(result.rows[1]).toMatchObject({ service: 257905.76, tax: 429842.93, status: "Valid" });
    expect(formatAstanaRupiah(429842.93)).toBe("Rp 429.842,93");
  });

  it("rejects a non-array root and invalid required fields", () => {
    expect(parseAstana(JSON.stringify({ Date: "2026-07-01" })).error).toMatch(/Format JSON tidak sesuai/);
    expect(parseAstana(JSON.stringify([{ foo: "bar" }])).error).toMatch(/Format JSON tidak sesuai/);
    const result = parseAstana(JSON.stringify([{ ...sample[0], Tax: null }]));
    expect(result.ok).toBe(true);
    expect(result.invalidRows).toBe(1);
    expect(result.rows[0].status).toBe("Invalid");
  });

  it("marks consistency differences for review without changing source values", () => {
    const result = parseAstana(JSON.stringify([{ ...sample[0], Nett: "1.00" }]));
    expect(result.rows[0].status).toBe("Perlu diperiksa");
    expect(result.rows[0].nett).toBe(1);
  });

  it("summarizes the complete dataset and excludes invalid rows only", () => {
    const result = parseAstana(JSON.stringify([...sample, { ...sample[0], Gross: null }]));
    const summary = summarizeAstana(result.rows);
    expect(result.totalRows).toBe(3);
    expect(summary.transactionCount).toBe(2);
    expect(summary.gross).toBe(5496578);
    expect(summary.service).toBe(284305.76);
    expect(summary.tax).toBe(473842.93);
    expect(summary.nett).toBe(4738429.31);
  });

  it("exports visible ASTANA rows as CSV", () => {
    const result = parseAstana(JSON.stringify(sample));
    const csv = astanaToCsv(result.rows);
    expect(csv).toContain('"Date","Product"');
    expect(csv).toContain("AST-BREAKFAST");
    expect(csv).toContain("Valid");
  });
});
