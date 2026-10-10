import type { JambuluwukSource } from "./jambuluwukParser";
import { buildTableRegistry, type TableRegistry } from "./jambuluwukMeta";
import { runSql, type QueryResult, type SqlSourceRow } from "./jambuluwukSql";

// Profil query editor CEK UPL · JAMBULUWUK: query default, penyimpanan lokal, dan pemetaan workbook → tabel virtual.

export type JambuluwukProfile = "HOTEL" | "RESTO";
export const JAMBULUWUK_PROFILES: JambuluwukProfile[] = ["HOTEL", "RESTO"];
export const PROFILE_LABEL: Record<JambuluwukProfile, string> = {
  HOTEL: "JAMBULUWUK HOTEL",
  RESTO: "JAMBULUWUK RESTO",
};

// Query bawaan = SQL acuan + dua penyesuaian (diminta pemilik aplikasi, supaya hasil tidak selisih):
//  1. Pajak diambil dari baris yang namanya mengandung 'Tax' (HOTEL dan RESTO sama). Pola ini HARUS sama dengan pola
//     pengecualian dpp ('Service|Tax'); sebelumnya HOTEL hanya 'Tax Room' sehingga nama seperti 'Room Tax' keluar dari dpp
//     tetapi tidak masuk tax, dan total kurang.
//  2. Jika sebuah folio tidak punya baris Tax sama sekali, tax = (dpp + service_charge) / 10 (dpp di sini belum termasuk
//     service; pajak = 10% dari dpp + service). Jika ada baris Tax, nilai baris itu dipakai langsung.
// Format hasil tetap ROUND(tax, 2) AS tax. SELECT akhir memakai "FROM hitung_tax" (SQL acuan tidak punya FROM) diikuti
// klausa WHERE date_trans (lihat DATE_FILTER_BLOCK) — satu-satunya tempat filter tanggal; tidak ada filter tanggal di UI.
// Filter tanggal TIDAK lagi punya UI sendiri: seluruhnya ditulis sebagai klausa WHERE di SELECT utama (setelah
// "FROM hitung_tax"), karena di sinilah alias date_trans sudah tersedia. WHERE tidak boleh dipasang di dalam CTE
// detail_transaksi untuk date_trans, sebab date_trans baru dihitung oleh SELECT di CTE itu (alias belum bisa dipakai di
// WHERE pada tingkat yang sama). Bentuk aktif = rentang satu bulan; dua bentuk lain ada sebagai contoh komentar.
// Batas akhir rentang eksklusif (< awal bulan berikutnya) supaya aman untuk nilai tanggal maupun timestamp.
const DATE_FILTER_BLOCK = `-- ===== FILTER TANGGAL (edit klausa WHERE di bawah ini) =====
-- Tanggal tertentu : WHERE date_trans LIKE '2026-09-01'
-- Satu bulan       : WHERE date_trans LIKE '2026-09%'
-- Rentang tanggal  : (bentuk aktif di bawah, batas akhir eksklusif)
-- Untuk memakai bentuk lain, ganti dua baris WHERE di bawah dengan salah satu contoh di atas.
WHERE date_trans >= '2026-09-01'
  AND date_trans < '2026-10-01'`;

