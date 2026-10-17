import { describe, expect, it } from "vitest";
import {
  formatSql, locate, runSql, SqlError, sumResultColumn, validateSql, valueToString, valueToNumber,
  type QueryResult, type SqlSourceRow,
} from "./jambuluwukSql";
import { DEFAULT_QUERIES, initialQuery, loadSavedQuery, resetQuery, saveQuery } from "./jambuluwukQueries";

// Fixture sintetis hanya untuk menguji mesin query (bukan data hasil aplikasi).
const FILE = "01.09.2026.xls";
const mk = (lines: Array<[unknown, string, unknown]>, filename = FILE): SqlSourceRow[] =>
  lines.map(([folio, name, nett], i) => ({
    n: i + 2,
    A: folio === null ? null : String(folio),
    E: name,
    J: nett === null ? null : String(nett),
    filename,
    id_command: "UPL0192",
  }));

const DATA = mk([
  [100, "Room Charge Deluxe", 1000],
  [100, "Disc Room Charge Deluxe", -100],
  [100, "Service Room", 90],
  [100, "Tax Room", 99],
  [100, "Laundry Express", 50],
  [100, "Breakfast Package", 200],
  [100, "Restaurant - Service", 20],
  [100, "Restaurant - Tax", 22],
  [200, "Restaurant - Food", 300],
  [200, "FO City Ledger", 777],
]);

const col = (r: QueryResult, name: string) => r.columns.findIndex((c) => c.toLowerCase() === name.toLowerCase());
const cell = (r: QueryResult, row: number, name: string) => r.rows[row][col(r, name)];
const num = (r: QueryResult, row: number, name: string) => valueToNumber(cell(r, row, name));
const run = (sql: string, rows: readonly SqlSourceRow[] = DATA) => runSql(sql, rows);
const errorOf = async (sql: string, rows: readonly SqlSourceRow[] = DATA) => {
  try { await run(sql, rows); } catch (e) { return e as SqlError; }
  throw new Error("query seharusnya gagal");
};

describe("query default HOTEL", () => {
  it("menerapkan filter, rumus, grup, dan pembulatan HOTEL", async () => {
    const r = await run(DEFAULT_QUERIES.HOTEL);
    expect(r.columns).toEqual(["id_agent", "no_struk", "date_trans", "dpp", "subtotal", "discount", "service_charge", "tax", "total", "keterangan", "namaFile"]);
    expect(r.rows).toHaveLength(1); // folio 200 tidak punya item HOTEL
    expect(valueToString(cell(r, 0, "id_agent"))).toBe("hotel_jambuluwuk");
    expect(valueToString(cell(r, 0, "no_struk"))).toBe("100-2026-09-01");
    expect(valueToString(cell(r, 0, "date_trans"))).toBe("2026-09-01");
    expect([num(r, 0, "dpp"), num(r, 0, "subtotal"), num(r, 0, "discount"), num(r, 0, "service_charge"), num(r, 0, "tax"), num(r, 0, "total")]).toEqual([950, 1050, -100, 90, 99, 1139]);
    expect(valueToString(cell(r, 0, "keterangan"))).toBe("no folio = 100");
    // sesuai SQL acuan: namaFile HOTEL = alias nama = nilai kolom E (baris pertama grup), BUKAN nama file
    expect(valueToString(cell(r, 0, "namaFile"))).toBe("Room Charge Deluxe");
    expect(r.warnings.join(" ")).toMatch(/"E"/);
  });
});

describe("query default RESTO", () => {
  it("menerapkan filter, rumus, dan pajak RESTO", async () => {
    const r = await run(DEFAULT_QUERIES.RESTO);
    expect(r.rows.map((_, i) => valueToString(cell(r, i, "no_struk"))).sort()).toEqual(["100-2026-09-01", "200-2026-09-01"]);
    const i100 = r.rows.findIndex((_, i) => valueToString(cell(r, i, "keterangan")) === "no folio = 100");
    expect([num(r, i100, "dpp"), num(r, i100, "subtotal"), num(r, i100, "discount"), num(r, i100, "service_charge"), num(r, i100, "tax"), num(r, i100, "total")]).toEqual([200, 200, 0, 20, 22, 242]);
    expect(valueToString(cell(r, i100, "id_agent"))).toBe("resto_jambuluwuk");
    // SQL acuan RESTO juga memakai "nama AS namaFile" di SELECT akhir (nama = kolom E), bukan alias namaFile di CTE
    expect(valueToString(cell(r, i100, "namaFile"))).toBe("Breakfast Package");
    expect(sumResultColumn(r, "total")).toBe(572); // folio 200: tanpa baris Tax → tax 30, total 330
    const i200 = r.rows.findIndex((_, i) => valueToString(cell(r, i, "keterangan")) === "no folio = 200");
    expect([num(r, i200, "dpp"), num(r, i200, "tax"), num(r, i200, "total")]).toEqual([300, 30, 330]);
    expect(sumResultColumn(r, "dpp")).toBe(500);
    expect(r.rows).toHaveLength(2);
  });
});

