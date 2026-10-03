import { describe, expect, it } from "vitest";
import { parseVendorJson, summarizeVendor } from "./vendorParser";
const cases = [
  ["rotio", [{ T1: { "4": "1100", "0": "2026-01-01", outlet: "A" } }], { dpp: 1000, tax: 100, total: 1100 }],
  ["kai", [{ waktu_out: "2026-01-01", biayatotal: 1100, kode_lokasi: "A" }], { dpp: 1000, tax: 100, total: 1100 }],
  ["hokben", { data: [{ no_transaksi: "H1", tax: 100 }] }, { dpp: 900, tax: 100, total: 1000 }],
  ["kopken", { result: [{ ID: "K1", dpp: "900", pajak: "100", total: "1000" }] }, { dpp: 900, tax: 100, total: 1000 }],
  ["fore", { data: [{ billing_id: "F1", total: 1000, pajak: 100 }] }, { dpp: 900, tax: 100, total: 1000 }],
  ["fave", { Data: [{ transaction_id: "V1", base_amount: 900, tax_amount: 100, grand_total: 1000 }] }, { dpp: 900, tax: 100, total: 1000 }],
  ["sams", { data: [{ id: "S1", dpp: "900", tax: "100", total: "1000" }] }, { dpp: 900, tax: 100, total: 1000 }],
] as const;
describe("vendor parsers", () => { it.each(cases)("parses %s with its own rules", (kind, input, expected) => { const result = parseVendorJson(kind, JSON.stringify(input)); expect(result.ok).toBe(true); expect(result.rows).toHaveLength(1); expect(summarizeVendor(result.rows)).toMatchObject(expected); }); });