export const DEFAULT_QUERIES: Record<JambuluwukProfile, string> = {
  HOTEL: `WITH detail_transaksi AS (
    SELECT
        A AS folio,
        E AS nama,
        STR_TO_DATE(
            SUBSTRING_INDEX(d.filename, '.', 3),
            '%d.%m.%Y'
        ) AS date_trans,
        SUM(
            CASE
                WHEN TRIM(d.E) NOT REGEXP 'Service|Tax'
                THEN CAST(TRIM(d.J) AS DECIMAL(15, 4))
                ELSE 0
            END
        ) AS dpp,
        SUM(
            CASE
                WHEN TRIM(d.E) NOT REGEXP 'Service|Tax|Disc'
                THEN CAST(TRIM(d.J) AS DECIMAL(15, 4))
                ELSE 0
            END
        ) AS subtotal,
        SUM(
            CASE
                WHEN TRIM(d.E) REGEXP 'Disc'
                THEN CAST(TRIM(d.J) AS DECIMAL(15, 4))
                ELSE 0
            END
        ) AS discount,
        SUM(
            CASE
                WHEN TRIM(d.E) REGEXP 'Service'
                THEN CAST(TRIM(d.J) AS DECIMAL(15, 4))
                ELSE 0
            END
        ) AS service_charge,
        SUM(
            CASE
                WHEN TRIM(d.E) REGEXP 'Tax'
                THEN CAST(TRIM(d.J) AS DECIMAL(15, 4))
                ELSE 0
            END
        ) AS tax_langsung,
        COUNT(
            CASE
                WHEN TRIM(d.E) REGEXP 'Tax'
                THEN 1
            END
        ) AS jumlah_baris_tax
    FROM d_file_data d
    WHERE
        d.id_command = 'UPL0192'
        AND d.A NOT REGEXP 'FOLIO'
        AND d.E REGEXP 'Room|Miscellaneous|Padel|Laundry|Phone|Jeep|Transportation|Swimming'
    GROUP BY d.A, d.filename
),
hitung_tax AS (
    SELECT
        folio,
        nama,
        date_trans,
        dpp,
        subtotal,
        discount,
        service_charge,
        CASE
            WHEN jumlah_baris_tax > 0
            THEN tax_langsung
            ELSE (dpp + service_charge) / 10
        END AS tax
    FROM detail_transaksi
)
SELECT
    'hotel_jambuluwuk' AS id_agent,
    CONCAT(folio, '-', DATE_FORMAT(date_trans, '%Y-%m-%d')) AS no_struk,
    date_trans,
    ROUND(dpp, 2) AS dpp,
    ROUND(subtotal, 2) AS subtotal,
    ROUND(discount, 2) AS discount,
    ROUND(service_charge, 2) AS service_charge,
    ROUND(tax, 2) AS tax,
    ROUND(dpp + service_charge + tax, 2) AS total,
    CONCAT('no folio = ', folio) AS keterangan,
    nama AS namaFile
FROM hitung_tax\n${DATE_FILTER_BLOCK};`,
  RESTO: `WITH detail_transaksi AS (
    SELECT
        A AS folio,
        E AS nama,
        STR_TO_DATE(
            SUBSTRING_INDEX(d.filename, '.', 3),
            '%d.%m.%Y'
        ) AS date_trans,
        SUM(
            CASE
                WHEN TRIM(d.E) NOT REGEXP 'Service|Tax'
                THEN CAST(TRIM(d.J) AS DECIMAL(15, 4))
                ELSE 0
            END
        ) AS dpp,
        SUM(
            CASE
                WHEN TRIM(d.E) NOT REGEXP 'Service|Tax|Disc'
                THEN CAST(TRIM(d.J) AS DECIMAL(15, 4))
                ELSE 0
            END
        ) AS subtotal,
        SUM(
            CASE
                WHEN TRIM(d.E) REGEXP 'Disc'
                THEN CAST(TRIM(d.J) AS DECIMAL(15, 4))
                ELSE 0
            END
        ) AS discount,
        SUM(
            CASE
                WHEN TRIM(d.E) REGEXP 'Service'
                THEN CAST(TRIM(d.J) AS DECIMAL(15, 4))
                ELSE 0
            END
        ) AS service_charge,
        SUM(
            CASE
                WHEN TRIM(d.E) REGEXP 'Tax'
                THEN CAST(TRIM(d.J) AS DECIMAL(15, 4))
                ELSE 0
            END
        ) AS tax_langsung,
        COUNT(
            CASE
                WHEN TRIM(d.E) REGEXP 'Tax'
                THEN 1
            END
        ) AS jumlah_baris_tax
    FROM d_file_data d
    WHERE
        d.id_command = 'UPL0192'
        AND d.A NOT REGEXP 'FOLIO'
        AND d.E REGEXP 'Breakfast|Dinner|Restaurant|Banquet'
    GROUP BY d.A, d.filename
),
hitung_tax AS (
    SELECT
        folio,
        nama,
        date_trans,
        dpp,
        subtotal,
        discount,
        service_charge,
        CASE
            WHEN jumlah_baris_tax > 0
            THEN tax_langsung
            ELSE (dpp + service_charge) / 10
        END AS tax
    FROM detail_transaksi
)
SELECT
    'resto_jambuluwuk' AS id_agent,
    CONCAT(folio, '-', DATE_FORMAT(date_trans, '%Y-%m-%d')) AS no_struk,
    date_trans,
    ROUND(dpp, 2) AS dpp,
    ROUND(subtotal, 2) AS subtotal,
    ROUND(discount, 2) AS discount,
    ROUND(service_charge, 2) AS service_charge,
    ROUND(tax, 2) AS tax,
    ROUND(dpp + service_charge + tax, 2) AS total,
    CONCAT('no folio = ', folio) AS keterangan,
    nama AS namaFile
FROM hitung_tax\n${DATE_FILTER_BLOCK};`,
};

