import { describe, expect, it } from "vitest";
import { detectApiFormat } from "./apiDetector";

const j = (v: unknown) => JSON.stringify(v);
// Fixture SINTETIS yang disusun dari field yang dibaca parser (bukan data produksi).
const astana = { Date: "2026-07-01", Product: "AST-BREAKFAST", NoBill: null, Gross: "510400.00", Service: "26400.00", Tax: "44000.00", Nett: "440000.00" };
const fore = { tgl: "2026-08-01T03:42:04.000Z", counter_id: 480, counter_name: "X", billing_id: "260824800017", total: 29000, pajak: 2636 };
const nsc = { transaction_no: "T1", movie_title: "M", date: "2026-01-01", show_time: "10:00", show_studio_id: 1, total_orders: 1, selected_orders: 1, total: 50000, total_seat: 2 };

describe("detectApiFormat", () => {
  it("ASTANA confident", () => { const r = detectApiFormat(j([astana, astana])); expect(r.status).toBe("confident"); if (r.status === "confident") expect(r.kind).toBe("astana"); });
  it("FORE confident (array dan nested)", () => {
    for (const input of [[fore], { data: [fore] }]) { const r = detectApiFormat(j(input)); expect(r.status).toBe("confident"); if (r.status === "confident") expect(r.kind).toBe("fore"); }
  });
  it("NSC confident", () => { const r = detectApiFormat(j([nsc])); expect(r.status).toBe("confident"); if (r.status === "confident") expect(r.kind).toBe("nsc"); });
  it("KAI confident", () => { const r = detectApiFormat(j([{ waktu_out: "2026-01-01", biayatotal: 1100, kode_lokasi: "A" }])); expect(r.status).toBe("confident"); if (r.status === "confident") expect(r.kind).toBe("kai"); });
  it("ROTIO confident", () => { const r = detectApiFormat(j([{ T1: { "4": "1100", "0": "2026-01-01" } }])); expect(r.status).toBe("confident"); if (r.status === "confident") expect(r.kind).toBe("rotio"); });
  it("KOPKEN confident", () => { const r = detectApiFormat(j({ result: [{ ID: "K1", dpp: "900", pajak: "100", total: "1000" }] })); expect(r.status).toBe("confident"); if (r.status === "confident") expect(r.kind).toBe("kopken"); });
  it("FAVE confident", () => { const r = detectApiFormat(j({ Data: [{ transaction_id: "V1", base_amount: 900, tax_amount: 100, grand_total: 1000 }] })); expect(r.status).toBe("confident"); if (r.status === "confident") expect(r.kind).toBe("fave"); });
  it("SAMS vs HOKBEN tidak pernah confident (bukti belum membedakan)", () => {
    expect(detectApiFormat(j({ data: [{ id: "S1", dpp: "900", tax: "100", total: "1000" }] })).status).toBe("uncertain");
    expect(detectApiFormat(j({ data: [{ no_transaksi: "H1", tax: 100 }] })).status).toBe("uncertain");
  });
  it("file campuran ditolak, tidak diproses", () => { expect(detectApiFormat(j([astana, { waktu_out: "x", biayatotal: 1 }])).status).toBe("mixed"); });
  it("sebagian record tidak cocok -> uncertain, bukan confident", () => { expect(detectApiFormat(j([astana, { foo: 1 }])).status).toBe("uncertain"); });
  it("FORE tanpa counter_id/tgl tidak dianggap confident", () => { expect(detectApiFormat(j({ data: [{ billing_id: "F1", total: 1000, pajak: 100 }] })).status).not.toBe("confident"); });
  it("kosong / invalid / tidak dikenal", () => {
    expect(detectApiFormat("").status).toBe("unsupported");
    expect(detectApiFormat("{bukan json").status).toBe("unsupported");
    expect(detectApiFormat("[]").status).toBe("unsupported");
    expect(detectApiFormat(j({ a: 1 })).status).toBe("unsupported");
    expect(detectApiFormat(j([{ x: 1 }])).status).toBe("unsupported");
  });
});
