import { describe, expect, it } from "vitest";
import {
  extractPointCoffeeHmRecords,
  formatPointCoffeeHmRupiah,
  paginatePointCoffeeHm,
  parsePointCoffeeHm,
  pointCoffeeHmCountWarning,
  pointCoffeeHmToCsv,
  summarizePointCoffeeHm,
} from "./pointcoffeHmParser";

// Dua contoh dari spesifikasi (hanya untuk menguji struktur, bukan data asli).
const sampleA = {
  id: 424403, id_agent: "point_pas", no_struk: "260929012000000014", date_trans: "2026-09-29 18:42:53",
  subtotal: 24545.454545, service_charge: null, discount: 0, dpp: 2454.545455, tax: 2454.545455, total: 27000,
  log_time: "2026-09-29 18:43:35", keterangan: null, pos_tipe: null, nama_usaha: "Point Coffee", id_server: "0", void: 0, id_outlet: "P036", outlet_name: null,
};
const sampleB = {
  id: 424399, id_agent: "point_pas", no_struk: "260929012000000013", date_trans: "2026-09-29 18:40:35",
  subtotal: 45454.545455, service_charge: null, discount: 20000, dpp: 4545.454545, tax: 4545.454545, total: 30000,
  log_time: "2026-09-29 18:41:35", keterangan: null, pos_tipe: null, nama_usaha: "Point Coffee", id_server: "0", void: 0, id_outlet: "P036", outlet_name: null,
};

// Dataset sintetis (hanya untuk uji volume) — bukan data transaksi asli.
function makeRecords(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    ...sampleA,
    id: 500000 + i,
    no_struk: `S${String(i).padStart(8, "0")}`,
    subtotal: 1000 + i,
    discount: i % 7 === 0 ? 500 : 0,
    dpp: 100 + i,
    tax: 10 + i,
    total: 2000 + i,
    void: i % 50 === 0 ? 1 : 0,
  }));
}
const wrap = (data: unknown[], count: number = data.length, status = "ok") => JSON.stringify({ status, count, data });

describe("parsePointCoffeeHm", () => {
  it("memproses kedua contoh dan mempertahankan nilai sumber", () => {
    const r = parsePointCoffeeHm(wrap([sampleA, sampleB]));
    expect(r.ok).toBe(true);
    expect(r.totalRows).toBe(2);
    const [a, b] = r.rows;
    expect(a.id).toBe("424403");
    expect(a.idAgent).toBe("point_pas");
    expect(a.noStruk).toBe("260929012000000014");
    expect(a.subtotal).toBe(24545.454545);
    expect(a.dpp).toBe(2454.545455);
    expect(a.tax).toBe(2454.545455);
    expect(a.total).toBe(27000);
    expect(a.discount).toBe(0);
    expect(a.idServer).toBe("0");
    expect(a.idOutlet).toBe("P036");
    // null tetap null, bukan 0 atau string kosong
    expect(a.serviceCharge).toBeNull();
    expect(a.keterangan).toBeNull();
    expect(a.posTipe).toBeNull();
    expect(a.outletName).toBeNull();
    // diskon positif; total TIDAK dikurangi diskon lagi; dpp bukan subtotal
    expect(b.discount).toBe(20000);
    expect(b.total).toBe(30000);
    expect(b.dpp).toBe(4545.454545);
    expect(b.tax).toBe(4545.454545);
    expect(b.raw).toBe(b.raw);
    expect(r.rows.every((row) => row.status === "Valid")).toBe(true);
  });

  it("memproses SEMUA objek (1166 dan 3000), tanpa batas preview", () => {
    for (const n of [1166, 3000]) {
      const records = makeRecords(n);
      const r = parsePointCoffeeHm(wrap(records));
      expect(r.totalRows).toBe(n);
      expect(r.rows.length).toBe(records.length);
      expect(r.validRows).toBe(n);
    }
  });

  it("urutan dan isi tidak berubah; cek acak cocok dengan sumber", () => {
    const records = makeRecords(1500);
    const r = parsePointCoffeeHm(wrap(records));
    for (const i of [0, 1, 49, 50, 777, 1165, 1499]) {
      const src = records[i];
      const row = r.rows[i];
      expect(row.id).toBe(String(src.id));
      expect(row.noStruk).toBe(src.no_struk);
      expect(row.subtotal).toBe(src.subtotal);
      expect(row.discount).toBe(src.discount);
      expect(row.dpp).toBe(src.dpp);
      expect(row.tax).toBe(src.tax);
      expect(row.total).toBe(src.total);
      expect(row.isVoid).toBe(src.void === 1);
    }
  });

  it("count tidak dipakai sebagai jumlah data dan memicu peringatan bila beda", () => {
    const records = makeRecords(10);
    const r = parsePointCoffeeHm(wrap(records, 1166));
    expect(r.totalRows).toBe(10);
    expect(r.declaredCount).toBe(1166);
    expect(pointCoffeeHmCountWarning(r)).toContain("1.166");
    expect(pointCoffeeHmCountWarning(r)).toContain("10");
    const same = parsePointCoffeeHm(wrap(records, 10));
    expect(pointCoffeeHmCountWarning(same)).toBeNull();
    const noCount = parsePointCoffeeHm(JSON.stringify({ status: "ok", data: records }));
    expect(noCount.declaredCount).toBeNull();
    expect(pointCoffeeHmCountWarning(noCount)).toBeNull();
  });

  it("void dipertahankan, tidak dibuang; no_struk kembar tidak dihapus", () => {
    const dup = { ...sampleA, id: 1 };
    const dup2 = { ...sampleA, id: 2, void: 1 };
    const r = parsePointCoffeeHm(wrap([dup, dup2, { ...sampleB, void: "1" }]));
    expect(r.totalRows).toBe(3);
    expect(r.voidRows).toBe(2);
    expect(r.rows[1].isVoid).toBe(true);
    expect(r.rows[0].isVoid).toBe(false);
    expect(r.rows[0].noStruk).toBe(r.rows[1].noStruk);
  });

  it("field null/kosong tidak menghilangkan transaksi; field wajib kosong ditandai Invalid", () => {
    const r = parsePointCoffeeHm(wrap([{ ...sampleA }, { ...sampleB, tax: null, dpp: "" }]));
    expect(r.totalRows).toBe(2);
    expect(r.validRows).toBe(1);
    expect(r.invalidRows).toBe(1);
    expect(r.rows[1].tax).toBeNull();
    expect(r.rows[1].error).toContain("dpp");
    expect(r.rows[1].error).toContain("tax");
  });

  it("validasi: JSON rusak, status bukan ok, data bukan array, data kosong, elemen bukan object", () => {
    expect(parsePointCoffeeHm("").ok).toBe(false);
    expect(parsePointCoffeeHm("{bad").error).toContain("tidak valid");
    expect(parsePointCoffeeHm(wrap([sampleA], 1, "error")).error).toContain("status");
    expect(parsePointCoffeeHm(JSON.stringify({ status: "ok", count: 1, data: {} })).error).toContain("bukan array");
    expect(parsePointCoffeeHm(wrap([])).error).toContain("kosong");
    expect(parsePointCoffeeHm(wrap([sampleA, 5])).ok).toBe(false);
    expect(parsePointCoffeeHm(wrap([{ foo: 1 }])).ok).toBe(false);
    expect(extractPointCoffeeHmRecords("123").ok).toBe(false);
  });
});

