import { describe, expect, it } from "vitest";
import { detectApiTrans } from "./apiTransDetector";

const base = {
  service_charge: null, discount: null, keterangan: null, pos_tipe: null, void: 0,
  log_time: "2026-10-17 21:28:57", id_server: "0", outlet_name: "",
};
const hangry = { ...base, id: 481378, id_agent: "hangry_sda", no_struk: "H136261017MGNY", date_trans: "2026-10-17 23:03:16", subtotal: 38180, dpp: 38180, tax: 3818, total: 42002, nama_usaha: "Hangry Sidoarjo", id_outlet: "H136" };
const nasgor = { ...base, id: 480786, id_agent: "nasgor69", no_struk: "10/26/10502", date_trans: "2026-10-17 00:00:00", subtotal: 69545, dpp: 69545, tax: 6954.5, total: 76499.5, nama_usaha: "Nasgor69", id_outlet: "nasgor69pas" };
const point = { ...base, id: 424403, id_agent: "point_pas", no_struk: "260929012000000014", date_trans: "2026-09-29 18:42:53", subtotal: 24545.454545, dpp: 2454.545455, tax: 2454.545455, total: 27000, nama_usaha: "Point Coffee", id_outlet: "P036" };
const family = { ...base, id: 482153, id_agent: "familymart_sda", no_struk: "2154-9126101700190578", date_trans: "2026-10-18 00:00:00", subtotal: 18180, dpp: 18180, tax: 1818, total: 20000, nama_usaha: "Family Mart Sidoarjo", id_outlet: "" };
const family2 = { ...family, id: 482152, no_struk: "2134-9126101800190952", subtotal: 84550, dpp: 84550, tax: 8455, total: 93000 };
const wrap = (data: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ status: "ok", count: data.length, data, ...extra });

describe("detectApiTrans: keempat perusahaan", () => {
  it("Hangry terdeteksi (id_agent hangry_sda)", () => {
    const d = detectApiTrans(wrap([hangry]));
    expect(d).toMatchObject({ ok: true, kind: "hangrySda", label: "HANGRY SDA", recordCount: 1 });
  });
  it("NASGOR69 terdeteksi dan TIDAK jatuh ke Hangry", () => {
    expect(detectApiTrans(wrap([nasgor, nasgor]))).toMatchObject({ ok: true, kind: "nasgor69" });
  });
  it("POINTCOFFE HM terdeteksi", () => {
    expect(detectApiTrans(wrap([point]))).toMatchObject({ ok: true, kind: "pointcoffeHm" });
  });
  it("FAMILY MART terdeteksi (banyak outlet/prefix no_struk dalam satu file)", () => {
    expect(detectApiTrans(wrap([family, family2]))).toMatchObject({ ok: true, kind: "familyMart", recordCount: 2 });
  });
  it("FAMILY MART tidak jatuh ke perusahaan lain dan sebaliknya", () => {
    expect(detectApiTrans(wrap([family, hangry]))).toMatchObject({ ok: false });
    expect(detectApiTrans(wrap([{ ...family, nama_usaha: "Hangry Sidoarjo" }]))).toMatchObject({ ok: false });
  });
  it("tebakan lama 'familymart' polos tidak dipakai lagi", () => {
    expect(detectApiTrans(wrap([{ ...family, id_agent: "familymart", nama_usaha: "FamilyMart" }]))).toMatchObject({ ok: false });
  });
  it("array polos juga dikenali (seperti parser lama)", () => {
    expect(detectApiTrans(JSON.stringify([nasgor]))).toMatchObject({ ok: true, kind: "nasgor69" });
  });
  it("struktur identik tidak cukup: tiga perusahaan berstruktur sama tetap dibedakan lewat identitas", () => {
    const kinds = [hangry, nasgor, point].map((r) => { const d = detectApiTrans(wrap([r])); return d.ok ? d.kind : "x"; });
    expect(kinds).toEqual(["hangrySda", "nasgor69", "pointcoffeHm"]);
  });
  it("normalisasi huruf besar/kecil dan spasi", () => {
    expect(detectApiTrans(wrap([{ ...hangry, id_agent: "  HANGRY_SDA  ", nama_usaha: "hangry   sidoarjo" }]))).toMatchObject({ ok: true, kind: "hangrySda" });
    expect(detectApiTrans(wrap([{ ...nasgor, id_agent: " NasGor69 ", nama_usaha: " NASGOR69" }]))).toMatchObject({ ok: true, kind: "nasgor69" });
  });
  it("hanya nama_usaha atau hanya id_agent yang dikenali tetap cukup bila tidak bertentangan", () => {
    const { nama_usaha: _n, ...noName } = hangry;
    expect(detectApiTrans(wrap([noName]))).toMatchObject({ ok: true, kind: "hangrySda" });
    const { id_agent: _a, ...noAgent } = point;
    expect(detectApiTrans(wrap([noAgent]))).toMatchObject({ ok: true, kind: "pointcoffeHm" });
  });
  it("file besar (3.000 record) terdeteksi dengan jumlah yang benar", () => {
    const data = Array.from({ length: 3000 }, (_, i) => ({ ...hangry, id: i }));
    expect(detectApiTrans(wrap(data))).toMatchObject({ ok: true, kind: "hangrySda", recordCount: 3000 });
  });
});

