import { describe, expect, it } from "vitest";
import {
  extractHangrySdaRecords,
  hangrySdaCountWarning,
  hangrySdaToCsv,
  paginateHangrySda,
  parseHangrySda,
  summarizeHangrySda,
} from "./hangrySdaParser";

// Sampel dari spesifikasi (satu transaksi nyata dari pemilik data).
const sample = {
  id: 481378, id_agent: "hangry_sda", no_struk: "H136261017MGNY", date_trans: "2026-10-17 23:03:16",
  subtotal: 38180, service_charge: null, discount: null, dpp: 38180, tax: 3818, total: 42002,
  log_time: "2026-10-18 06:30:07", keterangan: null, pos_tipe: null, nama_usaha: "Hangry Sidoarjo",
  id_server: "S04", void: 0, id_outlet: "H136", outlet_name: "",
};
const wrap = (data: unknown[], count: unknown = data.length, status: unknown = "ok") => JSON.stringify({ status, count, data });

// Dataset sintetis (hanya uji volume). total sengaja TIDAK = subtotal + tax untuk membuktikan tidak dihitung ulang.
const make = (n: number) => Array.from({ length: n }, (_, i) => ({
  ...sample, id: 600000 + i, no_struk: `H136261017${String(i).padStart(6, "0")}`,
  subtotal: 10000 + i, dpp: 9000 + i, tax: 900 + (i % 5), total: 12345 + i,
  discount: i % 4 === 0 ? null : 100, service_charge: null, void: i % 10 === 0 ? 1 : 0,
}));

describe("parseHangrySda", () => {
  it("membaca sampel Hangry dan mempertahankan nilai sumber", () => {
    const r = parseHangrySda(wrap([sample]));
    expect(r.ok).toBe(true);
    expect(r.totalRows).toBe(1);
    const [row] = r.rows;
    expect(row.id).toBe("481378");
    expect(row.idAgent).toBe("hangry_sda");
    expect(row.noStruk).toBe("H136261017MGNY");
    expect(row.dateTrans).toBe("2026-10-17 23:03:16");
    expect([row.subtotal, row.dpp, row.tax, row.total]).toEqual([38180, 38180, 3818, 42002]);
    expect(row.serviceCharge).toBeNull();
    expect(row.discount).toBeNull();
    expect(row.isVoid).toBe(false);
    expect(row.idOutlet).toBe("H136");
    expect(row.outletName).toBe("");
    expect(row.status).toBe("Valid");
  });

  it("tidak menghitung ulang total (total != subtotal + tax tetap apa adanya)", () => {
    const r = parseHangrySda(wrap([sample]));
    expect(r.rows[0].total).toBe(42002);
    expect(r.rows[0].subtotal + r.rows[0].tax!).not.toBe(r.rows[0].total);
  });

  it("dpp tidak diasumsikan sama dengan subtotal", () => {
    const r = parseHangrySda(wrap([{ ...sample, dpp: 30000 }]));
    expect(r.rows[0].subtotal).toBe(38180);
    expect(r.rows[0].dpp).toBe(30000);
  });

  it("null pada service_charge/discount tetap null dan tidak membuat record invalid", () => {
    const r = parseHangrySda(wrap([sample]));
    expect(r.invalidRows).toBe(0);
    const s = summarizeHangrySda(r.rows).all;
    expect(s.discount).toEqual({ sum: 0, validCount: 0, missingCount: 1 });
    expect(s.serviceCharge.missingCount).toBe(1);
  });

  it("void=1 tidak dibuang: dihitung di 'all', dan dipisah di nonVoid/voided", () => {
    const r = parseHangrySda(wrap([sample, { ...sample, id: 2, no_struk: "H136261017VOID", total: 1000, void: 1 }]));
    expect(r.totalRows).toBe(2);
    expect(r.voidRows).toBe(1);
    const s = summarizeHangrySda(r.rows);
    expect(s.all.transactionCount).toBe(2);
    expect(s.all.total.sum).toBe(43002);
    expect(s.nonVoid.transactionCount).toBe(1);
    expect(s.nonVoid.total.sum).toBe(42002);
    expect(s.voided.total.sum).toBe(1000);
  });

  it("nilai wajib tidak valid ditandai Invalid, tidak diubah jadi 0, dan tetap dihitung sebagai baris", () => {
    const r = parseHangrySda(wrap([sample, { ...sample, id: 3, no_struk: "BAD", total: "abc", tax: null }]));
    expect(r.totalRows).toBe(2);
    expect(r.invalidRows).toBe(1);
    const bad = r.rows[1];
    expect(bad.status).toBe("Invalid");
    expect(bad.total).toBeNull();
    expect(bad.tax).toBeNull();
    expect(bad.error).toMatch(/tax, total/);
    const s = summarizeHangrySda(r.rows).all;
    expect(s.total).toEqual({ sum: 42002, validCount: 1, missingCount: 1 });
  });

  it("field hilang (no_struk, date_trans, id) ditandai jelas", () => {
    const { no_struk: _n, date_trans: _d, id: _i, ...rest } = sample;
    const r = parseHangrySda(wrap([sample, rest]));
    expect(r.rows[1].status).toBe("Invalid");
    expect(r.rows[1].error).toMatch(/id, no_struk, date_trans/);
  });

  it("angka string numerik dibaca sebagai angka, bukan digabung sebagai teks", () => {
    const r = parseHangrySda(wrap([{ ...sample, subtotal: "1000", total: "2000" }, { ...sample, id: 9, subtotal: "250", total: "500" }]));
    expect(summarizeHangrySda(r.rows).all.subtotal.sum).toBe(1250);
    expect(summarizeHangrySda(r.rows).all.total.sum).toBe(2500);
  });

  it("mempertahankan nomor struk dan tanggal asli persis", () => {
    const r = parseHangrySda(wrap([{ ...sample, no_struk: "H0360000ABC0", date_trans: "2026-10-17 00:00:00" }]));
    expect(r.rows[0].noStruk).toBe("H0360000ABC0");
    expect(r.rows[0].dateTrans).toBe("2026-10-17 00:00:00");
  });

  it("tidak membuang no_struk kembar: tiap record diproses tepat satu kali", () => {
    const r = parseHangrySda(wrap([sample, sample, sample]));
    expect(r.totalRows).toBe(3);
    expect(summarizeHangrySda(r.rows).all.transactionCount).toBe(3);
  });

  it("dataset besar: jumlah dan total cocok dengan sumber (5.000 record)", () => {
    const data = make(5000);
    const r = parseHangrySda(wrap(data));
    expect(r.totalRows).toBe(5000);
    expect(r.invalidRows).toBe(0);
    const s = summarizeHangrySda(r.rows);
    expect(s.all.total.sum).toBe(data.reduce((a, d) => a + d.total, 0));
    expect(s.all.subtotal.sum).toBe(data.reduce((a, d) => a + d.subtotal, 0));
    expect(s.all.tax.sum).toBe(data.reduce((a, d) => a + d.tax, 0));
    expect(s.all.dpp.sum).toBe(data.reduce((a, d) => a + d.dpp, 0));
    expect(r.voidRows).toBe(500);
    expect(s.nonVoid.transactionCount + s.voided.transactionCount).toBe(5000);
    expect(s.nonVoid.total.sum + s.voided.total.sum).toBe(s.all.total.sum);
    expect(r.rows[0].noStruk).toBe(data[0].no_struk);
    expect(r.rows[4999].noStruk).toBe(data[4999].no_struk);
    // discount null pada i%4==0 -> 1250 null, tidak dihitung sebagai 0
    expect(s.all.discount.missingCount).toBe(1250);
    expect(s.all.discount.sum).toBe(3750 * 100);
  });
});

