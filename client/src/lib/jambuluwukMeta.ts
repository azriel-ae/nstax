import { BASE_COLUMNS, BASE_TABLE_NAME, decFromString, SqlError, tokenize, validateSql, type ValidationResult } from "./jambuluwukSql";

// Perintah metadata untuk editor query CEK UPL · JAMBULUWUK.
//
// NSTAX TIDAK terhubung ke database SQL. Satu-satunya "tabel" adalah tabel virtual yang dibangun di browser dari file Excel
// yang sedang dimuat (d_file_data). SHOW TABLES / DESCRIBE / SHOW COLUMNS membaca REGISTRY tabel virtual itu — bukan daftar tetap.
// Tidak ada tabel server, tabel Vercel, atau tabel database eksternal. Tidak memakai eval/Function.
//
// Sintaks yang didukung:
//   SHOW TABLES [;]
//   SHOW [FULL] COLUMNS|FIELDS FROM|IN <tabel> [;]
//   DESCRIBE|DESC <tabel> [;]
// Tidak didukung (ditolak dengan pesan jelas): SHOW TABLES LIKE/FROM/WHERE, SHOW DATABASES, SHOW CREATE, EXPLAIN, dsb.

export type ColumnInfo = {
  name: string;
  /** Tipe yang dipakai mesin query (nilai sel disimpan sebagai teks mentah). */
  type: "TEXT";
  /** Asal kolom: kolom Excel (mis. "A (FOLIO)") atau kolom virtual yang ditambahkan aplikasi. */
  origin: string;
  /** Huruf kolom sumber di Excel, atau null untuk kolom virtual. */
  sourcePosition: string | null;
  /** Hasil inferensi dari data yang benar-benar dimuat. */
  inferred: "numerik" | "teks" | "campuran" | "kosong" | "konstanta";
  nullCount: number;
  nonNullCount: number;
};

export type TableInfo = {
  name: string;
  kind: "virtual";
  description: string;
  rowCount: number;
  columns: ColumnInfo[];
};

export type TableRegistry = { tables: TableInfo[]; note: string | null };

const COLUMN_ORIGIN: Record<string, { origin: string; position: string | null }> = {
  A: { origin: "kolom A Excel (FOLIO)", position: "A" },
  E: { origin: "kolom E Excel (NAME)", position: "E" },
  J: { origin: "kolom J Excel (NETT)", position: "J" },
  filename: { origin: "virtual: nama file yang diunggah", position: null },
  id_command: { origin: "virtual: konteks pemrosesan JAMBULUWUK", position: null },
};

type VirtualRow = { A: string | null; E: string | null; J: string | null; filename: string; id_command: string };

function inferColumn(values: Array<string | null>, constant: boolean): Pick<ColumnInfo, "inferred" | "nullCount" | "nonNullCount"> {
  let nulls = 0;
  let numeric = 0;
  let text = 0;
  for (const v of values) {
    if (v === null || v.trim() === "") { nulls++; continue; }
    if (decFromString(v.trim()) !== null) numeric++; else text++;
  }
  const nonNull = numeric + text;
  let inferred: ColumnInfo["inferred"];
  if (constant && nonNull > 0) inferred = "konstanta";
  else if (nonNull === 0) inferred = "kosong";
  else if (text === 0) inferred = "numerik";
  else if (numeric === 0) inferred = "teks";
  else inferred = "campuran";
  return { inferred, nullCount: nulls, nonNullCount: nonNull };
}

/**
 * Registry tabel virtual untuk konteks pemrosesan aktif. Kosong bila belum ada file yang berhasil dimuat.
 * `rows` adalah baris virtual yang SAMA dengan yang dipakai query (lihat buildVirtualRows), sehingga jumlah baris dan
 * inferensi tipe berasal dari data aktual — tidak ada angka karangan.
 */
