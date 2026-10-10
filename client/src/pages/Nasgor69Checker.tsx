import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { AlertTriangle, ArrowLeft, Check, Download, FileJson, Filter, Info, Search, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import {
  buildNasgor69Result,
  extractNasgor69Records,
  formatNasgor69Rupiah,
  nasgor69ToCsv,
  paginateNasgor69,
  summarizeNasgor69,
  type Nasgor69ParseResult,
  type Nasgor69Status,
  type Nasgor69Transaction,
} from "@/lib/nasgor69Parser";

type Props = { onBack: () => void };
type StatusFilter = "ALL" | Nasgor69Status;
// Data asli bisa berisi ribuan transaksi (±450 byte/transaksi), jadi batas dibuat longgar.
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 50;
const EMPTY_ROWS: Nasgor69Transaction[] = [];

// Beri kesempatan browser me-render indikator loading sebelum parsing berat dimulai.
const nextPaint = () => new Promise<void>((resolve) => { requestAnimationFrame(() => setTimeout(resolve, 0)); });

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-card">
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
      <span className="metric-helper">Dari seluruh transaksi di data</span>
    </div>
  );
}

function statusClass(status: Nasgor69Status) {
  return status === "Valid" ? "notice-success" : "notice-error";
}

const money = (value: number | null) => (value === null ? "—" : formatNasgor69Rupiah(value));
const text = (value: string | null) => (value === null || value === "" ? "-" : value);