describe("perubahan query memengaruhi hasil", () => {
  it("mengubah REGEXP filter HOTEL (hapus Laundry) mengubah dpp", async () => {
    const edited = DEFAULT_QUERIES.HOTEL.replace("Phone|Jeep", "Jeep").replace("Laundry|", "");
    expect(edited).not.toBe(DEFAULT_QUERIES.HOTEL);
    const r = await run(edited);
    expect(num(r, 0, "dpp")).toBe(900);
    expect(num(r, 0, "subtotal")).toBe(1000);
    expect(num(r, 0, "total")).toBe(1089);
  });
  it("pajak HOTEL: 'Tax Room' dan 'Room Tax' sama-sama dihitung; filter yang diperluas menambah pajak lain", async () => {
    const r1 = await run(DEFAULT_QUERIES.HOTEL, mk([[1, "Room Charge", 1000], [1, "Service Room", 100], [1, "Room Tax", 110]]));
    expect([num(r1, 0, "dpp"), num(r1, 0, "service_charge"), num(r1, 0, "tax"), num(r1, 0, "total")]).toEqual([1000, 100, 110, 1210]);
    const edited = DEFAULT_QUERIES.HOTEL.replace("Room|Miscellaneous", "Room|Restaurant - Tax|Miscellaneous");
    expect(edited).not.toBe(DEFAULT_QUERIES.HOTEL);
    const r = await run(edited);
    expect(num(r, 0, "tax")).toBe(121); // 99 + 22
  });
  it("tax: ada baris Tax → diambil langsung; tidak ada → (dpp + service_charge) / 10; selalu ROUND(tax, 2)", async () => {
    const r = await run(DEFAULT_QUERIES.HOTEL, mk([[1, "Room Charge", 1000], [1, "Service Room", 100], [2, "Room Charge", 1000], [2, "Service Room", 100], [2, "Tax Room", 105], [3, "Room Charge", "333.33"], [4, "Room Charge", 500], [4, "Tax Room", 0]]));
    const byFolio = (f: string) => r.rows.findIndex((_, i) => valueToString(cell(r, i, "keterangan")) === `no folio = ${f}`);
    expect([num(r, byFolio("1"), "tax"), num(r, byFolio("1"), "total")]).toEqual([110, 1210]);
    expect([num(r, byFolio("2"), "tax"), num(r, byFolio("2"), "total")]).toEqual([105, 1205]);
    expect([num(r, byFolio("3"), "tax"), num(r, byFolio("3"), "total")]).toEqual([33.33, 366.66]);
    expect([num(r, byFolio("4"), "tax"), num(r, byFolio("4"), "total")]).toEqual([0, 500]);
    expect(DEFAULT_QUERIES.HOTEL).toContain("ROUND(tax, 2) AS tax");
    expect(DEFAULT_QUERIES.RESTO).toContain("ROUND(tax, 2) AS tax");
  });
  it("mengubah rumus total dan subtotal mengubah hasil yang dihitung", async () => {
    const edited = DEFAULT_QUERIES.HOTEL
      .replace("ROUND(dpp + service_charge + tax, 2) AS total", "ROUND(subtotal - discount + tax, 2) AS total")
      .replace("ROUND(subtotal, 2) AS subtotal", "ROUND(subtotal * 2, 2) AS subtotal");
    const r = await run(edited);
    expect(num(r, 0, "subtotal")).toBe(2100);
    expect(num(r, 0, "total")).toBe(1050 + 100 + 99);
    const original = await run(DEFAULT_QUERIES.HOTEL);
    expect(num(original, 0, "total")).toBe(1139);
  });
  it("ringkasan dihitung dari hasil query yang dijalankan, bukan nilai tetap", async () => {
    const q = "SELECT A AS folio, SUM(CAST(J AS DECIMAL(15,4))) AS nilai FROM d_file_data WHERE E REGEXP 'Room' GROUP BY A";
    const r = await run(q);
    expect(sumResultColumn(r, "nilai")).toBe(1000 - 100 + 90 + 99);
    const r2 = await run(q.replace("'Room'", "'Laundry'"));
    expect(sumResultColumn(r2, "nilai")).toBe(50);
  });
});

