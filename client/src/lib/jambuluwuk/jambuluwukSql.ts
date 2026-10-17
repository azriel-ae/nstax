// Mesin query SQL (subset) untuk editor query CEK UPL · JAMBULUWUK.
//
// Bukan database dan bukan penggantian teks berbasis regex: query ditokenisasi, di-parse menjadi AST,
// dianalisis (nama tabel/kolom/fungsi), lalu dievaluasi oleh interpreter TypeScript. Tidak memakai eval/Function.
// Seluruh perhitungan berjalan lokal di browser dan memakai aritmetika desimal eksak (BigInt) seperti DECIMAL MySQL.
//
// ── SINTAKS YANG DIDUKUNG ───────────────────────────────────────────────────────────────────────
//  Pernyataan : [WITH nama AS (SELECT ...) [, ...]] SELECT ... [;]      (hanya SELECT, satu pernyataan)
//  SELECT     : daftar ekspresi dengan alias (AS), atau * ; FROM <tabel> [AS] [alias] ; WHERE ; GROUP BY
//  Tabel      : d_file_data (virtual, dari baris Excel) atau CTE yang sudah didefinisikan di WITH
//  Kolom virtual d_file_data : A, E, J (kolom Excel), filename (nama file yang diunggah), id_command ('UPL0192')
//  Operator   : + - * / %  = <> != < > <= >=  AND OR NOT  IS [NOT] NULL  [NOT] IN (...)  [NOT] LIKE
//               [NOT] REGEXP / RLIKE  BETWEEN ... AND ...
//  CASE       : CASE WHEN ... THEN ... [ELSE ...] END   (bentuk CASE ekspresi WHEN ... tidak didukung)
//  Fungsi     : SUM, COUNT, ROUND, TRIM, CAST(x AS DECIMAL(p,s) | SIGNED | CHAR), STR_TO_DATE, DATE_FORMAT,
//               SUBSTRING_INDEX, CONCAT, COALESCE, IFNULL, ABS, UPPER, LOWER
//  Format tanggal : %d %e %m %c %Y %y (STR_TO_DATE) dan %d %e %m %c %Y %y %H %i %s (DATE_FORMAT)
// ── TIDAK DIDUKUNG (ditolak dengan pesan error, tidak diabaikan) ────────────────────────────────
//  JOIN, UNION, DISTINCT, HAVING, ORDER BY, LIMIT, subquery di dalam ekspresi, fungsi window, INSERT/UPDATE/DELETE/DDL,
//  fungsi di luar daftar di atas.
// ── PERILAKU YANG MENIRU MYSQL ──────────────────────────────────────────────────────────────────
//  • REGEXP memakai RegExp JavaScript dan tidak membedakan huruf besar/kecil; perbandingan teks juga tidak case-sensitive.
//  • Kolom non-agregat yang tidak ada di GROUP BY diambil dari baris pertama dalam grup (MySQL tanpa ONLY_FULL_GROUP_BY);
//    hal ini dilaporkan sebagai peringatan.
//  • NULL mengikuti logika tiga nilai; SUM mengabaikan NULL dan menghasilkan NULL jika tidak ada nilai.
//  • CAST(teks AS DECIMAL(p,s)) membulatkan setengah menjauhi nol; teks bukan angka atau di luar rentang → ERROR
//    (MySQL hanya memberi warning dan menghasilkan 0 — di sini tidak dibiarkan diam-diam).
//  • STR_TO_DATE mengabaikan sisa teks setelah format terpenuhi dan menghasilkan NULL untuk tanggal mustahil.
//  • Urutan baris hasil = urutan kemunculan pertama grup pada data sumber.

export class SqlError extends Error {
  pos: number | null;
  length: number;
  row: number | null;
  constructor(message: string, pos: number | null = null, length = 1, row: number | null = null) {
    super(message);
    this.name = "SqlError";
    this.pos = pos;
    this.length = Math.max(1, length);
    this.row = row;
  }
}

// ───────────────────────── tipe publik ─────────────────────────

export const BASE_TABLE_NAME = "d_file_data";
export const BASE_COLUMNS = ["A", "E", "J", "filename", "id_command"] as const;

export type SqlSourceRow = {
  n: number; // nomor baris di Excel (untuk pesan error)
  A: string | null;
  E: string | null;
  J: string | null;
  filename: string;
  id_command: string;
};

export type Dec = { k: "dec"; v: bigint; s: number };
export type DateV = { k: "date"; y: number; m: number; d: number };
export type Value = null | string | Dec | DateV;

export type QueryStage = { name: string; inputRows: number; matchedRows: number; outputRows: number };

export type QueryResult = {
  columns: string[];
  rows: Value[][];
  warnings: string[];
  stages: QueryStage[];
};

// ───────────────────────── tokenizer ─────────────────────────

type TokKind = "ident" | "qident" | "string" | "number" | "op" | "punct" | "comment" | "eof";
type Token = { kind: TokKind; text: string; raw: string; pos: number; end: number; upper: string };

const OPS2 = ["<=", ">=", "<>", "!="];
const OPS1 = ["=", "<", ">", "+", "-", "*", "/", "%"];
const PUNCT = ["(", ")", ",", ".", ";"];

export function tokenize(sql: string, keepComments = false): Token[] {
  const toks: Token[] = [];
  const n = sql.length;
  let i = 0;
  const push = (kind: TokKind, text: string, pos: number, end: number) =>
    toks.push({ kind, text, raw: sql.slice(pos, end), pos, end, upper: kind === "ident" ? text.toUpperCase() : text });
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if ((c === "-" && sql[i + 1] === "-") || c === "#") {
      const s = i;
      while (i < n && sql[i] !== "\n") i++;
      if (keepComments) push("comment", sql.slice(s, i).replace(/\s+$/, ""), s, i);
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const s = i;
      const close = sql.indexOf("*/", i + 2);
      if (close < 0) throw new SqlError("Komentar /* ... */ tidak ditutup dengan */.", s, 2);
      i = close + 2;
      if (keepComments) push("comment", sql.slice(s, i), s, i);
      continue;
    }
    if (c === "'" || c === '"') {
      const s = i;
      const quote = c;
      let out = "";
      i++;
      let closed = false;
      while (i < n) {
        const ch = sql[i];
        if (ch === "\\" && i + 1 < n) { out += sql[i + 1]; i += 2; continue; }
        if (ch === quote) {
          if (sql[i + 1] === quote) { out += quote; i += 2; continue; }
          closed = true; i++; break;
        }
        out += ch; i++;
      }
      if (!closed) throw new SqlError("Teks (string) tidak ditutup dengan tanda kutip.", s, Math.min(n - s, 12));
      push("string", out, s, i);
      continue;
    }
    if (c === "`") {
      const s = i;
      const close = sql.indexOf("`", i + 1);
      if (close < 0) throw new SqlError("Nama dalam backtick tidak ditutup.", s, 1);
      push("qident", sql.slice(i + 1, close), s, close + 1);
      i = close + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      const s = i;
      while (i < n && /[0-9]/.test(sql[i])) i++;
      if (sql[i] === ".") { i++; while (i < n && /[0-9]/.test(sql[i])) i++; }
      if (i < n && /[A-Za-z_]/.test(sql[i])) throw new SqlError(`Angka "${sql.slice(s, i + 1)}…" tidak valid.`, s, i - s + 1);
      push("number", sql.slice(s, i), s, i);
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const s = i;
      while (i < n && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      push("ident", sql.slice(s, i), s, i);
      continue;
    }
    const two = sql.slice(i, i + 2);
    if (OPS2.includes(two)) { push("op", two, i, i + 2); i += 2; continue; }
    if (OPS1.includes(c)) { push("op", c, i, i + 1); i++; continue; }
    if (PUNCT.includes(c)) { push("punct", c, i, i + 1); i++; continue; }
    throw new SqlError(`Karakter "${c}" tidak dikenali dalam query.`, i, 1);
  }
  toks.push({ kind: "eof", text: "", raw: "", pos: n, end: n, upper: "" });
  return toks;
}

// ───────────────────────── AST ─────────────────────────

type CastType = { kind: "decimal"; p: number; s: number } | { kind: "signed" } | { kind: "char" };