describe("validasi struktur Hangry", () => {
  it("status bukan ok ditolak sebelum data diproses", () => {
    const r = parseHangrySda(wrap([sample], 1, "error"));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/status/i);
    expect(r.rows).toHaveLength(0);
  });
  it("count tidak cocok: data tetap diproses penuh dan ada peringatan", () => {
    const r = parseHangrySda(wrap([sample, { ...sample, id: 2 }], 50));
    expect(r.ok).toBe(true);
    expect(r.totalRows).toBe(2);
    expect(hangrySdaCountWarning(r)).toMatch(/count API = 50.*aktual di data = 2/);
    expect(hangrySdaCountWarning(parseHangrySda(wrap([sample])))).toBeNull();
  });
  it("JSON rusak, kosong, data kosong, data bukan array, elemen bukan object", () => {
    expect(parseHangrySda("{rusak").error).toMatch(/tidak valid/i);
    expect(parseHangrySda("   ").error).toMatch(/kosong/i);
    expect(parseHangrySda(wrap([])).error).toMatch(/Data kosong/);
    expect(parseHangrySda(JSON.stringify({ status: "ok", data: "x" })).error).toMatch(/bukan array/);
    expect(parseHangrySda(wrap([sample, 5])).error).toMatch(/object transaksi/);
  });
  it("identitas bukan Hangry ditolak (tidak diam-diam diproses)", () => {
    const nasgor = { ...sample, id_agent: "nasgor69", nama_usaha: "Nasgor69" };
    expect(parseHangrySda(wrap([nasgor])).ok).toBe(false);
    expect(parseHangrySda(wrap([sample, nasgor])).error).toMatch(/identitas lain/);
  });
  it("tanpa id_agent/nama_usaha sama sekali ditolak", () => {
    const { id_agent: _a, nama_usaha: _n, ...anon } = sample;
    expect(extractHangrySdaRecords(wrap([anon])).ok).toBe(false);
  });
  it("identitas dinormalisasi (huruf besar dan spasi)", () => {
    expect(parseHangrySda(wrap([{ ...sample, id_agent: "  HANGRY_SDA " }])).ok).toBe(true);
  });
  it("array polos diterima seperti parser lain", () => {
    expect(parseHangrySda(JSON.stringify([sample])).totalRows).toBe(1);
  });
});

describe("helper tampilan", () => {
  it("paginate dan CSV", () => {
    const r = parseHangrySda(wrap(make(120)));
    const p = paginateHangrySda(r.rows, 3, 50);
    expect(p.visible).toHaveLength(20);
    expect(hangrySdaToCsv(r.rows).split("\n")).toHaveLength(121);
  });
});