describe("presisi dan semantik MySQL", () => {
  const q = (name: string) => `SELECT SUM(CAST(J AS DECIMAL(15,4))) AS v FROM d_file_data WHERE E = '${name}'`;
  it("CAST DECIMAL(15,4) membulatkan per baris sebelum dijumlah; total memakai jumlah belum dibulatkan", async () => {
    const rows = mk([[1, "Room Charge", "0.00444"], [1, "Service Room", "0.00444"], [1, "Tax Room", "0.00444"]]);
    const r = await run(DEFAULT_QUERIES.HOTEL, rows);
    expect([num(r, 0, "dpp"), num(r, 0, "service_charge"), num(r, 0, "tax"), num(r, 0, "total")]).toEqual([0, 0, 0, 0.01]);
  });
  it("ROUND setengah menjauhi nol untuk positif dan negatif", async () => {
    const rows = mk([[1, "Room Charge", "10.005"], [2, "Room Charge", "-10.005"]]);
    const r = await run(DEFAULT_QUERIES.HOTEL, rows);
    expect(r.rows.map((_, i) => num(r, i, "dpp")).sort((a, b) => (a as number) - (b as number))).toEqual([-10.01, 10.01]);
  });
  it("tidak ada galat floating point (0.1 + 0.2)", async () => {
    const rows = mk([[1, "a", "0.1"], [1, "a", "0.2"]]);
    const r = await run("SELECT SUM(CAST(J AS DECIMAL(15,4))) AS v FROM d_file_data", rows);
    expect(valueToString(r.rows[0][0])).toBe("0.3000");
  });
  it("REGEXP tidak membedakan huruf besar/kecil dan GROUP BY tidak membedakan case teks", async () => {
    const rows = mk([[1, "room charge", 10], [1, "TAX ROOM", 1]]);
    const r = await run(DEFAULT_QUERIES.HOTEL, rows);
    expect([num(r, 0, "dpp"), num(r, 0, "tax")]).toEqual([10, 1]);
  });
  it("NULL: SUM mengabaikan sel J kosong; jika semua kosong hasilnya NULL (seperti MySQL)", async () => {
    const rows = mk([[1, "Room Charge", null]]);
    const r = await run(DEFAULT_QUERIES.HOTEL, rows);
    expect(cell(r, 0, "dpp")).toBeNull();
    const mixed = await run(DEFAULT_QUERIES.HOTEL, mk([[1, "Room Charge", null], [1, "Room Extra", 7]]));
    expect(num(mixed, 0, "dpp")).toBe(7);
    const r2 = await run("SELECT SUM(CAST(J AS DECIMAL(15,4))) AS v FROM d_file_data", rows);
    expect(r2.rows[0][0]).toBeNull();
    const r3 = await run("SELECT COUNT(*) AS c, COUNT(J) AS cj FROM d_file_data", rows);
    expect([num(r3, 0, "c"), num(r3, 0, "cj")]).toEqual([1, 0]);
  });
  it("pembagian memakai 4 desimal tambahan dan pembagian nol = NULL", async () => {
    const r = await run("SELECT 1 / 3 AS a, 10 / 0 AS b, 7 % 4 AS c, -5 + 2 AS d, 2 * 3.5 AS e FROM d_file_data WHERE E = 'Tax Room'");
    expect(valueToString(r.rows[0][0])).toBe("0.3333");
    expect(r.rows[0][1]).toBeNull();
    expect(valueToString(r.rows[0][2])).toBe("3");
    expect(valueToString(r.rows[0][3])).toBe("-3");
    expect(valueToString(r.rows[0][4])).toBe("7.0");
  });
  it("hasil >100 folio dihitung seluruhnya", async () => {
    const lines: Array<[unknown, string, unknown]> = [];
    for (let i = 1; i <= 250; i++) lines.push([i, "Room Charge", 100]);
    const r = await run(DEFAULT_QUERIES.HOTEL, mk(lines));
    expect(r.rows).toHaveLength(250);
    expect(sumResultColumn(r, "total")).toBe(27500); // tanpa baris Tax → tax 10% dari dpp
  });
  it("tanpa data yang cocok → hasil kosong, tanpa data pengganti", async () => {
    const r = await run(DEFAULT_QUERIES.HOTEL, mk([[1, "FO City Ledger", 100]]));
    expect(r.rows).toEqual([]);
    expect(sumResultColumn(r, "total")).toBe(0);
  });
  it("kolom J tidak valid → error menyebut baris Excel, tidak diabaikan diam-diam", async () => {
    const e = await errorOf(DEFAULT_QUERIES.HOTEL, mk([[1, "Room Charge", "12x"]]));
    expect(e).toBeInstanceOf(SqlError);
    expect(e.message).toMatch(/12x/);
    expect(e.row).toBe(2);
    // baris di luar filter tidak ikut dievaluasi (CASE malas), sehingga tidak menimbulkan error
    const ok = await run(DEFAULT_QUERIES.HOTEL, mk([[1, "Room Charge", 5], [1, "FO City Ledger", "abc"]]));
    expect(ok.rows).toHaveLength(1);
  });
  it("nilai di luar DECIMAL(15,4) ditolak", async () => {
    const e = await errorOf(DEFAULT_QUERIES.HOTEL, mk([[1, "Room Charge", "100000000000"]]));
    expect(e.message).toMatch(/DECIMAL\(15,4\)/);
  });
});