type Expr =
  | { t: "num"; v: Dec; pos: number; len: number }
  | { t: "str"; v: string; pos: number; len: number }
  | { t: "null"; pos: number; len: number }
  | { t: "col"; table: string | null; name: string; pos: number; len: number }
  | { t: "star"; table: string | null; pos: number; len: number }
  | { t: "un"; op: "-" | "+" | "NOT"; e: Expr; pos: number; len: number }
  | { t: "bin"; op: string; l: Expr; r: Expr; pos: number; len: number }
  | { t: "isnull"; e: Expr; neg: boolean; pos: number; len: number }
  | { t: "in"; e: Expr; list: Expr[]; neg: boolean; pos: number; len: number }
  | { t: "like"; e: Expr; p: Expr; neg: boolean; regexp: boolean; pos: number; len: number }
  | { t: "case"; whens: Array<{ c: Expr; r: Expr }>; els: Expr | null; pos: number; len: number }
  | { t: "fn"; name: string; args: Expr[]; cast?: CastType; pos: number; len: number };

type SelItem = { expr: Expr; alias: string | null; text: string; pos: number };
type SelectStmt = { items: SelItem[]; from: { name: string; alias: string | null; pos: number; len: number }; where: Expr | null; groupBy: Expr[]; pos: number };
type Query = { ctes: Array<{ name: string; select: SelectStmt; pos: number }>; main: SelectStmt };

const FUNCS: Record<string, { min: number; max: number }> = {
  SUM: { min: 1, max: 1 }, COUNT: { min: 1, max: 1 }, ROUND: { min: 1, max: 2 }, TRIM: { min: 1, max: 1 },
  STR_TO_DATE: { min: 2, max: 2 }, DATE_FORMAT: { min: 2, max: 2 }, SUBSTRING_INDEX: { min: 3, max: 3 },
  CONCAT: { min: 1, max: Infinity }, COALESCE: { min: 1, max: Infinity }, IFNULL: { min: 2, max: 2 },
  ABS: { min: 1, max: 1 }, UPPER: { min: 1, max: 1 }, LOWER: { min: 1, max: 1 },
};
const AGGREGATES = new Set(["SUM", "COUNT"]);

const RESERVED = new Set([
  "SELECT", "FROM", "WHERE", "GROUP", "BY", "WITH", "AS", "AND", "OR", "NOT", "CASE", "WHEN", "THEN", "ELSE", "END",
  "IS", "NULL", "IN", "LIKE", "REGEXP", "RLIKE", "BETWEEN", "ORDER", "LIMIT", "HAVING", "JOIN", "INNER", "LEFT", "RIGHT",
  "CROSS", "OUTER", "ON", "UNION", "INTERSECT", "EXCEPT", "DISTINCT", "TRUE", "FALSE", "OVER", "XOR", "DIV",
]);
const UNSUPPORTED_CLAUSE = new Set(["ORDER", "LIMIT", "HAVING", "JOIN", "INNER", "LEFT", "RIGHT", "CROSS", "OUTER", "UNION", "INTERSECT", "EXCEPT", "DISTINCT", "OVER", "XOR", "DIV"]);
const TYPE_WORDS = new Set(["DECIMAL", "SIGNED", "UNSIGNED", "CHAR", "INTEGER", "INT"]);

// ───────────────────────── parser ─────────────────────────

class Parser {
  private i = 0;
  constructor(private toks: Token[], private src: string) {}

  private get cur(): Token { return this.toks[this.i]; }
  private peekAt(k: number): Token { return this.toks[Math.min(this.i + k, this.toks.length - 1)]; }
  private advance(): Token { const t = this.toks[this.i]; if (t.kind !== "eof") this.i++; return t; }
  private isKw(word: string, t: Token = this.cur) { return t.kind === "ident" && t.upper === word; }
  private isPunct(p: string, t: Token = this.cur) { return t.kind === "punct" && t.text === p; }
  private isOp(o: string, t: Token = this.cur) { return t.kind === "op" && t.text === o; }
  private describe(t: Token) { return t.kind === "eof" ? "akhir query" : `"${t.raw}"`; }
  private fail(message: string, t: Token = this.cur): never {
    throw new SqlError(message, t.pos, Math.max(1, t.end - t.pos));
  }
  private expectKw(word: string) {
    if (!this.isKw(word)) this.fail(`Diharapkan ${word}, tetapi ditemukan ${this.describe(this.cur)}.`);
    return this.advance();
  }
  private expectPunct(p: string) {
    if (!this.isPunct(p)) this.fail(`Diharapkan "${p}", tetapi ditemukan ${this.describe(this.cur)}.`);
    return this.advance();
  }
  private checkUnsupported(t: Token = this.cur) {
    if (t.kind === "ident" && UNSUPPORTED_CLAUSE.has(t.upper)) {
      this.fail(`${t.upper} belum didukung oleh mesin query ini. Sintaks yang didukung: SELECT, FROM, WHERE, GROUP BY, WITH (CTE).`, t);
    }
  }

  parseQuery(): Query {
    const first = this.cur;
    if (first.kind === "eof") throw new SqlError("Query kosong.", 0, 1);
    if (!this.isKw("SELECT") && !this.isKw("WITH")) {
      this.fail(`Hanya query SELECT (opsional dengan WITH) yang didukung; ditemukan ${this.describe(first)}. Perintah yang mengubah data tidak diizinkan.`);
    }
    const ctes: Query["ctes"] = [];
    if (this.isKw("WITH")) {
      this.advance();
      if (this.isKw("RECURSIVE")) this.fail("WITH RECURSIVE belum didukung.");
      for (;;) {
        const nameTok = this.cur;
        if (nameTok.kind !== "ident" && nameTok.kind !== "qident") this.fail(`Diharapkan nama CTE setelah WITH, ditemukan ${this.describe(nameTok)}.`);
        if (nameTok.kind === "ident" && RESERVED.has(nameTok.upper)) this.fail(`"${nameTok.raw}" adalah kata kunci dan tidak bisa dipakai sebagai nama CTE.`);
        this.advance();
        if (this.isPunct("(")) this.fail("Daftar kolom setelah nama CTE belum didukung; beri nama kolom dengan alias (AS) di dalam SELECT.");
        this.expectKw("AS");
        this.expectPunct("(");
        const select = this.parseSelect();
        this.expectPunct(")");
        ctes.push({ name: nameTok.text, select, pos: nameTok.pos });
        if (this.isPunct(",")) { this.advance(); continue; }
        break;
      }
    }
    if (!this.isKw("SELECT")) this.fail(`Diharapkan SELECT utama setelah definisi WITH, tetapi ditemukan ${this.describe(this.cur)}.`);
    const main = this.parseSelect();
    if (this.isPunct(";")) this.advance();
    if (this.cur.kind !== "eof") {
      this.checkUnsupported();
      this.fail(`Teks tidak terduga ${this.describe(this.cur)} setelah akhir query. Hanya satu pernyataan SELECT yang didukung.`);
    }
    return { ctes, main };
  }

  private parseSelect(): SelectStmt {
    const selTok = this.expectKw("SELECT");
    this.checkUnsupported();
    const items: SelItem[] = [];
    for (;;) {
      const startTok = this.cur;
      let expr: Expr;
      if (this.isOp("*")) {
        this.advance();
        expr = { t: "star", table: null, pos: startTok.pos, len: 1 };
      } else {
        expr = this.parseExpr();
      }
      const lastTok = this.toks[this.i - 1];
      const text = this.src.slice(startTok.pos, lastTok.end).replace(/\s+/g, " ").trim();
      let alias: string | null = null;
      if (this.isKw("AS")) {
        this.advance();
        const a = this.cur;
        if (a.kind !== "ident" && a.kind !== "qident" && a.kind !== "string") this.fail(`Diharapkan alias setelah AS, ditemukan ${this.describe(a)}.`);
        if (a.kind === "ident" && RESERVED.has(a.upper)) this.fail(`"${a.raw}" adalah kata kunci dan tidak bisa dipakai sebagai alias.`);
        alias = a.text;
        this.advance();
      } else if ((this.cur.kind === "ident" && !RESERVED.has(this.cur.upper)) || this.cur.kind === "qident") {
        alias = this.cur.text;
        this.advance();
      }
      if (expr.t === "star" && alias) throw new SqlError("Alias tidak bisa dipakai pada *.", startTok.pos, 1);
      items.push({ expr, alias, text, pos: startTok.pos });
      if (this.isPunct(",")) { this.advance(); continue; }
      break;
    }
    if (!this.isKw("FROM")) {
      this.checkUnsupported();
      this.fail(`Diharapkan FROM setelah daftar kolom SELECT, tetapi ditemukan ${this.describe(this.cur)}.`);
    }
    this.advance();
    const t = this.cur;
    if (this.isPunct("(")) this.fail("Subquery di dalam FROM belum didukung; gunakan WITH (CTE).");
    if (t.kind !== "ident" && t.kind !== "qident") this.fail(`Diharapkan nama tabel setelah FROM, ditemukan ${this.describe(t)}.`);
    if (t.kind === "ident" && RESERVED.has(t.upper)) this.fail(`Diharapkan nama tabel setelah FROM, ditemukan kata kunci "${t.raw}".`);
    this.advance();
    let alias: string | null = null;
    if (this.isKw("AS")) {
      this.advance();
      const a = this.cur;
      if ((a.kind !== "ident" && a.kind !== "qident") || (a.kind === "ident" && RESERVED.has(a.upper))) this.fail(`Diharapkan alias tabel setelah AS, ditemukan ${this.describe(a)}.`);
      alias = a.text;
      this.advance();
    } else if ((this.cur.kind === "ident" && !RESERVED.has(this.cur.upper)) || this.cur.kind === "qident") {
      alias = this.cur.text;
      this.advance();
    }
    if (this.isPunct(",")) this.fail("Beberapa tabel di FROM (join implisit) belum didukung.");
    this.checkUnsupported();
    const from = { name: t.text, alias, pos: t.pos, len: t.end - t.pos };

    let where: Expr | null = null;
    if (this.isKw("WHERE")) { this.advance(); where = this.parseExpr(); }
    const groupBy: Expr[] = [];
    if (this.isKw("GROUP")) {
      this.advance();
      this.expectKw("BY");
      for (;;) {
        groupBy.push(this.parseExpr());
        if (this.isPunct(",")) { this.advance(); continue; }
        break;
      }
    }
    this.checkUnsupported();
    return { items, from, where, groupBy, pos: selTok.pos };
  }

