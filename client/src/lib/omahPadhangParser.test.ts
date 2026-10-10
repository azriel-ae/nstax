import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { convertDateTime, parseOmahPadhangCsv, parseOmahPadhangZip, parseOmahPadhangZips } from "./omahPadhangParser";

// Fixture sintetis hanya untuk menguji parser (bukan data hasil aplikasi).
const HEADER = "Outlet,Date,Time,Gross Sales,Discounts,Refunds,Net Sales,Gratuity,Tax,Total Collected,Total Amount,Other Note (Optional),Receipt Number,Collected By,Served By,Customer,Customer Phone,Items,Payment Method,Event Type,Reason of Refund";
const line = (o: Partial<Record<string, string>> = {}) => {
  const v = { outlet: "Outlet 1", date: "05-02-2030", time: "08:09:10", gross: "1000.0", disc: "100.0", ref: "0.0", net: "900.0", grat: "45.0", tax: "94.5", coll: "2000.0", total: "1039.5", note: "", rcpt: "T1", by: "S", served: "", cust: "", phone: "", items: '"A, B, C"', pay: "Cash", event: "Payment", reason: "", ...o };
  return [v.outlet, v.date, v.time, v.gross, v.disc, v.ref, v.net, v.grat, v.tax, v.coll, v.total, v.note, v.rcpt, v.by, v.served, v.cust, v.phone, v.items, v.pay, v.event, v.reason].join(",");
};
const csv = (...lines: string[]) => [HEADER, ...lines].join("\n");
const zipOf = async (files: Record<string, string>) => {
  const zip = new JSZip();
  Object.entries(files).forEach(([name, content]) => zip.file(name, content));
  return zip.generateAsync({ type: "uint8array" });
};

describe("convertDateTime", () => {
  it("DD-MM-YYYY HH:mm:ss → YYYY-MM-DD HH:mm:ss", () => {
    expect(convertDateTime("05-02-2030", "08:09:10")).toBe("2030-02-05 08:09:10");
  });
  it("menolak tanggal/waktu tidak valid", () => {
    expect(convertDateTime("31-02-2030", "08:09:10")).toBeNull();
    expect(convertDateTime("05-02-2030", "25:00:00")).toBeNull();
    expect(convertDateTime("", "08:09:10")).toBeNull();
  });
});

describe("parseOmahPadhangCsv", () => {
  it("koma di dalam field Items ber-quote tidak menggeser kolom", () => {
    const r = parseOmahPadhangCsv(csv(line()), "a.csv");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].keterangan).toBe("A, B, C");
    expect(r.rows[0].eventType).toBe("Payment");
  });
  it("memetakan field & rumus: dpp = G - E + H, total = K (bukan Total Collected)", () => {
    const [row] = parseOmahPadhangCsv(csv(line()), "a.csv").rows;
    expect(row).toMatchObject({ id_agent: "omahpadhang_kabpas", no_struk: "T1", date_trans: "2030-02-05 08:09:10", subtotal: 900, service_charge: 45, discount: 100, dpp: 845, tax: 94.5, total: 1039.5 });
  });
  it("pemetaan memakai header, bukan posisi kolom", () => {
    const cols = HEADER.split(",");
    // item ber-quote: gabungkan ulang saat membalik urutan
    const rec = line({ items: "X" }).split(",");
    const rev = [...cols].reverse().join(",");
    const text = `${rev}\n${[...rec].reverse().join(",")}`;
    const r = parseOmahPadhangCsv(text, "rev.csv");
    expect(rec.length).toBe(cols.length);
    expect(r.rows[0]).toMatchObject({ no_struk: "T1", subtotal: 900, tax: 94.5, total: 1039.5, keterangan: "X" });
  });
  it("mempertahankan desimal, tidak membulatkan", () => {
    const [row] = parseOmahPadhangCsv(csv(line({ net: "100.25", disc: "0.1", grat: "0.2", tax: "10.5", total: "110.95" })), "a.csv").rows;
    expect(row.dpp).toBeCloseTo(100.35, 6);
    expect(row.subtotal).toBe(100.25);
  });
  it("header wajib hilang → error, tidak menebak", () => {
    const bad = csv(line()).replace("Net Sales", "Netto");
    const r = parseOmahPadhangCsv(bad, "a.csv");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/net sales/);
  });
  it("header ambigu → error", () => {
    const r = parseOmahPadhangCsv(csv(line()).replace("Gratuity", "Tax"), "a.csv");
    expect(r.ok).toBe(false);
  });
  it("baris kosong & baris Grand Total dilewati; baris kolom tidak pas ditandai invalid", () => {
    const text = csv(line(), "", "Grand Total,,,1,1,1,1,1,1,1,1,,,,,,,,,,", line({ rcpt: "T2" }), "Outlet 1,05-02-2030,08:00:00,1,1");
    const r = parseOmahPadhangCsv(text, "a.csv");
    expect(r.rows.map((x) => x.no_struk)).toEqual(["T1", "T2"]);
    expect(r.summaryRowsSkipped).toBe(1);
    expect(r.invalidRows).toBe(1);
  });
  it("angka kosong/tidak valid → baris invalid, bukan angka buatan", () => {
    const r = parseOmahPadhangCsv(csv(line({ tax: "" }), line({ net: "abc" })), "a.csv");
    expect(r.rows).toHaveLength(0);
    expect(r.invalidRows).toBe(2);
  });
  it("no struk kosong ditandai, tidak dibuatkan pengganti", () => {
    const [row] = parseOmahPadhangCsv(csv(line({ rcpt: "" })), "a.csv").rows;
    expect(row.no_struk).toBe("");
    expect(row.issues.join()).toMatch(/kosong/);
  });
  it("BOM dan CRLF ditangani", () => {
    const r = parseOmahPadhangCsv("﻿" + csv(line(), line({ rcpt: "T2" })).replace(/\n/g, "\r\n"), "a.csv");
    expect(r.rows).toHaveLength(2);
  });
});

