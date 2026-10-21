import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, Check, FileJson, Filter, Search, ShieldCheck, Trash2 } from "lucide-react";
import {
  FAMILY_MART_ALL,
  buildFamilyMartRows,
  extractFamilyMartPrefixes,
  extractFamilyMartRecords,
  familyMartText,
  filterFamilyMartRows,
  formatFamilyMartDate,
  formatFamilyMartRupiah,
  splitFamilyMartNoStruk,
  summarizeFamilyMartRows,
  type FamilyMartAmountSummary,
  type FamilyMartRow,
} from "@/lib/parsers/familyMartParser";
import { SidebarBrand } from "@/components/BrandLogo";

type Props = { onBack: () => void; initialJson?: string };

const PLACEHOLDER = 'Tempelkan JSON di sini.\nFormat: array langsung [ {...} ] atau object { "status", "count", "data": [ {...} ] }.\nField yang ditampilkan: id_agent, no_struk, date_trans, nama_usaha, total.';

function NoStruk({ value }: { value: unknown }) {
  const split = splitFamilyMartNoStruk(value);
  if (!split) return <>{familyMartText(value)}</>;
  return <><strong style={{ color: "#2563eb" }}>{split.prefix}</strong>-{split.rest}</>;
}

/** Nilai kartu untuk total/tax: tidak pernah menampilkan angka bila tidak ada nilai valid, dan menandai data tidak lengkap. */
function amountCard(amount: FamilyMartAmountSummary, transactionCount: number, field: string) {
  if (transactionCount === 0) return { value: "-", helper: "Tidak ada data pada filter ini" };
  if (amount.validCount === 0) return { value: "Tidak tersedia", helper: `Field ${field} tidak ada/valid di sumber` };
  const helper = amount.missingCount > 0
    ? `Belum lengkap: ${amount.missingCount.toLocaleString("id-ID")} dari ${transactionCount.toLocaleString("id-ID")} transaksi tanpa ${field} valid`
    : `Dari ${amount.validCount.toLocaleString("id-ID")} nilai ${field}`;
  return { value: formatFamilyMartRupiah(amount.sum), helper };
}