export function buildTableRegistry(rows: readonly VirtualRow[] | null): TableRegistry {
  if (rows === null) {
    return { tables: [], note: "Belum ada sumber data yang dimuat. Upload file Excel JAMBULUWUK terlebih dahulu; tabel virtual d_file_data dibuat dari file tersebut." };
  }
  const columns: ColumnInfo[] = BASE_COLUMNS.map((name) => {
    const meta = COLUMN_ORIGIN[name];
    const values = rows.map((r) => r[name as keyof VirtualRow] as string | null);
    const constant = name === "filename" || name === "id_command";
    return { name, type: "TEXT", origin: meta.origin, sourcePosition: meta.position, ...inferColumn(values, constant) };
  });
  return {
    tables: [{
      name: BASE_TABLE_NAME,
      kind: "virtual",
      description: "Baris detail dari file Excel yang sedang dimuat (virtual, hanya di browser)",
      rowCount: rows.length,
      columns,
    }],
    note: null,
  };
}

export type MetaResult = {
  statement: "SHOW TABLES" | "SHOW COLUMNS" | "DESCRIBE";
  columns: string[];
  rows: string[][];
  /** Catatan informatif (mis. belum ada sumber data, tabel kosong). */
  notes: string[];
};

type MetaStatement =
  | { kind: "SHOW TABLES" }
  | { kind: "SHOW COLUMNS"; table: string; tablePos: number; tableLen: number; full: boolean }
  | { kind: "DESCRIBE"; table: string; tablePos: number; tableLen: number };

const META_LEADS = new Set(["SHOW", "DESCRIBE", "DESC"]);

/** Apakah teks diawali perintah metadata (SHOW / DESCRIBE / DESC)? Komentar di depan diabaikan. */
export function isMetadataStatement(sql: string): boolean {
  try {
    const first = tokenize(sql)[0];
    return first.kind === "ident" && META_LEADS.has(first.upper);
  } catch {
    return false;
  }
}

function parseMeta(sql: string): MetaStatement {
  const toks = tokenize(sql);
  let i = 0;
  const cur = () => toks[i];
  const desc = (t: (typeof toks)[number]) => (t.kind === "eof" ? "akhir query" : `"${t.raw}"`);
  const fail = (msg: string, t = cur()): never => { throw new SqlError(msg, t.pos, Math.max(1, t.end - t.pos)); };
  const isKw = (w: string, t = cur()) => t.kind === "ident" && t.upper === w;
  const endOfStatement = () => {
    if (cur().kind === "punct" && cur().text === ";") i++;
    if (cur().kind !== "eof") fail(`Teks tidak terduga ${desc(cur())} setelah akhir perintah metadata. Hanya satu perintah yang didukung.`);
  };
  const tableName = (): { name: string; pos: number; len: number } => {
    const t = cur();
    if (t.kind !== "ident" && t.kind !== "qident") fail(`Diharapkan nama tabel, tetapi ditemukan ${desc(t)}.`);
    i++;
    if (cur().kind === "punct" && cur().text === ".") fail("Nama tabel dengan awalan database/skema tidak didukung; gunakan nama tabel virtual saja (mis. d_file_data).");
    return { name: t.text, pos: t.pos, len: t.end - t.pos };
  };

  const lead = cur();
  if (lead.kind !== "ident" || !META_LEADS.has(lead.upper)) fail("Bukan perintah metadata.");
  i++;

  if (lead.upper === "DESCRIBE" || lead.upper === "DESC") {
    const t = tableName();
    endOfStatement();
    return { kind: "DESCRIBE", table: t.name, tablePos: t.pos, tableLen: t.len };
  }

  // SHOW ...
  let full = false;
  if (isKw("FULL")) { full = true; i++; }
  if (isKw("TABLES")) {
    if (full) fail("SHOW FULL TABLES belum didukung; gunakan SHOW TABLES.", toks[i - 1]);
    i++;
    if (isKw("LIKE") || isKw("WHERE") || isKw("FROM") || isKw("IN")) {
      fail(`SHOW TABLES ${cur().upper} belum didukung. Gunakan SHOW TABLES; saja (hanya ada tabel virtual dari file yang dimuat).`);
    }
    endOfStatement();
    return { kind: "SHOW TABLES" };
  }
  if (isKw("COLUMNS") || isKw("FIELDS")) {
    i++;
    if (!(isKw("FROM") || isKw("IN"))) fail(`Diharapkan FROM setelah SHOW COLUMNS, tetapi ditemukan ${desc(cur())}. Contoh: SHOW COLUMNS FROM d_file_data;`);
    i++;
    const t = tableName();
    if (isKw("LIKE") || isKw("WHERE") || isKw("FROM") || isKw("IN")) fail(`SHOW COLUMNS ... ${cur().upper} belum didukung.`);
    endOfStatement();
    return { kind: "SHOW COLUMNS", table: t.name, tablePos: t.pos, tableLen: t.len, full };
  }
  return fail(`Perintah SHOW ${desc(cur())} belum didukung. Yang didukung: SHOW TABLES, SHOW COLUMNS FROM <tabel>, DESCRIBE <tabel>.`);
}

