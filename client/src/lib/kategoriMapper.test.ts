import { describe, expect, it } from "vitest";
import type { UplRow } from "./uplParser";
import {
  categorizeAllRows,
  categorizeTransactionRow,
  createBuiltInKategoriResult,
  detectTransactionKategoriColumns,
  filterRowsByCategory,
  summarizeByCategory,
  validateCategoryTotals,
  UNMAPPED_LABEL,
} from "./kategoriMapper";

function makeRow(sourceRow: number, cells: string[], subtotal: number | null = null, tax: number | null = null): UplRow {
  return {
    sourceRow,
    sourceSheet: "TO 020926",
    no_struk: cells[0] ?? "",
    description: cells[3] ?? "",
    qtyRaw: "1",
    qty: 1,
    subtotalRaw: subtotal === null ? "" : String(subtotal),
    subtotal,
    taxRaw: tax === null ? "" : String(tax),
    tax,
    cells,
  };
}

describe("CEK UPL master-item categorization", () => {
  const master = createBuiltInKategoriResult();
  const columns = detectTransactionKategoriColumns(["No Struk", "Account", "Nama Perusahaan", "Rincian / Item", "Day-Gros", "Tax"]);

  it.each([
    ["Food OPPA KFOOD", "K FOOD"],
    [" food oppa kfood ", "K FOOD"],
    ["Food Resto Padi", "K FOOD"],
    ["Food PREEGO", "RESTO PREGO"],
    ["Beverage PREEGO", "RESTO PREGO"],
    ["25 Pastry & Bakery", "RESTO PREGO"],
    ["Food BANQUET", "RESTO PREGO"],
    ["Other REST No Serv", "HIBURAN — MESIN CAPIT"],
    ["22 Activity Sport", "HIBURAN — KLAND HIBURAN"],
    ["23 Activity Nature", "HIBURAN — KLAND HIBURAN"],
    ["20 Activity Entry Gate", "HIBURAN — WATER SLIDE"],
    ["914 Disc waterslide", "HIBURAN — WATER SLIDE"],
    ["21 Activity Parking", "PARKIR"],
  ])("maps %s to %s", (item, expected) => {
    const result = categorizeTransactionRow(makeRow(2, ["STR1", "UNKNOWN", "UNKNOWN UNIT", item, "100", "10"], 100, 10), master, columns);
    expect(result.category).toBe(expected);
  });

  it("uses only Rincian/Item and never account, company, category, or generic keywords", () => {
    const row = makeRow(2, ["STR1", "21 Activity Parking", "K FOOD", "Food", "100", "10"], 100, 10);
    const result = categorizeTransactionRow(row, master, columns);
    expect(result.category).toBe(UNMAPPED_LABEL);
  });

  it("does not use substring or generic keyword matching", () => {
    const genericRows = ["food", "activity", "parking", "prego", "Some Activity Sport Extra"].map((item, index) =>
      makeRow(index + 2, [String(index), "", "", item, "100", "10"], 100, 10),
    );
    expect(categorizeAllRows(genericRows, master, columns).every((row) => row.category === UNMAPPED_LABEL)).toBe(true);
  });

  it("maps the exact Activity Parking item to PARKIR and keeps its quantity/value totals", () => {
    const row = makeRow(68, ["68", "", "", "Activity Parking", "20000", "1818"], 20000, 1818);
    row.qty = 2;
    const categorized = categorizeAllRows([row], master, columns);
    const perCategory = summarizeByCategory(categorized);
    expect(categorized[0].category).toBe("PARKIR");
    expect(perCategory.PARKIR.quantityTotal).toBe(2);
    expect(perCategory.PARKIR.subtotalTotal).toBe(20000);
    expect(perCategory.PARKIR.taxTotal).toBe(1818);
  });

  it("categorizes the full dataset, sums each bucket, and validates one bucket per row", () => {
    const rows = [
      makeRow(2, ["STR1", "", "", "Food OPPA KFOOD", "500", "50"], 500, 50),
      makeRow(3, ["STR2", "", "", "Food PREEGO", "300", "30"], 300, 30),
      makeRow(4, ["STR3", "", "", "22 Activity Sport", "100", "10"], 100, 10),
      makeRow(5, ["STR4", "", "", "21 Activity Parking", "20", "2"], 20, 2),
      makeRow(6, ["STR5", "", "", "UNKNOWN ITEM", "5", "1"], 5, 1),
    ];
    const categorized = categorizeAllRows(rows, master, columns);
    const perCategory = summarizeByCategory(categorized);

    expect(perCategory["K FOOD"]).toEqual({ count: 1, quantityTotal: 1, subtotalTotal: 500, taxTotal: 50 });
    expect(perCategory["RESTO PREGO"]).toEqual({ count: 1, quantityTotal: 1, subtotalTotal: 300, taxTotal: 30 });
    expect(perCategory["HIBURAN — KLAND HIBURAN"]).toEqual({ count: 1, quantityTotal: 1, subtotalTotal: 100, taxTotal: 10 });
    expect(perCategory.PARKIR).toEqual({ count: 1, quantityTotal: 1, subtotalTotal: 20, taxTotal: 2 });
    expect(perCategory[UNMAPPED_LABEL]).toEqual({ count: 1, quantityTotal: 1, subtotalTotal: 5, taxTotal: 1 });
    expect(validateCategoryTotals(categorized, perCategory)).toBeNull();
    expect(filterRowsByCategory(categorized, "K FOOD")).toHaveLength(1);
    expect(filterRowsByCategory(categorized, "ALL")).toHaveLength(5);
  });
});
