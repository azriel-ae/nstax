// NSTAX V2 — jembatan ke PARSER ASLI. Tidak ada rumus di file ini:
// semua angka datang dari parser/summarizer/CSV yang sudah ada; di sini hanya diformat jadi tabel tampilan.
import { astanaToCsv, formatAstanaRupiah, parseAstana, summarizeAstana } from "@/lib/parsers/astanaParser";
import { calculateForeSummary, formatForeRupiah, foreToCsv, parseForeJson } from "@/lib/parsers/foreParser";
import { calculateSummary, formatInteger, formatRupiahMinor, parseTransactionJson, toCsv as nscToCsv, TAX_RATE_PERCENT } from "@/lib/parsers/transactionParser";
import { formatVendorRupiah, parseVendorJson, summarizeVendor, vendorToCsv, type VendorKind } from "@/lib/parsers/vendorParser";
import { filterManyarRows, formatManyarRowMoney, formatManyarRupiah, manyarToCsv, parseManyar, summarizeManyar, type ManyarFilter } from "@/lib/parsers/manyarParser";
import type { ApiKind } from "./apiDetector";

export type RunView = {
  ok: boolean;
  error?: string;
  notices: string[];
  metrics: { label: string; value: string }[];
  columns: { label: string; numeric?: boolean }[];
  rows: string[][];
  csv: () => string;
  fileSlug: string;
  /** Opsional (MANYAR): filter kategori. `select` menghitung ulang metrik/baris dari data sumber yang sama, tanpa mengubahnya. */
  filters?: { key: string; label: string }[];
  select?: (key: string) => { metrics: { label: string; value: string }[]; rows: string[][]; csv: () => string };
};

const fail = (error: string, slug: string): RunView => ({ ok: false, error, notices: [], metrics: [], columns: [], rows: [], csv: () => "", fileSlug: slug });
const n = (v: number) => v.toLocaleString("id-ID");