  // ----- ekspresi -----
  parseExpr(): Expr { return this.parseOr(); }

  private parseOr(): Expr {
    let l = this.parseAnd();
    while (this.isKw("OR")) {
      const t = this.advance();
      const r = this.parseAnd();
      l = { t: "bin", op: "OR", l, r, pos: t.pos, len: t.end - t.pos };
    }
    return l;
  }
  private parseAnd(): Expr {
    let l = this.parseNot();
    while (this.isKw("AND")) {
      const t = this.advance();
      const r = this.parseNot();
      l = { t: "bin", op: "AND", l, r, pos: t.pos, len: t.end - t.pos };
    }
    return l;
  }
  private parseNot(): Expr {
    if (this.isKw("NOT")) {
      const t = this.advance();
      return { t: "un", op: "NOT", e: this.parseNot(), pos: t.pos, len: t.end - t.pos };
    }
    return this.parseCmp();
  }
  private parseCmp(): Expr {
    let l = this.parseAdd();
    for (;;) {
      const t = this.cur;
      if (t.kind === "op" && ["=", "<>", "!=", "<", ">", "<=", ">="].includes(t.text)) {
        this.advance();
        const r = this.parseAdd();
        l = { t: "bin", op: t.text === "!=" ? "<>" : t.text, l, r, pos: t.pos, len: t.end - t.pos };
        continue;
      }
      if (this.isKw("IS")) {
        this.advance();
        let neg = false;
        if (this.isKw("NOT")) { this.advance(); neg = true; }
        if (!this.isKw("NULL")) this.fail(`Hanya IS [NOT] NULL yang didukung setelah IS, ditemukan ${this.describe(this.cur)}.`);
        this.advance();
        l = { t: "isnull", e: l, neg, pos: t.pos, len: t.end - t.pos };
        continue;
      }
      let neg = false;
      let opTok = t;
      if (this.isKw("NOT") && (this.isKw("IN", this.peekAt(1)) || this.isKw("LIKE", this.peekAt(1)) || this.isKw("REGEXP", this.peekAt(1)) || this.isKw("RLIKE", this.peekAt(1)) || this.isKw("BETWEEN", this.peekAt(1)))) {
        this.advance();
        neg = true;
        opTok = this.cur;
      }
      if (this.isKw("IN")) {
        this.advance();
        this.expectPunct("(");
        if (this.isKw("SELECT")) this.fail("Subquery di dalam IN belum didukung.");
        const list: Expr[] = [];
        for (;;) {
          list.push(this.parseExpr());
          if (this.isPunct(",")) { this.advance(); continue; }
          break;
        }
        this.expectPunct(")");
        l = { t: "in", e: l, list, neg, pos: opTok.pos, len: opTok.end - opTok.pos };
        continue;
      }
      if (this.isKw("LIKE") || this.isKw("REGEXP") || this.isKw("RLIKE")) {
        const regexp = !this.isKw("LIKE");
        this.advance();
        const p = this.parseAdd();
        if (this.isKw("ESCAPE")) this.fail("LIKE ... ESCAPE belum didukung.");
        l = { t: "like", e: l, p, neg, regexp, pos: opTok.pos, len: opTok.end - opTok.pos };
        continue;
      }
      if (this.isKw("BETWEEN")) {
        this.advance();
        const lo = this.parseAdd();
        this.expectKw("AND");
        const hi = this.parseAdd();
        const both: Expr = {
          t: "bin", op: "AND", pos: opTok.pos, len: opTok.end - opTok.pos,
          l: { t: "bin", op: ">=", l, r: lo, pos: opTok.pos, len: opTok.end - opTok.pos },
          r: { t: "bin", op: "<=", l, r: hi, pos: opTok.pos, len: opTok.end - opTok.pos },
        };
        l = neg ? { t: "un", op: "NOT", e: both, pos: opTok.pos, len: opTok.end - opTok.pos } : both;
        continue;
      }
      break;
    }
    return l;
  }
  private parseAdd(): Expr {
    let l = this.parseMul();
    while (this.cur.kind === "op" && (this.cur.text === "+" || this.cur.text === "-")) {
      const t = this.advance();
      const r = this.parseMul();
      l = { t: "bin", op: t.text, l, r, pos: t.pos, len: 1 };
    }
    return l;
  }
  private parseMul(): Expr {
    let l = this.parseUnary();
    while (this.cur.kind === "op" && (this.cur.text === "*" || this.cur.text === "/" || this.cur.text === "%")) {
      const t = this.advance();
      const r = this.parseUnary();
      l = { t: "bin", op: t.text, l, r, pos: t.pos, len: 1 };
    }
    return l;
  }
  private parseUnary(): Expr {
    if (this.cur.kind === "op" && (this.cur.text === "-" || this.cur.text === "+")) {
      const t = this.advance();
      return { t: "un", op: t.text as "-" | "+", e: this.parseUnary(), pos: t.pos, len: 1 };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.cur;
    const len = t.end - t.pos;
    switch (t.kind) {
      case "number":
        this.advance();
        return { t: "num", v: decFromString(t.text)!, pos: t.pos, len };
      case "string":
        this.advance();
        return { t: "str", v: t.text, pos: t.pos, len };
      case "punct":
        if (t.text === "(") {
          this.advance();
          if (this.isKw("SELECT")) this.fail("Subquery di dalam ekspresi belum didukung.");
          const e = this.parseExpr();
          this.expectPunct(")");
          return e;
        }
        break;
      case "qident":
        return this.parseColumn();
      case "ident": {
        const u = t.upper;
        if (u === "NULL") { this.advance(); return { t: "null", pos: t.pos, len }; }
        if (u === "TRUE" || u === "FALSE") { this.advance(); return { t: "num", v: { k: "dec", v: u === "TRUE" ? 1n : 0n, s: 0 }, pos: t.pos, len }; }
        if (u === "CASE") return this.parseCase();
        if (UNSUPPORTED_CLAUSE.has(u)) this.checkUnsupported(t);
        if (RESERVED.has(u)) this.fail(`Kata kunci ${u} tidak bisa dipakai di posisi ini.`);
        if (this.isPunct("(", this.peekAt(1))) return this.parseCall();
        return this.parseColumn();
      }
      default:
        break;
    }
    this.fail(t.kind === "eof" ? "Query berakhir sebelum ekspresi selesai." : `Ekspresi tidak valid di dekat ${this.describe(t)}.`);
  }

  private parseColumn(): Expr {
    const t = this.advance();
    if (this.isPunct(".")) {
      this.advance();
      const c = this.cur;
      if (this.isOp("*")) {
        this.advance();
        return { t: "star", table: t.text, pos: t.pos, len: c.end - t.pos };
      }
      if (c.kind !== "ident" && c.kind !== "qident") this.fail(`Diharapkan nama kolom setelah "${t.raw}.", ditemukan ${this.describe(c)}.`);
      if (c.kind === "ident" && RESERVED.has(c.upper)) this.fail(`"${c.raw}" adalah kata kunci, bukan nama kolom.`);
      this.advance();
      if (this.isPunct(".")) this.fail("Nama kolom dengan awalan database/skema belum didukung.");
      return { t: "col", table: t.text, name: c.text, pos: t.pos, len: c.end - t.pos };
    }
    return { t: "col", table: null, name: t.text, pos: t.pos, len: t.end - t.pos };
  }

  private parseCase(): Expr {
    const caseTok = this.advance();
    if (!this.isKw("WHEN")) this.fail("Bentuk CASE ekspresi WHEN ... belum didukung; gunakan CASE WHEN kondisi THEN hasil ... END.");
    const whens: Array<{ c: Expr; r: Expr }> = [];
    while (this.isKw("WHEN")) {
      this.advance();
      const c = this.parseExpr();
      this.expectKw("THEN");
      const r = this.parseExpr();
      whens.push({ c, r });
    }
    let els: Expr | null = null;
    if (this.isKw("ELSE")) { this.advance(); els = this.parseExpr(); }
    if (!this.isKw("END")) this.fail(`CASE harus ditutup dengan END, tetapi ditemukan ${this.describe(this.cur)}.`);
    const endTok = this.advance();
    return { t: "case", whens, els, pos: caseTok.pos, len: endTok.end - caseTok.pos };
  }

  private parseCall(): Expr {
    const nameTok = this.advance();
    const name = nameTok.upper;
    const len = nameTok.end - nameTok.pos;
    this.expectPunct("(");
    if (name === "CAST") {
      const e = this.parseExpr();
      this.expectKw("AS");
      const typeTok = this.cur;
      if (typeTok.kind !== "ident" || !TYPE_WORDS.has(typeTok.upper)) this.fail(`Tipe CAST ${this.describe(typeTok)} belum didukung. Tipe yang didukung: DECIMAL(p,s), SIGNED, CHAR.`);
      this.advance();
      let cast: CastType;
      if (typeTok.upper === "DECIMAL") {
        let p = 10;
        let s = 0;
        if (this.isPunct("(")) {
          this.advance();
          const pt = this.cur;
          if (pt.kind !== "number" || pt.text.includes(".")) this.fail("Presisi DECIMAL harus bilangan bulat.");
          p = Number(pt.text);
          this.advance();
          if (this.isPunct(",")) {
            this.advance();
            const st = this.cur;
            if (st.kind !== "number" || st.text.includes(".")) this.fail("Skala DECIMAL harus bilangan bulat.");
            s = Number(st.text);
            this.advance();
          }
          this.expectPunct(")");
        }
        if (p < 1 || p > 65 || s < 0 || s > 30 || s > p) throw new SqlError(`DECIMAL(${p},${s}) tidak valid (presisi 1–65, skala 0–30 dan ≤ presisi).`, typeTok.pos, typeTok.end - typeTok.pos);
        cast = { kind: "decimal", p, s };
      } else if (typeTok.upper === "CHAR") {
        cast = { kind: "char" };
      } else {
        if (typeTok.upper === "UNSIGNED") this.fail("CAST ... AS UNSIGNED belum didukung; gunakan SIGNED atau DECIMAL.", typeTok);
        if (this.isKw("INTEGER") || this.isKw("INT")) this.advance();
        cast = { kind: "signed" };
      }
      this.expectPunct(")");
      return { t: "fn", name, args: [e], cast, pos: nameTok.pos, len };
    }
    const spec = FUNCS[name];
    if (!spec) {
      throw new SqlError(`Fungsi ${nameTok.raw}() belum didukung. Fungsi yang didukung: ${Object.keys(FUNCS).join(", ")}, CAST.`, nameTok.pos, len);
    }
    const args: Expr[] = [];
    if (this.isKw("DISTINCT")) this.fail(`${name}(DISTINCT ...) belum didukung.`);
    if (!this.isPunct(")")) {
      for (;;) {
        if (name === "COUNT" && this.isOp("*")) {
          const s = this.advance();
          args.push({ t: "star", table: null, pos: s.pos, len: 1 });
        } else {
          args.push(this.parseExpr());
        }
        if (this.isKw("FROM")) this.fail(`Bentuk ${name}(... FROM ...) belum didukung; gunakan ${name}(ekspresi).`);
        if (this.isPunct(",")) { this.advance(); continue; }
        break;
      }
    }
    this.expectPunct(")");
    if (args.length < spec.min || args.length > spec.max) {
      const want = spec.min === spec.max ? `${spec.min}` : spec.max === Infinity ? `minimal ${spec.min}` : `${spec.min}–${spec.max}`;
      throw new SqlError(`Fungsi ${name}() membutuhkan ${want} argumen, tetapi diberi ${args.length}.`, nameTok.pos, len);
    }
    return { t: "fn", name, args, pos: nameTok.pos, len };
  }
}

export function parseSql(sql: string): Query {
  return new Parser(tokenize(sql), sql).parseQuery();
}

// ───────────────────────── desimal eksak ─────────────────────────

const P10: bigint[] = [1n];
const pow10 = (n: number): bigint => {
  while (P10.length <= n) P10.push(P10[P10.length - 1] * 10n);
  return P10[n];
};
const mkDec = (v: bigint, s: number): Dec => ({ k: "dec", v, s });
const ZERO = mkDec(0n, 0);
const ONE = mkDec(1n, 0);
const bool = (b: boolean): Dec => (b ? ONE : ZERO);

function roundDiv(n: bigint, d: bigint): bigint {
  const neg = n < 0n;
  const a = neg ? -n : n;
  let q = a / d;
  if ((a % d) * 2n >= d) q += 1n;
  return neg ? -q : q;
}
function rescale(x: Dec, s: number): Dec {
  if (s === x.s) return x;
  if (s > x.s) return mkDec(x.v * pow10(s - x.s), s);
  return mkDec(roundDiv(x.v, pow10(x.s - s)), s);
}
const align = (a: Dec, b: Dec): [bigint, bigint, number] => {
  const s = Math.max(a.s, b.s);
  return [a.v * pow10(s - a.s), b.v * pow10(s - b.s), s];
};
const capScale = (x: Dec): Dec => (x.s > 30 ? rescale(x, 30) : x);

export function decFromString(text: string): Dec | null {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!m) return null;
  const ip = m[2] ?? "";
  const fp = m[3] ?? "";
  if (ip === "" && fp === "") return null;
  const v = BigInt((ip === "" ? "0" : ip) + fp);
  return mkDec(m[1] === "-" ? -v : v, fp.length);
}
export function decToString(x: Dec): string {
  const neg = x.v < 0n;
  let digits = (neg ? -x.v : x.v).toString();
  if (x.s > 0) {
    digits = digits.padStart(x.s + 1, "0");
    return `${neg ? "-" : ""}${digits.slice(0, -x.s)}.${digits.slice(-x.s)}`;
  }
  return `${neg ? "-" : ""}${digits}`;
}
function normalizeDec(x: Dec): Dec {
  let { v, s } = x;
  while (s > 0 && v % 10n === 0n) { v /= 10n; s--; }
  return mkDec(v, s);
}
const decCmp = (a: Dec, b: Dec): number => {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
};
function roundDec(x: Dec, places: number): Dec {
  if (places >= 0) return rescale(x, places);
  const unit = pow10(-places);
  const r = rescale(x, 0);
  return mkDec(roundDiv(r.v, unit) * unit, 0);
}

