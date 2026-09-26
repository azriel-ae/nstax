import { useMemo, useRef, useState, type DragEvent, type ChangeEvent } from "react";
import {
  AlertTriangle,
  BarChart3,
  Check,
  ChevronRight,
  Clipboard,
  ClipboardCheck,
  Copy,
  Database,
  Download,
  FileJson,
  FileText,
  Filter,
  Hash,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Receipt,
  Search,
  ShieldCheck,
  Sun,
  Table2,
  Trash2,
  Upload,
  Wallet,
  X,
} from "lucide-react";
import {
  calculateSummary,
  formatInteger,
  formatRupiahMinor,
  MAX_FILE_SIZE_BYTES,
  parseTransactionJson,
  TAX_RATE_PERCENT,
  toCsv,
  type ParsedTransaction,
  type ParseResult,
} from "@/lib/transactionParser";
import ForeChecker from "@/pages/ForeChecker";
import VendorChecker from "@/pages/VendorChecker";
import type { VendorKind } from "@/lib/vendorParser";
import ReceiptChecker from "@/pages/ReceiptChecker";
import UplChecker from "@/pages/UplChecker";
import AstanaChecker from "@/pages/AstanaChecker";
import PointCoffeeChecker from "@/pages/PointCoffeeChecker";
import ReceiptCompareChecker from "@/pages/ReceiptCompareChecker";
import Nasgor69Checker from "@/pages/Nasgor69Checker";

const initialJson = "";

type Notice = { kind: "success" | "error" | "warning"; message: string } | null;

type MetricCardProps = {
  label: string;
  value: string;
  helper: string;
  icon: typeof BarChart3;
  accent: string;
};

function MetricCard({ label, value, helper, icon: Icon, accent }: MetricCardProps) {
  return (
    <article className="metric-card">
      <div className="metric-topline">
        <span className={`metric-icon ${accent}`}><Icon size={17} strokeWidth={1.9} /></span>
        <span className="metric-label">{label}</span>
      </div>
      <strong className="metric-value">{value}</strong>
      <span className="metric-helper">{helper}</span>
    </article>
  );
}

function formatDate(date: string) {
  if (!date || date === "—") return "—";
  const parsed = new Date(`${date}T00:00:00`);
  return Number.isNaN(parsed.getTime())
    ? date
    : new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", year: "numeric" }).format(parsed);
}

function shapeLabel(shape: ParseResult["detectedShape"]) {
  return { object: "Satu object", array: "Array", nested: "Nested object", unknown: "Belum terdeteksi" }[shape];
}

function copyToClipboard(value: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const temporary = document.createElement("textarea");
  temporary.value = value;
  temporary.style.position = "fixed";
  temporary.style.opacity = "0";
  document.body.appendChild(temporary);
  temporary.select();
  document.execCommand("copy");
  temporary.remove();
  return Promise.resolve();
}

