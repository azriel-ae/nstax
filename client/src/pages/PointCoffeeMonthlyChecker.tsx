import { useState } from "react";
import { ArrowLeft, Check, FileText, ShieldCheck, Trash2, AlertTriangle } from "lucide-react";
import { formatPointCoffeeMoney } from "@/lib/pointcoffeParser";
import { parsePointCoffeeMonthly, type PointCoffeeMonthlyResult } from "@/lib/pointcoffeMonthly";
import type { MonthlyProgress } from "@/lib/monthlyCommon";
import { MonthlyDebugPanel, MonthlyDropZone, MonthlyFileList, MonthlyProgressBar, Pager, PeriodSwitch, ProcessAllButton, StagedFileList, type Period } from "@/components/MonthlyUploadParts";

const PAGE_SIZE = 100;

const Metric = ({ label, value }: { label: string; value: string }) => (
  <div className="metric-card"><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong></div>
);

/** CEK POINTCOFFE — UPLOAD BULANAN (state terpisah dari mode harian). */
export default function PointCoffeeMonthlyChecker({ onBack, period, onPeriod, initialFiles }: { onBack: () => void; period: Period; onPeriod: (p: Period) => void; initialFiles?: File[] }) {
  const [staged, setStaged] = useState<File[]>(initialFiles ?? []);
  const [result, setResult] = useState<PointCoffeeMonthlyResult | null>(null);
  const [progress, setProgress] = useState<MonthlyProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [page, setPage] = useState(1);

  const addFiles = (files: File[]) => {
    if (!files.length || busy) return;
    setStaged((prev) => [...prev, ...files]);
    setResult(null);
    setNotice("");
  };
  const clearAll = () => { setStaged([]); setResult(null); setNotice(""); setPage(1); };

  const run = async (files: File[]) => {
    if (!files.length || busy) return;
    setBusy(true); setResult(null); setNotice(""); setPage(1);
    setProgress({ done: 0, total: files.length, fileName: files[0].name });
    try {
      const parsed = await parsePointCoffeeMonthly(files, setProgress);
      setResult(parsed);
      if (!parsed.ok) setNotice(parsed.error || "Tidak ada file yang berhasil diproses.");
      else {
        const s = parsed.monthlySummary;
        setNotice(`✓ ${s.successFiles + s.warningFiles} file berhasil diproses${s.failedFiles ? ` · ${s.failedFiles} file gagal` : ""}${s.duplicateFiles ? ` · ${s.duplicateFiles} file duplikat` : ""} · ${s.transactionCount.toLocaleString("id-ID")} transaksi digabung.`);
      }
    } catch {
      setNotice("Terjadi kesalahan saat memproses file bulanan.");
    } finally { setBusy(false); setProgress(null); }
  };

  const summary = result?.ok ? result.monthlySummary : undefined;
  const allMonthlyRows = result?.ok ? result.allMonthlyRows : [];
  const start = (page - 1) * PAGE_SIZE;
  const visibleRows = allMonthlyRows.slice(start, start + PAGE_SIZE); // hanya tampilan

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="brand-lockup"><div className="brand-mark"><span>α</span></div><div><div className="brand-name">nstax</div><div className="brand-caption">transaction intelligence</div></div></div>
        <div className="sidebar-divider" />
        <nav className="sidebar-nav">
          <button className="nav-item" type="button" onClick={onBack}><ArrowLeft size={18} /><span>Kembali ke CEK UPL</span></button>
          <div className="nav-item is-active"><FileText size={18} /><span>CEK POINTCOFFE · Bulanan</span></div>
        </nav>
        <div className="sidebar-footer"><div className="privacy-badge"><ShieldCheck size={16} /><div><strong>Local-first</strong><span>Data tidak keluar dari browser</span></div></div></div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <button className="button button-secondary compact" type="button" onClick={onBack}><ArrowLeft size={15} /> Kembali ke CEK UPL</button>
          <div className="breadcrumb"><span>CEK UPL</span><span>›</span><strong>CEK POINTCOFFE · Bulanan</strong></div>
        </header>
        <div className="page-container">
          <section className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> CEK POINTCOFFE · UPLOAD BULANAN</div>
              <h1>Periksa PointCoffee<br /><em>satu bulan.</em></h1>
              <p>Seluruh CSV (delimiter pipe |) diproses satu per satu, seluruh row digabung, lalu summary dihitung dari dataset lengkap.</p>
            </div>
            <div className="heading-meta">
              <span className="meta-label">DATASET BULANAN</span>
              <strong>{summary ? `${summary.totalFiles} file` : "Belum ada file"}</strong>
              <span className="meta-subtitle">{summary ? `${summary.transactionCount.toLocaleString("id-ID")} transaksi valid` : "Menunggu CSV"}</span>
            </div>
          </section>

          <section className="input-panel panel-surface">
            <PeriodSwitch period={period} onChange={onPeriod} />
            <div className="panel-heading"><div className="panel-title-wrap"><span className="section-number">01</span><div><h2>Upload file bulanan PointCoffee</h2><p>Delimiter wajib: | (pipe), bukan koma.</p></div></div></div>
            <MonthlyDropZone accept=".csv,text/csv" kindLabel="CSV" disabled={busy} hint="Header: TANGGAL|WAKTU|TOKO|NO_STRUK|SHIFT|STATION|DESKRIPSI_ITEM|DPP|PAJAK_RESTORAN" onFiles={addFiles} />
            {staged.length > 0 && <div className="used-columns"><strong>{staged.length.toLocaleString("id-ID")} file dipilih</strong></div>}
            <StagedFileList files={staged} results={result?.monthlyFileResults ?? null} busy={busy} onRemove={(i) => { setStaged((prev) => prev.filter((_, idx) => idx !== i)); setResult(null); setNotice(""); }} onClearAll={clearAll} />
            <div className="input-actions"><ProcessAllButton count={staged.length} busy={busy} onClick={() => void run(staged)} /></div>
            {progress && <MonthlyProgressBar progress={progress} />}
            <div className="input-actions">
              <div className="privacy-note"><ShieldCheck size={15} /> Diproses lokal di browser</div>
              <button className="button button-ghost" type="button" onClick={clearAll}><Trash2 size={16} /> Clear</button>
            </div>
          </section>

          {notice && (
            <div className={`notice ${result?.ok ? "notice-success" : "notice-error"}`}>
              <span className="notice-icon">{result?.ok ? <Check size={17} /> : <AlertTriangle size={17} />}</span>{notice}
            </div>
          )}

          {result && <MonthlyFileList results={result.monthlyFileResults} />}

          {result?.ok && summary && (
            <>
              <div className="metric-grid upl-metrics">
                <Metric label="Total file" value={(summary.successFiles + summary.warningFiles).toLocaleString("id-ID")} />
                <Metric label="Total transaksi" value={summary.transactionCount.toLocaleString("id-ID")} />
                <Metric label="Total subtotal" value={formatPointCoffeeMoney(summary.subtotal)} />
                <Metric label="Total DPP" value={formatPointCoffeeMoney(summary.dpp)} />
                <Metric label="Total tax" value={formatPointCoffeeMoney(summary.tax)} />
                <Metric label="Total total" value={formatPointCoffeeMoney(summary.total)} />
              </div>
              <MonthlyDebugPanel results={result.monthlyFileResults} allRowsLength={allMonthlyRows.length} extra={result.validation.duplicateReceiptKeys ? `✕ ${result.validation.duplicateReceiptKeys} no_struk ganda` : "✓ Seluruh no_struk unik"} />
              <section className="excel-preview">
                <div className="section-heading">
                  <div><div className="eyebrow"><span className="eyebrow-line" /> DATASET BULANAN</div><h2>Daftar transaksi PointCoffee</h2></div>
                  <span className="result-count">Menampilkan {visibleRows.length.toLocaleString("id-ID")} dari {allMonthlyRows.length.toLocaleString("id-ID")} baris</span>
                </div>
                <div className="excel-scroll">
                  <table>
                    <thead><tr><th>No</th><th>File</th><th>No Struk</th><th>Date Trans</th><th>Toko</th><th>DPP</th><th>Tax</th><th>Total</th><th>Keterangan</th></tr></thead>
                    <tbody>
                      {visibleRows.map((row, i) => (
                        <tr key={`${row.no_struk}-${start + i}`}><td>{start + i + 1}</td><td>{row.fileName}</td><td>{row.no_struk}</td><td>{row.date_trans}</td><td>{row.toko}</td><td>{formatPointCoffeeMoney(row.dpp)}</td><td>{formatPointCoffeeMoney(row.tax)}</td><td>{formatPointCoffeeMoney(row.total)}</td><td>{row.keterangan}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager page={page} pageSize={PAGE_SIZE} total={allMonthlyRows.length} onPage={setPage} />
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