/** Validasi sintaks perintah metadata saja (tanpa registry). */
export function validateMetadata(sql: string): ValidationResult {
  try {
    parseMeta(sql);
    return { ok: true, warnings: [] };
  } catch (err) {
    if (err instanceof SqlError) return { ok: false, error: err };
    throw err;
  }
}

/** Validasi untuk editor: menerima perintah metadata maupun SELECT. */
export function validateStatement(sql: string): ValidationResult & { metadata: boolean } {
  if (isMetadataStatement(sql)) return { ...validateMetadata(sql), metadata: true };
  return { ...validateSql(sql), metadata: false };
}

const yn = (b: boolean) => (b ? "YES" : "NO");

/** Menjalankan perintah metadata terhadap registry aktual. Melempar SqlError untuk sintaks/tabel yang tidak valid. */
export function runMetadata(sql: string, registry: TableRegistry): MetaResult {
  const stmt = parseMeta(sql);

  if (stmt.kind === "SHOW TABLES") {
    const notes: string[] = [];
    if (registry.tables.length === 0 && registry.note) notes.push(registry.note);
    notes.push("Daftar ini hanya berisi tabel virtual NSTAX yang dibuat di browser dari file Excel yang dimuat; bukan tabel database server.");
    return {
      statement: "SHOW TABLES",
      columns: ["Tables_in_nstax_virtual", "Jenis", "Jumlah_kolom", "Jumlah_baris", "Keterangan"],
      rows: registry.tables.map((t) => [t.name, t.kind, String(t.columns.length), String(t.rowCount), t.description]),
      notes,
    };
  }

  const wanted = stmt.table.toLowerCase();
  const table = registry.tables.find((t) => t.name.toLowerCase() === wanted);
  if (!table) {
    const available = registry.tables.map((t) => t.name);
    const hint = available.length
      ? `Tabel yang tersedia: ${available.join(", ")}.`
      : `Belum ada tabel virtual yang tersedia karena belum ada file Excel yang dimuat. ${BASE_TABLE_NAME} baru dibuat setelah file berhasil dibaca.`;
    throw new SqlError(`Tabel "${stmt.table}" tidak ditemukan. ${hint}`, stmt.tablePos, stmt.tableLen);
  }

  const notes = [`Tabel virtual ${table.name}: ${table.rowCount.toLocaleString("id-ID")} baris dimuat dari file yang sedang aktif.`];
  const full = stmt.kind === "SHOW COLUMNS" && stmt.full;
  if (stmt.kind === "DESCRIBE" || !full) {
    return {
      statement: stmt.kind,
      columns: ["Field", "Type", "Null", "Sumber", "Posisi_kolom_sumber", "Terdeteksi_dari_data"],
      rows: table.columns.map((c) => [c.name, c.type, yn(c.nullCount > 0), c.origin, c.sourcePosition ?? "(virtual)", c.inferred]),
      notes: [...notes, "Type = tipe di mesin query (teks mentah; gunakan CAST untuk angka). Null = YES bila ada nilai kosong pada data yang dimuat."],
    };
  }
  return {
    statement: "SHOW COLUMNS",
    columns: ["Field", "Type", "Null", "Sumber", "Posisi_kolom_sumber", "Terdeteksi_dari_data", "Baris_terisi", "Baris_kosong"],
    rows: table.columns.map((c) => [c.name, c.type, yn(c.nullCount > 0), c.origin, c.sourcePosition ?? "(virtual)", c.inferred, String(c.nonNullCount), String(c.nullCount)]),
    notes,
  };
}