describe("detectApiTrans: penolakan", () => {
  const reason = (s: string) => { const d = detectApiTrans(s); return d.ok ? "" : d.reason; };
  it("JSON rusak", () => expect(reason("{rusak")).toMatch(/JSON tidak valid/));
  it("input kosong / spasi", () => { expect(reason("")).toMatch(/kosong/i); expect(reason("   \n")).toMatch(/kosong/i); });
  it("data kosong", () => expect(reason(wrap([]))).toMatch(/Data kosong/));
  it("status bukan ok", () => expect(reason(wrap([hangry], { status: "error" }))).toMatch(/Status/));
  it("data bukan array / root bukan object", () => {
    expect(reason(JSON.stringify({ status: "ok", data: {} }))).toMatch(/Struktur JSON/);
    expect(reason("123")).toMatch(/Struktur JSON/);
  });
  it("elemen bukan object", () => expect(reason(wrap([hangry, 7]))).toMatch(/bukan object/));
  it("identitas bertentangan dalam satu record (id_agent vs nama_usaha)", () => {
    expect(reason(wrap([{ ...hangry, nama_usaha: "Nasgor69" }]))).toMatch(/tidak konsisten/);
  });
  it("dua perusahaan dalam satu file", () => {
    expect(reason(wrap([hangry, nasgor]))).toMatch(/tidak konsisten.*HANGRY SDA 1.*NASGOR69 1|tidak konsisten.*NASGOR69 1.*HANGRY SDA 1/);
  });
  it("identitas hilang sama sekali", () => {
    const { id_agent: _a, nama_usaha: _n, ...anon } = hangry;
    expect(reason(wrap([anon]))).toMatch(/Format tidak dikenali/);
  });
  it("identitas tidak dikenal (agen lain) tidak menebak parser", () => {
    expect(reason(wrap([{ ...hangry, id_agent: "toko_lain", nama_usaha: "Toko Lain" }]))).toMatch(/Format tidak dikenali/);
  });
  it("sebagian record tanpa identitas: ditolak, bukan dipilihkan parser", () => {
    const { id_agent: _a, nama_usaha: _n, ...anon } = hangry;
    expect(reason(wrap([hangry, anon, hangry]))).toMatch(/tidak cukup kuat.*1 dari 3/);
  });
  it("kemiripan struktur saja tidak dipakai (id_agent mirip tapi tidak persis)", () => {
    expect(reason(wrap([{ ...hangry, id_agent: "hangry_sda_2", nama_usaha: "x" }]))).toMatch(/Format tidak dikenali/);
    expect(reason(wrap([{ ...nasgor, id_agent: "nasgor", nama_usaha: "" }]))).toMatch(/Format tidak dikenali/);
  });
});
