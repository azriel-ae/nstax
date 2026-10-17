import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_KINDS, detectApiFormat, type ApiKind } from "./apiDetector";
import { runApiParser } from "./apiRunner";

const j = (v: unknown) => JSON.stringify(v);
const rec = (noBill: unknown, product = "MANYAR RESTO", extra: Record<string, unknown> = {}) => ({ Date: "2026-08-02", Product: product, NoBill: noBill, Gross: "114000.00", Service: "9421.46", Tax: "10363.69", Nett: "94214.85", ...extra });
const kindOf = (d: ReturnType<typeof detectApiFormat>) => (d.status === "confident" ? d.kind : null);

// Fixture sintetis parser lama (struktur sama dengan apiDetector.test.ts).
const astana = { Date: "2026-07-01", Product: "AST-BREAKFAST", NoBill: null, Gross: "510400.00", Service: "26400.00", Tax: "44000.00", Nett: "440000.00" };
const fore = { tgl: "2026-08-01T03:42:04.000Z", counter_id: 480, counter_name: "X", billing_id: "260824800017", total: 29000, pajak: 2636 };
const nsc = { transaction_no: "T1", movie_title: "M", date: "2026-01-01", show_time: "10:00", show_studio_id: 1, total_orders: 1, selected_orders: 1, total: 50000, total_seat: 2 };

describe("deteksi otomatis MANYAR (BACA DATA API V2)", () => {
  it("campuran HOTEL (Product ROOM REVENUE) dan RESTO → confident MANYAR, bukan ASTANA", () => {
    const data = [rec("FL.26001775", "ROOM REVENUE"), rec("SL-26RST0000587"), rec("FL-26001776", "ROOM REVENUE"), rec("SL.26RST0000588")];
    const d = detectApiFormat(j(data));
    expect(d.status).toBe("confident");
    expect(kindOf(d)).toBe("manyar");
    if (d.status === "confident") expect(d.recordCount).toBe(4);
  });

  it("satu record saja dan seluruh record diperiksa (bukan hanya yang pertama)", () => {
    expect(kindOf(detectApiFormat(j([rec("FL.1")])))).toBe("manyar");
    expect(kindOf(detectApiFormat(j([rec("SL.1")])))).toBe("manyar");
    // record pertama MANYAR tetapi record terakhir bukan → tidak confident
    const d = detectApiFormat(j([rec("FL.1"), rec("SL.2"), { foo: 1 }]));
    expect(d.status).not.toBe("confident");
  });

  it("ribuan record campuran terdeteksi confident", () => {
    const data = Array.from({ length: 6000 }, (_, i) => rec(`${i % 3 ? "SL" : "FL"}${i % 2 ? "." : "-"}26${i}`));
    const d = detectApiFormat(j(data));
    expect(kindOf(d)).toBe("manyar");
    if (d.status === "confident") expect(d.recordCount).toBe(6000);
  });

  it("urutan properti berbeda tetap terdeteksi", () => {
    const reversed = Object.fromEntries(Object.entries(rec("FL.26001775")).reverse());
    expect(kindOf(detectApiFormat(j([reversed])))).toBe("manyar");
  });

  it("huruf kecil / spasi pada NoBill tetap dikenali", () => {
    expect(kindOf(detectApiFormat(j([rec("  fl.26001775 "), rec("sl-26rst1")])))).toBe("manyar");
  });

  it("MANYAR bercampur record ber-NoBill kosong/asing → uncertain (pilih manual), bukan confident dan bukan 'mixed' buntu", () => {
    const d = detectApiFormat(j([rec("FL.1"), rec("SL.2"), rec(null), rec("XX.9")]));
    expect(d.status).toBe("uncertain");
    if (d.status === "uncertain") expect(d.candidates.map((c) => c.kind)).toEqual(expect.arrayContaining(["manyar", "astana"]));
  });

  it("MANYAR tersedia sebagai pilihan manual dan menghasilkan hasil dari parser MANYAR", () => {
    expect(API_KINDS).toContain("manyar");
    const view = runApiParser("manyar", j([rec("FL.1"), rec(null)]));
    expect(view.ok).toBe(true);
    expect(view.notices.join(" ")).toMatch(/tidak dikenal/);
  });
});