describe("tanggal dari nama file", () => {
  it("01.09.2026.xls → 2026-09-01 lewat SUBSTRING_INDEX + STR_TO_DATE + DATE_FORMAT", async () => {
    const r = await run("SELECT STR_TO_DATE(SUBSTRING_INDEX(filename, '.', 3), '%d.%m.%Y') AS d, DATE_FORMAT(STR_TO_DATE(SUBSTRING_INDEX(filename, '.', 3), '%d.%m.%Y'), '%Y-%m-%d') AS f, SUBSTRING_INDEX(filename, '.', 3) AS s, SUBSTRING_INDEX(filename, '.', -1) AS ext FROM d_file_data WHERE E = 'Tax Room'");
    expect(valueToString(r.rows[0][0])).toBe("2026-09-01");
    expect(valueToString(r.rows[0][1])).toBe("2026-09-01");
    expect(valueToString(r.rows[0][2])).toBe("01.09.2026");
    expect(valueToString(r.rows[0][3])).toBe("xls");
    // Query default memfilter September 2026 lewat WHERE; untuk file Desember 2027 pengguna mengganti WHERE di editor.
    const dec2027 = DEFAULT_QUERIES.HOTEL.replace("WHERE date_trans >= '2026-09-01'\n  AND date_trans < '2026-10-01'", "WHERE date_trans LIKE '2027-12-15'");
    expect(dec2027).not.toBe(DEFAULT_QUERIES.HOTEL);
    const r2 = await run(dec2027, mk([[1, "Room Charge", 5]], "15.12.2027.xlsx"));
    expect(valueToString(cell(r2, 0, "date_trans"))).toBe("2027-12-15");
    expect(valueToString(cell(r2, 0, "no_struk"))).toBe("1-2027-12-15");
  });
  it("tanggal mustahil → NULL (31.02) dan format tidak didukung → error jelas", async () => {
    const r = await run("SELECT STR_TO_DATE('31.02.2026', '%d.%m.%Y') AS d FROM d_file_data WHERE E = 'Tax Room'");
    expect(r.rows[0][0]).toBeNull();
    const e = await errorOf("SELECT STR_TO_DATE('x', '%W') AS d FROM d_file_data");
    expect(e.message).toMatch(/%W/);
  });
});

