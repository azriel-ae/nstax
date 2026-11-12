import { describe, expect, it } from "vitest";
import { parsePointCoffeeCsv } from "./pointcoffeParser";

describe("PointCoffee pipe CSV parser", () => {
  it("parses pipe-delimited rows with commas in item descriptions and calculates all rows", () => {
    const csv = [
      "TANGGAL|WAKTU|TOKO|NO_STRUK|SHIFT|STATION|DESKRIPSI_ITEM|DPP|PAJAK_RESTORAN",
      "2026-07-31|07:07:07|TCYN|94|1|A|POINT COFFEE,PALM SUGAR LATTE ICE|22727.272727|2272.727273",
      "2026-08-01|08:00:00|TCYN|95|1|A|Americano|10000|1000",
    ].join("\n");
    const result = parsePointCoffeeCsv(csv);
    expect(result.ok).toBe(true);
    expect(result.rows[0]).toMatchObject({ no_struk: "TCYN_942026-07-3107:07:07_1", date_trans: "2026-07-31 07:07:07", subtotal: 22727.272727, dpp: 22727.272727, tax: 2272.727273, total: 25000 });
    expect(result.summary).toMatchObject({ count: 2, dpp: 32727.272727, tax: 3272.727273, total: 36000 });
  });

  it("rejects comma-delimited input", () => {
    expect(parsePointCoffeeCsv("TANGGAL,WAKTU,TOKO").ok).toBe(false);
  });
});
