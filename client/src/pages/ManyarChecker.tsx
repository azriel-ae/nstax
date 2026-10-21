import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { AlertTriangle, ArrowLeft, Check, Download, FileJson, Filter, Info, Search, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import { filterManyarRows, formatManyarRowMoney, formatManyarRupiah, manyarToCsv, parseManyar, summarizeManyar, type ManyarFilter, type ManyarParseResult, type ManyarRow } from "@/lib/parsers/manyarParser";
import { SidebarBrand } from "@/components/BrandLogo";

type Props = { onBack: () => void };
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const PAGE = 200;
const FILTERS: Array<[ManyarFilter, string]> = [["ALL", "Semua Kategori"], ["HOTEL", "MANYAR HOTEL"], ["RESTO", "MANYAR RESTO"]];
const id = (n: number) => n.toLocaleString("id-ID");

function Metric({ label, value, helper }: { label: string; value: string; helper: string }) {
  return <div className="metric-card"><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><span className="metric-helper">{helper}</span></div>;
}

const statusClass = (status: ManyarRow["status"]) => (status === "Valid" ? "notice-success" : status === "Nilai invalid" ? "notice-error" : "notice-warning");
const categoryLabel = (row: ManyarRow) => (row.category === "UNKNOWN" ? "TIDAK DIKENAL" : row.category);

export default function ManyarChecker({ onBack }: Props) {
  const [jsonText, setJsonText] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [result, setResult] = useState<ManyarParseResult | null>(null);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ManyarFilter>("ALL");
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<ManyarRow | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const analyze = (text = jsonText, source = sourceName) => {
    const parsed = parseManyar(text);
    setResult(parsed);
    setQuery("");
    setFilter("ALL");
    setShown(PAGE);
    if (!parsed.ok) setNotice(parsed.error ?? "Format JSON tidak sesuai dengan MANYAR.");
    else setNotice(`${id(parsed.validation.totalRecords)} record dibaca penuh · HOTEL ${id(parsed.validation.hotelRecords)} · RESTO ${id(parsed.validation.restoRecords)} · masuk total ${id(parsed.validation.includedRecords)}.`);
    if (source) setSourceName(source);
  };

  const handleFile = async (file?: File) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".json")) { setNotice("CEK MANYAR hanya menerima file .json."); return; }
    if (file.size > MAX_FILE_SIZE) { setNotice("Ukuran file terlalu besar. Batas maksimal adalah 10 MB."); return; }
    try { const text = await file.text(); setJsonText(text); analyze(text, file.name); } catch { setNotice("File JSON tidak dapat dibaca."); }
  };

  // Ringkasan dan tabel memakai sumber `result.rows` yang sama dan tidak pernah mengubahnya: mengganti filter hanya menghitung ulang.
  const summary = useMemo(() => summarizeManyar(result?.rows ?? [], filter, result?.maxDecimals ?? 0), [result, filter]);
  const categoryRows = useMemo(() => filterManyarRows(result?.rows ?? [], filter), [result, filter]);
  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? categoryRows.filter((row) => [row.date, row.product, row.noBill ?? "", categoryLabel(row), row.status].some((value) => value.toLowerCase().includes(needle))) : categoryRows;
  }, [categoryRows, query]);

  const clear = () => { setJsonText(""); setSourceName(""); setResult(null); setNotice(""); setQuery(""); setFilter("ALL"); setShown(PAGE); setSelected(null); };
  const downloadCsv = () => { const blob = new Blob([manyarToCsv(filteredRows)], { type: "text/csv;charset=utf-8" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `nstax-manyar-${filter.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url); };
  const money = (value: bigint) => formatManyarRupiah(value, summary.decimals);
  const v = result?.validation;
  const filterLabel = FILTERS.find(([key]) => key === filter)?.[1] ?? "";

  return <div className="app-shell">
    <aside className="app-sidebar"><SidebarBrand /><div className="sidebar-divider" /><nav className="sidebar-nav"><button className="nav-item" type="button" onClick={onBack}><ArrowLeft size={18} /><span>Kembali pilih mode</span></button><div className="nav-item is-active"><FileJson size={18} /><span>CEK MANYAR</span></div><button className="nav-item" type="button" onClick={() => document.getElementById("manyar-results")?.scrollIntoView({ behavior: "smooth" })}><Filter size={18} /><span>Hasil & filter</span></button></nav><div className="sidebar-footer"><div className="privacy-badge"><ShieldCheck size={16} /><div><strong>Local-first</strong><span>Data tidak keluar dari browser</span></div></div><div className="version-label">nstax / CEK MANYAR</div></div></aside>
    <main className="main-content"><header className="topbar"><button className="button button-secondary compact" type="button" onClick={onBack}><ArrowLeft size={15} /> Kembali</button><div className="breadcrumb"><span>CEK DATA API</span><span>›</span><strong>CEK MANYAR</strong></div><div className="status-chip"><span className="status-dot" /></div></header>
      <div className="page-container"><section className="page-heading"><div><h1>Cek <em>MANYAR</em></h1>
              <p>Upload atau tempel array JSON. HOTEL dan RESTO dipisahkan otomatis dari awalan NoBill (FL = HOTEL, SL = RESTO). Gross, Service, Tax, dan Nett dijumlahkan langsung dari data sumber tanpa hitung ulang.</p></div><div className="heading-meta"><span className="meta-label">CURRENT SOURCE</span><strong>{sourceName || "Belum ada file"}</strong><span className="meta-subtitle">{id(v?.totalRecords ?? 0)} record total</span></div></section>
        <section className="input-panel panel-surface"><div className="panel-heading"><div className="panel-title-wrap"><span className="section-number">01</span><div><h2>Upload JSON MANYAR</h2><p>Field: Date, Product, NoBill, Gross, Service, Tax, Nett. Mendukung ribuan transaksi dalam satu input.</p></div></div>{sourceName && <span className="file-pill"><FileJson size={15} />{sourceName}</span>}</div><div className="input-grid"><div className="drop-zone-wrap"><div className={`drop-zone ${dragActive ? "is-dragging" : ""}`} onDragEnter={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragActive(true); }} onDragOver={(e) => e.preventDefault()} onDragLeave={() => setDragActive(false)} onDrop={(e) => { e.preventDefault(); setDragActive(false); void handleFile(e.dataTransfer.files?.[0]); }}><div className="upload-symbol"><Upload size={20} /></div><strong>{dragActive ? "Lepaskan file JSON di sini" : "Tarik file JSON ke sini"}</strong><span>atau pilih dari perangkat Anda</span><button className="button button-secondary" type="button" onClick={() => inputRef.current?.click()}><FileJson size={16} /> Pilih JSON</button><small>Maksimal 10 MB · array of object MANYAR</small><input ref={inputRef} type="file" accept=".json,application/json" hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { void handleFile(e.target.files?.[0]); e.target.value = ""; }} /></div></div><div className="editor-wrap"><div className="editor-toolbar"><span><span className="toolbar-dot red" /><span className="toolbar-dot amber" /><span className="toolbar-dot green" /></span><span className="editor-label">manyar.json</span><span className="editor-hint">UTF-8</span></div><textarea className="json-editor" value={jsonText} onChange={(e) => { setJsonText(e.target.value); if (notice) setNotice(""); }} placeholder={'[\n  {\n    "Date": "2026-08-02",\n    "Product": "MANYAR RESTO",\n    "NoBill": "SL-26RST0000587",\n    "Gross": "114000.00",\n    "Service": "9421.46",\n    "Tax": "10363.69",\n    "Nett": "94214.85"\n  }\n]'} spellCheck={false} aria-label="Input JSON MANYAR" /></div></div><div className="input-actions"><div className="privacy-note"><ShieldCheck size={15} /> Diproses lokal di browser</div><div className="button-row"><button className="button button-ghost" type="button" onClick={clear}><Trash2 size={16} /> Clear</button><button className="button button-primary" type="button" onClick={() => analyze()}><Check size={16} /> Analisis MANYAR</button></div></div></section>
        {notice && <div className={`notice ${result?.ok ? "notice-success" : "notice-error"}`}><span className="notice-icon">{result?.ok ? <Check size={17} /> : <AlertTriangle size={17} />}</span>{notice}</div>}
        {result?.ok && v && <><section className="analysis-section"><div className="section-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> 02 · DASHBOARD FULL DATA</div><h2>Ringkasan MANYAR · {filterLabel}</h2></div><button className="button button-secondary compact" type="button" onClick={downloadCsv}><Download size={15} /> Export CSV</button></div>
          <div className="button-row" role="group" aria-label="Filter kategori" style={{ margin: "0 0 14px", flexWrap: "wrap" }}>{FILTERS.map(([key, label]) => <button key={key} type="button" className={`button compact ${filter === key ? "button-primary" : "button-secondary"}`} aria-pressed={filter === key} onClick={() => { setFilter(key); setShown(PAGE); }}>{label}</button>)}</div>
          <div className="metric-grid upl-metrics"><Metric label="Jumlah transaksi" value={id(summary.transactionCount)} helper="kategori dikenal & nilai valid" /><Metric label="Total Gross" value={money(summary.gross)} helper="jumlah field Gross" /><Metric label="Total Service" value={money(summary.service)} helper="jumlah field Service" /><Metric label="Total Tax" value={money(summary.tax)} helper="jumlah field Tax" /><Metric label="Total Nett" value={money(summary.nett)} helper="jumlah field Nett" /></div>
          <div className="used-columns"><strong>Total record: {id(v.totalRecords)}</strong><strong>HOTEL: {id(v.hotelRecords)}</strong><strong>RESTO: {id(v.restoRecords)}</strong><strong>Kategori tidak dikenal: {id(v.unknownCategory)}</strong><strong>Nilai wajib invalid: {id(v.invalidValues)}</strong></div>
          {(v.unknownCategory > 0 || v.invalidValues > 0) && <div className="notice notice-warning" style={{ marginTop: 12 }}><span className="notice-icon"><Info size={17} /></span><span>
            {v.unknownCategory > 0 && <>{id(v.unknownCategory)} record tidak berawalan FL/SL (atau NoBill kosong) dan tidak masuk total HOTEL maupun RESTO. </>}
            {v.invalidValues > 0 && <>{id(v.invalidValues)} record memiliki nilai wajib kosong/tidak valid ({id(v.invalidKnownCategory)} kategori dikenal, {id(v.invalidUnknownCategory)} kategori tidak dikenal) dan tidak dihitung dalam total; nilai tidak dianggap nol. </>}
            Alasan per record ada di kolom Status.</span></div>}</section>
          <section className="analysis-section" id="manyar-results"><div className="section-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> 03 · TRANSAKSI</div><h2>Data transaksi MANYAR</h2></div><span className="result-count">{id(filteredRows.length)} dari {id(categoryRows.length)} baris {filter === "ALL" ? "" : filter}</span></div><div className="input-actions"><label className="search-field"><Search size={15} /><input value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }} placeholder="Cari Date, Product, NoBill, atau Status" /></label></div><div className="table-shell"><table><thead><tr><th>No</th><th>Date</th><th>Product</th><th>NoBill</th><th>Kategori</th><th className="numeric">Gross</th><th className="numeric">Service</th><th className="numeric">Tax</th><th className="numeric">Nett</th><th>Status</th><th>Detail</th></tr></thead><tbody>{filteredRows.slice(0, shown).map((row, index) => <tr key={row.index}><td>{index + 1}</td><td>{row.date || "—"}</td><td><strong>{row.product || "—"}</strong></td><td>{row.noBill ?? "-"}</td><td>{categoryLabel(row)}</td><td className="numeric">{formatManyarRowMoney(row.gross)}</td><td className="numeric">{formatManyarRowMoney(row.service)}</td><td className="numeric">{formatManyarRowMoney(row.tax)}</td><td className="numeric">{formatManyarRowMoney(row.nett)}</td><td><span className={`notice ${statusClass(row.status)}`} style={{ display: "inline-flex", padding: "4px 8px", margin: 0 }}>{row.status}</span></td><td><button className="button button-ghost compact" type="button" onClick={() => setSelected(row)}>Lihat</button></td></tr>)}</tbody></table>{filteredRows.length === 0 && <div className="table-empty"><Search size={21} /><strong>Tidak ada transaksi yang cocok</strong><span>Coba ubah kata kunci atau kategori.</span></div>}</div>{shown < filteredRows.length && <div className="input-actions"><span className="result-count">Menampilkan {id(Math.min(shown, filteredRows.length))} dari {id(filteredRows.length)} baris</span><button className="button button-secondary compact" type="button" onClick={() => setShown((s) => s + PAGE)}>Tampilkan {PAGE} baris lagi</button></div>}</section></>}
      </div></main>
    {selected && <div className="modal-backdrop" role="presentation" onClick={() => setSelected(null)}><div className="modal-card" role="dialog" aria-modal="true" aria-label="Detail transaksi MANYAR" onClick={(e) => e.stopPropagation()}><div className="section-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> DETAIL TRANSAKSI</div><h2>{selected.product || "Transaksi MANYAR"}</h2></div><button className="icon-button" type="button" onClick={() => setSelected(null)} aria-label="Tutup"><X size={18} /></button></div><div className="mapping-grid upl-audit-grid"><div><strong>Date</strong><span>{selected.date || "—"}</span></div><div><strong>Product</strong><span>{selected.product || "—"}</span></div><div><strong>NoBill</strong><span>{selected.noBill ?? "-"}</span></div><div><strong>Kategori</strong><span>{categoryLabel(selected)}</span></div><div><strong>Gross</strong><span>{formatManyarRowMoney(selected.gross)}</span></div><div><strong>Service</strong><span>{formatManyarRowMoney(selected.service)}</span></div><div><strong>Tax</strong><span>{formatManyarRowMoney(selected.tax)}</span></div><div><strong>Nett</strong><span>{formatManyarRowMoney(selected.nett)}</span></div><div><strong>Status</strong><span>{selected.status}</span></div><div><strong>Urutan record</strong><span>{id(selected.index + 1)}</span></div></div>{selected.errors.length > 0 && <div className="notice notice-warning"><Info size={17} /> {selected.errors.join(" · ")}</div>}</div></div>}
  </div>;
}