describe("parser lama tidak berubah / tidak salah dikenali sebagai MANYAR", () => {
  it("ASTANA (NoBill null) tetap ASTANA", () => { expect(kindOf(detectApiFormat(j([astana, astana])))).toBe("astana"); });

  it("ASTANA dengan NoBill terisi non-FL/SL tetap ASTANA", () => {
    expect(kindOf(detectApiFormat(j([{ ...astana, NoBill: "AST-0001" }, { ...astana, NoBill: "INV/2026/09" }])))).toBe("astana");
    expect(kindOf(detectApiFormat(j([{ ...astana, NoBill: "FLOWER-1" }])))).toBe("astana"); // kata biasa berawalan FL
    expect(kindOf(detectApiFormat(j([{ ...astana, NoBill: "SLAMET" }])))).toBe("astana");
  });

  it("FORE, NSC, KAI, ROTIO, KOPKEN, FAVE tetap terdeteksi benar", () => {
    const cases: Array<[unknown, ApiKind]> = [
      [[fore], "fore"], [{ data: [fore] }, "fore"], [[nsc], "nsc"],
      [[{ waktu_out: "2026-01-01", biayatotal: 1100, kode_lokasi: "A" }], "kai"],
      [[{ T1: { "4": "1100", "0": "2026-01-01" } }], "rotio"],
      [{ result: [{ ID: "K1", dpp: "900", pajak: "100", total: "1000" }] }, "kopken"],
      [{ Data: [{ transaction_id: "V1", base_amount: 900, tax_amount: 100, grand_total: 1000 }] }, "fave"],
    ];
    for (const [input, kind] of cases) expect(kindOf(detectApiFormat(j(input)))).toBe(kind);
  });

  it("SAMS / HOKBEN tetap tidak pernah confident; campuran lama tetap 'mixed'", () => {
    expect(detectApiFormat(j({ data: [{ id: "S1", dpp: "900", tax: "100", total: "1000" }] })).status).toBe("uncertain");
    expect(detectApiFormat(j({ data: [{ no_transaksi: "H1", tax: 100 }] })).status).toBe("uncertain");
    expect(detectApiFormat(j([astana, { waktu_out: "x", biayatotal: 1 }])).status).toBe("mixed");
  });

  it("MANYAR + format lain (bukan ASTANA) tetap ditolak sebagai campuran", () => {
    expect(detectApiFormat(j([rec("FL.1"), { waktu_out: "x", biayatotal: 1 }])).status).toBe("mixed");
  });

  it("runner ASTANA tidak memakai filter kategori (perilaku lama)", () => {
    const v = runApiParser("astana", j([astana]));
    expect(v.ok).toBe(true);
    expect(v.filters).toBeUndefined();
    expect(v.select).toBeUndefined();
  });
});