export const isDec = (v: Value): v is Dec => typeof v === "object" && v !== null && v.k === "dec";
export const isDate = (v: Value): v is DateV => typeof v === "object" && v !== null && v.k === "date";

const pad = (n: number, w: number) => String(n).padStart(w, "0");
const dateToString = (d: DateV) => `${pad(d.y, 4)}-${pad(d.m, 2)}-${pad(d.d, 2)}`;

export function valueToString(v: Value): string {
  if (v === null) return "NULL";
  if (typeof v === "string") return v;
  if (isDec(v)) return decToString(v);
  return dateToString(v);
}
export function valueToNumber(v: Value): number | null {
  if (v === null) return null;
  if (isDec(v)) return Number(decToString(v));
  if (typeof v === "string") { const d = decFromString(v); return d ? Number(decToString(d)) : null; }
  return null;
}
/** Jumlah eksak sebuah kolom hasil (BigInt). null jika kolom tidak ada atau berisi nilai non-numerik. */
export function sumResultColumn(result: QueryResult, column: string): number | null {
  const idx = result.columns.findIndex((c) => c.toLowerCase() === column.toLowerCase());
  if (idx < 0) return null;
  let acc: Dec = ZERO;
  for (const row of result.rows) {
    const v = row[idx];
    if (v === null) continue;
    if (!isDec(v)) return null;
    const [a, b, s] = align(acc, v);
    acc = mkDec(a + b, s);
  }
  return Number(decToString(acc));
}