// ───────────── penyimpanan lokal (per profil, per browser) ─────────────

export type StoredQuery = { sql: string; savedAt: string };
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const storageKey = (profile: JambuluwukProfile) => `nstax.jambuluwuk.query.${profile}.v1`;

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null; // mis. mode privat/akses storage diblokir
  }
}

export function loadSavedQuery(profile: JambuluwukProfile, storage: StorageLike | null = defaultStorage()): StoredQuery | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(storageKey(profile));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredQuery>;
    if (typeof parsed?.sql !== "string" || parsed.sql.trim() === "") return null;
    return { sql: parsed.sql, savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "" };
  } catch {
    return null;
  }
}

export function saveQuery(profile: JambuluwukProfile, sql: string, storage: StorageLike | null = defaultStorage()): { ok: true; savedAt: string } | { ok: false; error: string } {
  if (!storage) return { ok: false, error: "Penyimpanan lokal browser tidak tersedia (mungkin diblokir atau mode privat). Query tidak tersimpan." };
  try {
    const savedAt = new Date().toISOString();
    storage.setItem(storageKey(profile), JSON.stringify({ sql, savedAt } satisfies StoredQuery));
    return { ok: true, savedAt };
  } catch {
    return { ok: false, error: "Gagal menyimpan ke penyimpanan lokal browser (kapasitas penuh atau diblokir)." };
  }
}

export function resetQuery(profile: JambuluwukProfile, storage: StorageLike | null = defaultStorage()): { ok: true } | { ok: false; error: string } {
  if (!storage) return { ok: true }; // tidak ada yang tersimpan
  try {
    storage.removeItem(storageKey(profile));
    return { ok: true };
  } catch {
    return { ok: false, error: "Gagal menghapus query tersimpan dari penyimpanan lokal browser." };
  }
}

/** Query awal untuk editor: versi tersimpan jika ada, jika tidak query default. Isi file Excel tidak pernah disimpan. */
export function initialQuery(profile: JambuluwukProfile, storage?: StorageLike | null): { sql: string; saved: StoredQuery | null } {
  const saved = loadSavedQuery(profile, storage);
  return { sql: saved ? saved.sql : DEFAULT_QUERIES[profile], saved };
}

// ───────────── workbook → tabel virtual d_file_data ─────────────

export const VIRTUAL_ID_COMMAND = "UPL0192"; // konteks pemrosesan JAMBULUWUK, bukan ID tabel database sungguhan

/**
 * Memetakan baris Excel yang sudah dibaca parser (kolom A, E, J) menjadi baris virtual:
 *   A = FOLIO, E = NAME, J = NETT (teks asli sel), filename = nama file yang diunggah, id_command = 'UPL0192'.
 * Baris header berulang, baris total laporan, baris kosong, dan baris tanpa folio sudah dikeluarkan oleh parser,
 * sehingga tidak ada penghitungan ganda dari ringkasan laporan.
 */
export function buildVirtualRows(source: JambuluwukSource): SqlSourceRow[] {
  return source.rows.map((r) => ({
    n: r.sheetRow,
    A: r.folio,
    E: r.item,
    J: r.rawAmount === "" ? null : r.rawAmount,
    filename: source.fileName,
    id_command: VIRTUAL_ID_COMMAND,
  }));
}

/**
 * Banyak file → satu tabel virtual. Tiap baris tetap membawa `filename` file asalnya, dan query bawaan mengelompokkan
 * per folio + filename, sehingga folio yang sama di hari berbeda tidak tercampur. Hanya file yang berhasil dibaca dipakai.
 */
export function buildVirtualRowsMulti(sources: readonly JambuluwukSource[]): SqlSourceRow[] {
  return sources.filter((s) => s.ok).flatMap((s) => buildVirtualRows(s));
}

export function runProfileQuery(sql: string, source: JambuluwukSource): Promise<QueryResult> {
  return runSql(sql, buildVirtualRows(source));
}

export function runProfileQueryMulti(sql: string, sources: readonly JambuluwukSource[]): Promise<QueryResult> {
  return runSql(sql, buildVirtualRowsMulti(sources));
}

/** Registry tabel virtual untuk konteks aktif: kosong bila belum ada file yang berhasil dibaca. */
export function registryForSource(source: JambuluwukSource | null): TableRegistry {
  return buildTableRegistry(source && source.ok ? buildVirtualRows(source) : null);
}

export function registryForSources(sources: readonly JambuluwukSource[]): TableRegistry {
  const ok = sources.filter((s) => s.ok);
  return buildTableRegistry(ok.length ? buildVirtualRowsMulti(ok) : null);
}
