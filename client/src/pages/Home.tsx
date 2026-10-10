import { useMemo, useRef, useState, type DragEvent, type ChangeEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  BarChart3,
  ArrowLeftRight,
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
import { BrandLogo, NstaxMark } from "@/components/BrandLogo";
import { PARSER_BRANDS, categoryBrand, type BrandSpec } from "@/lib/parserBrands";
import ForeChecker from "@/pages/ForeChecker";
import VendorChecker from "@/pages/VendorChecker";
import type { VendorKind } from "@/lib/vendorParser";
import ReceiptChecker from "@/pages/ReceiptChecker";
import UplChecker from "@/pages/UplChecker";
import AstanaChecker from "@/pages/AstanaChecker";
import PointCoffeeChecker from "@/pages/PointCoffeeChecker";
import ReceiptCompareChecker from "@/pages/ReceiptCompareChecker";
import Nasgor69Checker from "@/pages/Nasgor69Checker";
import OmalaChecker from "@/pages/OmalaChecker";
import OmahPadhangChecker from "@/pages/OmahPadhangChecker";
import JambuluwukChecker from "@/pages/JambuluwukChecker";
import InnaTretesChecker from "@/pages/InnaTretesChecker";

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


type AppMode = "api-menu" | "upl-menu" | "home" | "fore" | "nsc" | "nasgor69" | "receipt" | "receipt-compare" | "upl" | "pointcoffe" | "omala-menu" | "omala-hotel" | "omala-resto" | "omahpadhang" | "jambuluwuk" | "innatretes" | "astana" | VendorKind;

type Crumb = { label: string; onClick?: () => void };

function MenuShell({ onBack, backLabel, trail, children }: { onBack?: () => void; backLabel?: string; trail?: Crumb[]; children: ReactNode }) {
  return (
    <div className="mode-shell nx-shell">
      <header className="mode-brand">
        <div className="mode-brand-left">
          <NstaxMark size={36} />
          <div className="nx-wordmark"><div className="brand-name">nstax</div><div className="nx-caption">transaction intelligence</div></div>
        </div>
        {onBack && <button className="button button-secondary compact" type="button" onClick={onBack}>← {backLabel ?? "Kembali"}</button>}
      </header>
      <main className="menu-main">
        {trail && trail.length > 0 && (
          <nav className="nx-trail" aria-label="Breadcrumb">
            {trail.map((crumb, index) => (
              <span key={crumb.label} className="nx-trail-item">
                {index > 0 && <ChevronRight size={12} />}
                {crumb.onClick ? <button type="button" onClick={crumb.onClick}>{crumb.label}</button> : <strong>{crumb.label}</strong>}
              </span>
            ))}
          </nav>
        )}
        {children}
      </main>
    </div>
  );
}

function MenuCard<T extends string>({ mode, label, wide, lead, onSelect }: { mode: T; label: string; wide?: boolean; lead?: ReactNode; onSelect: (mode: T) => void }) {
  return (
    <button className={`menu-card${wide ? " is-wide" : ""}`} type="button" onClick={() => onSelect(mode)}>
      {lead && <span className="menu-card-lead">{lead}</span>}
      <span className="menu-card-label">{label}</span>
      <span className="menu-card-arrow" aria-hidden="true"><ChevronRight size={16} strokeWidth={2.4} /></span>
    </button>
  );
}

function ParserCard<T extends string>({ mode, label, onSelect }: { mode: T; label: string; onSelect: (mode: T) => void }) {
  const spec: BrandSpec = PARSER_BRANDS[mode] ?? { name: label };
  return <MenuCard mode={mode} label={label} lead={<BrandLogo spec={spec} size={44} />} onSelect={onSelect} />;
}

function HeroArt() {
  return (
    <svg className="nx-hero-art" viewBox="0 0 220 150" aria-hidden="true">
      <rect x="22" y="22" width="120" height="92" rx="10" fill="#fff" stroke="#efd9c2" />
      <circle cx="38" cy="36" r="3" fill="#e2581a" /><circle cx="48" cy="36" r="3" fill="#f2a56b" /><circle cx="58" cy="36" r="3" fill="#f6cfa8" />
      <rect x="36" y="52" width="64" height="6" rx="3" fill="#efe3d4" /><rect x="36" y="66" width="46" height="6" rx="3" fill="#f3e9dc" />
      <rect x="104" y="78" width="38" height="36" rx="8" fill="#e2581a" />
      <rect x="112" y="98" width="5" height="10" rx="1.5" fill="#fff" /><rect x="120" y="90" width="5" height="18" rx="1.5" fill="#fff" /><rect x="128" y="84" width="5" height="24" rx="1.5" fill="#fff" />
      <rect x="150" y="30" width="50" height="34" rx="9" fill="#fff" stroke="#efd9c2" /><circle cx="164" cy="47" r="4" fill="#e2581a" /><rect x="174" y="43" width="20" height="5" rx="2.5" fill="#efe3d4" />
    </svg>
  );
}

function ApiSelector({ onSelect }: { onSelect: (mode: AppMode) => void }) {
  return (
    <MenuShell>
      <section className="nx-hero">
        <div className="nx-hero-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> Solusi cerdas untuk data transaksi</div>
          <h1>Transaction Intelligence, <em>Simplified.</em></h1>
          <p>Periksa, olah, dan bandingkan data transaksi dalam satu workspace.</p>
        </div>
        <HeroArt />
      </section>
      <nav className="menu-home" aria-label="Menu utama">
        <MenuCard mode="api-menu" label="CEK DATA API" wide lead={<span className="menu-icon"><Database size={26} strokeWidth={1.7} /></span>} onSelect={onSelect} />
        <MenuCard mode="receipt" label="CEK STRUK" lead={<span className="menu-icon"><Receipt size={26} strokeWidth={1.7} /></span>} onSelect={onSelect} />
        <MenuCard mode="receipt-compare" label="COMPARE 2 FILE" lead={<span className="menu-icon"><ArrowLeftRight size={26} strokeWidth={1.7} /></span>} onSelect={onSelect} />
        <MenuCard mode="upl-menu" label="CEK UPL" wide lead={<span className="menu-icon"><Upload size={26} strokeWidth={1.7} /></span>} onSelect={onSelect} />
      </nav>
    </MenuShell>
  );
}

function ApiParserSelector({ onSelect, onBack }: { onSelect: (mode: AppMode) => void; onBack: () => void }) {
  const parsers: Array<[AppMode, string]> = [["astana", "ASTANA"], ["fore", "FORE"], ["nsc", "NSC"], ["nasgor69", "NASGOR 69"], ["rotio", "ROTIO"], ["kai", "KAI"], ["hokben", "HOKBEN"], ["kopken", "KOPKEN"], ["fave", "FAVE"], ["sams", "SAMS"]];
  const [query, setQuery] = useState("");
  const visible = parsers.filter(([, label]) => label.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <MenuShell onBack={onBack} backLabel="Menu utama" trail={[{ label: "Beranda", onClick: onBack }, { label: "Cek Data API" }]}>
      <div className="menu-title-row">
        <h1 className="menu-title">CEK DATA API</h1>
        <label className="search-field nx-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari parser..." aria-label="Cari parser" /></label>
      </div>
      <nav className="menu-grid" aria-label="Parser API">
        {visible.map(([mode, label]) => <ParserCard key={mode} mode={mode} label={label} onSelect={onSelect} />)}
      </nav>
      {visible.length === 0 && <div className="nx-empty">Parser tidak ditemukan.</div>}
    </MenuShell>
  );
}

type UplMode = "upl" | "pointcoffe" | "omala-menu" | "omahpadhang" | "jambuluwuk" | "innatretes";

function UplModeSelector({ onSelect, onBack }: { onSelect: (mode: UplMode) => void; onBack: () => void }) {
  const options: Array<[UplMode, string]> = [
    ["upl", "KLAND"],
    ["pointcoffe", "POINTCOFFE"],
    ["omala-menu", "THE OMALA"],
    ["omahpadhang", "OMAH PADHANG"],
    ["jambuluwuk", "JAMBULUWUK"],
    ["innatretes", "INNA TRETES"],
  ];
  return (
    <MenuShell onBack={onBack} backLabel="Menu utama" trail={[{ label: "Beranda", onClick: onBack }, { label: "Cek UPL" }]}>
      <div className="menu-title-row"><h1 className="menu-title">CEK UPL</h1></div>
      <nav className="menu-grid" aria-label="Parser UPL">
        {options.map(([mode, label]) => <ParserCard key={mode} mode={mode} label={label} onSelect={onSelect} />)}
      </nav>
    </MenuShell>
  );
}

function OmalaModeSelector({ onSelect, onBack, onHome }: { onSelect: (mode: "omala-hotel" | "omala-resto") => void; onBack: () => void; onHome: () => void }) {
  return (
    <MenuShell onBack={onBack} backLabel="CEK UPL" trail={[{ label: "Beranda", onClick: onHome }, { label: "Cek UPL", onClick: onBack }, { label: "THE OMALA" }]}>
      <div className="menu-title-row"><h1 className="menu-title">THE OMALA</h1></div>
      <nav className="menu-grid" aria-label="Kategori THE OMALA">
        <MenuCard mode="omala-hotel" label="HOTEL" lead={<BrandLogo spec={categoryBrand("HOTEL")} size={44} />} onSelect={onSelect} />
        <MenuCard mode="omala-resto" label="RESTO" lead={<BrandLogo spec={categoryBrand("RESTO")} size={44} />} onSelect={onSelect} />
      </nav>
    </MenuShell>
  );
}

export default function Home() {
  const [mode, setMode] = useState<AppMode>("home");
  const home = () => setMode("home");
  const apiList = () => setMode("api-menu");
  const uplList = () => setMode("upl-menu");
  if (mode === "home") return <ApiSelector onSelect={setMode} />;
  if (mode === "api-menu") return <ApiParserSelector onSelect={setMode} onBack={home} />;
  if (mode === "upl-menu") return <UplModeSelector onSelect={setMode} onBack={home} />;
  if (mode === "fore") return <ForeChecker onBack={apiList} />;
  if (mode === "nsc") return <NscChecker onBack={apiList} />;
  if (mode === "nasgor69") return <Nasgor69Checker onBack={apiList} />;
  if (mode === "astana") return <AstanaChecker onBack={apiList} />;
  if (mode === "receipt") return <ReceiptChecker onBack={home} />;
  if (mode === "receipt-compare") return <ReceiptCompareChecker onBack={home} />;
  if (mode === "upl") return <UplChecker onBack={uplList} />;
  if (mode === "pointcoffe") return <PointCoffeeChecker onBack={uplList} />;
  if (mode === "omala-menu") return <OmalaModeSelector onSelect={setMode} onBack={uplList} onHome={home} />;
  if (mode === "omala-hotel") return <OmalaChecker category="HOTEL" onBack={() => setMode("omala-menu")} />;
  if (mode === "omala-resto") return <OmalaChecker category="RESTO" onBack={() => setMode("omala-menu")} />;
  if (mode === "omahpadhang") return <OmahPadhangChecker onBack={uplList} />;
  if (mode === "jambuluwuk") return <JambuluwukChecker onBack={uplList} />;
  if (mode === "innatretes") return <InnaTretesChecker onBack={uplList} />;
  return <VendorChecker kind={mode} onBack={apiList} />;
}
