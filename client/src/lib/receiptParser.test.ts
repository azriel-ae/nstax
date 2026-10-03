import { describe, expect, it } from "vitest";
import { parseReceiptMatrix } from "./receiptParser";

describe("receipt parser sales-details headers", () => {
  it("maps order no and order time to compare fields", () => {
    const result = parseReceiptMatrix([
      ["order no", "order time", "subtotal", "tax", "discount", "service charge", "rounding", "paid amount"],
      ["319A26080100037342", "01-Aug-2026", "65000", "6500", "0", "0", "0", "71500"],
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ no_struk: "319A26080100037342", date_trans: "01-Aug-2026", subtotal: "65000", tax: "6500", paid_amount: "71500" });
  });
});
