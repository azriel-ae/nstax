import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { AlertTriangle, ArrowLeft, Check, Download, FileJson, Filter, Info, Search, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import { astanaToCsv, formatAstanaRupiah, parseAstana, summarizeAstana, type AstanaStatus, type AstanaTransaction, type AstanaParseResult } from "@/lib/astanaParser";

type Props = { onBack: () => void };
type StatusFilter = "ALL" | AstanaStatus;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric-card"><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><span className="metric-helper">Data dari seluruh JSON valid</span></div>;
}

function statusClass(status: AstanaStatus) {
  return status === "Valid" ? "notice-success" : status === "Invalid" ? "notice-error" : "notice-warning";
}

export default function AstanaChecker({ onBack }: Props) {
  const [jsonText, setJsonText] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [result, setResult] = useState<AstanaParseResult | null>(null);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [selected, setSelected] = useState<AstanaTransaction | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const analyze = (text = jsonText, source = sourceName) => {
    const parsed = parseAstana(text);
    setResult(parsed);
    setQuery("");
    setStatusFilter("ALL");
    if (!parsed.ok) setNotice(parsed.error ?? "Format JSON tidak sesuai dengan CEK ASTANA.");
    else setNotice(`${parsed.totalRows.toLocaleString("id-ID")} baris dibaca penuh · ${parsed.validRows.toLocaleString("id-ID")} valid · ${parsed.invalidRows.toLocaleString("id-ID")} invalid · ${parsed.needsReviewRows.toLocaleString("id-ID")} perlu diperiksa.`);
    if (source) setSourceName(source);
  };

  const handleFile = async (file?: File) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".json")) { setNotice("CEK ASTANA hanya menerima file .json."); return; }
    if (file.size > MAX_FILE_SIZE) { setNotice("Ukuran file terlalu besar. Batas maksimal adalah 10 MB."); return; }
    try { const text = await file.text(); setJsonText(text); analyze(text, file.name); } catch { setNotice("File JSON tidak dapat dibaca."); }
  };

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (result?.rows ?? []).filter((row) => {
      const matchesText = !needle || [row.date, row.product, row.noBill ?? ""].some((value) => value.toLowerCase().includes(needle));
      return matchesText && (statusFilter === "ALL" || row.status === statusFilter);
    });
  }, [query, result, statusFilter]);

  const summary = useMemo(() => summarizeAstana(result?.rows ?? []), [result]);
  const clear = () => { setJsonText(""); setSourceName(""); setResult(null); setNotice(""); setQuery(""); setSelected(null); };
  const downloadCsv = () => { const blob = new Blob([astanaToCsv(filteredRows)], { type: "text/csv;charset=utf-8" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `nstax-astana-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url); };

  return <div className="app-shell">
    <aside className="app-sidebar"><div className="brand-lockup"><div className="brand-mark"><span>α</span></div><div><div className="brand-name">nstax</div><div className="brand-caption">transaction intelligence</div></div></div><div className="sidebar-divider" /><nav className="sidebar-nav"><button className="nav-item" type="button" onClick={onBack}><ArrowLeft size={18} /><span>Kembali pilih mode</span></button><div className="nav-item is-active"><FileJson size={18} /><span>CEK ASTANA</span></div><button className="nav-item" type="button" onClick={() => document.getElementById("astana-results")?.scrollIntoView({ behavior: "smooth" })}><Filter size={18} /><span>Hasil & filter</span></button></nav><div className="sidebar-footer"><div className="privacy-badge"><ShieldCheck size={16} /><div><strong>Local-first</strong><span>Data tidak keluar dari browser</span></div></div><div className="version-label">nstax / CEK ASTANA</div></div></aside>
    <main className="main-content"><header className="topbar"><button className="button button-secondary compact" type="button" onClick={onBack}><ArrowLeft size={15} /> Kembali</button><div className="breadcrumb"><span>Workspace</span><span>›</span><strong>CEK ASTANA</strong></div><div className="status-chip"><span className="status-dot" /></div></header>
      <div className="page-container"><section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> CEK ASTANA · JSON AUDIT</div><h1>Periksa data<br /><em>ASTANA secara presisi.</em></h1><p>Upload atau tempel array JSON ASTANA. Semua transaksi diproses dari full dataset tanpa menghitung ulang nilai Gross, Service, Tax, atau Nett.</p></div><div className="heading-meta"><span className="meta-label">CURRENT SOURCE</span><strong>{sourceName || "Belum ada file"}</strong><span className="meta-subtitle">{result?.totalRows?.toLocaleString("id-ID") ?? "0"} baris total</span></div></section>
        <section className="input-panel panel-surface"><div className="panel-heading"><div className="panel-title-wrap"><span className="section-number">01</span><div><h2>Upload JSON ASTANA</h2><p>Field wajib: Date, Product, Gross, Service, Tax, Nett. NoBill boleh null.</p></div></div>{sourceName && <span className="file-pill"><FileJson size={15} />{sourceName}</span>}</div><div className="input-grid"><div className="drop-zone-wrap"><div className={`drop-zone ${dragActive ? "is-dragging" : ""}`} onDragEnter={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragActive(true); }} onDragOver={(e) => e.preventDefault()} onDragLeave={() => setDragActive(false)} onDrop={(e) => { e.preventDefault(); setDragActive(false); void handleFile(e.dataTransfer.files?.[0]); }}><div className="upload-symbol"><Upload size={20} /></div><strong>{dragActive ? "Lepaskan file JSON di sini" : "Tarik file JSON ke sini"}</strong><span>atau pilih dari perangkat Anda</span><button className="button button-secondary" type="button" onClick={() => inputRef.current?.click()}><FileJson size={16} /> Pilih JSON</button><small>Maksimal 10 MB · array of object ASTANA</small><input ref={inputRef} type="file" accept=".json,application/json" hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { void handleFile(e.target.files?.[0]); e.target.value = ""; }} /></div></div><div className="editor-wrap"><div className="editor-toolbar"><span><span className="toolbar-dot red" /><span className="toolbar-dot amber" /><span className="toolbar-dot green" /></span><span className="editor-label">astana.json</span><span className="editor-hint">UTF-8</span></div><textarea className="json-editor" value={jsonText} onChange={(e) => { setJsonText(e.target.value); if (notice) setNotice(""); }} placeholder={'[\n  {\n    "Date": "2026-07-01",\n    "Product": "AST-BREAKFAST",\n    "NoBill": null,\n    "Gross": "510400.00",\n    "Service": "26400.00",\n    "Tax": "44000.00",\n    "Nett": "440000.00"\n  }\n]'} spellCheck={false} aria-label="Input JSON ASTANA" /></div></div><div className="input-actions"><div className="privacy-note"><ShieldCheck size={15} /> Diproses lokal di browser</div><div className="button-row"><button className="button button-ghost" type="button" onClick={clear}><Trash2 size={16} /> Clear</button><button className="button button-primary" type="button" onClick={() => analyze()}><Check size={16} /> Analisis ASTANA</button></div></div></section>
        {notice && <div className={`notice ${result?.ok ? "notice-success" : "notice-error"}`}><span className="notice-icon">{result?.ok ? <Check size={17} /> : <AlertTriangle size={17} />}</span>{notice}</div>}
        {result?.ok && <><section className="analysis-section"><div className="section-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> 02 · DASHBOARD FULL DATA</div><h2>Ringkasan ASTANA</h2></div><button className="button button-secondary compact" type="button" onClick={downloadCsv}><Download size={15} /> Export CSV</button></div><div className="metric-grid upl-metrics"><Metric label="Total transaksi valid" value={summary.transactionCount.toLocaleString("id-ID")} /><Metric label="Total Gross" value={formatAstanaRupiah(summary.gross)} /><Metric label="Total Service" value={formatAstanaRupiah(summary.service)} /><Metric label="Total Tax" value={formatAstanaRupiah(summary.tax)} /><Metric label="Total Nett" value={formatAstanaRupiah(summary.nett)} /></div><div className="used-columns"><strong>Total baris: {result.totalRows.toLocaleString("id-ID")}</strong><strong>Valid: {result.validRows.toLocaleString("id-ID")}</strong><strong>Invalid: {result.invalidRows.toLocaleString("id-ID")}</strong><strong>Perlu diperiksa: {result.needsReviewRows.toLocaleString("id-ID")}</strong></div></section>
          <section className="analysis-section" id="astana-results"><div className="section-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> 03 · TRANSAKSI</div><h2>Data transaksi ASTANA</h2></div><span className="result-count">{filteredRows.length.toLocaleString("id-ID")} dari {result.totalRows.toLocaleString("id-ID")} baris</span></div><div className="input-actions"><label className="search-field"><Search size={15} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Cari Date, Product, atau NoBill" /></label><label className="date-field"><Filter size={15} /><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}><option value="ALL">Semua</option><option value="Valid">Valid</option><option value="Invalid">Invalid</option><option value="Perlu diperiksa">Perlu diperiksa</option></select></label></div><div className="table-shell"><table><thead><tr><th>No</th><th>Date</th><th>Product</th><th>NoBill</th><th className="numeric">Gross</th><th className="numeric">Service</th><th className="numeric">Tax</th><th className="numeric">Nett</th><th>Status</th><th>Detail</th></tr></thead><tbody>{filteredRows.map((row, index) => <tr key={`${row.date}-${row.product}-${index}`}><td>{index + 1}</td><td>{row.date}</td><td><strong>{row.product || "—"}</strong></td><td>{row.noBill ?? "-"}</td><td className="numeric">{row.gross === null ? "—" : formatAstanaRupiah(row.gross)}</td><td className="numeric">{row.service === null ? "—" : formatAstanaRupiah(row.service)}</td><td className="numeric">{row.tax === null ? "—" : formatAstanaRupiah(row.tax)}</td><td className="numeric">{row.nett === null ? "—" : formatAstanaRupiah(row.nett)}</td><td><span className={`notice ${statusClass(row.status)}`} style={{ display: "inline-flex", padding: "4px 8px", margin: 0 }}>{row.status}</span></td><td><button className="button button-ghost compact" type="button" onClick={() => setSelected(row)}>Lihat</button></td></tr>)}</tbody></table></div></section></>}
      </div></main>
    {selected && <div className="modal-backdrop" role="presentation" onClick={() => setSelected(null)}><div className="modal-card" role="dialog" aria-modal="true" aria-label="Detail transaksi ASTANA" onClick={(e) => e.stopPropagation()}><div className="section-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> DETAIL TRANSAKSI</div><h2>{selected.product || "Transaksi ASTANA"}</h2></div><button className="icon-button" type="button" onClick={() => setSelected(null)} aria-label="Tutup"><X size={18} /></button></div><div className="mapping-grid upl-audit-grid"><div><strong>Date</strong><span>{selected.date || "—"}</span></div><div><strong>Product</strong><span>{selected.product || "—"}</span></div><div><strong>NoBill</strong><span>{selected.noBill ?? "-"}</span></div><div><strong>Status</strong><span>{selected.status}</span></div><div><strong>Gross</strong><span>{selected.gross === null ? "—" : formatAstanaRupiah(selected.gross)}</span></div><div><strong>Service</strong><span>{selected.service === null ? "—" : formatAstanaRupiah(selected.service)}</span></div><div><strong>Tax</strong><span>{selected.tax === null ? "—" : formatAstanaRupiah(selected.tax)}</span></div><div><strong>Nett</strong><span>{selected.nett === null ? "—" : formatAstanaRupiah(selected.nett)}</span></div></div>{selected.error && <div className="notice notice-warning"><Info size={17} /> {selected.error}</div>}</div></div>}
  </div>;
}