export default function Nasgor69Checker({ onBack }: Props) {
  const [jsonText, setJsonText] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [result, setResult] = useState<Nasgor69ParseResult | null>(null);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [selected, setSelected] = useState<Nasgor69Transaction | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [loadingText, setLoadingText] = useState("");
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [currentPage, setCurrentPage] = useState(1);
  const inputRef = useRef<HTMLInputElement>(null);

  // Upload file dan paste JSON memakai jalur yang sama persis (analyze).
  // JSON di-parse satu kali; seluruh `data` menjadi allTransactions tanpa
  // slice/sampling, dan `count` dari API tidak dipakai sebagai batas dataset.
  const analyze = async (value = jsonText, source = sourceName) => {
    setIsAnalyzing(true);
    setLoadingText("Memproses data NASGOR 69...");
    await nextPaint();
    try {
      const extracted = extractNasgor69Records(value);
      let parsed: Nasgor69ParseResult;
      if (!extracted.ok) {
        parsed = { ok: false, error: extracted.error, rows: [], totalRows: 0, validRows: 0, invalidRows: 0, voidRows: 0, declaredCount: null };
      } else {
        setLoadingText(`Memproses ${extracted.records.length.toLocaleString("id-ID")} transaksi...`);
        await nextPaint();
        parsed = buildNasgor69Result(extracted.records, extracted.declaredCount);
      }
      setResult(parsed);
      setQuery("");
      setStatusFilter("ALL");
      setSelected(null);
      setCurrentPage(1);
      if (!parsed.ok) {
        setNotice(parsed.error ?? "Format JSON tidak sesuai dengan CEK NASGOR 69.");
      } else {
        const voidNote = parsed.voidRows ? ` · ${parsed.voidRows.toLocaleString("id-ID")} void` : "";
        const countNote = parsed.declaredCount !== null && parsed.declaredCount !== parsed.totalRows
          ? ` Catatan: field count API = ${parsed.declaredCount.toLocaleString("id-ID")}, seluruh ${parsed.totalRows.toLocaleString("id-ID")} transaksi di data tetap diproses.`
          : "";
        setNotice(`NASGOR 69 berhasil diproses · Total transaksi: ${parsed.totalRows.toLocaleString("id-ID")} · ${parsed.validRows.toLocaleString("id-ID")} valid · ${parsed.invalidRows.toLocaleString("id-ID")} invalid${voidNote}.${countNote}`);
      }
      if (source) setSourceName(source);
    } finally {
      setIsAnalyzing(false);
      setLoadingText("");
    }
  };

  const handleFile = async (file?: File) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".json")) {
      setNotice("CEK NASGOR 69 hanya menerima file .json.");
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setNotice("Ukuran file terlalu besar. Batas maksimal adalah 10 MB.");
      return;
    }
    try {
      setIsAnalyzing(true);
      setLoadingText("Membaca file NASGOR 69...");
      const value = await file.text();
      setJsonText(value);
      await analyze(value, file.name);
    } catch {
      setIsAnalyzing(false);
      setLoadingText("");
      setNotice("File JSON tidak dapat dibaca.");
    }
  };

  // allTransactions = seluruh dataset hasil parse (bisa ribuan baris) dan
  // SATU-SATUNYA sumber untuk summary/kalkulasi. filteredRows hanya untuk
  // tampilan (search/filter), dan displayTransactions di bawah memotongnya
  // lagi per halaman supaya tabel tidak me-render ribuan DOM row sekaligus.
  const allTransactions = result?.rows ?? EMPTY_ROWS;

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle && statusFilter === "ALL") return allTransactions; // tanpa salinan array
    return allTransactions.filter((row) => {
      const matchesText = !needle || [row.noStruk, row.idAgent, row.namaUsaha, row.idOutlet, row.dateTrans].some((value) => value.toLowerCase().includes(needle));
      return matchesText && (statusFilter === "ALL" || row.status === statusFilter);
    });
  }, [allTransactions, query, statusFilter]);

  // Summary WAJIB dihitung dari allTransactions (seluruh dataset), bukan
  // dari filteredRows atau displayTransactions yang sudah dipotong tampilan.
  const summary = useMemo(() => summarizeNasgor69(allTransactions), [allTransactions]);

  const { visible: displayTransactions, activePage, totalPages, startIndex: pageStart, endIndex: pageEnd } = useMemo(
    () => paginateNasgor69(filteredRows, currentPage, pageSize),
    [filteredRows, currentPage, pageSize],
  );

  const goToPage = (page: number) => setCurrentPage(Math.min(Math.max(1, page), totalPages));

  const clear = () => {
    setJsonText("");
    setSourceName("");
    setResult(null);
    setNotice("");
    setQuery("");
    setStatusFilter("ALL");
    setSelected(null);
    setCurrentPage(1);
    setPageSize(DEFAULT_PAGE_SIZE);
  };

  const downloadCsv = () => {
    // Export tetap memakai seluruh hasil search/filter (bukan hanya halaman
    // yang sedang tampil), karena CSV tidak dibatasi oleh ukuran DOM.
    const blob = new Blob([nasgor69ToCsv(filteredRows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `nstax-nasgor69-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><span>α</span></div>
          <div><div className="brand-name">nstax</div><div className="brand-caption">transaction intelligence</div></div>
        </div>
        <div className="sidebar-divider" />
        <nav className="sidebar-nav">
          <button className="nav-item" type="button" onClick={onBack}><ArrowLeft size={18} /><span>Kembali pilih mode</span></button>
          <div className="nav-item is-active"><FileJson size={18} /><span>CEK NASGOR 69</span></div>
          <button className="nav-item" type="button" onClick={() => document.getElementById("nasgor69-results")?.scrollIntoView({ behavior: "smooth" })}><Filter size={18} /><span>Hasil & filter</span></button>
        </nav>
        <div className="sidebar-footer">
          <div className="privacy-badge"><ShieldCheck size={16} /><div><strong>Local-first</strong><span>Data tidak keluar dari browser</span></div></div>
          <div className="version-label">nstax / CEK NASGOR 69</div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <button className="button button-secondary compact" type="button" onClick={onBack}><ArrowLeft size={15} /> Kembali</button>
          <div className="breadcrumb"><span>Workspace</span><span>›</span><strong>CEK NASGOR 69</strong></div>
          <div className="status-chip"><span className="status-dot" /></div>
        </header>

        <div className="page-container">
          <section className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> CEK NASGOR 69 · JSON AUDIT</div>
              <h1>Periksa transaksi<br /><em>Nasgor 69 dengan presisi.</em></h1>
              <p>Transaksi Nasgor 69 · Struk, DPP, Tax, dan Total. Upload atau tempel JSON NASGOR 69 (status, count, data); seluruh transaksi di field data diproses tanpa menghitung ulang DPP, Tax, atau Total.</p>
            </div>
            <div className="heading-meta">
              <span className="meta-label">CURRENT SOURCE</span>
              <strong>{sourceName || "Input JSON langsung"}</strong>
              <span className="meta-subtitle">{result?.totalRows?.toLocaleString("id-ID") ?? "0"} transaksi total</span>
            </div>
          </section>

          <section className="input-panel panel-surface">
            <div className="panel-heading">
              <div className="panel-title-wrap">
                <span className="section-number">01</span>
                <div><h2>Upload JSON NASGOR 69</h2><p>Field: id, id_agent, no_struk, date_trans, subtotal, service_charge, discount, dpp, tax, total, id_outlet, dan lainnya.</p></div>
              </div>
              {sourceName && <span className="file-pill"><FileJson size={15} />{sourceName}</span>}
            </div>
            <div className="input-grid">
              <div className="drop-zone-wrap">
                <div
                  className={`drop-zone ${dragActive ? "is-dragging" : ""}`}
                  onDragEnter={(event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragActive(true); }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={(event) => { event.preventDefault(); setDragActive(false); void handleFile(event.dataTransfer.files?.[0]); }}
                >
                  <div className="upload-symbol"><Upload size={20} /></div>
                  <strong>{dragActive ? "Lepaskan file JSON di sini" : "Tarik file JSON ke sini"}</strong>
                  <span>atau pilih dari perangkat Anda</span>
                  <button className="button button-secondary" type="button" onClick={() => inputRef.current?.click()}><FileJson size={16} /> Pilih JSON</button>
                  <small>Maksimal 50 MB · format {"{ status, count, data[] }"}</small>
                  <input ref={inputRef} type="file" accept=".json,application/json" hidden onChange={(event: ChangeEvent<HTMLInputElement>) => { void handleFile(event.target.files?.[0]); event.target.value = ""; }} />
                </div>
              </div>
              <div className="editor-wrap">
                <div className="editor-toolbar"><span><span className="toolbar-dot red" /><span className="toolbar-dot amber" /><span className="toolbar-dot green" /></span><span className="editor-label">nasgor69.json</span><span className="editor-hint">UTF-8</span></div>
                <textarea
                  className="json-editor"
                  value={jsonText}
                  onChange={(event) => { setJsonText(event.target.value); if (notice) setNotice(""); }}
                  placeholder={'{\n  "status": "ok",\n  "count": 2,\n  "data": [\n    {\n      "id": 387508,\n      "id_agent": "hangry_sda",\n      "no_struk": "H103260919QIRW",\n      "date_trans": "2026-09-20 00:42:08",\n      "subtotal": 15100,\n      "service_charge": null,\n      "discount": null,\n      "dpp": 15100,\n      "tax": 1510,\n      "total": 16605,\n      "id_outlet": "H103"\n    }\n  ]\n}'}
                  spellCheck={false}
                  aria-label="Input JSON NASGOR 69"
                />
                <div className="editor-footer"><span>{jsonText.length ? `${jsonText.length.toLocaleString("id-ID")} karakter` : "Menunggu input"}</span><span>Parsing lokal aktif</span></div>
              </div>
            </div>
            <div className="input-actions">
              <div className="privacy-note"><ShieldCheck size={15} /> Diproses lokal di browser</div>
              <div className="button-row">
                <button className="button button-ghost" type="button" onClick={clear}><Trash2 size={16} /> Clear</button>
                <button className="button button-primary" type="button" disabled={isAnalyzing} onClick={() => analyze()}><Check size={16} /> {isAnalyzing ? "Menganalisis..." : "Analisis NASGOR 69"}</button>
              </div>
            </div>
          </section>

          {isAnalyzing && loadingText && <div className="notice notice-success" role="status" aria-live="polite"><span className="notice-icon"><Info size={17} /></span>{loadingText}</div>}

          {notice && !isAnalyzing && <div className={`notice ${result?.ok ? "notice-success" : "notice-error"}`}><span className="notice-icon">{result?.ok ? <Check size={17} /> : <AlertTriangle size={17} />}</span>{notice}</div>}

          {result?.ok && <>
            <section className="analysis-section">
              <div className="section-heading">
                <div><div className="eyebrow"><span className="eyebrow-line" /> 02 · DASHBOARD FULL DATA</div><h2>Ringkasan NASGOR 69</h2></div>
                <button className="button button-secondary compact" type="button" onClick={downloadCsv}><Download size={15} /> Export CSV</button>
              </div>
              <div className="metric-grid upl-metrics">
                <Metric label="Total transaksi" value={summary.transactionCount.toLocaleString("id-ID")} />
                <Metric label="Total subtotal" value={formatNasgor69Rupiah(summary.subtotal)} />
                <Metric label="Total DPP" value={formatNasgor69Rupiah(summary.dpp)} />
                <Metric label="Total tax" value={formatNasgor69Rupiah(summary.tax)} />
                <Metric label="Total total" value={formatNasgor69Rupiah(summary.total)} />
              </div>
              <div className="used-columns">
                <strong>Total baris: {result.totalRows.toLocaleString("id-ID")}</strong>
                <strong>Valid: {result.validRows.toLocaleString("id-ID")}</strong>
                <strong>Invalid: {result.invalidRows.toLocaleString("id-ID")}</strong>
                <strong>Void: {result.voidRows.toLocaleString("id-ID")}</strong>
              </div>
            </section>

            <section className="analysis-section" id="nasgor69-results">
              <div className="section-heading">
                <div><div className="eyebrow"><span className="eyebrow-line" /> 03 · TRANSAKSI</div><h2>Data transaksi NASGOR 69</h2></div>
                <span className="result-count">{filteredRows.length.toLocaleString("id-ID")} dari {result.totalRows.toLocaleString("id-ID")} baris</span>
              </div>
              <div className="input-actions">
                <label className="search-field"><Search size={15} /><input value={query} onChange={(event) => { setQuery(event.target.value); setCurrentPage(1); }} placeholder="Cari no_struk, id_agent, outlet..." /></label>
                <label className="date-field"><Filter size={15} /><select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as StatusFilter); setCurrentPage(1); }}><option value="ALL">Semua</option><option value="Valid">Valid</option><option value="Invalid">Invalid</option></select></label>
                <label className="date-field"><span>Baris/halaman</span><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setCurrentPage(1); }}>{PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
              </div>
              <div className="table-shell">
                <table>
                  <thead>
                    <tr><th>No</th><th>No Struk</th><th>Tanggal</th><th>ID Agent</th><th>Outlet</th><th className="numeric">Subtotal</th><th className="numeric">DPP</th><th className="numeric">Tax</th><th className="numeric">Total</th><th>Void</th><th>Status</th><th>Detail</th></tr>
                  </thead>
                  <tbody>
                    {displayTransactions.map((row, index) => (
                      <tr key={`${row.noStruk || row.id}-${pageStart + index}`}>
                        <td>{pageStart + index + 1}</td>
                        <td><strong>{row.noStruk || "—"}</strong></td>
                        <td>{row.dateTrans || "—"}</td>
                        <td>{row.idAgent || "—"}</td>
                        <td>{row.idOutlet || "—"}{row.outletName ? ` · ${row.outletName}` : ""}</td>
                        <td className="numeric">{money(row.subtotal)}</td>
                        <td className="numeric">{money(row.dpp)}</td>
                        <td className="numeric">{money(row.tax)}</td>
                        <td className="numeric">{money(row.total)}</td>
                        <td>{row.isVoid ? "Ya" : "Tidak"}</td>
                        <td><span className={`notice ${statusClass(row.status)}`} style={{ display: "inline-flex", padding: "4px 8px", margin: 0 }}>{row.status}</span></td>
                        <td><button className="button button-ghost compact" type="button" onClick={() => setSelected(row)}>Lihat</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filteredRows.length === 0 && <div className="table-empty"><Search size={21} /><strong>Tidak ada transaksi yang cocok</strong><span>Coba ubah kata kunci atau filter status.</span></div>}
              </div>
              {filteredRows.length > 0 && (
                <div className="table-footnote">
                  <span><span className="table-dot" />Menampilkan {(pageStart + 1).toLocaleString("id-ID")}-{pageEnd.toLocaleString("id-ID")} dari {filteredRows.length.toLocaleString("id-ID")} transaksi (halaman {activePage.toLocaleString("id-ID")}/{totalPages.toLocaleString("id-ID")})</span>
                  <span className="button-row">
                    <button className="button button-secondary compact" type="button" disabled={activePage <= 1} onClick={() => goToPage(1)}>« Awal</button>
                    <button className="button button-secondary compact" type="button" disabled={activePage <= 1} onClick={() => goToPage(activePage - 1)}>← Sebelumnya</button>
                    <button className="button button-secondary compact" type="button" disabled={activePage >= totalPages} onClick={() => goToPage(activePage + 1)}>Berikutnya →</button>
                    <button className="button button-secondary compact" type="button" disabled={activePage >= totalPages} onClick={() => goToPage(totalPages)}>Akhir »</button>
                  </span>
                </div>
              )}
            </section>
          </>}
        </div>
      </main>

      {selected && (
        <div className="modal-backdrop" role="presentation" onClick={() => setSelected(null)}>
          <div className="modal-card" role="dialog" aria-modal="true" aria-label="Detail transaksi NASGOR 69" onClick={(event) => event.stopPropagation()}>
            <div className="section-heading">
              <div><div className="eyebrow"><span className="eyebrow-line" /> DETAIL TRANSAKSI</div><h2>{selected.noStruk || "Transaksi NASGOR 69"}</h2></div>
              <button className="icon-button" type="button" onClick={() => setSelected(null)} aria-label="Tutup"><X size={18} /></button>
            </div>
            <div className="mapping-grid upl-audit-grid">
              <div><strong>ID</strong><span>{text(selected.id)}</span></div>
              <div><strong>ID Agent</strong><span>{text(selected.idAgent)}</span></div>
              <div><strong>No Struk</strong><span>{text(selected.noStruk)}</span></div>
              <div><strong>Date Trans</strong><span>{text(selected.dateTrans)}</span></div>
              <div><strong>Log Time</strong><span>{text(selected.logTime)}</span></div>
              <div><strong>Status</strong><span>{selected.status}</span></div>
              <div><strong>Subtotal</strong><span>{money(selected.subtotal)}</span></div>
              <div><strong>Service Charge</strong><span>{money(selected.serviceCharge)}</span></div>
              <div><strong>Discount</strong><span>{money(selected.discount)}</span></div>
              <div><strong>DPP</strong><span>{money(selected.dpp)}</span></div>
              <div><strong>Tax</strong><span>{money(selected.tax)}</span></div>
              <div><strong>Total</strong><span>{money(selected.total)}</span></div>
              <div><strong>Void</strong><span>{selected.isVoid ? "Ya" : "Tidak"}</span></div>
              <div><strong>Keterangan</strong><span>{text(selected.keterangan)}</span></div>
              <div><strong>Pos Tipe</strong><span>{text(selected.posTipe)}</span></div>
              <div><strong>Nama Usaha</strong><span>{text(selected.namaUsaha)}</span></div>
              <div><strong>ID Server</strong><span>{text(selected.idServer)}</span></div>
              <div><strong>ID Outlet</strong><span>{text(selected.idOutlet)}</span></div>
              <div><strong>Outlet Name</strong><span>{text(selected.outletName)}</span></div>
            </div>
            {selected.error && <div className="notice notice-warning"><Info size={17} /> {selected.error}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