describe("runner MANYAR V2: filter Semua / HOTEL / RESTO", () => {
  const data = [
    rec("FL.1", "ROOM REVENUE", { Gross: "413584.00", Service: "34180.50", Tax: "37598.55", Nett: "341804.95" }),
    rec("SL-1", "MANYAR RESTO", { Gross: "114000.00", Service: "9421.46", Tax: "10363.69", Nett: "94214.85" }),
    rec("FL-2", "ROOM REVENUE", { Gross: "100000.10", Service: "8264.46", Tax: "9090.90", Nett: "82644.74" }),
    rec("SL.2", "MANYAR RESTO", { Gross: "50000.55", Service: "4132.23", Tax: "4545.45", Nett: "41322.87" }),
  ];
  const view = runApiParser("manyar", j(data));
  const val = (metrics: { label: string; value: string }[], label: string) => metrics.find((m) => m.label === label)?.value;

  it("tiga filter tersedia dan total sesuai hitungan manual", () => {
    expect(view.ok).toBe(true);
    expect(view.filters?.map((f) => f.key)).toEqual(["ALL", "HOTEL", "RESTO"]);
    const all = view.select!("ALL");
    const hotel = view.select!("HOTEL");
    const resto = view.select!("RESTO");
    expect(val(all.metrics, "Jumlah transaksi")).toBe("4");
    expect(val(all.metrics, "Total Gross")).toBe("Rp 677.584,65");
    expect(val(all.metrics, "Total Nett")).toBe("Rp 559.987,41");
    expect(val(hotel.metrics, "Jumlah transaksi")).toBe("2");
    expect(val(hotel.metrics, "Total Gross")).toBe("Rp 513.584,10");
    expect(val(hotel.metrics, "Total Service")).toBe("Rp 42.444,96");
    expect(val(hotel.metrics, "Total Tax")).toBe("Rp 46.689,45");
    expect(val(hotel.metrics, "Total Nett")).toBe("Rp 424.449,69");
    expect(val(resto.metrics, "Total Gross")).toBe("Rp 164.000,55");
    expect(val(resto.metrics, "Total Service")).toBe("Rp 13.553,69");
    expect(val(resto.metrics, "Total Tax")).toBe("Rp 14.909,14");
    expect(val(resto.metrics, "Total Nett")).toBe("Rp 135.537,72");
  });

  it("tabel mengikuti kategori; memanggil filter berulang konsisten dan tidak menumpuk", () => {
    const before = JSON.stringify(view.select!("ALL").metrics);
    expect(view.select!("HOTEL").rows.map((r) => r[2])).toEqual(["FL.1", "FL-2"]);
    expect(view.select!("RESTO").rows.map((r) => r[2])).toEqual(["SL-1", "SL.2"]);
    expect(view.select!("ALL").rows).toHaveLength(4);
    for (let i = 0; i < 5; i++) { view.select!("HOTEL"); view.select!("RESTO"); }
    expect(JSON.stringify(view.select!("ALL").metrics)).toBe(before);
  });

  it("CSV mengikuti kategori terpilih", () => {
    expect(view.select!("RESTO").csv()).toContain("SL-1");
    expect(view.select!("RESTO").csv()).not.toContain("FL.1");
  });

  it("JSON rusak dan array kosong → gagal dengan pesan jelas", () => {
    expect(runApiParser("manyar", "{rusak").ok).toBe(false);
    const empty = runApiParser("manyar", "[]");
    expect(empty.ok).toBe(false);
    expect(empty.error).toMatch(/kosong/i);
  });
});

describe("batas perubahan V2: CEK UPL dan BACA DATA APITRANS tidak tersentuh", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const read = (rel: string) => readFileSync(resolve(dir, rel), "utf8");

  it("V2App (rute APITRANS/UPL) dan LegacyEmbed tidak mereferensikan MANYAR atau detektor", () => {
    for (const rel of ["../V2App.tsx", "../LegacyEmbed.tsx"]) {
      const src = read(rel);
      expect(src).not.toMatch(/manyar/i);
      expect(src).not.toMatch(/apiDetector|apiRunner/);
    }
  });

  it("detektor hanya dipakai halaman BACA DATA API", () => {
    expect(read("../pages/CekDataApi.tsx")).toMatch(/detectApiFormat/);
    for (const page of ["Nasgor69Checker", "PointCoffeeHmChecker", "FamilyMartChecker", "UplChecker", "UplMonthlyChecker"]) {
      const src = readFileSync(resolve(dir, "../../pages", `${page}.tsx`), "utf8");
      expect(src).not.toMatch(/manyar|apiDetector/i);
    }
  });
});