// ───────────────────────── tanggal ─────────────────────────

const validDate = (y: number, m: number, d: number) => {
  if (m < 1 || m > 12 || d < 1) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
};

function strToDate(input: string, fmt: string, node: Expr): DateV | null {
  let i = 0;
  let y: number | null = null;
  let m: number | null = null;
  let d: number | null = null;
  const num = (min: number, max: number): number | null => {
    let j = i;
    while (j < input.length && j - i < max && /[0-9]/.test(input[j])) j++;
    if (j - i < min) return null;
    const v = Number(input.slice(i, j));
    i = j;
    return v;
  };
  for (let f = 0; f < fmt.length; f++) {
    const c = fmt[f];
    if (c === "%") {
      const spec = fmt[++f];
      let v: number | null;
      switch (spec) {
        case "d": case "e": v = num(1, 2); if (v === null) return null; d = v; break;
        case "m": case "c": v = num(1, 2); if (v === null) return null; m = v; break;
        case "Y": v = num(4, 4); if (v === null) return null; y = v; break;
        case "y": v = num(2, 2); if (v === null) return null; y = v >= 70 ? 1900 + v : 2000 + v; break;
        case "%": if (input[i] !== "%") return null; i++; break;
        default:
          throw new SqlError(`Spesifier format "%${spec ?? ""}" belum didukung di STR_TO_DATE (didukung: %d %e %m %c %Y %y).`, node.pos, node.len);
      }
    } else {
      if (input[i] !== c) return null;
      i++;
    }
  }
  if (y === null || m === null || d === null) return null;
  if (!validDate(y, m, d)) return null;
  return { k: "date", y, m, d };
}

function dateFormat(v: Value, fmt: string, node: Expr): string | null {
  let date: DateV | null = null;
  if (isDate(v)) date = v;
  else if (typeof v === "string") {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v.trim());
    if (m && validDate(Number(m[1]), Number(m[2]), Number(m[3]))) date = { k: "date", y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  }
  if (!date) return null;
  let out = "";
  for (let f = 0; f < fmt.length; f++) {
    const c = fmt[f];
    if (c !== "%") { out += c; continue; }
    const spec = fmt[++f];
    switch (spec) {
      case "Y": out += pad(date.y, 4); break;
      case "y": out += pad(date.y % 100, 2); break;
      case "m": out += pad(date.m, 2); break;
      case "c": out += String(date.m); break;
      case "d": out += pad(date.d, 2); break;
      case "e": out += String(date.d); break;
      case "H": case "i": case "s": out += "00"; break;
      case "%": out += "%"; break;
      default:
        throw new SqlError(`Spesifier format "%${spec ?? ""}" belum didukung di DATE_FORMAT (didukung: %Y %y %m %c %d %e %H %i %s).`, node.pos, node.len);
    }
  }
  return out;
}

// ───────────────────────── analisis statis ─────────────────────────

const containsAggregate = (e: Expr): boolean => {
  switch (e.t) {
    case "fn": return AGGREGATES.has(e.name) || e.args.some(containsAggregate);
    case "un": return containsAggregate(e.e);
    case "bin": return containsAggregate(e.l) || containsAggregate(e.r);
    case "isnull": return containsAggregate(e.e);
    case "in": return containsAggregate(e.e) || e.list.some(containsAggregate);
    case "like": return containsAggregate(e.e) || containsAggregate(e.p);
    case "case": return e.whens.some((w) => containsAggregate(w.c) || containsAggregate(w.r)) || (e.els !== null && containsAggregate(e.els));
    default: return false;
  }
};

/** Kolom yang dirujuk di luar fungsi agregat. */
const bareColumns = (e: Expr, out: Expr[] = []): Expr[] => {
  switch (e.t) {
    case "col": out.push(e); break;
    case "fn": if (!AGGREGATES.has(e.name)) e.args.forEach((a) => bareColumns(a, out)); break;
    case "un": bareColumns(e.e, out); break;
    case "bin": bareColumns(e.l, out); bareColumns(e.r, out); break;
    case "isnull": bareColumns(e.e, out); break;
    case "in": bareColumns(e.e, out); e.list.forEach((a) => bareColumns(a, out)); break;
    case "like": bareColumns(e.e, out); bareColumns(e.p, out); break;
    case "case": e.whens.forEach((w) => { bareColumns(w.c, out); bareColumns(w.r, out); }); if (e.els) bareColumns(e.els, out); break;
    default: break;
  }
  return out;
};

const itemName = (item: SelItem): string => item.alias ?? (item.expr.t === "col" ? item.expr.name : item.text);

type Scope = Map<string, string[]>; // nama relasi (lowercase) → nama kolom (tampilan)

function analyzeSelect(stmt: SelectStmt, scope: Scope, warnings: Set<string>): string[] {
  const rel = scope.get(stmt.from.name.toLowerCase());
  if (!rel) {
    const available = [...scope.keys()].map((k) => (k === BASE_TABLE_NAME ? BASE_TABLE_NAME : k)).join(", ");
    throw new SqlError(`Tabel "${stmt.from.name}" tidak ditemukan. Tabel yang tersedia: ${available}.`, stmt.from.pos, stmt.from.len);
  }
  const qualifiers = new Set([stmt.from.name.toLowerCase(), (stmt.from.alias ?? stmt.from.name).toLowerCase()]);
  const colSet = new Set(rel.map((c) => c.toLowerCase()));

  const check = (e: Expr, ctx: { allowAgg: boolean; inAgg: boolean }): void => {
    switch (e.t) {
      case "col": {
        if (e.table !== null && !qualifiers.has(e.table.toLowerCase())) {
          throw new SqlError(`Alias/tabel "${e.table}" tidak dikenal pada kolom "${e.table}.${e.name}".`, e.pos, e.len);
        }
        if (!colSet.has(e.name.toLowerCase())) {
          throw new SqlError(`Kolom "${e.name}" tidak ditemukan di "${stmt.from.name}". Kolom tersedia: ${rel.join(", ")}.`, e.pos, e.len);
        }
        return;
      }
      case "star": return;
      case "fn": {
        const isAgg = AGGREGATES.has(e.name);
        if (isAgg && !ctx.allowAgg) throw new SqlError(`Fungsi agregat ${e.name}() tidak boleh dipakai di WHERE atau GROUP BY.`, e.pos, e.len);
        if (isAgg && ctx.inAgg) throw new SqlError(`Fungsi agregat ${e.name}() tidak boleh bersarang di dalam fungsi agregat lain.`, e.pos, e.len);
        for (const a of e.args) {
          if (a.t === "star" && !(e.name === "COUNT")) throw new SqlError(`"*" hanya boleh dipakai pada COUNT(*).`, a.pos, a.len);
          check(a, { allowAgg: ctx.allowAgg, inAgg: ctx.inAgg || isAgg });
        }
        return;
      }
      case "un": check(e.e, ctx); return;
      case "bin": check(e.l, ctx); check(e.r, ctx); return;
      case "isnull": check(e.e, ctx); return;
      case "in": check(e.e, ctx); e.list.forEach((a) => check(a, ctx)); return;
      case "like": check(e.e, ctx); check(e.p, ctx); return;
      case "case": e.whens.forEach((w) => { check(w.c, ctx); check(w.r, ctx); }); if (e.els) check(e.els, ctx); return;
      default: return;
    }
  };

  if (stmt.where) check(stmt.where, { allowAgg: false, inAgg: false });
  stmt.groupBy.forEach((g) => check(g, { allowAgg: false, inAgg: false }));
  const names: string[] = [];
  for (const item of stmt.items) {
    if (item.expr.t === "star") {
      if (item.expr.table !== null && !qualifiers.has(item.expr.table.toLowerCase())) {
        throw new SqlError(`Alias/tabel "${item.expr.table}" tidak dikenal.`, item.expr.pos, item.expr.len);
      }
      names.push(...rel);
      continue;
    }
    check(item.expr, { allowAgg: true, inAgg: false });
    names.push(itemName(item));
  }

  const aggregated = stmt.groupBy.length > 0 || stmt.items.some((it) => containsAggregate(it.expr));
  if (aggregated) {
    const grouped = new Set<string>();
    for (const g of stmt.groupBy) if (g.t === "col") grouped.add(g.name.toLowerCase());
    for (const item of stmt.items) {
      const cols = item.expr.t === "star" ? rel.map((c) => ({ name: c })) : bareColumns(item.expr).map((c) => ({ name: (c as Extract<Expr, { t: "col" }>).name }));
      for (const c of cols) {
        if (!grouped.has(c.name.toLowerCase())) {
          warnings.add(`Kolom "${c.name}" dipakai tanpa fungsi agregat dan tidak ada di GROUP BY (dalam "${stmt.from.name}"): nilainya diambil dari baris pertama pada setiap grup, seperti MySQL tanpa ONLY_FULL_GROUP_BY.`);
        }
      }
    }
  }
  return names;
}

