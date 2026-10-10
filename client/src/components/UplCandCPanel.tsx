import { useState } from "react";
import { AlertTriangle, Info } from "lucide-react";
import { CANDC_COLUMNS, candcCrossCheck, type CandCResult } from "@/lib/candcParser";
import type { CategoryBucket, CategorizedUplRow, CategoryFilter, TransactionCategory } from "@/lib/kategoriMapper";
import { categoryDisplayLabel } from "@/lib/categoryDisplay";
import { RESTO_COLUMNS, RESTO_KINDS, restoCrossCheck, type RestoResult } from "@/lib/restoParser";
import { formatUplRupiah } from "@/lib/uplParser";

const ROW_LIMIT = 100;

function Metric({ label, value, money = false }: { label: string; value: number; money?: boolean }) {
  return (
    <div className="metric-card">
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{money ? formatUplRupiah(value) : value.toLocaleString("id-ID")}</strong>
    </div>
  );
}

/**
 * Detail kategori C&C (format record id_agent / no_struk / date_trans / ...).
 * Murni tampilan tambahan: tidak mengubah summary atau kategori lain.
 * Semua angka dihitung dari seluruh record file yang diupload.
 */
function CandCDetail({ candc, bucket }: { candc: CandCResult | null; bucket?: CategoryBucket }) {
  const [expanded, setExpanded] = useState(false);
  if (!candc) return null;
  const hasData = candc.records.length > 0 || (bucket?.count ?? 0) > 0;
  if (!hasData && candc.warnings.length === 0) return null;

  const { totals, records } = candc;
  const issues = candcCrossCheck(bucket, records);
  const rows = expanded ? records : records.slice(0, ROW_LIMIT);

  return (
    <section className="analysis-section">
      <div className="section-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> DETAIL KATEGORI C&amp;C</div>
          <h2>Record C&amp;C (Food C &amp; C, Beverage C &amp; C)</h2>
        </div>
        <span className="result-count">{totals.transactionCount.toLocaleString("id-ID")} record dari {candc.files.length.toLocaleString("id-ID")} file</span>
      </div>
      <div className="metric-grid upl-metrics">
        <Metric label="Jumlah transaksi" value={totals.transactionCount} />
        <Metric label="Subtotal" value={totals.subtotal} money />
        <Metric label="Service charge" value={totals.service_charge} money />
        <Metric label="Discount" value={totals.discount} money />
        <Metric label="DPP" value={totals.dpp} money />
        <Metric label="Tax" value={totals.tax} money />
        <Metric label="Total" value={totals.total} money />
      </div>
      <div className="used-columns">
        Kolom Excel dipakai:{" "}
        {(Object.entries(CANDC_COLUMNS) as [string, string][]).map(([field, letter]) => (
          <strong key={field}>{field} → {letter}</strong>
        ))}
      </div>
      {candc.warnings.length > 0 && (
        <div className="notice notice-warning">
          <span className="notice-icon"><Info size={17} /></span>
          <div>{candc.warnings.map((warning) => <div key={warning}>{warning}</div>)}</div>
        </div>
      )}
      {issues.length > 0 && (
        <div className="notice notice-error">
          <span className="notice-icon"><AlertTriangle size={17} /></span>
          <div>
            {issues.map((issue) => <div key={issue}>{issue}</div>)}
            <div>Periksa apakah kolom B–F pada file ini sesuai mapping sebelum angka C&amp;C dipakai.</div>
          </div>
        </div>
      )}
      {records.length > 0 && (
        <div className="excel-preview">
          <div className="excel-scroll">
            <table>
              <thead>
                <tr>
                  <th>No</th><th>id_agent</th><th>no_struk</th><th>date_trans</th><th>subtotal</th><th>service_charge</th>
                  <th>discount</th><th>dpp</th><th>tax</th><th>total</th><th>keterangan</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((record, i) => (
                  <tr key={`${record.fileName}-${record.sourceRow}`}>
                    <td>{i + 1}</td><td>{record.id_agent}</td><td>{record.no_struk}</td><td>{record.date_trans ?? "—"}</td>
                    <td>{formatUplRupiah(record.subtotal)}</td><td>{formatUplRupiah(record.service_charge)}</td>
                    <td>{formatUplRupiah(record.discount)}</td><td>{formatUplRupiah(record.dpp)}</td>
                    <td>{formatUplRupiah(record.tax)}</td><td>{formatUplRupiah(record.total)}</td><td>{record.keterangan}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {records.length > ROW_LIMIT && (
            <div className="upl-expand-row">
              <button className="button button-ghost compact" type="button" onClick={() => setExpanded((value) => !value)}>
                {expanded ? "Tampilkan sebagian saja" : `Tampilkan seluruh ${records.length.toLocaleString("id-ID")} record`}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Detail kategori KLAND RESTO (PREGO) dan KLAND RESTO / KFOOD: record
 * id_agent / no_struk / date_trans / ... dari kolom B, D, E, F, G.
 * Murni tampilan tambahan: tidak mengubah summary atau kategori lain.
 */
export function RestoDetail({ resto, bucket }: { resto: RestoResult | null; bucket?: CategoryBucket }) {
  const [expanded, setExpanded] = useState(false);
  if (!resto) return null;
  const meta = RESTO_KINDS[resto.kind];
  const { totals, records } = resto;
  const issues = restoCrossCheck(resto.kind, bucket, records);
  const rows = expanded ? records : records.slice(0, ROW_LIMIT);

  return (
    <section className="analysis-section">
      <div className="section-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> DETAIL KATEGORI {meta.label.toUpperCase()}</div>
          <h2>Record {meta.label} ({meta.id_agent})</h2>
        </div>
        <span className="result-count">{totals.transactionCount.toLocaleString("id-ID")} record dari {resto.files.length.toLocaleString("id-ID")} file</span>
      </div>
      <div className="metric-grid upl-metrics">
        <Metric label="Jumlah transaksi" value={totals.transactionCount} />
        <Metric label="Subtotal" value={totals.subtotal} money />
        <Metric label="Service charge" value={totals.service_charge} money />
        <Metric label="Discount" value={totals.discount} money />
        <Metric label="DPP" value={totals.dpp} money />
        <Metric label="Tax" value={totals.tax} money />
        <Metric label="Total" value={totals.total} money />
      </div>
      <div className="used-columns">
        Kolom Excel dipakai:{" "}
        {(Object.entries(RESTO_COLUMNS) as [string, string][]).map(([field, letter]) => (
          <strong key={field}>{field} → {letter}</strong>
        ))}
      </div>
      {resto.warnings.length > 0 && (
        <div className="notice notice-warning">
          <span className="notice-icon"><Info size={17} /></span>
          <div>{resto.warnings.map((warning) => <div key={warning}>{warning}</div>)}</div>
        </div>
      )}
      {issues.length > 0 && (
        <div className="notice notice-error">
          <span className="notice-icon"><AlertTriangle size={17} /></span>
          <div>
            {issues.map((issue) => <div key={issue}>{issue}</div>)}
            <div>Periksa apakah kolom B, D, E, F, G pada file ini sesuai mapping sebelum angka {meta.label} dipakai.</div>
          </div>
        </div>
      )}
      {records.length === 0 ? (
        <div className="notice notice-warning">
          <span className="notice-icon"><Info size={17} /></span>
          <div>Tidak ada transaksi untuk kategori ini.</div>
        </div>
      ) : (
        <div className="excel-preview">
          <div className="excel-scroll">
            <table>
              <thead>
                <tr>
                  <th>No</th><th>id_agent</th><th>no_struk</th><th>date_trans</th><th>subtotal</th><th>service_charge</th>
                  <th>discount</th><th>dpp</th><th>tax</th><th>total</th><th>keterangan</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((record, i) => (
                  <tr key={`${record.fileName}-${record.sourceRow}`}>
                    <td>{i + 1}</td><td>{record.id_agent}</td><td>{record.no_struk}</td><td>{record.date_trans ?? "—"}</td>
                    <td>{formatUplRupiah(record.subtotal)}</td><td>{formatUplRupiah(record.service_charge)}</td>
                    <td>{formatUplRupiah(record.discount)}</td><td>{formatUplRupiah(record.dpp)}</td>
                    <td>{formatUplRupiah(record.tax)}</td><td>{formatUplRupiah(record.total)}</td><td>{record.keterangan}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {records.length > ROW_LIMIT && (
            <div className="upl-expand-row">
              <button className="button button-ghost compact" type="button" onClick={() => setExpanded((value) => !value)}>
                {expanded ? "Tampilkan sebagian saja" : `Tampilkan seluruh ${records.length.toLocaleString("id-ID")} record`}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

type DetailRow = CategorizedUplRow & { fileName?: string };

/** Detail transaksi untuk kategori selain C&C (atau SEMUA KATEGORI), dari baris dataset yang sudah dikategorikan. */
function CategoryRowsDetail({ label, rows }: { label: string; rows: DetailRow[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? rows : rows.slice(0, ROW_LIMIT);
  const qty = rows.reduce((sum, row) => sum + (row.qty ?? 1), 0);
  const gross = rows.reduce((sum, row) => sum + (row.subtotal ?? 0), 0);
  const tax = rows.reduce((sum, row) => sum + (row.tax ?? 0), 0);

  return (
    <section className="analysis-section">
      <div className="section-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> DETAIL KATEGORI {label}</div>
          <h2>Record {label}</h2>
        </div>
        <span className="result-count">{rows.length.toLocaleString("id-ID")} record</span>
      </div>
      <div className="metric-grid upl-metrics">
        <Metric label="Jumlah transaksi" value={rows.length} />
        <Metric label="Total Day-qty" value={qty} />
        <Metric label="Total Day-Gros" value={gross} money />
        <Metric label="Total Tax" value={tax} money />
      </div>
      {rows.length === 0 ? (
        <div className="notice notice-warning">
          <span className="notice-icon"><Info size={17} /></span>
          <div>Tidak ada transaksi untuk kategori ini.</div>
        </div>
      ) : (
        <div className="excel-preview">
          <div className="excel-scroll">
            <table>
              <thead>
                <tr><th>No</th><th>File</th><th>Sheet</th><th>Baris</th><th>no_struk</th><th>Description / Unit</th><th>Day-qty</th><th>Tax</th><th>Day-Gros</th><th>Kategori</th></tr>
              </thead>
              <tbody>
                {shown.map((row, i) => (
                  <tr key={`${row.fileName ?? ""}-${row.sourceSheet}-${row.sourceRow}-${i}`}>
                    <td>{i + 1}</td><td>{row.fileName ?? "—"}</td><td>{row.sourceSheet}</td><td>{row.sourceRow}</td><td>{row.no_struk || "—"}</td>
                    <td>{row.description || "—"}</td><td>{row.qty ?? "—"}</td><td>{formatUplRupiah(row.tax ?? 0)}</td>
                    <td>{formatUplRupiah(row.subtotal ?? 0)}</td><td>{row.category}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > ROW_LIMIT && (
            <div className="upl-expand-row">
              <button className="button button-ghost compact" type="button" onClick={() => setExpanded((value) => !value)}>
                {expanded ? "Tampilkan sebagian saja" : `Tampilkan seluruh ${rows.length.toLocaleString("id-ID")} record`}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Detail kategori yang mengikuti dropdown.
 * - Tanpa `selectedCategory` (mis. dipakai halaman Harian): perilaku lama, detail C&C.
 * - `C&C`: detail record C&C (Food C & C, Beverage C & C).
 * - Kategori lain / Tidak Terpetakan / ALL: baris dataset yang category-nya sama dengan pilihan.
 */
export default function UplCandCPanel({
  candc,
  bucket,
  selectedCategory,
  rows,
  prego,
  kfood,
  pregoBucket,
  kfoodBucket,
}: {
  candc: CandCResult | null;
  bucket?: CategoryBucket;
  selectedCategory?: CategoryFilter | TransactionCategory;
  rows?: DetailRow[];
  prego?: RestoResult | null;
  kfood?: RestoResult | null;
  pregoBucket?: CategoryBucket;
  kfoodBucket?: CategoryBucket;
}) {
  if (selectedCategory === undefined || selectedCategory === "C&C") {
    return <CandCDetail candc={candc} bucket={bucket} />;
  }
  if (selectedCategory === "RESTO PREGO" && prego) return <RestoDetail key="prego" resto={prego} bucket={pregoBucket} />;
  if (selectedCategory === "K FOOD" && kfood) return <RestoDetail key="kfood" resto={kfood} bucket={kfoodBucket} />;
  const detailRows = (rows ?? []).filter((row) => selectedCategory === "ALL" || row.category === selectedCategory);
  const label = selectedCategory === "ALL" ? "SEMUA KATEGORI" : categoryDisplayLabel(selectedCategory).toUpperCase();
  // key memastikan state expand di-reset saat kategori berganti
  return <CategoryRowsDetail key={selectedCategory} label={label} rows={detailRows} />;
}
