import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { AlertTriangle, ArrowLeft, Check, Download, FileJson, Filter, Info, Search, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import {
  buildHangrySdaResult,
  extractHangrySdaRecords,
  formatHangrySdaRupiah,
  paginateHangrySda,
  hangrySdaCountWarning,
  hangrySdaToCsv,
  summarizeHangrySda,
  type HangrySdaParseResult,
  type HangrySdaTransaction,
} from "@/lib/parsers/hangrySdaParser";
import { SidebarBrand } from "@/components/BrandLogo";

type Props = { onBack: () => void; initialJson?: string; initialSourceName?: string };
type RowFilter = "ALL" | "Valid" | "Invalid" | "VOID" | "NON_VOID";
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 50;
const EMPTY_ROWS: HangrySdaTransaction[] = [];

// Beri kesempatan browser me-render indikator loading sebelum parsing berat dimulai.
const nextPaint = () => new Promise<void>((resolve) => { requestAnimationFrame(() => setTimeout(resolve, 0)); });

function Metric({ label, value, helper }: { label: string; value: string; helper?: string }) {
  return (
    <div className="metric-card">
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
      <span className="metric-helper">{helper ?? "Dari seluruh transaksi di data"}</span>
    </div>
  );
}

// Nilai null tampil "—" (bukan 0); desimal sumber tidak dibulatkan ke bilangan bulat.
const money = (value: number | null, maxFraction = 2) => (value === null ? "—" : formatHangrySdaRupiah(value, maxFraction));
const amountHelper = (missing: number) => (missing > 0 ? `${missing.toLocaleString("id-ID")} transaksi tanpa nilai (null/kosong), tidak dijumlah` : "Dari seluruh transaksi di data");
const text = (value: string | null) => (value === null || value === "" ? "-" : value);

export default function HangrySdaChecker({ onBack, initialJson, initialSourceName }: Props) {
  const [jsonText, setJsonText] = useState(initialJson ?? "");
  const [sourceName, setSourceName] = useState(initialSourceName ?? "");
  const [result, setResult] = useState<HangrySdaParseResult | null>(null);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [rowFilter, setRowFilter] = useState<RowFilter>("ALL");
  const [selected, setSelected] = useState<HangrySdaTransaction | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [loadingText, setLoadingText] = useState("");
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [currentPage, setCurrentPage] = useState(1);
  const inputRef = useRef<HTMLInputElement>(null);

  // Upload file dan paste JSON memakai jalur yang sama (analyze). JSON di-parse
  // sekali; seluruh isi array `data` menjadi allTransactions tanpa slice/sampling.
  const analyze = async (value = jsonText, source = sourceName) => {
    setIsAnalyzing(true);
    setLoadingText("Memproses data HANGRY SDA...");
    await nextPaint();
    try {
      const extracted = extractHangrySdaRecords(value);
      let parsed: HangrySdaParseResult;
      if (!extracted.ok) {
        parsed = { ok: false, error: extracted.error, rows: [], totalRows: 0, validRows: 0, invalidRows: 0, voidRows: 0, declaredCount: null };
      } else {
        setLoadingText(`Memproses ${extracted.records.length.toLocaleString("id-ID")} transaksi...`);
        await nextPaint();
        parsed = buildHangrySdaResult(extracted.records, extracted.declaredCount);
      }
      setResult(parsed);
      setQuery("");
      setRowFilter("ALL");
      setSelected(null);
      setCurrentPage(1);
      if (!parsed.ok) {
        setNotice(parsed.error ?? "Format JSON tidak sesuai dengan HANGRY SDA.");
      } else {
        const voidNote = parsed.voidRows ? ` · ${parsed.voidRows.toLocaleString("id-ID")} void` : "";
        setNotice(`HANGRY SDA berhasil diproses · Total transaksi: ${parsed.totalRows.toLocaleString("id-ID")} · ${parsed.validRows.toLocaleString("id-ID")} valid · ${parsed.invalidRows.toLocaleString("id-ID")} invalid${voidNote}.`);
      }
      if (source) setSourceName(source);
    } finally {
      setIsAnalyzing(false);
      setLoadingText("");
    }
  };

  // Dipakai BACA DATA APITRANS (V2): data dari auto-detect langsung dianalisis, tanpa mengubah jalur parsing.
  useEffect(() => {
    if (initialJson) void analyze(initialJson, initialSourceName ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFile = async (file?: File) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".json")) {
      setNotice("HANGRY SDA hanya menerima file .json.");
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setNotice("Ukuran file terlalu besar. Batas maksimal adalah 50 MB.");
      return;
    }
    try {
      setIsAnalyzing(true);
      setLoadingText("Membaca file HANGRY SDA...");
      const value = await file.text();
      setJsonText(value);
      await analyze(value, file.name);
    } catch {
      setIsAnalyzing(false);
      setLoadingText("");
      setNotice("File JSON tidak dapat dibaca.");
    }
  };

  // allTransactions = seluruh dataset hasil parse dan SATU-SATUNYA sumber summary.
  // filteredRows hanya untuk tampilan; displayTransactions hanya satu halaman.
  const allTransactions = result?.rows ?? EMPTY_ROWS;

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle && rowFilter === "ALL") return allTransactions;
    return allTransactions.filter((row) => {
      const matchesText = !needle || [row.noStruk, row.idAgent, row.namaUsaha, row.idOutlet, row.dateTrans, row.id].some((value) => value.toLowerCase().includes(needle));
      const matchesFilter = rowFilter === "ALL"
        || (rowFilter === "VOID" ? row.isVoid : rowFilter === "NON_VOID" ? !row.isVoid : row.status === rowFilter);
      return matchesText && matchesFilter;
    });
  }, [allTransactions, query, rowFilter]);

  const summary = useMemo(() => summarizeHangrySda(allTransactions), [allTransactions]);
  const countWarning = result?.ok ? hangrySdaCountWarning(result) : null;

  const { visible: displayTransactions, activePage, totalPages, startIndex: pageStart, endIndex: pageEnd } = useMemo(
    () => paginateHangrySda(filteredRows, currentPage, pageSize),
    [filteredRows, currentPage, pageSize],
  );

  const goToPage = (page: number) => setCurrentPage(Math.min(Math.max(1, page), totalPages));

  const clear = () => {
    setJsonText("");
    setSourceName("");
    setResult(null);
    setNotice("");
    setQuery("");
    setRowFilter("ALL");
    setSelected(null);
    setCurrentPage(1);
    setPageSize(DEFAULT_PAGE_SIZE);
  };

  const downloadCsv = () => {
    const blob = new Blob([hangrySdaToCsv(filteredRows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `nstax-hangry-sda-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <SidebarBrand />
        <div className="sidebar-divider" />
        <nav className="sidebar-nav">
          <button className="nav-item" type="button" onClick={onBack}><ArrowLeft size={18} /><span>Kembali ke CEK DATA API</span></button>
          <div className="nav-item is-active"><FileJson size={18} /><span>HANGRY SDA</span></div>
          <button className="nav-item" type="button" onClick={() => document.getElementById("hangry-sda-results")?.scrollIntoView({ behavior: "smooth" })}><Filter size={18} /><span>Hasil & filter</span></button>
        </nav>
        <div className="sidebar-footer">
          <div className="privacy-badge"><ShieldCheck size={16} /><div><strong>Local-first</strong><span>Data tidak keluar dari browser</span></div></div>
          <div className="version-label">nstax / HANGRY SDA</div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <button className="button button-secondary compact" type="button" onClick={onBack}><ArrowLeft size={15} /> Kembali</button>
          <div className="breadcrumb"><span>CEK DATA API</span><span>›</span><strong>HANGRY SDA</strong></div>
          <div className="status-chip"><span className="status-dot" /></div>
        </header>

        <div className="page-container">
          <section className="page-heading">
            <div>
              <h1>Cek <em>HANGRY SDA</em></h1>
              <p>Upload atau tempel JSON (status, count, data). Seluruh transaksi di field data diproses; Subtotal, Diskon, DPP, Pajak, dan Total memakai nilai sumber tanpa dihitung ulang.</p>
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
                <div><h2>Upload JSON HANGRY SDA</h2><p>Field: id, id_agent, no_struk, date_trans, subtotal, service_charge, discount, dpp, tax, total, void, id_outlet, dan lainnya.</p></div>
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
                <div className="editor-toolbar"><span><span className="toolbar-dot red" /><span className="toolbar-dot amber" /><span className="toolbar-dot green" /></span><span className="editor-label">hangry-sda.json</span><span className="editor-hint">UTF-8</span></div>
                <textarea
                  className="json-editor"
                  value={jsonText}
                  onChange={(event) => { setJsonText(event.target.value); if (notice) setNotice(""); }}
                  placeholder={'{\n  "status": "ok",\n  "count": 1,\n  "data": [\n    {\n      "id": 481378,\n      "id_agent": "hangry_sda",\n      "no_struk": "H136261017MGNY",\n      "date_trans": "2026-10-17 23:03:16",\n      "subtotal": 38180,\n      "service_charge": null,\n      "discount": null,\n      "dpp": 38180,\n      "tax": 3818,\n      "total": 42002,\n      "void": 0,\n      "id_outlet": "H136"\n    }\n  ]\n}'}
                  spellCheck={false}
                  aria-label="Input JSON HANGRY SDA"
                />
                <div className="editor-footer"><span>{jsonText.length ? `${jsonText.length.toLocaleString("id-ID")} karakter` : "Menunggu input"}</span><span>Parsing lokal aktif</span></div>
              </div>
            </div>
            <div className="input-actions">
              <div className="privacy-note"><ShieldCheck size={15} /> Diproses lokal di browser</div>
              <div className="button-row">
                <button className="button button-ghost" type="button" onClick={clear}><Trash2 size={16} /> Clear</button>
                <button className="button button-primary" type="button" disabled={isAnalyzing} onClick={() => analyze()}><Check size={16} /> {isAnalyzing ? "Menganalisis..." : "Analisis HANGRY SDA"}</button>
              </div>
            </div>
          </section>

          {isAnalyzing && loadingText && <div className="notice notice-success" role="status" aria-live="polite"><span className="notice-icon"><Info size={17} /></span>{loadingText}</div>}

          {notice && !isAnalyzing && <div className={`notice ${result?.ok ? "notice-success" : "notice-error"}`}><span className="notice-icon">{result?.ok ? <Check size={17} /> : <AlertTriangle size={17} />}</span>{notice}</div>}

          {countWarning && !isAnalyzing && <div className="notice notice-warning" role="alert"><span className="notice-icon"><AlertTriangle size={17} /></span>{countWarning}</div>}

          {result?.ok && <>
            <section className="analysis-section">
              <div className="section-heading">
                <div><div className="eyebrow"><span className="eyebrow-line" /> 02 · DASHBOARD FULL DATA</div><h2>Ringkasan HANGRY SDA</h2></div>
                <button className="button button-secondary compact" type="button" onClick={downloadCsv}><Download size={15} /> Export CSV</button>
              </div>
              <div className="metric-grid upl-metrics">
                <Metric label="Total transaksi" value={summary.all.transactionCount.toLocaleString("id-ID")} helper="Jumlah objek aktual di data (termasuk void)" />
                <Metric label="Total subtotal" value={money(summary.all.subtotal.sum)} helper={amountHelper(summary.all.subtotal.missingCount)} />
                <Metric label="Total service charge" value={money(summary.all.serviceCharge.sum)} helper={amountHelper(summary.all.serviceCharge.missingCount)} />
                <Metric label="Total diskon" value={money(summary.all.discount.sum)} helper={amountHelper(summary.all.discount.missingCount)} />
                <Metric label="Total DPP" value={money(summary.all.dpp.sum)} helper={amountHelper(summary.all.dpp.missingCount)} />
                <Metric label="Total pajak" value={money(summary.all.tax.sum)} helper={amountHelper(summary.all.tax.missingCount)} />
                <Metric label="Total total" value={money(summary.all.total.sum)} helper={amountHelper(summary.all.total.missingCount)} />
              </div>
              <div className="used-columns">
                <strong>Total baris: {result.totalRows.toLocaleString("id-ID")}</strong>
                <strong>Valid: {result.validRows.toLocaleString("id-ID")}</strong>
                <strong>Invalid: {result.invalidRows.toLocaleString("id-ID")}</strong>
                <strong>Void: {result.voidRows.toLocaleString("id-ID")}</strong>
                <strong>Non-void: {(result.totalRows - result.voidRows).toLocaleString("id-ID")}</strong>
              </div>
              {result.voidRows > 0 && (
                <div className="used-columns">
                  <strong>Hanya non-void: {summary.nonVoid.transactionCount.toLocaleString("id-ID")} transaksi</strong>
                  <strong>Subtotal {money(summary.nonVoid.subtotal.sum)}</strong>
                  <strong>DPP {money(summary.nonVoid.dpp.sum)}</strong>
                  <strong>Pajak {money(summary.nonVoid.tax.sum)}</strong>
                  <strong>Total {money(summary.nonVoid.total.sum)}</strong>
                </div>
              )}
              <div className="table-footnote"><span>Aturan penghitungan: nilai sumber dijumlah apa adanya tanpa dihitung ulang. Nilai null tidak dianggap 0 (hanya nilai valid yang dijumlah; jumlah yang kosong dilaporkan di bawah tiap kartu). Void tidak dibuang: kartu di atas mencakup semua transaksi, dan total non-void ditampilkan terpisah. Perlakuan void untuk Hangry perlu dikonfirmasi.</span></div>
            </section>

            <section className="analysis-section" id="hangry-sda-results">
              <div className="section-heading">
                <div><div className="eyebrow"><span className="eyebrow-line" /> 03 · TRANSAKSI</div><h2>Data transaksi HANGRY SDA</h2></div>
                <span className="result-count">{filteredRows.length.toLocaleString("id-ID")} dari {result.totalRows.toLocaleString("id-ID")} baris</span>
              </div>
              <div className="input-actions">
                <label className="search-field"><Search size={15} /><input value={query} onChange={(event) => { setQuery(event.target.value); setCurrentPage(1); }} placeholder="Cari no_struk, id, id_agent, outlet..." /></label>
                <label className="date-field"><Filter size={15} /><select value={rowFilter} onChange={(event) => { setRowFilter(event.target.value as RowFilter); setCurrentPage(1); }}><option value="ALL">Semua</option><option value="Valid">Valid</option><option value="Invalid">Invalid</option><option value="VOID">Void</option><option value="NON_VOID">Non-void</option></select></label>
                <label className="date-field"><span>Baris/halaman</span><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setCurrentPage(1); }}>{PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
              </div>
              <div className="table-shell">
                <table>
                  <thead>
                    <tr><th>No</th><th>No Struk</th><th>Tanggal</th><th>ID Agent</th><th>ID Outlet</th><th className="numeric">Subtotal</th><th className="numeric">Diskon</th><th className="numeric">DPP</th><th className="numeric">Pajak</th><th className="numeric">Total</th><th>Void</th><th>Status</th><th>Detail</th></tr>
                  </thead>
                  <tbody>
                    {displayTransactions.map((row, index) => (
                      <tr key={`${row.id || row.noStruk}-${pageStart + index}`}>
                        <td>{pageStart + index + 1}</td>
                        <td><strong>{row.noStruk || "—"}</strong></td>
                        <td>{row.dateTrans || "—"}</td>
                        <td>{row.idAgent || "—"}</td>
                        <td>{row.idOutlet || "—"}</td>
                        <td className="numeric">{money(row.subtotal)}</td>
                        <td className="numeric">{money(row.discount)}</td>
                        <td className="numeric">{money(row.dpp)}</td>
                        <td className="numeric">{money(row.tax)}</td>
                        <td className="numeric">{money(row.total)}</td>
                        <td>{row.isVoid ? "Ya" : "Tidak"}</td>
                        <td><span className={`notice ${row.status === "Valid" ? "notice-success" : "notice-error"}`} style={{ display: "inline-flex", padding: "4px 8px", margin: 0 }}>{row.status}</span></td>
                        <td><button className="button button-ghost compact" type="button" onClick={() => setSelected(row)}>Lihat</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filteredRows.length === 0 && <div className="table-empty"><Search size={21} /><strong>Tidak ada transaksi yang cocok</strong><span>Coba ubah kata kunci atau filter.</span></div>}
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
          <div className="modal-card" role="dialog" aria-modal="true" aria-label="Detail transaksi HANGRY SDA" onClick={(event) => event.stopPropagation()}>
            <div className="section-heading">
              <div><div className="eyebrow"><span className="eyebrow-line" /> DETAIL TRANSAKSI</div><h2>{selected.noStruk || "Transaksi HANGRY SDA"}</h2></div>
              <button className="icon-button" type="button" onClick={() => setSelected(null)} aria-label="Tutup"><X size={18} /></button>
            </div>
            <div className="mapping-grid upl-audit-grid">
              <div><strong>ID</strong><span>{text(selected.id)}</span></div>
              <div><strong>ID Agent</strong><span>{text(selected.idAgent)}</span></div>
              <div><strong>No Struk</strong><span>{text(selected.noStruk)}</span></div>
              <div><strong>Date Trans</strong><span>{text(selected.dateTrans)}</span></div>
              <div><strong>Log Time</strong><span>{text(selected.logTime)}</span></div>
              <div><strong>Status</strong><span>{selected.status}</span></div>
              <div><strong>Subtotal</strong><span>{money(selected.subtotal, 6)}</span></div>
              <div><strong>Service Charge</strong><span>{money(selected.serviceCharge, 6)}</span></div>
              <div><strong>Discount</strong><span>{money(selected.discount, 6)}</span></div>
              <div><strong>DPP</strong><span>{money(selected.dpp, 6)}</span></div>
              <div><strong>Tax</strong><span>{money(selected.tax, 6)}</span></div>
              <div><strong>Total</strong><span>{money(selected.total, 6)}</span></div>
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