function analyze(q: Query): string[] {
  const scope: Scope = new Map();
  scope.set(BASE_TABLE_NAME, [...BASE_COLUMNS]);
  const warnings = new Set<string>();
  for (const cte of q.ctes) {
    const key = cte.name.toLowerCase();
    if (scope.has(key)) throw new SqlError(`Nama CTE "${cte.name}" dipakai lebih dari sekali atau sama dengan tabel yang sudah ada.`, cte.pos, cte.name.length);
    const names = analyzeSelect(cte.select, scope, warnings);
    const seen = new Set<string>();
    for (const nm of names) {
      if (seen.has(nm.toLowerCase())) throw new SqlError(`Kolom "${nm}" duplikat di CTE "${cte.name}"; beri alias yang berbeda.`, cte.select.pos, 6);
      seen.add(nm.toLowerCase());
    }
    scope.set(key, names);
  }
  analyzeSelect(q.main, scope, warnings);
  return [...warnings];
}

// ───────────────────────── evaluator ─────────────────────────

type Row = { n: number; v: Record<string, Value> };
type Ctx = { row: Row; group: Row[] | null };

const regexCache = new Map<string, RegExp>();
const RISKY_REGEX = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/;

function getRegex(pattern: string, node: Expr): RegExp {
  let rx = regexCache.get(pattern);
  if (rx) return rx;
  if (pattern.length > 300) throw new SqlError("Pola REGEXP terlalu panjang (maksimum 300 karakter).", node.pos, node.len);
  if (RISKY_REGEX.test(pattern)) throw new SqlError(`Pola REGEXP "${pattern}" berisiko backtracking berlebihan (kuantifier bersarang) dan ditolak.`, node.pos, node.len);
  try {
    rx = new RegExp(pattern, "i");
  } catch (err) {
    throw new SqlError(`Pola REGEXP "${pattern}" tidak valid: ${(err as Error).message}`, node.pos, node.len);
  }
  if (regexCache.size > 200) regexCache.clear();
  regexCache.set(pattern, rx);
  return rx;
}
function likeToRegex(pattern: string): RegExp {
  let src = "^";
  for (const ch of pattern) {
    if (ch === "%") src += "[\\s\\S]*";
    else if (ch === "_") src += "[\\s\\S]";
    else src += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(src + "$", "i");
}

const toText = (v: Value): string => valueToString(v);

function toDecStrict(v: Value, node: Expr, what: string): Dec | null {
  if (v === null) return null;
  if (isDec(v)) return v;
  if (typeof v === "string") {
    const d = decFromString(v);
    if (!d) throw new SqlError(`${what}: teks "${v.length > 40 ? v.slice(0, 40) + "…" : v}" bukan angka.`, node.pos, node.len);
    return d;
  }
  throw new SqlError(`${what}: tanggal tidak dapat dipakai sebagai angka.`, node.pos, node.len);
}

function compareValues(a: Value, b: Value, node: Expr): number | null {
  if (a === null || b === null) return null;
  if (isDec(a) && isDec(b)) return decCmp(a, b);
  if (isDec(a) || isDec(b)) {
    const x = toDecStrict(a, node, "Perbandingan angka");
    const y = toDecStrict(b, node, "Perbandingan angka");
    return decCmp(x!, y!);
  }
  // Tanggal (DATE) dibandingkan dengan teks tanggal/timestamp seperti MySQL: teks 'YYYY-MM-DD[ HH:MM:SS]' dibaca sebagai
  // waktu, tanggal murni dianggap pukul 00:00:00. Tanpa ini, date_trans = '2026-09-01 00:00:00' atau rentang berbatas
  // timestamp akan salah karena dibandingkan sebagai teks dengan panjang berbeda.
  if (isDate(a) !== isDate(b)) {
    const ka = temporalKey(a), kb = temporalKey(b);
    if (ka !== null && kb !== null) return ka < kb ? -1 : ka > kb ? 1 : 0;
  }
  const x = toText(a).toLowerCase();
  const y = toText(b).toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Kunci urut 'YYYYMMDDHHMMSS' (angka) untuk DATE atau teks tanggal[/waktu] yang valid; null jika bukan tanggal. */
function temporalKey(v: Value): number | null {
  if (v === null) return null;
  if (isDate(v)) return v.y * 1e10 + v.m * 1e8 + v.d * 1e6;
  if (typeof v !== "string") return null;
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*$/.exec(v);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const hh = m[4] ? Number(m[4]) : 0, mi = m[5] ? Number(m[5]) : 0, ss = m[6] ? Number(m[6]) : 0;
  if (!validDate(y, mo, d) || hh > 23 || mi > 59 || ss > 59) return null;
  return y * 1e10 + mo * 1e8 + d * 1e6 + hh * 1e4 + mi * 1e2 + ss;
}

function truthy(v: Value): boolean {
  if (v === null) return false;
  if (isDec(v)) return v.v !== 0n;
  if (typeof v === "string") { const d = decFromString(v); return d !== null && d.v !== 0n; }
  return true;
}

function evalExpr(e: Expr, ctx: Ctx): Value {
  switch (e.t) {
    case "num": return e.v;
    case "str": return e.v;
    case "null": return null;
    case "col": {
      const v = ctx.row.v[e.name.toLowerCase()];
      return v === undefined ? null : v;
    }
    case "star": throw new SqlError('"*" tidak dapat dievaluasi sebagai nilai di sini.', e.pos, e.len);
    case "un": {
      if (e.op === "NOT") { const v = evalExpr(e.e, ctx); return v === null ? null : bool(!truthy(v)); }
      const d = toDecStrict(evalExpr(e.e, ctx), e, "Operasi aritmetika");
      if (d === null) return null;
      return e.op === "-" ? mkDec(-d.v, d.s) : d;
    }
    case "bin": return evalBinary(e, ctx);
    case "isnull": { const v = evalExpr(e.e, ctx); return bool((v === null) !== e.neg); }
    case "in": {
      const left = evalExpr(e.e, ctx);
      if (left === null) return null;
      let sawNull = false;
      for (const item of e.list) {
        const r = compareValues(left, evalExpr(item, ctx), e);
        if (r === null) sawNull = true;
        else if (r === 0) return bool(!e.neg);
      }
      if (sawNull) return null;
      return bool(e.neg);
    }
    case "like": {
      const left = evalExpr(e.e, ctx);
      const pat = evalExpr(e.p, ctx);
      if (left === null || pat === null) return null;
      const hit = e.regexp ? getRegex(toText(pat), e).test(toText(left)) : likeToRegex(toText(pat)).test(toText(left));
      return bool(hit !== e.neg);
    }
    case "case": {
      for (const w of e.whens) if (truthy(evalExpr(w.c, ctx))) return evalExpr(w.r, ctx);
      return e.els ? evalExpr(e.els, ctx) : null;
    }
    case "fn": return evalFunction(e, ctx);
  }
}

function evalBinary(e: Extract<Expr, { t: "bin" }>, ctx: Ctx): Value {
  if (e.op === "AND") {
    const l = evalExpr(e.l, ctx);
    if (l !== null && !truthy(l)) return ZERO;
    const r = evalExpr(e.r, ctx);
    if (r !== null && !truthy(r)) return ZERO;
    return l === null || r === null ? null : ONE;
  }
  if (e.op === "OR") {
    const l = evalExpr(e.l, ctx);
    if (l !== null && truthy(l)) return ONE;
    const r = evalExpr(e.r, ctx);
    if (r !== null && truthy(r)) return ONE;
    return l === null || r === null ? null : ZERO;
  }
  const lv = evalExpr(e.l, ctx);
  const rv = evalExpr(e.r, ctx);
  if (["=", "<>", "<", ">", "<=", ">="].includes(e.op)) {
    const c = compareValues(lv, rv, e);
    if (c === null) return null;
    switch (e.op) {
      case "=": return bool(c === 0);
      case "<>": return bool(c !== 0);
      case "<": return bool(c < 0);
      case ">": return bool(c > 0);
      case "<=": return bool(c <= 0);
      default: return bool(c >= 0);
    }
  }
  const a = toDecStrict(lv, e, "Operasi aritmetika");
  const b = toDecStrict(rv, e, "Operasi aritmetika");
  if (a === null || b === null) return null;
  switch (e.op) {
    case "+": { const [x, y, s] = align(a, b); return mkDec(x + y, s); }
    case "-": { const [x, y, s] = align(a, b); return mkDec(x - y, s); }
    case "*": return capScale(mkDec(a.v * b.v, a.s + b.s));
    case "/": {
      if (b.v === 0n) return null;
      const neg = b.v < 0n;
      const num = (neg ? -a.v : a.v) * pow10(4 + b.s);
      const den = neg ? -b.v : b.v;
      return capScale(mkDec(roundDiv(num, den), a.s + 4));
    }
    case "%": {
      if (b.v === 0n) return null;
      const [x, y, s] = align(a, b);
      return mkDec(x % y, s);
    }
    default: throw new SqlError(`Operator ${e.op} belum didukung.`, e.pos, e.len);
  }
}

function evalFunction(e: Extract<Expr, { t: "fn" }>, ctx: Ctx): Value {
  const { name } = e;
  if (AGGREGATES.has(name)) {
    if (!ctx.group) throw new SqlError(`Fungsi agregat ${name}() tidak dapat dipakai di sini.`, e.pos, e.len);
    const arg = e.args[0];
    if (name === "COUNT") {
      if (arg.t === "star") return mkDec(BigInt(ctx.group.length), 0);
      let c = 0n;
      for (const r of ctx.group) if (evalExpr(arg, { row: r, group: null }) !== null) c++;
      return mkDec(c, 0);
    }
    let acc: Dec | null = null;
    for (const r of ctx.group) {
      const d = toDecStrict(evalExpr(arg, { row: r, group: null }), e, "SUM");
      if (d === null) continue;
      if (acc === null) acc = d;
      else { const [x, y, s] = align(acc, d); acc = mkDec(x + y, s); }
    }
    return acc;
  }
  if (e.cast) return evalCast(e, ctx);
  const args = e.args.map((a) => evalExpr(a, ctx));
  switch (name) {
    case "ROUND": {
      const d = toDecStrict(args[0], e, "ROUND");
      if (d === null) return null;
      let places = 0;
      if (args.length === 2) {
        const p = toDecStrict(args[1], e, "ROUND");
        if (p === null) return null;
        places = Number(decToString(rescale(p, 0)));
        if (!Number.isFinite(places) || places > 30 || places < -30) throw new SqlError("Jumlah desimal ROUND harus antara -30 dan 30.", e.pos, e.len);
      }
      return roundDec(d, places);
    }
    case "TRIM": return args[0] === null ? null : toText(args[0]).trim();
    case "UPPER": return args[0] === null ? null : toText(args[0]).toUpperCase();
    case "LOWER": return args[0] === null ? null : toText(args[0]).toLowerCase();
    case "ABS": { const d = toDecStrict(args[0], e, "ABS"); return d === null ? null : mkDec(d.v < 0n ? -d.v : d.v, d.s); }
    case "CONCAT": {
      let out = "";
      for (const a of args) { if (a === null) return null; out += toText(a); }
      return out;
    }
    case "COALESCE": { for (const a of args) if (a !== null) return a; return null; }
    case "IFNULL": return args[0] !== null ? args[0] : args[1];
    case "SUBSTRING_INDEX": {
      if (args[0] === null || args[1] === null || args[2] === null) return null;
      const str = toText(args[0]);
      const delim = toText(args[1]);
      const cnt = toDecStrict(args[2], e, "SUBSTRING_INDEX");
      const count = Number(decToString(rescale(cnt!, 0)));
      if (delim === "" || count === 0) return "";
      const parts = str.split(delim);
      if (count > 0) return parts.length <= count ? str : parts.slice(0, count).join(delim);
      return parts.length <= -count ? str : parts.slice(count).join(delim);
    }
    case "STR_TO_DATE": {
      if (args[0] === null || args[1] === null) return null;
      return strToDate(toText(args[0]), toText(args[1]), e);
    }
    case "DATE_FORMAT": {
      if (args[0] === null || args[1] === null) return null;
      return dateFormat(args[0], toText(args[1]), e);
    }
    default: throw new SqlError(`Fungsi ${name}() belum didukung.`, e.pos, e.len);
  }
}

function evalCast(e: Extract<Expr, { t: "fn" }>, ctx: Ctx): Value {
  const v = evalExpr(e.args[0], ctx);
  if (v === null) return null;
  const cast = e.cast!;
  if (cast.kind === "char") return toText(v);
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) {
      throw new SqlError(`CAST gagal: nilai "${v.length > 40 ? v.slice(0, 40) + "…" : v}" bukan angka valid.`, e.pos, e.len);
    }
  }
  const d = toDecStrict(v, e, "CAST");
  if (d === null) return null;
  if (cast.kind === "signed") return rescale(d, 0);
  const out = rescale(d, cast.s);
  const limit = pow10(cast.p);
  if (out.v >= limit || out.v <= -limit) {
    throw new SqlError(`CAST gagal: nilai ${decToString(d)} melebihi DECIMAL(${cast.p},${cast.s}).`, e.pos, e.len);
  }
  return out;
}