export function runApiParser(kind: ApiKind, text: string): RunView {
  if (kind === "astana") {
    const r = parseAstana(text);
    if (!r.ok) return fail(r.error ?? "Format JSON tidak sesuai dengan CEK ASTANA.", kind);
    const s = summarizeAstana(r.rows);
    return {
      ok: true, fileSlug: kind,
      notices: [`${n(r.totalRows)} baris dibaca penuh · ${n(r.validRows)} valid · ${n(r.invalidRows)} invalid · ${n(r.needsReviewRows)} perlu diperiksa.`],
      metrics: [
        { label: "Transaksi (tidak invalid)", value: n(s.transactionCount) }, { label: "Total Gross", value: formatAstanaRupiah(s.gross) },
        { label: "Total Service", value: formatAstanaRupiah(s.service) }, { label: "Total Tax", value: formatAstanaRupiah(s.tax) }, { label: "Total Nett", value: formatAstanaRupiah(s.nett) },
      ],
      columns: [{ label: "Date" }, { label: "Product" }, { label: "NoBill" }, { label: "Gross", numeric: true }, { label: "Service", numeric: true }, { label: "Tax", numeric: true }, { label: "Nett", numeric: true }, { label: "Status" }],
      rows: r.rows.map((x) => [x.date, x.product || "—", x.noBill ?? "-", ...[x.gross, x.service, x.tax, x.nett].map((v) => (v === null ? "—" : formatAstanaRupiah(v))), x.error ? `${x.status}: ${x.error}` : x.status]),
      csv: () => astanaToCsv(r.rows),
    };
  }
  if (kind === "fore") {
    const r = parseForeJson(text);
    if (!r.ok) return fail(r.error ?? "Format JSON tidak sesuai dengan mode FORE.", kind);
    const s = calculateForeSummary(r.validTransactions);
    return {
      ok: true, fileSlug: kind,
      notices: r.issues.length ? [`${n(r.issues.length)} baris tidak diproses karena format FORE tidak lengkap.`, ...r.issues.slice(0, 5)] : [`${n(r.validTransactions.length)} transaksi FORE siap diperiksa.`],
      metrics: [{ label: "Total transaksi", value: n(s.count) }, { label: "SUM(total)", value: formatForeRupiah(s.total) }, { label: "SUM(pajak)", value: formatForeRupiah(s.pajak) }, { label: "Counter unik", value: n(s.uniqueCounters) }],
      columns: [{ label: "Tanggal" }, { label: "Counter" }, { label: "Billing ID" }, { label: "Total", numeric: true }, { label: "Pajak", numeric: true }],
      rows: r.validTransactions.map((x) => [x.dateTime, `${x.counterName} (${x.counterId})`, x.billingId, formatForeRupiah(x.total), formatForeRupiah(x.pajak)]),
      csv: () => foreToCsv(r.validTransactions),
    };
  }
  if (kind === "nsc") {
    // Guard identik dengan NscChecker lama di Home.tsx: JSON bergaya FORE ditolak di mode NSC.
    try {
      const probe = JSON.parse(text) as unknown;
      const recs = Array.isArray(probe) ? probe : [probe];
      if (recs.some((it) => it && typeof it === "object" && ("billing_id" in it || "counter_id" in it || "pajak" in it))) return fail("Format JSON tidak sesuai dengan mode NSC.", kind);
    } catch { /* pesan JSON rusak berasal dari parser asli di bawah */ }
    const r = parseTransactionJson(text);
    if (!r.ok) return fail(r.error ?? "Tidak dapat membaca JSON.", kind);
    const s = calculateSummary(r.validTransactions);
    const notices: string[] = [];
    if (!r.validTransactions.length) notices.push(r.warning ?? "Tidak ditemukan transaksi valid.");
    else if (r.issues.length || r.duplicateCount) notices.push(`${r.issues.length ? `${r.issues.length} masalah` : ""}${r.issues.length && r.duplicateCount ? " · " : ""}${r.duplicateCount ? `${r.duplicateCount} baris kemungkinan duplikat` : ""}. Data valid tetap dihitung, data bermasalah dikeluarkan.`);
    else notices.push(`${r.validTransactions.length} transaksi siap diperiksa.`);
    r.issues.slice(0, 5).forEach((i) => notices.push(`Baris ${i.index + 1} · ${i.field}: ${i.message}`));
    return {
      ok: true, fileSlug: kind, notices,
      metrics: [{ label: "Total transaksi", value: n(s.count) }, { label: "Subtotal", value: formatRupiahMinor(s.totalMinor) }, { label: `Pajak (${TAX_RATE_PERCENT}%)`, value: formatRupiahMinor(s.taxMinor) }, { label: "Grand total", value: formatRupiahMinor(s.grandTotalMinor) }, { label: "Total seat", value: formatInteger(s.totalSeat) }],
      columns: [{ label: "Transaction No" }, { label: "Movie" }, { label: "Tanggal" }, { label: "Jam" }, { label: "Studio" }, { label: "Subtotal", numeric: true }, { label: "Pajak", numeric: true }, { label: "Grand total", numeric: true }, { label: "Catatan" }],
      rows: r.validTransactions.map((x) => [x.transactionNo, x.movieTitle, x.date, x.showTime, x.studio, formatRupiahMinor(x.totalMinor), formatRupiahMinor(x.taxMinor), formatRupiahMinor(x.grandTotalMinor), x.isDuplicate ? "Kemungkinan duplikat" : x.warnings.join("; ")]),
      csv: () => nscToCsv(r.validTransactions),
    };
  }
  if (kind === "manyar") {
    const r = parseManyar(text);
    if (!r.ok) return fail(r.error ?? "Format JSON tidak sesuai dengan MANYAR.", kind);
    const v = r.validation;
    const select = (key: string) => {
      const f = (key === "HOTEL" || key === "RESTO" ? key : "ALL") as ManyarFilter;
      const s = summarizeManyar(r.rows, f, r.maxDecimals);
      const shown = filterManyarRows(r.rows, f);
      return {
        metrics: [
          { label: "Jumlah transaksi", value: n(s.transactionCount) },
          { label: "Total Gross", value: formatManyarRupiah(s.gross, s.decimals) },
          { label: "Total Service", value: formatManyarRupiah(s.service, s.decimals) },
          { label: "Total Tax", value: formatManyarRupiah(s.tax, s.decimals) },
          { label: "Total Nett", value: formatManyarRupiah(s.nett, s.decimals) },
        ],
        rows: shown.map((x) => [x.date || "—", x.product || "—", x.noBill ?? "-", x.category === "UNKNOWN" ? "TIDAK DIKENAL" : x.category, formatManyarRowMoney(x.gross), formatManyarRowMoney(x.service), formatManyarRowMoney(x.tax), formatManyarRowMoney(x.nett), x.errors.length ? `${x.status}: ${x.errors.join("; ")}` : x.status]),
        csv: () => manyarToCsv(shown),
      };
    };
    const first = select("ALL");
    const notices = [`${n(v.totalRecords)} record dibaca penuh · HOTEL ${n(v.hotelRecords)} · RESTO ${n(v.restoRecords)} · masuk total ${n(v.includedRecords)}.`];
    if (v.unknownCategory) notices.push(`${n(v.unknownCategory)} record kategori tidak dikenal (NoBill kosong / bukan FL atau SL): tidak masuk total HOTEL maupun RESTO.`);
    if (v.invalidValues) notices.push(`${n(v.invalidValues)} record bernilai wajib kosong/tidak valid (${n(v.invalidKnownCategory)} kategori dikenal, ${n(v.invalidUnknownCategory)} kategori tidak dikenal): tidak masuk total. Lihat kolom Status.`);
    return {
      ok: true, fileSlug: kind, notices,
      filters: [{ key: "ALL", label: "Semua Kategori" }, { key: "HOTEL", label: "HOTEL" }, { key: "RESTO", label: "RESTO" }],
      select,
      metrics: first.metrics,
      columns: [{ label: "Date" }, { label: "Product" }, { label: "NoBill" }, { label: "Kategori" }, { label: "Gross", numeric: true }, { label: "Service", numeric: true }, { label: "Tax", numeric: true }, { label: "Nett", numeric: true }, { label: "Status" }],
      rows: first.rows,
      csv: first.csv,
    };
  }
  const vk = kind as VendorKind;
  const r = parseVendorJson(vk, text);
  if (!r.ok) return fail(r.error ?? "Format JSON tidak sesuai.", kind);
  const s = summarizeVendor(r.rows);
  return {
    ok: true, fileSlug: kind,
    notices: r.issues.length ? [`${n(r.rows.length)} transaksi valid; ${n(r.issues.length)} baris dilewati.`, ...r.issues.slice(0, 5)] : [`${n(r.rows.length)} transaksi berhasil diproses.`],
    metrics: [{ label: "Total transaksi", value: n(s.count) }, { label: "Total DPP", value: formatVendorRupiah(s.dpp) }, { label: "Total tax", value: formatVendorRupiah(s.tax) }, { label: "Total keseluruhan", value: formatVendorRupiah(s.total) }],
    columns: [{ label: "Tanggal" }, { label: "Referensi" }, { label: "Outlet" }, { label: "DPP", numeric: true }, { label: "Tax", numeric: true }, { label: "Total", numeric: true }],
    rows: r.rows.map((x) => [x.date, x.reference, x.outlet || "—", formatVendorRupiah(x.dpp), formatVendorRupiah(x.tax), formatVendorRupiah(x.total)]),
    csv: () => vendorToCsv(r.rows),
  };
}