export default function FamilyMartChecker({ onBack, initialJson }: Props) {
  const [jsonText, setJsonText] = useState(initialJson ?? "");
  const [rows, setRows] = useState<FamilyMartRow[] | null>(null);
  const [error, setError] = useState("");
  const [prefix, setPrefix] = useState<string>(FAMILY_MART_ALL);

  // Seluruh elemen array diproses; jumlah selalu berasal dari array aktual, bukan `count` wrapper.
  const analyze = () => {
    setError("");
    const extracted = extractFamilyMartRecords(jsonText);
    if (!extracted.ok) {
      setRows(null);
      setError(extracted.error);
      return;
    }
    setRows(buildFamilyMartRows(extracted.records));
    setPrefix(FAMILY_MART_ALL);
  };

  // Dipakai BACA DATA APITRANS (V2): JSON dari auto-detect langsung dianalisis (jsonText sudah berisi initialJson sejak render pertama).
  useEffect(() => {
    if (initialJson) analyze();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clear = () => {
    setJsonText("");
    setRows(null);
    setError("");
    setPrefix(FAMILY_MART_ALL);
  };

  const prefixes = useMemo(() => (rows ? extractFamilyMartPrefixes(rows) : []), [rows]);
  const filtered = useMemo(() => (rows ? filterFamilyMartRows(rows, prefix) : []), [rows, prefix]);

  // Ringkasan memakai `filtered` yang sama dengan tabel, sehingga selalu mengikuti filter prefix aktif.
  const summary = useMemo(() => summarizeFamilyMartRows(filtered), [filtered]);
  const totalCard = amountCard(summary.total, summary.transactionCount, "total");
  const taxCard = amountCard(summary.tax, summary.transactionCount, "tax");

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <SidebarBrand />
        <div className="sidebar-divider" />
        <nav className="sidebar-nav">
          <button className="nav-item" type="button" onClick={onBack}><ArrowLeft size={18} /><span>Kembali ke CEK DATA API</span></button>
          <div className="nav-item is-active"><FileJson size={18} /><span>FAMILY MART</span></div>
          <button className="nav-item" type="button" onClick={() => document.getElementById("family-mart-results")?.scrollIntoView({ behavior: "smooth" })}><Filter size={18} /><span>Hasil & filter</span></button>
        </nav>
        <div className="sidebar-footer">
          <div className="privacy-badge"><ShieldCheck size={16} /><div><strong>Local-first</strong><span>Data tidak keluar dari browser</span></div></div>
          <div className="version-label">nstax / FAMILY MART</div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <button className="button button-secondary compact" type="button" onClick={onBack}><ArrowLeft size={15} /> Kembali</button>
          <div className="breadcrumb"><span>CEK DATA API</span><span>›</span><strong>FAMILY MART</strong></div>
          <div className="status-chip"><span className="status-dot" /></div>
        </header>

        <div className="page-container">
          <section className="page-heading">
            <div>
              <h1>Cek Data <em>Family Mart</em></h1>
              <p>Tempelkan payload JSON transaksi. Kode awal No Struk (teks sebelum tanda “-” pertama) diekstrak otomatis sebagai filter. Nilai sumber ditampilkan apa adanya tanpa dihitung ulang.</p>
            </div>
            <div className="heading-meta">
              <span className="meta-label">CURRENT SOURCE</span>
              <strong>Input JSON langsung</strong>
              <span className="meta-subtitle">{rows ? rows.length.toLocaleString("id-ID") : "0"} transaksi total</span>
            </div>
          </section>

          <section className="input-panel panel-surface">
            <div className="panel-heading">
              <div className="panel-title-wrap">
                <span className="section-number">01</span>
                <div><h2>Data JSON</h2><p>Array langsung atau object dengan properti data berupa array.</p></div>
              </div>
            </div>
            <div className="editor-wrap">
              <div className="editor-toolbar"><span><span className="toolbar-dot red" /><span className="toolbar-dot amber" /><span className="toolbar-dot green" /></span><span className="editor-label">family-mart.json</span><span className="editor-hint">UTF-8</span></div>
              <textarea
                className="json-editor"
                value={jsonText}
                onChange={(event) => { setJsonText(event.target.value); if (error) setError(""); }}
                placeholder={PLACEHOLDER}
                spellCheck={false}
                aria-label="Input JSON Family Mart"
              />
              <div className="editor-footer"><span>{jsonText.length ? `${jsonText.length.toLocaleString("id-ID")} karakter` : "Menunggu input"}</span><span>Parsing lokal aktif</span></div>
            </div>
            <div className="input-actions">
              <div className="privacy-note"><ShieldCheck size={15} /> Diproses lokal di browser</div>
              <div className="button-row">
                <button className="button button-ghost" type="button" onClick={clear}><Trash2 size={16} /> Clear</button>
                <button className="button button-primary" type="button" onClick={analyze}><Check size={16} /> Proses Data</button>
              </div>
            </div>
          </section>

          {error && <div className="notice notice-error" role="alert"><span className="notice-icon"><AlertTriangle size={17} /></span>{error}</div>}

          {rows && (
            <section className="analysis-section" id="family-mart-results">
              <div className="section-heading">
                <div><div className="eyebrow"><span className="eyebrow-line" /> 02 · TRANSAKSI</div><h2>Data transaksi Family Mart</h2></div>
                <span className="result-count">{prefix === FAMILY_MART_ALL ? "Total" : "Menampilkan"}: {filtered.length.toLocaleString("id-ID")} Data</span>
              </div>
              <div className="input-actions">
                <label className="date-field">
                  <Filter size={15} />
                  <span>Filter Kode Struk:</span>
                  <select value={prefix} onChange={(event) => setPrefix(event.target.value)} aria-label="Filter Kode Struk">
                    <option value={FAMILY_MART_ALL}>Semua Kode</option>
                    {prefixes.map((item) => <option key={item} value={item}>Awalan: {item}</option>)}
                  </select>
                </label>
              </div>
              <div className="metric-grid">
                <div className="metric-card"><span className="metric-label">Total Nominal Transaksi</span><strong className="metric-value">{totalCard.value}</strong><span className="metric-helper">{totalCard.helper}</span></div>
                <div className="metric-card"><span className="metric-label">Jumlah Transaksi</span><strong className="metric-value">{summary.transactionCount.toLocaleString("id-ID")}</strong><span className="metric-helper">Record pada filter aktif</span></div>
                <div className="metric-card"><span className="metric-label">Total Tax</span><strong className="metric-value">{taxCard.value}</strong><span className="metric-helper">{taxCard.helper}</span></div>
                <div className="metric-card"><span className="metric-label">Jumlah Struk Unik</span><strong className="metric-value">{summary.uniqueReceiptCount.toLocaleString("id-ID")}</strong><span className="metric-helper">No Struk valid yang berbeda</span></div>
              </div>
              <div className="table-shell">
                <table>
                  <thead>
                    <tr><th>ID Agent</th><th>No Struk</th><th>Tanggal</th><th>Nama Usaha</th><th className="numeric">Total</th></tr>
                  </thead>
                  <tbody>
                    {filtered.map((row) => (
                      <tr key={row.index}>
                        <td><strong>{familyMartText(row.idAgent)}</strong></td>
                        <td><NoStruk value={row.noStruk} /></td>
                        <td>{formatFamilyMartDate(row.dateTrans)}</td>
                        <td>{familyMartText(row.namaUsaha)}</td>
                        <td className="numeric">{formatFamilyMartRupiah(row.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filtered.length === 0 && <div className="table-empty"><Search size={21} /><strong>Tidak ada data yang sesuai dengan filter ini.</strong></div>}
              </div>
            </section>
          )}

          {!rows && !error && <div className="table-empty"><Search size={21} /><strong>Belum ada hasil</strong><span>Tempelkan JSON lalu klik Proses Data.</span></div>}
        </div>
      </main>
    </div>
  );
}