describe("parseOmahPadhangZip", () => {
  it("mengekstrak ZIP, menggabungkan banyak CSV, ringkasan dari seluruh data", async () => {
    const bytes = await zipOf({ "x/a.csv": csv(line(), line({ rcpt: "T2" })), "x/b.csv": csv(line({ rcpt: "T3", net: "100.0", disc: "0.0", grat: "5.0", tax: "10.5", total: "115.5" })), "readme.txt": "bukan csv" });
    const r = await parseOmahPadhangZip(bytes, "t.zip");
    expect(r.ok).toBe(true);
    expect(r.csvFound).toBe(2);
    expect(r.rows).toHaveLength(3);
    expect(r.summary).toMatchObject({ files: 2, count: 3, subtotal: 1900, service_charge: 95, discount: 200, dpp: 1795, tax: 199.5, total: 2194.5 });
  });
  it("CSV berisi sama yang muncul dua kali tidak digandakan", async () => {
    const same = csv(line());
    const r = await parseOmahPadhangZip(await zipOf({ "a.csv": same, "copy/b.csv": same }), "t.zip");
    expect(r.rows).toHaveLength(1);
    expect(r.files.filter((f) => f.status === "duplicate")).toHaveLength(1);
  });
  it("no struk duplikat antar-file tidak dihapus, hanya ditandai", async () => {
    const r = await parseOmahPadhangZip(await zipOf({ "a.csv": csv(line()), "b.csv": csv(line({ net: "1.0", disc: "0.0", grat: "0.0", tax: "0.0", total: "1.0" })) }), "t.zip");
    expect(r.rows).toHaveLength(2);
    expect(r.duplicateReceipts).toBe(1);
    expect(r.rows[0].issues.join()).toMatch(/duplikat/);
  });
  it("ZIP rusak → error jelas", async () => {
    const r = await parseOmahPadhangZip(new Uint8Array([1, 2, 3, 4]), "rusak.zip");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/rusak/);
    expect(r.rows).toHaveLength(0);
  });
  it("ZIP tanpa CSV → error jelas", async () => {
    const r = await parseOmahPadhangZip(await zipOf({ "a.txt": "x" }), "t.zip");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/tidak berisi file CSV/);
  });
  it("CSV dengan header salah → error, tanpa transaksi", async () => {
    const r = await parseOmahPadhangZip(await zipOf({ "a.csv": "foo,bar\n1,2" }), "t.zip");
    expect(r.ok).toBe(false);
    expect(r.rows).toHaveLength(0);
  });
  it("menolak file non-zip (CSV langsung)", async () => {
    const r = await parseOmahPadhangZip(new TextEncoder().encode(csv(line())), "a.csv");
    expect(r.ok).toBe(false);
  });
});

