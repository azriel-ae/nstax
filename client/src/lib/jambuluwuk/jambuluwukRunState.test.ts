import { describe, expect, it } from "vitest";
import { deriveView, finishRun, IDLE, startRun, type Failure, type RunInputs, type RunPhase } from "./jambuluwukRunState";
import type { QueryResult } from "./jambuluwukSql";

const result = (n: number): QueryResult => ({ columns: ["total"], rows: Array.from({ length: n }, () => [null]), warnings: [], stages: [] });
const inp = (over: Partial<RunInputs> = {}): RunInputs => ({ profile: "HOTEL", sql: "SELECT 1", sourceVersion: 1, ...over });
const fail: Failure = { message: "x", pos: null, length: 1, row: null, sql: "SELECT 1" };
const ok = (r: QueryResult, i = inp()): RunPhase => ({ kind: "success", runId: 1, inputs: i, result: r, fileName: "f.xls" });

describe("visibilitas hasil query JAMBULUWUK (status eksekusi + identitas input)", () => {
  it("1/2. belum pernah dijalankan (halaman dibuka / file diunggah saja): tidak ada hasil", () => {
    expect(deriveView(IDLE, inp())).toEqual({ kind: "none" });
    expect(deriveView(IDLE, inp({ sourceVersion: 2 }))).toEqual({ kind: "none" });
  });
  it("3. query valid berhasil dengan baris: ready", () => {
    expect(deriveView(ok(result(3)), inp()).kind).toBe("ready");
  });
  it("4. berhasil tanpa baris dibedakan dari belum dijalankan: empty vs none", () => {
    expect(deriveView(ok(result(0)), inp()).kind).toBe("empty");
    expect(deriveView(IDLE, inp()).kind).toBe("none");
  });
  it("5. query gagal: bukan hasil; error ditampilkan, hasil sebelumnya tidak kembali", () => {
    const running = startRun(2, inp());
    expect(deriveView(running, inp())).toEqual({ kind: "running" });
    const failed = finishRun(running, 2, { kind: "error", runId: 2, inputs: inp(), failure: fail });
    expect(deriveView(failed, inp()).kind).toBe("error");
  });
  it("6. query diedit setelah sukses: hasil lama stale (disembunyikan)", () => {
    expect(deriveView(ok(result(3)), inp({ sql: "SELECT 2" }))).toMatchObject({ kind: "stale", reason: "query" });
  });
  it("7. ganti profil: hasil profil sebelumnya tidak tampil", () => {
    expect(deriveView(ok(result(3)), inp({ profile: "RESTO" }))).toMatchObject({ kind: "stale", reason: "profil", previousProfile: "HOTEL" });
    expect(deriveView(startRun(3, inp()), inp({ profile: "RESTO" })).kind).toBe("none");
  });
  it("8. ganti file: hasil lama stale sampai eksekusi baru", () => {
    expect(deriveView(ok(result(3)), inp({ sourceVersion: 2 }))).toMatchObject({ kind: "stale", reason: "file" });
  });
  it("9. jalankan ulang: hasil baru menggantikan, tidak dicampur", () => {
    const running = startRun(5, inp({ sql: "SELECT 2" }));
    expect(deriveView(running, inp({ sql: "SELECT 2" })).kind).toBe("running"); // hasil lama tidak tampil selama berjalan
    const done = finishRun(running, 5, { kind: "success", runId: 5, inputs: inp({ sql: "SELECT 2" }), result: result(7), fileName: "f.xls" });
    const v = deriveView(done, inp({ sql: "SELECT 2" }));
    expect(v.kind === "ready" && v.result.rows.length).toBe(7);
  });
  it("hasil dari eksekusi usang diabaikan (file diganti / hasil direset saat berjalan)", () => {
    const running = startRun(6, inp());
    expect(finishRun(IDLE, 6, { kind: "success", runId: 6, inputs: inp(), result: result(1), fileName: "f" })).toBe(IDLE);
    expect(finishRun(startRun(7, inp()), 6, { kind: "success", runId: 6, inputs: inp(), result: result(1), fileName: "f" }).kind).toBe("running");
    expect(running.kind).toBe("running");
  });
  it("error pada profil/file lain tidak ikut tampil", () => {
    const e: RunPhase = { kind: "error", runId: 1, inputs: inp(), failure: fail };
    expect(deriveView(e, inp({ profile: "RESTO" })).kind).toBe("none");
    expect(deriveView(e, inp({ sourceVersion: 9 })).kind).toBe("none");
    expect(deriveView(e, inp({ sql: "edit" })).kind).toBe("error"); // teks query tetap bisa diperbaiki dengan pesan terlihat
  });
  it("mengubah klausa WHERE (tanggal) di editor membuat hasil lama kedaluwarsa, tidak tampil sebagai hasil terbaru", () => {
    const sql1 = "SELECT 1 FROM t WHERE date_trans LIKE '2026-09-01'";
    const sql2 = "SELECT 1 FROM t WHERE date_trans LIKE '2026-09%'";
    const done: RunPhase = { kind: "success", runId: 1, inputs: inp({ sql: sql1 }), result: result(3), fileName: "f" };
    expect(deriveView(done, inp({ sql: sql1 })).kind).toBe("ready");
    expect(deriveView(done, inp({ sql: sql2 }))).toMatchObject({ kind: "stale", reason: "query" });
  });
});