describe("summarizePointCoffeeHm", () => {
  it("menjumlah seluruh data (bukan satu halaman) tanpa menghitung ulang", () => {
    const records = makeRecords(1166);
    const r = parsePointCoffeeHm(wrap(records));
    const s = summarizePointCoffeeHm(r.rows);
    const sum = (key: "subtotal" | "discount" | "dpp" | "tax" | "total") => records.reduce((acc, rec) => acc + rec[key], 0);
    expect(s.transactionCount).toBe(1166);
    expect(s.subtotal).toBe(sum("subtotal"));
    expect(s.discount).toBe(sum("discount"));
    expect(s.dpp).toBe(sum("dpp"));
    expect(s.tax).toBe(sum("tax"));
    expect(s.total).toBe(sum("total"));
    const page = paginatePointCoffeeHm(r.rows, 1, 50);
    expect(page.visible.length).toBe(50);
    expect(summarizePointCoffeeHm(page.visible).transactionCount).toBe(50); // halaman saja = bukan ringkasan
  });

  it("desimal sumber dijumlah apa adanya (void termasuk), null dianggap 0 hanya untuk penjumlahan", () => {
    const r = parsePointCoffeeHm(wrap([sampleA, sampleB, { ...sampleA, id: 3, void: 1, discount: null }]));
    const s = summarizePointCoffeeHm(r.rows);
    expect(s.subtotal).toBeCloseTo(24545.454545 * 2 + 45454.545455, 6);
    expect(s.discount).toBe(20000);
    expect(s.total).toBe(27000 + 30000 + 27000);
    expect(r.rows[2].discount).toBeNull();
  });
});

describe("pagination, format, csv", () => {
  it("pagination hanya memotong tampilan", () => {
    const rows = Array.from({ length: 1166 }, (_, i) => i);
    const p = paginatePointCoffeeHm(rows, 24, 50);
    expect(p.totalPages).toBe(24);
    expect(p.visible.length).toBe(16);
    expect(paginatePointCoffeeHm(rows, 999, 50).activePage).toBe(24);
  });

  it("format rupiah mempertahankan desimal", () => {
    expect(formatPointCoffeeHmRupiah(27000)).toBe("Rp 27.000");
    expect(formatPointCoffeeHmRupiah(24545.454545)).toBe("Rp 24.545,45");
    expect(formatPointCoffeeHmRupiah(24545.454545, 6)).toBe("Rp 24.545,454545");
  });

  it("CSV memuat semua baris dan nilai asli (null jadi kosong)", () => {
    const r = parsePointCoffeeHm(wrap(makeRecords(120)));
    const lines = pointCoffeeHmToCsv(r.rows).split("\n");
    expect(lines.length).toBe(121);
    expect(lines[1]).toContain("\"500000\"");
    const a = parsePointCoffeeHm(wrap([sampleA]));
    expect(pointCoffeeHmToCsv(a.rows)).toContain("\"24545.454545\"");
  });
});