describe("parseOmahPadhangZips (banyak ZIP)", () => {
  it("satu ZIP = hasil identik dengan parseOmahPadhangZip", async () => {
    const data = await zipOf({ "a.csv": csv(line({ rcpt: "T1" })) });
    const single = await parseOmahPadhangZip(data, "x.zip");
    const multi = await parseOmahPadhangZips([{ data, name: "x.zip" }]);
    expect(multi.result).toEqual(single);
    expect(multi.zips).toMatchObject([{ zipName: "x.zip", status: "processed", transactions: 1 }]);
  });

  it("beberapa ZIP harian digabung menjadi satu dataset; ringkasan dari seluruh baris", async () => {
    const z1 = await zipOf({ "d1.csv": csv(line({ rcpt: "A1", date: "01-09-2030" }), line({ rcpt: "A2", date: "01-09-2030" })) });
    const z2 = await zipOf({ "d2.csv": csv(line({ rcpt: "B1", date: "02-09-2030" })) });
    const z3 = await zipOf({ "d3.csv": csv(line({ rcpt: "C1", date: "03-09-2030" })) });
    const { result, zips } = await parseOmahPadhangZips([{ data: z1, name: "01.zip" }, { data: z2, name: "02.zip" }, { data: z3, name: "03.zip" }]);
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(4);
    expect(result.summary.count).toBe(4);
    expect(result.summary.files).toBe(3);
    expect(result.summary.total).toBeCloseTo(4 * 1039.5, 6);
    expect(zips.map((z) => z.status)).toEqual(["processed", "processed", "processed"]);
    expect(result.rows[0].filename).toBe("01.zip › d1.csv"); // asal baris tetap bisa ditelusuri
  });

  it("ZIP yang sama dipilih dua kali dengan isi sama tidak menggandakan transaksi", async () => {
    const a = await zipOf({ "d1.csv": csv(line({ rcpt: "A1" })) });
    const b = await zipOf({ "copy-of-d1.csv": csv(line({ rcpt: "A1" })) });
    const c = await zipOf({ "d2.csv": csv(line({ rcpt: "B1", date: "02-09-2030" })) });
    const { result, zips } = await parseOmahPadhangZips([{ data: a, name: "a.zip" }, { data: b, name: "b.zip" }, { data: c, name: "c.zip" }]);
    expect(result.rows).toHaveLength(2);
    expect(zips.map((z) => z.status)).toEqual(["processed", "skipped", "processed"]);
  });

  it("satu ZIP gagal di antara ZIP valid: ditandai failed, yang lain tetap dihitung", async () => {
    const good = await zipOf({ "d1.csv": csv(line({ rcpt: "A1" })) });
    const { result, zips } = await parseOmahPadhangZips([{ data: good, name: "good.zip" }, { data: new Uint8Array([1, 2, 3]), name: "rusak.zip" }, { data: good, name: "notzip.txt" }]);
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(zips.find((z) => z.zipName === "rusak.zip")?.status).toBe("failed");
    expect(zips.find((z) => z.zipName === "notzip.txt")?.status).toBe("failed");
  });

  it("semua ZIP gagal → hasil gagal dengan alasan per file", async () => {
    const { result, zips } = await parseOmahPadhangZips([{ data: new Uint8Array([1]), name: "a.zip" }, { data: new Uint8Array([2]), name: "b.zip" }]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("a.zip");
    expect(zips.every((z) => z.status === "failed")).toBe(true);
  });

  it("no_struk yang sama lintas ZIP ditandai (tidak dihapus), tanpa penandaan ganda", async () => {
    const a = await zipOf({ "d1.csv": csv(line({ rcpt: "DUP", date: "01-09-2030" })) });
    const b = await zipOf({ "d2.csv": csv(line({ rcpt: "DUP", date: "02-09-2030" })) });
    const { result } = await parseOmahPadhangZips([{ data: a, name: "a.zip" }, { data: b, name: "b.zip" }]);
    expect(result.rows).toHaveLength(2);
    expect(result.duplicateReceipts).toBe(1);
    result.rows.forEach((r) => expect(r.issues.filter((m) => m.startsWith("No struk duplikat"))).toHaveLength(1));
  });
});