// ───────────────────────── eksekusi ─────────────────────────

const YIELD_EVERY = 4000;
const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type Relation = { columns: string[]; rows: Row[] };

async function executeSelect(stmt: SelectStmt, rel: Relation, label: string, stages: QueryStage[]): Promise<Relation> {
  let counter = 0;
  const guard = <T,>(row: Row, fn: () => T): T => {
    try { return fn(); } catch (err) {
      if (err instanceof SqlError && err.row === null) err.row = row.n;
      throw err;
    }
  };

  let rows = rel.rows;
  if (stmt.where) {
    const kept: Row[] = [];
    for (const row of rows) {
      if (++counter % YIELD_EVERY === 0) await yieldToBrowser();
      if (truthy(guard(row, () => evalExpr(stmt.where!, { row, group: null })))) kept.push(row);
    }
    rows = kept;
  }
  const matched = rows.length;

  // kolom hasil
  const outNames: string[] = [];
  type Producer = { expr: Expr } | { copy: string };
  const producers: Producer[] = [];
  for (const item of stmt.items) {
    if (item.expr.t === "star") {
      for (const c of rel.columns) { outNames.push(c); producers.push({ copy: c.toLowerCase() }); }
    } else {
      outNames.push(itemName(item));
      producers.push({ expr: item.expr });
    }
  }
  const project = (row: Row, group: Row[] | null): Row => {
    const v: Record<string, Value> = Object.create(null);
    outNames.forEach((nm, idx) => {
      const p = producers[idx];
      v[nm.toLowerCase()] = "copy" in p ? (row.v[p.copy] ?? null) : evalExpr(p.expr, { row, group });
    });
    return { n: row.n, v };
  };

  const aggregated = stmt.groupBy.length > 0 || stmt.items.some((it) => containsAggregate(it.expr));
  const out: Row[] = [];
  if (aggregated) {
    const groups = new Map<string, Row[]>();
    if (stmt.groupBy.length === 0) {
      groups.set("", rows);
    } else {
      for (const row of rows) {
        if (++counter % YIELD_EVERY === 0) await yieldToBrowser();
        const key = guard(row, () =>
          stmt.groupBy.map((g) => {
            const v = evalExpr(g, { row, group: null });
            return v === null ? "\u0000null" : typeof v === "string" ? `s:${v.toLowerCase()}` : isDec(v) ? `d:${decToString(normalizeDec(v))}` : `t:${dateToString(v)}`;
          }).join("\u0001"),
        );
        const g = groups.get(key);
        if (g) g.push(row); else groups.set(key, [row]);
      }
    }
    for (const g of groups.values()) {
      if (++counter % YIELD_EVERY === 0) await yieldToBrowser();
      const first: Row = g[0] ?? { n: 0, v: Object.create(null) };
      out.push(guard(first, () => project(first, g)));
    }
  } else {
    for (const row of rows) {
      if (++counter % YIELD_EVERY === 0) await yieldToBrowser();
      out.push(guard(row, () => project(row, null)));
    }
  }
  stages.push({ name: label, inputRows: rel.rows.length, matchedRows: matched, outputRows: out.length });
  return { columns: outNames, rows: out };
}

