import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseJambuluwukWorkbook } from "./jambuluwukParser";
import { registryForSource } from "./jambuluwukQueries";
import { isMetadataStatement, runMetadata, validateStatement } from "./jambuluwukMeta";
import { SqlError, validateSql } from "./jambuluwukSql";

const HEADER = ["FOLIO", "FODATE", "FOSHIFT", "CATEGORY", "NAME", "REMARK", "REFERENCE", "DEBIT", "CREDIT", "NETT"];
const line = (folio: unknown, name: string, nett: unknown) => [folio, 1, "1", "0101", name, "", "", 0, 0, nett];
const source = (rows: unknown[][]) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["LAPORAN"], [], HEADER, ...rows]), "S");
  return parseJambuluwukWorkbook(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer, "01.09.2026.xlsx");
};
const loaded = () => source([line(100, "Room Charge", 1000), line(100, "Tax Room", 99), line(200, "Restaurant", 300), line(300, "Room Misc", null)]);

describe("metadata: SHOW TABLES / DESCRIBE / SHOW COLUMNS", () => {
  it("SHOW TABLES saat tabel virtual tersedia: hasil dari registry aktual (jumlah baris dari data)", () => {
    const src = loaded();
    expect(src.ok).toBe(true);
    const reg = registryForSource(src);
    const res = runMetadata("SHOW TABLES;", reg);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0][0]).toBe("d_file_data");
    expect(res.rows[0][3]).toBe(String(src.rows.length));
    expect(res.rows[0][2]).toBe("5");
  });

  it("SHOW TABLES tanpa sumber data: hasil kosong yang valid + catatan informatif", () => {
    const res = runMetadata("show tables", registryForSource(null));
    expect(res.rows).toEqual([]);
    expect(res.notes.join(" ")).toMatch(/Belum ada sumber data/);
  });

  it("file gagal dibaca juga dianggap belum ada sumber data", () => {
    const bad = parseJambuluwukWorkbook(new ArrayBuffer(8), "x.xlsx");
    expect(bad.ok).toBe(false);
    expect(runMetadata("SHOW TABLES", registryForSource(bad)).rows).toEqual([]);
  });

  it("DESCRIBE dan SHOW COLUMNS FROM menampilkan kolom, posisi sumber, dan tipe hasil inferensi dari data", () => {
    const reg = registryForSource(loaded());
    for (const sql of ["DESCRIBE d_file_data;", "DESC `d_file_data`", "SHOW COLUMNS FROM d_file_data;", "SHOW FIELDS IN D_FILE_DATA"]) {
      const res = runMetadata(sql, reg);
      expect(res.rows.map((r) => r[0])).toEqual(["A", "E", "J", "filename", "id_command"]);
      expect(res.rows.map((r) => r[4])).toEqual(["A", "E", "J", "(virtual)", "(virtual)"]);
    }
    const res = runMetadata("DESCRIBE d_file_data", reg);
    const byName = Object.fromEntries(res.rows.map((r) => [r[0], r]));
    expect(byName.J[5]).toBe("numerik"); // 1000, 99, 300 + satu sel kosong
    expect(byName.J[2]).toBe("YES"); // ada sel NETT kosong pada data yang dimuat
    expect(byName.E[5]).toBe("teks");
    expect(byName.id_command[5]).toBe("konstanta");
    expect(res.notes[0]).toContain("baris dimuat");
  });

  it("SHOW FULL COLUMNS menambah jumlah baris terisi/kosong yang benar", () => {
    const res = runMetadata("SHOW FULL COLUMNS FROM d_file_data", registryForSource(loaded()));
    const j = res.rows.find((r) => r[0] === "J")!;
    expect(res.columns.slice(-2)).toEqual(["Baris_terisi", "Baris_kosong"]);
    expect(Number(j[6]) + Number(j[7])).toBeGreaterThan(0);
    expect(j[7]).toBe("1");
  });

  it("nama tabel tidak ditemukan → SqlError dengan daftar tabel tersedia", () => {
    const reg = registryForSource(loaded());
    expect(() => runMetadata("DESCRIBE tabel_lain", reg)).toThrow(/tidak ditemukan.*d_file_data/s);
    expect(() => runMetadata("SHOW COLUMNS FROM tabel_lain", reg)).toThrow(SqlError);
  });

  it("nama tabel tidak ditemukan tanpa sumber data → pesan menjelaskan belum ada file", () => {
    expect(() => runMetadata("DESCRIBE d_file_data", registryForSource(null))).toThrow(/belum ada file Excel/);
  });

  it("sintaks tidak didukung ditolak dengan pesan jelas, bukan diabaikan", () => {
    const reg = registryForSource(loaded());
    expect(() => runMetadata("SHOW DATABASES", reg)).toThrow(/belum didukung/);
    expect(() => runMetadata("SHOW TABLES LIKE 'd%'", reg)).toThrow(/belum didukung/);
    expect(() => runMetadata("SHOW TABLES; SELECT 1", reg)).toThrow(/tidak terduga/);
    expect(() => runMetadata("DESCRIBE", reg)).toThrow(/nama tabel/);
    expect(() => runMetadata("SHOW COLUMNS d_file_data", reg)).toThrow(/FROM/);
  });

  it("deteksi dan validasi; perilaku SELECT tidak berubah", () => {
    expect(isMetadataStatement("-- c\nSHOW TABLES")).toBe(true);
    expect(isMetadataStatement("SELECT * FROM d_file_data")).toBe(false);
    expect(validateStatement("SHOW TABLES;")).toMatchObject({ ok: true, metadata: true });
    expect(validateStatement("SHOW NOPE")).toMatchObject({ ok: false, metadata: true });
    expect(validateStatement("SELECT A FROM d_file_data")).toMatchObject({ ok: true, metadata: false });
    // mesin SELECT tetap menolak perintah pengubah data
    const del = validateSql("DELETE FROM d_file_data");
    expect(del.ok).toBe(false);
  });
});
