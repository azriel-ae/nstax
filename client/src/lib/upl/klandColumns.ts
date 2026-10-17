import { FIELD_ALIASES, columnLetter, normalizeHeader } from "./uplParser";

/**
 * Penentuan kolom record C&C / PREGO / KFOOD berdasarkan NAMA HEADER file yang sedang
 * diproses — prinsip yang sama dengan parser KLAND utama (Day-qty / Day-Gros / Tax).
 *
 * Sebelumnya record dibaca dari huruf kolom tetap (C&C: B–F, RESTO: B,D–G). Huruf tetap
 * itu tidak ikut bergeser jika kolom antar file berbeda dan, untuk C&C, tidak sama dengan
 * layout laporan (A Art, B Description, C Day-qty, D Day-Nett, E Service, F Tax, G Day-Gros)
 * sehingga ringkasan (dari header) dan detail (dari huruf) bisa membaca kolom yang berbeda.
 *
 * Pemetaan field record -> header:
 *   keterangan     <- Description / Rincian
 *   qty            <- Day-qty            (opsional)
 *   subtotal       <- Day-Nett
 *   service_charge <- Service
 *   tax            <- Tax                (alias sama dengan parser utama)
 *   total          <- Day-Gros           (kolom yang sama dengan Total Day-Gros pada ringkasan)
 */

export type RecordField = "keterangan" | "qty" | "subtotal" | "service_charge" | "tax" | "total";
export type RecordColumns = Record<Exclude<RecordField, "qty">, number> & { qty: number | null };

const RECORD_ALIASES: Record<RecordField, string[]> = {
  keterangan: FIELD_ALIASES.description,
  qty: FIELD_ALIASES.qty,
  subtotal: ["day_nett", "day_net", "daynett", "daynet", "day_nett_total", "day_net_total"],
  service_charge: ["service", "service_charge", "day_service", "servis"],
  tax: FIELD_ALIASES.tax,
  total: FIELD_ALIASES.subtotal, // alias Day-Gros pada parser utama
};

const REQUIRED: Exclude<RecordField, "qty">[] = ["keterangan", "subtotal", "service_charge", "tax", "total"];
const HEADER_SCAN_LIMIT = 2000;

export type LocatedColumns = { headerIndex: number; cols: RecordColumns };

/** Cari baris header pertama yang memuat semua field wajib. null jika tidak ada. */
export function locateRecordColumns(matrix: unknown[][]): LocatedColumns | null {
  const limit = Math.min(matrix.length, HEADER_SCAN_LIMIT);
  for (let r = 0; r < limit; r++) {
    const found: Partial<Record<RecordField, number>> = {};
    (matrix[r] ?? []).forEach((cell, c) => {
      const normalized = normalizeHeader(cell);
      if (!normalized) return;
      (Object.keys(RECORD_ALIASES) as RecordField[]).forEach((field) => {
        if (found[field] === undefined && RECORD_ALIASES[field].includes(normalized)) found[field] = c;
      });
    });
    if (REQUIRED.every((field) => found[field] !== undefined)) {
      return { headerIndex: r, cols: { ...(found as Record<Exclude<RecordField, "qty">, number>), qty: found.qty ?? null } };
    }
  }
  return null;
}

/** Huruf kolom Excel untuk tampilan ("kolom dipakai"). */
export function columnLettersOf(cols: RecordColumns, firstColumn: number): Record<string, string> {
  const out: Record<string, string> = {};
  (Object.keys(cols) as RecordField[]).forEach((field) => {
    const idx = cols[field];
    if (idx !== null && idx !== undefined) out[field] = columnLetter(firstColumn + idx);
  });
  return out;
}