describe("pergantian profil tanpa upload ulang", () => {
  it("HOTEL dan RESTO memakai baris sumber yang sama dan tidak mengubahnya", async () => {
    const rows = mk([[1, "Room Charge", 100], [1, "Restaurant - Food", 50]]);
    const snapshot = JSON.stringify(rows);
    Object.freeze(rows);
    rows.forEach((r) => Object.freeze(r));
    const hotel = await run(DEFAULT_QUERIES.HOTEL, rows);
    const resto = await run(DEFAULT_QUERIES.RESTO, rows);
    const hotel2 = await run(DEFAULT_QUERIES.HOTEL, rows);
    expect(num(hotel, 0, "dpp")).toBe(100);
    expect(num(resto, 0, "dpp")).toBe(50);
    expect(hotel2).toEqual(hotel);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
});

describe("validasi dan pesan error", () => {
  const expectInvalid = (sql: string, message: RegExp) => {
    const v = validateSql(sql);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.error.message).toMatch(message);
      expect(v.error.pos).not.toBeNull();
    }
  };
  it("query default HOTEL dan RESTO valid", () => {
    expect(validateSql(DEFAULT_QUERIES.HOTEL).ok).toBe(true);
    expect(validateSql(DEFAULT_QUERIES.RESTO).ok).toBe(true);
  });
  it("sintaks salah menunjuk posisi bermasalah", () => {
    const sql = "SELECT A AS folio\nFROM d_file_data\nWHERE E REGEXP";
    const v = validateSql(sql);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      const loc = locate(sql, v.error.pos ?? 0);
      expect(loc.line).toBe(3);
    }
    expectInvalid("SELECT FROM d_file_data", /.+/);
    expectInvalid("SELECT A FROM", /nama tabel/);
    expectInvalid("SELECT 'abc FROM d_file_data", /tidak ditutup/);
    expectInvalid("SELECT (A FROM d_file_data", /"\)"/);
  });
  it("kolom, tabel, dan fungsi yang tidak dikenal ditolak", () => {
    expectInvalid("SELECT Z FROM d_file_data", /Kolom "Z" tidak ditemukan/);
    expectInvalid("SELECT A FROM tabel_lain", /Tabel "tabel_lain" tidak ditemukan/);
    expectInvalid("SELECT FOO(A) FROM d_file_data", /FOO\(\) belum didukung/);
    expectInvalid("SELECT x.A FROM d_file_data d", /Alias\/tabel "x"/);
    expectInvalid("SELECT ROUND() FROM d_file_data", /ROUND\(\) membutuhkan/);
  });
  it("sintaks yang belum didukung ditolak, tidak diabaikan diam-diam", () => {
    expectInvalid("SELECT A FROM d_file_data ORDER BY A", /ORDER belum didukung/);
    expectInvalid("SELECT A FROM d_file_data LIMIT 5", /LIMIT belum didukung/);
    expectInvalid("SELECT DISTINCT A FROM d_file_data", /DISTINCT belum didukung/);
    expectInvalid("SELECT a.A FROM d_file_data a JOIN d_file_data b ON a.A = b.A", /JOIN belum didukung/);
    expectInvalid("SELECT A FROM d_file_data UNION SELECT E FROM d_file_data", /UNION belum didukung/);
    expectInvalid("SELECT CASE A WHEN 1 THEN 2 END FROM d_file_data", /CASE ekspresi/);
    expectInvalid("SELECT CAST(A AS DATE) FROM d_file_data", /Tipe CAST/);
    expectInvalid("SELECT A FROM d_file_data WHERE SUM(1) > 0", /agregat/);
    expectInvalid("SELECT SUM(SUM(1)) FROM d_file_data", /bersarang/);
  });
  it("perintah berbahaya atau multi-pernyataan ditolak", () => {
    expectInvalid("DELETE FROM d_file_data", /Hanya query SELECT/);
    expectInvalid("DROP TABLE d_file_data", /Hanya query SELECT/);
    expectInvalid("SELECT A FROM d_file_data; DROP TABLE x", /satu pernyataan/);
    expectInvalid("", /kosong/);
  });
  it("REGEXP tidak valid atau berisiko ditolak saat dijalankan", async () => {
    expect((await errorOf("SELECT A FROM d_file_data WHERE E REGEXP '('")).message).toMatch(/tidak valid/);
    expect((await errorOf("SELECT A FROM d_file_data WHERE E REGEXP '(a+)+$'")).message).toMatch(/backtracking/);
  });
  it("query yang gagal tidak menghasilkan hasil", async () => {
    await expect(run("SELECT Z FROM d_file_data")).rejects.toBeInstanceOf(SqlError);
  });
  it("komentar dan titik koma akhir diperbolehkan", async () => {
    const r = await run("-- komentar\nSELECT /* x */ COUNT(*) AS c FROM d_file_data; ");
    expect(num(r, 0, "c")).toBe(DATA.length);
  });
});