export type ValidationResult = { ok: true; warnings: string[] } | { ok: false; error: SqlError };

/** Tokenisasi + parse + analisis nama tabel/kolom/fungsi, tanpa data. */
export function validateSql(sql: string): ValidationResult {
  try {
    const q = parseSql(sql);
    return { ok: true, warnings: analyze(q) };
  } catch (err) {
    if (err instanceof SqlError) return { ok: false, error: err };
    throw err;
  }
}

/** Menjalankan query terhadap baris virtual d_file_data. Melempar SqlError jika query/data bermasalah. */
export async function runSql(sql: string, source: readonly SqlSourceRow[]): Promise<QueryResult> {
  const q = parseSql(sql);
  const warnings = analyze(q);
  const base: Relation = {
    columns: [...BASE_COLUMNS],
    rows: source.map((r) => {
      const v: Record<string, Value> = Object.create(null);
      v.a = r.A; v.e = r.E; v.j = r.J; v.filename = r.filename; v.id_command = r.id_command;
      return { n: r.n, v };
    }),
  };
  const relations = new Map<string, Relation>([[BASE_TABLE_NAME, base]]);
  const stages: QueryStage[] = [];
  for (const cte of q.ctes) {
    const input = relations.get(cte.select.from.name.toLowerCase())!;
    relations.set(cte.name.toLowerCase(), await executeSelect(cte.select, input, cte.name, stages));
  }
  const input = relations.get(q.main.from.name.toLowerCase())!;
  const final = await executeSelect(q.main, input, "SELECT utama", stages);
  const lc = final.columns.map((c) => c.toLowerCase());
  return {
    columns: final.columns,
    rows: final.rows.map((r) => lc.map((c) => r.v[c] ?? null)),
    warnings,
    stages,
  };
}

// ───────────────────────── lokasi error & format ─────────────────────────

export function locate(sql: string, pos: number): { line: number; column: number; lineText: string } {
  const p = Math.max(0, Math.min(pos, sql.length));
  const before = sql.slice(0, p);
  const line = before.split("\n").length;
  const lineStart = before.lastIndexOf("\n") + 1;
  const lineEnd = sql.indexOf("\n", p);
  return { line, column: p - lineStart + 1, lineText: sql.slice(lineStart, lineEnd < 0 ? sql.length : lineEnd) };
}

const FORMAT_KEYWORDS = new Set([...RESERVED, ...TYPE_WORDS, ...Object.keys(FUNCS), "CAST", "ASC", "DESC", "RECURSIVE", "ESCAPE"]);

/** Merapikan query (huruf besar kata kunci, indentasi, satu kolom per baris). Komentar dipertahankan. */
export function formatSql(sql: string): string {
  const toks = tokenize(sql, true);
  type Frame = { kind: "root" | "sub" | "call" | "case"; base: number; clause: string; breakArgs: boolean };
  const IND = "    ";
  const frames: Frame[] = [{ kind: "root", base: 0, clause: "", breakArgs: false }];
  let out = "";
  let indent = 0;
  let lineStart = true;
  let noSpace = false;
  let prev: Token | null = null;
  const top = () => frames[frames.length - 1];
  const nl = () => { if (!lineStart) { out = out.replace(/[ ]+$/, "") + "\n"; lineStart = true; } };
  const emit = (s: string, spaceBefore = true) => {
    if (lineStart) { out += IND.repeat(indent); lineStart = false; }
    else if (spaceBefore && !noSpace && !out.endsWith(" ") && !out.endsWith("(") && !out.endsWith(".")) out += " ";
    out += s;
    noSpace = false;
  };
  const isClauseLevel = () => top().kind === "root" || top().kind === "sub";
  const sig = (idx: number): Token | undefined => { for (let k = idx; k < toks.length; k++) if (toks[k].kind !== "comment") return toks[k]; return undefined; };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === "eof") break;
    if (t.kind === "comment") {
      const ownLine = prev === null || sql.slice(prev.end, t.pos).includes("\n");
      if (ownLine) nl();
      emit(t.text);
      if (t.text.startsWith("--") || t.text.startsWith("#") || ownLine) nl();
      continue;
    }
    const up = t.kind === "ident" ? t.upper : "";
    const isKw = t.kind === "ident" && FORMAT_KEYWORDS.has(up);
    const text = isKw ? up : t.raw;
    const f = top();

    if (t.kind === "ident" && isClauseLevel() && (up === "SELECT" || up === "FROM" || up === "WHERE" || up === "GROUP" || up === "WITH")) {
      indent = f.base;
      nl();
      if (up === "GROUP") {
        emit("GROUP");
        f.clause = "GROUP";
      } else {
        emit(up);
        f.clause = up;
        if (up === "SELECT" || up === "WHERE" || up === "WITH") { /* isi di baris berikutnya */ }
      }
      if (up === "SELECT" || up === "WHERE") { indent = f.base + 1; nl(); }
      else if (up === "WITH") { indent = f.base; }
      prev = t;
      continue;
    }
    if (t.kind === "ident" && up === "BY" && prev?.kind === "ident" && prev.upper === "GROUP") { emit("BY"); prev = t; continue; }
    if (t.kind === "ident" && (up === "AND" || up === "OR") && isClauseLevel() && f.clause === "WHERE") {
      indent = f.base + 1;
      nl();
      emit(up);
      prev = t;
      continue;
    }
    if (t.kind === "ident" && up === "CASE") {
      emit("CASE");
      frames.push({ kind: "case", base: indent, clause: "", breakArgs: false });
      prev = t;
      continue;
    }
    if (f.kind === "case" && t.kind === "ident" && (up === "WHEN" || up === "THEN" || up === "ELSE")) {
      indent = f.base + 1;
      nl();
      emit(up);
      prev = t;
      continue;
    }
    if (f.kind === "case" && t.kind === "ident" && up === "END") {
      indent = f.base;
      nl();
      emit("END");
      frames.pop();
      prev = t;
      continue;
    }
    if (t.kind === "punct" && t.text === "(") {
      let depth = 0;
      let j = i;
      for (; j < toks.length; j++) {
        if (toks[j].kind === "punct" && toks[j].text === "(") depth++;
        else if (toks[j].kind === "punct" && toks[j].text === ")") { depth--; if (depth === 0) break; }
      }
      const inner = toks.slice(i + 1, j).filter((x) => x.kind !== "comment");
      const nextSig = sig(i + 1);
      const isSub = nextSig?.kind === "ident" && nextSig.upper === "SELECT";
      const hasCase = inner.some((x) => x.kind === "ident" && x.upper === "CASE");
      const flatLen = inner.reduce((a, x) => a + x.raw.length + 1, 0);
      const brk = isSub || hasCase || flatLen > 80;
      const glued = prev !== null && prev.kind === "ident" && !RESERVED.has(prev.upper);
      emit("(", !glued);
      frames.push({ kind: isSub ? "sub" : "call", base: indent + (brk ? 1 : 0), clause: "", breakArgs: brk });
      if (brk) { indent += 1; nl(); }
      prev = t;
      continue;
    }
    if (t.kind === "punct" && t.text === ")") {
      const fr = frames.length > 1 ? frames.pop()! : top();
      if (fr.breakArgs) { indent = fr.base - 1; nl(); emit(")"); } else emit(")", false);
      prev = t;
      continue;
    }
    if (t.kind === "punct" && t.text === ",") {
      emit(",", false);
      if ((isClauseLevel() && (f.clause === "SELECT" || f.clause === "WITH")) || (f.kind === "call" && f.breakArgs)) nl();
      prev = t;
      continue;
    }
    if (t.kind === "punct" && t.text === ".") { emit(".", false); noSpace = true; prev = t; continue; }
    if (t.kind === "punct" && t.text === ";") { emit(";", false); nl(); prev = t; continue; }
    if (t.kind === "op") {
      const starLike = t.text === "*" && (prev === null || (prev.kind === "ident" && prev.upper === "SELECT") || (prev.kind === "punct" && [",", "(", "."].includes(prev.text)));
      const unary = (t.text === "-" || t.text === "+") && (prev === null || prev.kind === "op" || (prev.kind === "punct" && (prev.text === "(" || prev.text === ",")) || (prev.kind === "ident" && FORMAT_KEYWORDS.has(prev.upper) && !TYPE_WORDS.has(prev.upper)));
      if (starLike) { emit("*", !(prev?.kind === "punct" && prev.text === ".")); }
      else if (unary) { emit(t.text); noSpace = true; }
      else emit(t.text);
      prev = t;
      continue;
    }
    emit(text);
    prev = t;
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\s+$/, "");
}