function NscChecker({ onBack }: { onBack?: () => void }) {
  const [jsonText, setJsonText] = useState(initialJson);
  const [sourceName, setSourceName] = useState("");
  const [result, setResult] = useState<ParseResult | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [query, setQuery] = useState("");
  const [dateFilter, setDateFilter] = useState("");
  const [selectedTransaction, setSelectedTransaction] = useState<ParsedTransaction | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [copiedKey, setCopiedKey] = useState("");
  const [darkMode, setDarkMode] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const analyze = (text = jsonText, source = sourceName) => {
    try {
      const probe = JSON.parse(text) as unknown;
      const records = Array.isArray(probe) ? probe : [probe];
      if (records.some((item) => item && typeof item === "object" && ("billing_id" in item || "counter_id" in item || "pajak" in item))) {
        setResult(null);
        setNotice({ kind: "error", message: "Format JSON tidak sesuai dengan mode NSC." });
        return;
      }
    } catch {
      // The existing NSC parser provides the canonical malformed-JSON message below.
    }
    const parsed = parseTransactionJson(text);
    setResult(parsed);
    setQuery("");
    setDateFilter("");
    if (!parsed.ok) {
      setNotice({ kind: "error", message: parsed.error ?? "Tidak dapat membaca JSON." });
    } else if (!parsed.validTransactions.length) {
      setNotice({ kind: "warning", message: parsed.warning ?? "Tidak ditemukan transaksi valid." });
    } else if (parsed.issues.length || parsed.duplicateCount) {
      const detail = [
        parsed.issues.length ? `${parsed.issues.length} masalah` : "",
        parsed.duplicateCount ? `${parsed.duplicateCount} baris kemungkinan duplikat` : "",
      ].filter(Boolean).join(" · ");
      setNotice({ kind: "warning", message: `${detail}. Data valid tetap dihitung, data bermasalah dikeluarkan.` });
    } else {
      setNotice({ kind: "success", message: `${parsed.validTransactions.length} transaksi siap diperiksa.` });
    }
    if (source) setSourceName(source);
  };

  const handleFile = async (file?: File) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".json")) {
      setNotice({ kind: "error", message: "Hanya file dengan ekstensi .json yang dapat di-upload." });
      return;
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      setNotice({ kind: "error", message: "Ukuran file terlalu besar. Batas maksimal adalah 5 MB." });
      return;
    }
    try {
      const text = await file.text();
      setJsonText(text);
      setSourceName(file.name);
      analyze(text, file.name);
    } catch {
      setNotice({ kind: "error", message: "File tidak dapat dibaca. Coba pilih file JSON lain." });
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    void handleFile(event.target.files?.[0]);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    void handleFile(event.dataTransfer.files?.[0]);
  };

  const clearAll = () => {
    setJsonText("");
    setSourceName("");
    setResult(null);
    setNotice(null);
    setQuery("");
    setDateFilter("");
    setSelectedTransaction(null);
  };

  const transactions = result?.validTransactions ?? [];
  const filteredTransactions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return transactions.filter((transaction) => {
      const matchesQuery = !normalizedQuery || [transaction.transactionNo, transaction.movieTitle, transaction.date, transaction.studio]
        .some((value) => value.toLowerCase().includes(normalizedQuery));
      return matchesQuery && (!dateFilter || transaction.date === dateFilter);
    });
  }, [dateFilter, query, transactions]);

  const summary = useMemo(() => calculateSummary(filteredTransactions), [filteredTransactions]);
  const hasAnalysis = Boolean(result);
  const sourceLabel = sourceName || "Input JSON langsung";

  const setCopied = (key: string) => {
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey(""), 1800);
  };

  const copySummary = async () => {
    const text = [
      "Ringkasan nstax",
      `Sumber: ${sourceLabel}`,
      `Total Transaksi: ${summary.count}`,
      `Total Subtotal: ${formatRupiahMinor(summary.totalMinor)}`,
      `Total Pajak (${TAX_RATE_PERCENT}%): ${formatRupiahMinor(summary.taxMinor)}`,
      `Grand Total: ${formatRupiahMinor(summary.grandTotalMinor)}`,
      `Total Orders: ${formatInteger(summary.totalOrders)}`,
      `Total Selected Orders: ${formatInteger(summary.selectedOrders)}`,
      `Total Seat: ${formatInteger(summary.totalSeat)}`,
    ].join("\n");
    await copyToClipboard(text);
    setCopied("summary");
  };

  const copyTable = async () => {
    const text = filteredTransactions.map((transaction, index) => [
      index + 1,
      transaction.transactionNo,
      transaction.movieTitle,
      transaction.date,
      transaction.showTime,
      transaction.studio,
      transaction.totalOrders,
      transaction.selectedOrders,
      transaction.totalSeat,
      formatRupiahMinor(transaction.totalMinor),
      formatRupiahMinor(transaction.taxMinor),
      formatRupiahMinor(transaction.grandTotalMinor),
    ].join("\t")).join("\n");
    await copyToClipboard(text);
    setCopied("table");
  };

  const downloadCsv = () => {
    const blob = new Blob([toCsv(filteredTransactions)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `nstax-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={`app-shell ${darkMode ? "dark-mode" : ""}`}>
      <aside className={`app-sidebar ${sidebarOpen ? "is-open" : "is-collapsed"}`}>
        <div className="brand-lockup">
          <div className="brand-mark"><span>α</span></div>
          {sidebarOpen && <div><div className="brand-name">nstax</div><div className="brand-caption">transaction intelligence</div></div>}
        </div>
        <div className="sidebar-divider" />
        <nav className="sidebar-nav" aria-label="Navigasi utama">
          {onBack && <button className="nav-item" type="button" onClick={onBack}><ChevronRight size={18} className="back-chevron" /><span>Kembali pilih mode</span></button>}
          <button className="nav-item is-active" type="button" onClick={() => document.getElementById("workspace")?.scrollIntoView({ behavior: "smooth" })}>
            <BarChart3 size={18} /><span>Analisis</span>
          </button>
          <button className="nav-item" type="button" onClick={() => document.getElementById("transactions")?.scrollIntoView({ behavior: "smooth" })}>
            <Table2 size={18} /><span>Transaksi</span>
          </button>
          <button className="nav-item" type="button" onClick={() => document.getElementById("privacy")?.scrollIntoView({ behavior: "smooth" })}>
            <ShieldCheck size={18} /><span>Privasi data</span>
          </button>
        </nav>
        {sidebarOpen && <div className="sidebar-footer">
          <div className="privacy-badge"><ShieldCheck size={16} /><div><strong>Local-first</strong><span>Data tidak keluar dari browser</span></div></div>
          <div className="version-label">nstax / v1.0</div>
        </div>}
      </aside>

      <main className="main-content">
        <header className="topbar">
          <button className="icon-button sidebar-toggle" type="button" onClick={() => setSidebarOpen((open) => !open)} aria-label="Toggle sidebar">
            {sidebarOpen ? <PanelLeftClose size={19} /> : <PanelLeftOpen size={19} />}
          </button>
          <div className="breadcrumb"><span>Workspace</span><ChevronRight size={14} /><strong>NSC Tax Checker</strong></div>
          {onBack && <button className="button button-secondary compact" type="button" onClick={onBack}>← Kembali pilih mode</button>}
          <div className="topbar-actions">
            <div className="status-chip"><span className="status-dot" /></div>
            <button className="icon-button" type="button" onClick={() => setDarkMode((mode) => !mode)} aria-label="Ganti tema">
              {darkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </header>

        <div className="page-container" id="workspace">
          <section className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> DATA TRANSACTION WORKSPACE</div>
              <h1>Periksa transaksi<br /><em>tanpa prasangka.</em></h1>
              <p>Parse, validasi, dan hitung data JSON secara presisi. Semua proses berjalan lokal di browser Anda.</p>
            </div>
            <div className="heading-meta">
              <span className="meta-label">CURRENT SOURCE</span>
              <strong>{sourceLabel}</strong>
              <span className="meta-subtitle">{hasAnalysis ? `${transactions.length} transaksi valid terdeteksi` : "Belum ada data dianalisis"}</span>
            </div>
          </section>

          <section className="input-panel panel-surface">
            <div className="panel-heading">
              <div className="panel-title-wrap"><span className="section-number">01</span><div><h2>Input data JSON</h2><p>Upload file atau tempel payload langsung untuk memulai.</p></div></div>
              {sourceName && <div className="file-pill"><FileJson size={15} />{sourceName}<button type="button" onClick={() => setSourceName("")} aria-label="Hapus nama file"><X size={13} /></button></div>}
            </div>
            <div className="input-grid">
              <div className="drop-zone-wrap">
                <div
                  className={`drop-zone ${dragActive ? "is-dragging" : ""}`}
                  onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={(event) => { if (event.currentTarget === event.target) setDragActive(false); }}
                  onDrop={handleDrop}
                >
                  <div className="upload-symbol"><Upload size={20} /></div>
                  <strong>{dragActive ? "Lepaskan file di sini" : "Tarik file JSON ke sini"}</strong>
                  <span>atau pilih dari perangkat Anda</span>
                  <button className="button button-secondary" type="button" onClick={() => fileInputRef.current?.click()}><FileJson size={16} /> Pilih file JSON</button>
                  <small>Maksimal 5 MB · hanya .json</small>
                  <input ref={fileInputRef} type="file" accept=".json,application/json" onChange={handleFileChange} hidden />
                </div>
              </div>
              <div className="editor-wrap">
                <div className="editor-toolbar"><span><span className="toolbar-dot red" /><span className="toolbar-dot amber" /><span className="toolbar-dot green" /></span><span className="editor-label">payload.json</span><span className="editor-hint">UTF-8</span></div>
                <textarea
                  className="json-editor"
                  value={jsonText}
                  onChange={(event) => { setJsonText(event.target.value); if (notice) setNotice(null); }}
                  placeholder={'{\n  "transaction_no": "...",\n  "movie_title": "...",\n  "total": 0\n}'}
                  spellCheck={false}
                  aria-label="Input JSON"
                />
                <div className="editor-footer"><span>{jsonText.length ? `${jsonText.length.toLocaleString("id-ID")} karakter` : "Menunggu input"}</span><span>Parsing lokal aktif</span></div>
              </div>
            </div>
            <div className="input-actions">
              <div className="privacy-note"><ShieldCheck size={15} /><span>Diproses lokal di browser · tidak dikirim ke server</span></div>
              <div className="button-row"><button className="button button-ghost" type="button" onClick={clearAll}><Trash2 size={16} /> Clear</button><button className="button button-primary" type="button" onClick={() => analyze()}><BarChart3 size={16} /> Analisis JSON</button></div>
            </div>
          </section>

          {notice && <div className={`notice notice-${notice.kind}`} role="status"><span className="notice-icon">{notice.kind === "success" ? <Check size={17} /> : <AlertTriangle size={17} />}</span><span>{notice.message}</span>{notice.kind !== "success" && result?.issues.length ? <button type="button" onClick={() => document.getElementById("validation-issues")?.scrollIntoView({ behavior: "smooth" })}>Lihat detail <ChevronRight size={14} /></button> : null}</div>}

          {hasAnalysis && result && transactions.length > 0 && <>
            <section className="analysis-section" aria-labelledby="summary-heading">
              <div className="section-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> 02 · CALCULATION OUTPUT</div><h2 id="summary-heading">Ringkasan analisis</h2></div><div className="section-actions"><span className="result-count">Menampilkan {filteredTransactions.length} dari {transactions.length}</span><button className="text-button" type="button" onClick={copySummary}>{copiedKey === "summary" ? <ClipboardCheck size={15} /> : <Clipboard size={15} />}{copiedKey === "summary" ? "Tersalin" : "Copy summary"}</button></div></div>
              <div className="metric-grid">
                <MetricCard label="Total transaksi" value={formatInteger(BigInt(summary.count))} helper="baris valid" icon={BarChart3} accent="accent-sage" />
                <MetricCard label="Total subtotal" value={formatRupiahMinor(summary.totalMinor)} helper="sebelum pajak" icon={Database} accent="accent-ochre" />
                <MetricCard label={`Total pajak (${TAX_RATE_PERCENT}%)`} value={formatRupiahMinor(summary.taxMinor)} helper="dihitung otomatis" icon={Receipt} accent="accent-rose" />
                <MetricCard label="Grand total" value={formatRupiahMinor(summary.grandTotalMinor)} helper="subtotal + pajak" icon={Wallet} accent="accent-indigo" />
                <MetricCard label="Total orders" value={formatInteger(summary.totalOrders)} helper="semua pesanan" icon={Hash} accent="accent-coral" />
                <MetricCard label="Selected orders" value={formatInteger(summary.selectedOrders)} helper="pesanan terpilih" icon={Check} accent="accent-sage" />
                <MetricCard label="Total seat" value={formatInteger(summary.totalSeat)} helper="kursi terdata" icon={Table2} accent="accent-teal" />
              </div>
            </section>

            <section className="table-section" id="transactions" aria-labelledby="table-heading">
              <div className="section-heading table-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> 03 · TRANSACTION REGISTER</div><h2 id="table-heading">Daftar transaksi</h2></div><div className="table-actions"><button className="button button-secondary compact" type="button" onClick={copyTable}><Copy size={15} />{copiedKey === "table" ? "Tersalin" : "Copy tabel"}</button><button className="button button-secondary compact" type="button" onClick={downloadCsv}><Download size={15} />Export CSV</button></div></div>
              <div className="filters-bar"><div className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari transaction no, movie, date, studio..." aria-label="Cari transaksi" />{query && <button type="button" onClick={() => setQuery("")} aria-label="Hapus pencarian"><X size={14} /></button>}</div><label className="date-field"><Filter size={15} /><span>Tanggal</span><input type="date" value={dateFilter} onChange={(event) => setDateFilter(event.target.value)} /></label></div>
              <div className="table-shell"><table><thead><tr><th>No</th><th>Transaction No</th><th>Movie</th><th>Date</th><th>Show Time</th><th>Studio</th><th className="numeric">Orders</th><th className="numeric">Selected</th><th className="numeric">Seat</th><th className="numeric">Subtotal</th><th className="numeric">{`Pajak (${TAX_RATE_PERCENT}%)`}</th><th className="numeric">Grand Total</th></tr></thead><tbody>{filteredTransactions.map((transaction, index) => <tr key={transaction.id} className="transaction-row" onClick={() => setSelectedTransaction(transaction)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter") setSelectedTransaction(transaction); }}><td className="row-number">{String(index + 1).padStart(2, "0")}</td><td><div className="transaction-id">{transaction.transactionNo}{transaction.isDuplicate && <span className="duplicate-tag">duplikat</span>}</div></td><td className="movie-cell">{transaction.movieTitle}</td><td>{formatDate(transaction.date)}</td><td className="mono-cell">{transaction.showTime}</td><td><span className="studio-badge">{transaction.studio}</span></td><td className="numeric">{formatInteger(transaction.totalOrders)}</td><td className="numeric">{formatInteger(transaction.selectedOrders)}</td><td className="numeric">{formatInteger(transaction.totalSeat)}</td><td className="numeric subtotal-cell">{formatRupiahMinor(transaction.totalMinor)}</td><td className="numeric">{formatRupiahMinor(transaction.taxMinor)}</td><td className="numeric grand-total-cell">{formatRupiahMinor(transaction.grandTotalMinor)}</td></tr>)}</tbody></table>{filteredTransactions.length === 0 && <div className="table-empty"><Search size={21} /><strong>Tidak ada transaksi yang cocok</strong><span>Coba ubah kata kunci atau filter tanggal.</span></div>}</div><div className="table-footnote"><span><span className="table-dot" />Klik baris untuk melihat detail JSON transaksi</span><span>Data asli tidak diubah</span></div>
            </section>

            {result.issues.length > 0 && <section className="issues-panel" id="validation-issues"><div className="issues-heading"><div className="issue-icon"><AlertTriangle size={17} /></div><div><h3>Catatan validasi</h3><p>Baris berikut tidak dihitung sampai data diperbaiki.</p></div><span className="issue-count">{result.issues.length} masalah</span></div><div className="issues-list">{result.issues.slice(0, 8).map((issue, index) => <div className="issue-row" key={`${issue.index}-${issue.field}-${index}`}><span className="issue-index">{String(issue.index + 1).padStart(2, "0")}</span><span className="issue-field">{issue.field}</span><span className="issue-message">{issue.message}</span>{issue.transactionNo && <span className="issue-transaction">{issue.transactionNo}</span>}</div>)}{result.issues.length > 8 && <div className="issues-more">+ {result.issues.length - 8} masalah lain tidak ditampilkan</div>}</div></section>}
          </>}

          {!hasAnalysis && <section className="empty-workspace"><div className="empty-illustration"><div className="empty-square square-one" /><div className="empty-square square-two" /><FileText size={32} strokeWidth={1.4} /></div><h2>Workspace siap digunakan</h2><p>Masukkan JSON transaksi untuk melihat ringkasan, validasi, dan register data aktual Anda.</p><div className="empty-rules"><span><Check size={14} /> Object atau array</span><span><Check size={14} /> Validasi field numerik</span><span><Check size={14} /> Tanpa data dummy</span></div></section>}

          {hasAnalysis && result && transactions.length === 0 && <section className="empty-workspace compact-empty"><div className="empty-illustration"><AlertTriangle size={32} strokeWidth={1.4} /></div><h2>Belum ada transaksi valid</h2><p>JSON berhasil dibaca, tetapi tidak ditemukan object yang memenuhi field transaksi atau semua kandidat memiliki masalah.</p>{result.issues.length > 0 && <div className="empty-rules"><span><AlertTriangle size={14} /> {result.issues.length} masalah validasi terdeteksi</span></div>}</section>}

          <footer className="app-footer" id="privacy"><div className="footer-brand"><div className="brand-mark small"><span>α</span></div><span>nstax</span></div><span>Data JSON diproses secara lokal di browser dan tidak dikirim ke server.</span><span className="footer-right">Built for accurate inspection</span></footer>
        </div>
      </main>

      {selectedTransaction && <div className="drawer-backdrop" onClick={() => setSelectedTransaction(null)}><aside className="detail-drawer" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="detail-title"><div className="drawer-header"><div><div className="eyebrow"><span className="eyebrow-line" /> TRANSACTION DETAIL</div><h2 id="detail-title">Detail transaksi</h2></div><button className="icon-button" type="button" onClick={() => setSelectedTransaction(null)} aria-label="Tutup detail"><X size={19} /></button></div><div className="drawer-id"><span>Transaction</span><strong>{selectedTransaction.transactionNo}</strong>{selectedTransaction.isDuplicate && <span className="duplicate-tag large">Kemungkinan duplikat</span>}</div><div className="detail-grid"><div><span>Movie</span><strong>{selectedTransaction.movieTitle}</strong></div><div><span>Tanggal</span><strong>{formatDate(selectedTransaction.date)}</strong></div><div><span>Jam</span><strong>{selectedTransaction.showTime}</strong></div><div><span>Studio</span><strong>{selectedTransaction.studio}</strong></div><div><span>Total orders</span><strong>{formatInteger(selectedTransaction.totalOrders)}</strong></div><div><span>Selected orders</span><strong>{formatInteger(selectedTransaction.selectedOrders)}</strong></div><div><span>Total seat</span><strong>{formatInteger(selectedTransaction.totalSeat)}</strong></div><div><span>Subtotal</span><strong className="drawer-money">{formatRupiahMinor(selectedTransaction.totalMinor)}</strong></div><div><span>{`Pajak (${TAX_RATE_PERCENT}%)`}</span><strong className="drawer-money">{formatRupiahMinor(selectedTransaction.taxMinor)}</strong></div><div><span>Grand total</span><strong className="drawer-money">{formatRupiahMinor(selectedTransaction.grandTotalMinor)}</strong></div></div><div className="raw-section"><div className="raw-header"><div><span>Raw JSON</span><small>Data asli transaksi</small></div><button className="text-button" type="button" onClick={async () => { await copyToClipboard(JSON.stringify(selectedTransaction.raw, null, 2)); setCopied("raw"); }}>{copiedKey === "raw" ? <ClipboardCheck size={15} /> : <Copy size={15} />}{copiedKey === "raw" ? "Tersalin" : "Copy JSON"}</button></div><pre>{JSON.stringify(selectedTransaction.raw, null, 2)}</pre></div></aside></div>}
    </div>
  );
}


type AppMode = "api" | "api-menu" | "upl-menu" | "receipt-menu" | "fore" | "nsc" | "nasgor69" | "receipt" | "receipt-compare" | "upl" | "pointcoffe" | "astana" | VendorKind;

function ApiParserSelector({ onSelect, onBack }: { onSelect: (mode: AppMode) => void; onBack: () => void }) {
  const parsers: Array<[AppMode, string, string, string]> = [["astana", "CEK ASTANA", "Cek Data ASTANA", "JSON revenue · Gross, Service, Tax, Nett"], ["fore", "CEK FORE", "Cek Data FORE", "Transaksi counter, billing, total, dan pajak"], ["nsc", "CEK NSC", "Cek Data NSC", "Transaksi film, studio, order, dan kursi"], ["nasgor69", "CEK NASGOR 69", "Cek Data NASGOR 69", "Transaksi Nasgor 69 · Struk, DPP, Tax, dan Total"], ["rotio", "CEK ROTIO", "Cek Data ROTIO", "Parser dan rumus pajak khusus ROTIO"], ["kai", "CEK KAI", "Cek Data KAI", "Parser dan rumus pajak khusus KAI"], ["hokben", "CEK HOKBEN", "Cek Data HOKBEN", "Parser dan rumus pajak khusus HOKBEN"], ["kopken", "CEK KOPKEN", "Cek Data KOPKEN", "Parser dan rumus pajak khusus KOPKEN"], ["fave", "CEK FAVE", "Cek Data FAVE", "Parser dan rumus pajak khusus FAVE"], ["sams", "CEK SAMS", "Cek Data SAMS", "Parser dan rumus pajak khusus SAMS"]];
  return <div className="mode-shell"><div className="mode-brand"><div className="mode-brand-left"><div className="brand-mark"><span>α</span></div><div><div className="brand-name">nstax</div><div className="brand-caption">transaction intelligence</div></div></div><div className="mode-status"><span className="status-dot" />Local</div></div><div className="hero-block"><button className="button button-secondary compact mode-back" type="button" onClick={onBack}>← Kembali ke menu utama</button><div className="eyebrow"><span className="eyebrow-line" /> NSTAX · CEK DATA API</div><h1>Pilih parser<br /><em>data API.</em></h1><p>{parsers.length} sumber data API didukung, masing-masing dengan parser dan rumus pajak tersendiri.</p><nav className="tool-list">{parsers.map(([mode, label, title, detail]) => <button className="tool-row" type="button" key={mode} onClick={() => onSelect(mode)}><span className="tool-row-main"><span className="tool-row-label">{label}</span><span className="tool-row-title">{title}</span><span className="tool-row-detail">{detail}</span></span><span className="tool-row-arrow"><ChevronRight size={16} /></span></button>)}</nav><div className="mode-local"><ShieldCheck size={16} /> Semua data diproses lokal di browser Anda</div></div></div>;
}

function ApiSelector({ onSelect }: { onSelect: (mode: AppMode) => void }) {
  const menu: Array<[AppMode, string, string, string]> = [
    ["api-menu", "01 · CEK DATA API", "Cek Data API", "ASTANA, FORE, NSC, NASGOR 69, ROTIO, KAI, HOKBEN, KOPKEN, FAVE, SAMS — 10 parser"],
    ["receipt-menu", "02 · CEK STRUK", "Baca Data Struk", "Baca satu file struk, atau bandingkan dua file struk sekaligus"],
    ["upl-menu", "03 · CEK UPL", "Periksa Upload File", "CEK KLAND dan CEK POINTCOFFE"],
  ];
  return (
    <div className="mode-shell">
      <div className="mode-brand">
        <div className="mode-brand-left"><div className="brand-mark"><span>α</span></div><div><div className="brand-name">nstax</div><div className="brand-caption">transaction intelligence</div></div></div>
        <div className="mode-status"><span className="status-dot" /></div>
      </div>
      <div className="hero-block">
        <div className="eyebrow"><span className="eyebrow-line" /> NSTAX · MENU UTAMA</div>
        <h1>Analyze, validate<br /><em>and compare</em> transaction data.</h1>
        <p>Kelola dan periksa data transaksi dengan tools yang sesuai untuk setiap kebutuhan — seluruh perhitungan berjalan lokal di browser Anda.</p>
        <div className="hero-stats">
          <div className="hero-stat"><strong>10</strong><span>API Sources</span></div>
          <div className="hero-stat"><strong>3</strong><span>Modul Utama</span></div>
          <div className="hero-stat"><strong>PDF · XLSX · CSV · JSON</strong><span>Format Didukung</span></div>
        </div>
        <nav className="tool-list" aria-label="Menu utama">
          {menu.map(([mode, label, title, detail]) => (
            <button className="tool-row" type="button" key={mode} onClick={() => onSelect(mode)}>
              <span className="tool-row-main">
                <span className="tool-row-label">{label}</span>
                <span className="tool-row-title">{title}</span>
                <span className="tool-row-detail">{detail}</span>
              </span>
              <span className="tool-row-arrow"><ChevronRight size={16} /></span>
            </button>
          ))}
        </nav>
        <div className="mode-local"><ShieldCheck size={16} /> Semua data diproses lokal di browser Anda</div>
      </div>
    </div>
  );
}

function UplModeSelector({ onSelect, onBack }: { onSelect: (mode: "upl" | "pointcoffe") => void; onBack: () => void }) {
  const options: Array<["upl" | "pointcoffe", string, string, string]> = [
    ["upl", "CEK KLAND", "Cek KLAND", "Parser Excel KLAND yang sudah ada"],
    ["pointcoffe", "CEK POINTCOFFE", "Cek PointCoffe", "Delimiter pipe (|), DPP, Pajak, Total"],
  ];
  return <div className="mode-shell"><div className="mode-brand"><div className="mode-brand-left"><div className="brand-mark"><span>α</span></div><div><div className="brand-name">nstax</div><div className="brand-caption">transaction intelligence</div></div></div><div className="mode-status"><span className="status-dot" />Local</div></div><div className="hero-block"><button className="button button-secondary compact mode-back" type="button" onClick={onBack}>← Kembali ke CEK DATA API</button><div className="eyebrow"><span className="eyebrow-line" /> CEK UPL</div><h1>Pilih sumber<br /><em>data UPL.</em></h1><nav className="tool-list">{options.map(([mode, label, title, detail]) => <button className="tool-row" type="button" key={mode} onClick={() => onSelect(mode)}><span className="tool-row-main"><span className="tool-row-label">{label}</span><span className="tool-row-title">{title}</span><span className="tool-row-detail">{detail}</span></span><span className="tool-row-arrow"><ChevronRight size={16} /></span></button>)}</nav></div></div>;
}

function ReceiptModeSelector({ onSelect, onBack }: { onSelect: (mode: "receipt" | "receipt-compare") => void; onBack: () => void }) {
  const options: Array<["receipt" | "receipt-compare", string, string, string]> = [
    ["receipt", "CEK STRUK", "Periksa satu file struk", "Parser PDF, Excel, dan CSV lama"],
    ["receipt-compare", "BANDINGKAN 2 FILE STRUK", "Compare dua file struk", "Bandingkan berdasarkan no_struk dan field transaksi"],
  ];
  return <div className="mode-shell"><div className="mode-brand"><div className="mode-brand-left"><div className="brand-mark"><span>α</span></div><div><div className="brand-name">nstax</div><div className="brand-caption">transaction intelligence</div></div></div><div className="mode-status"><span className="status-dot" />Local</div></div><div className="hero-block"><button className="button button-secondary compact mode-back" type="button" onClick={onBack}>← Kembali ke menu utama</button><div className="eyebrow"><span className="eyebrow-line" /> CEK STRUK</div><h1>Pilih fitur<br /><em>struk.</em></h1><nav className="tool-list">{options.map(([mode, label, title, detail]) => <button className="tool-row" type="button" key={mode} onClick={() => onSelect(mode)}><span className="tool-row-main"><span className="tool-row-label">{label}</span><span className="tool-row-title">{title}</span><span className="tool-row-detail">{detail}</span></span><span className="tool-row-arrow"><ChevronRight size={16} /></span></button>)}</nav></div></div>;
}

export default function Home() {
  const [mode, setMode] = useState<AppMode>("api");
  const back = () => setMode("api");
  if (mode === "api") return <ApiSelector onSelect={setMode} />;
  if (mode === "api-menu") return <ApiParserSelector onSelect={setMode} onBack={back} />;
  if (mode === "upl-menu") return <UplModeSelector onSelect={setMode} onBack={back} />;
  if (mode === "receipt-menu") return <ReceiptModeSelector onSelect={setMode} onBack={back} />;
  if (mode === "fore") return <ForeChecker onBack={back} />;
  if (mode === "nsc") return <NscChecker onBack={back} />;
  if (mode === "nasgor69") return <Nasgor69Checker onBack={back} />;
  if (mode === "receipt") return <ReceiptChecker onBack={() => setMode("receipt-menu")} />;
  if (mode === "receipt-compare") return <ReceiptCompareChecker onBack={() => setMode("receipt-menu")} />;
  if (mode === "upl") return <UplChecker onBack={() => setMode("upl-menu")} />;
  if (mode === "pointcoffe") return <PointCoffeeChecker onBack={() => setMode("upl-menu")} />;
  if (mode === "astana") return <AstanaChecker onBack={back} />;
  return <VendorChecker kind={mode} onBack={back} />;
}