describe("format query", () => {
  it("menghasilkan query yang setara dan stabil (idempoten) untuk query default", async () => {
    for (const profile of ["HOTEL", "RESTO"] as const) {
      const formatted = formatSql(DEFAULT_QUERIES[profile]);
      expect(formatSql(formatted)).toBe(formatted);
      expect(validateSql(formatted).ok).toBe(true);
      const a = await run(DEFAULT_QUERIES[profile]);
      const b = await run(formatted);
      expect(b).toEqual(a);
    }
  });
  it("merapikan query satu baris dan mempertahankan teks serta komentar", async () => {
    const messy = "select a as folio, sum(cast(trim(j) as decimal(15,4))) as v from d_file_data d where d.e regexp 'Room|Tax' and d.a not regexp 'FOLIO' -- catatan\n group by d.a";
    const f = formatSql(messy);
    expect(f).toContain("SELECT\n");
    expect(f).toContain("'Room|Tax'");
    expect(f).toContain("-- catatan");
    expect(f).toMatch(/\n\s*AND d\.a NOT REGEXP/);
    expect(formatSql(f)).toBe(f);
    expect(await run(f)).toEqual(await run(messy));
  });
  it("tanda minus unary dan * tidak rusak", async () => {
    const f = formatSql("select -5 + 2 as a, count(*) as c, d.* from d_file_data d group by d.a");
    expect(f).toContain("-5 + 2");
    expect(f).toContain("COUNT(*)");
    expect(f).toContain("d.*");
    expect(validateSql(f).ok).toBe(true);
  });
  it("query dengan kesalahan lexical memunculkan SqlError saat diformat", () => {
    expect(() => formatSql("SELECT 'abc")).toThrow(SqlError);
  });
});

describe("penyimpanan query (localStorage)", () => {
  const fakeStorage = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), map: m };
  };
  it("menyimpan HOTEL dan RESTO secara terpisah dan tetap ada setelah 'reload'", () => {
    const st = fakeStorage();
    expect(initialQuery("HOTEL", st).sql).toBe(DEFAULT_QUERIES.HOTEL);
    expect(saveQuery("HOTEL", "SELECT 1 AS h FROM d_file_data", st).ok).toBe(true);
    // 'reload' = baca ulang dari storage yang sama
    expect(initialQuery("HOTEL", st).sql).toBe("SELECT 1 AS h FROM d_file_data");
    expect(initialQuery("HOTEL", st).saved).not.toBeNull();
    // RESTO tidak tertimpa
    expect(initialQuery("RESTO", st).sql).toBe(DEFAULT_QUERIES.RESTO);
    expect(loadSavedQuery("RESTO", st)).toBeNull();
    saveQuery("RESTO", "SELECT 2 AS r FROM d_file_data", st);
    expect(loadSavedQuery("HOTEL", st)!.sql).toBe("SELECT 1 AS h FROM d_file_data");
    expect(loadSavedQuery("RESTO", st)!.sql).toBe("SELECT 2 AS r FROM d_file_data");
  });
  it("reset hanya menghapus profil yang dipilih dan mengembalikan default", () => {
    const st = fakeStorage();
    saveQuery("HOTEL", "SELECT 1 AS h FROM d_file_data", st);
    saveQuery("RESTO", "SELECT 2 AS r FROM d_file_data", st);
    expect(resetQuery("HOTEL", st).ok).toBe(true);
    expect(initialQuery("HOTEL", st).sql).toBe(DEFAULT_QUERIES.HOTEL);
    expect(initialQuery("RESTO", st).sql).toBe("SELECT 2 AS r FROM d_file_data");
  });
  it("tidak menyimpan isi file Excel; hanya teks query dan waktu simpan", () => {
    const st = fakeStorage();
    saveQuery("HOTEL", "SELECT 1 AS h FROM d_file_data", st);
    const stored = JSON.parse([...st.map.values()][0]);
    expect(Object.keys(stored).sort()).toEqual(["savedAt", "sql"]);
  });
  it("storage tidak tersedia atau rusak ditangani tanpa crash", () => {
    expect(saveQuery("HOTEL", "x", null).ok).toBe(false);
    expect(loadSavedQuery("HOTEL", null)).toBeNull();
    const broken = { getItem: () => "{bukan json", setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("x"); } };
    expect(loadSavedQuery("HOTEL", broken)).toBeNull();
    expect(saveQuery("HOTEL", "x", broken).ok).toBe(false);
    expect(resetQuery("HOTEL", broken).ok).toBe(false);
    expect(initialQuery("HOTEL", broken).sql).toBe(DEFAULT_QUERIES.HOTEL);
  });
});
