import { useMemo, useState } from "react";
import { ArrowLeft, Check, FileSpreadsheet, Filter, ShieldCheck, Trash2, AlertTriangle } from "lucide-react";
import { formatUplRupiah } from "@/lib/uplParser";
import { CATEGORY_DROPDOWN_OPTIONS, categoryDisplayLabel } from "@/lib/categoryDisplay";
import { MAIN_CATEGORIES, UNMAPPED_LABEL, type CategoryFilter, type TransactionCategory } from "@/lib/kategoriMapper";
import { parseUplMonthly, type UplMonthlyResult, type UplMonthlyRow } from "@/lib/uplMonthly";
import type { MonthlyProgress } from "@/lib/monthlyCommon";
import UplCandCPanel from "@/components/UplCandCPanel";
import { parseCandCForMonthly, type CandCResult } from "@/lib/candcParser";
import { parseRestoForMonthly, type RestoResult } from "@/lib/restoParser";
import { MonthlyDebugPanel, MonthlyDropZone, MonthlyFileList, MonthlyProgressBar, Pager, PeriodSwitch, ProcessAllButton, StagedFileList, type Period } from "@/components/MonthlyUploadParts";

const PAGE_SIZE = 100;

function Metric({ label, value, money = false }: { label: string; value: number; money?: boolean }) {
  return (
    <div className="metric-card">
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{money ? formatUplRupiah(value) : value.toLocaleString("id-ID")}</strong>
    </div>
  );
}

/**
 * CEK KLAND — UPLOAD BULANAN.
 * State di sini SENGAJA terpisah dari UplDailyChecker: monthlyFileResults,
 * allMonthlyRows, monthlySummary. Summary selalu dari allMonthlyRows penuh;
 * `visibleRows` (pagination) hanya untuk tampilan tabel.
 */
export default function UplMonthlyChecker({ onBack, period, onPeriod, initialFiles }: { onBack: () => void; period: Period; onPeriod: (p: Period) => void; initialFiles?: File[] }) {
  const [staged, setStaged] = useState<File[]>(initialFiles ?? []);
  const [result, setResult] = useState<UplMonthlyResult | null>(null);
  const [progress, setProgress] = useState<MonthlyProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter | TransactionCategory>("ALL");
  const [page, setPage] = useState(1);
  const [candc, setCandc] = useState<CandCResult | null>(null);
  const [prego, setPrego] = useState<RestoResult | null>(null);
  const [kfood, setKfood] = useState<RestoResult | null>(null);

  // Memilih file hanya menambah ke daftar; pemrosesan dimulai lewat tombol PROSES SEMUA FILE.
  const addFiles = (files: File[]) => {
    if (!files.length || busy) return;
    setStaged((prev) => [...prev, ...files]);
    setResult(null);
    setNotice("");
  };

  const run = async (files: File[]) => {
    if (!files.length || busy) return;
    setBusy(true);
    setResult(null);
    setCandc(null);
    setPrego(null);
    setKfood(null);
    setNotice("");
    setCategoryFilter("ALL");
    setPage(1);
    setProgress({ done: 0, total: files.length, fileName: files[0].name });
    try {
      const parsed = await parseUplMonthly(files, setProgress);
      setResult(parsed);
      // C&C diproses dari SEMUA file yang ikut dihitung di dataset bulanan, lalu digabung.
      setCandc(parsed.ok ? await parseCandCForMonthly(files, parsed.monthlyFileResults) : null);
      // PREGO & KFOOD: record dari kolom B, D–G seluruh file yang ikut dihitung, lalu digabung.
      setPrego(parsed.ok ? await parseRestoForMonthly(files, parsed.monthlyFileResults, "PREGO") : null);
      setKfood(parsed.ok ? await parseRestoForMonthly(files, parsed.monthlyFileResults, "KFOOD") : null);
      if (!parsed.ok) setNotice(parsed.error || "Tidak ada file yang berhasil diproses.");
      else {
        const s = parsed.monthlySummary;
        setNotice(`✓ ${s.successFiles + s.warningFiles} file berhasil diproses${s.failedFiles ? ` · ${s.failedFiles} file gagal` : ""}${s.duplicateFiles ? ` · ${s.duplicateFiles} file duplikat` : ""} · ${s.rowCount.toLocaleString("id-ID")} row digabung.`);
      }
    } catch {
      setNotice("Terjadi kesalahan saat memproses file bulanan.");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const clear = () => { setStaged([]); setResult(null); setCandc(null); setPrego(null); setKfood(null); setNotice(""); setProgress(null); setCategoryFilter("ALL"); setPage(1); };

  const summary = result?.ok ? result.monthlySummary : undefined;
  const allMonthlyRows: UplMonthlyRow[] = result?.ok ? result.allMonthlyRows : [];

  // Filter kategori dikerjakan terhadap dataset PENUH.
  const filteredRows = useMemo(() => (categoryFilter === "ALL" ? allMonthlyRows : allMonthlyRows.filter((row) => row.category === categoryFilter)), [allMonthlyRows, categoryFilter]);
  const active = useMemo(() => {
    if (!summary) return undefined;
    if (categoryFilter === "ALL") return { rows: summary.rowCount, qty: summary.quantityTotal, gross: summary.subtotalTotal, tax: summary.taxTotal };
    const b = summary.perCategory[categoryFilter];
    return { rows: b.count, qty: b.quantityTotal, gross: b.subtotalTotal, tax: b.taxTotal };
  }, [summary, categoryFilter]);

  const start = (page - 1) * PAGE_SIZE;
  const visibleRows = filteredRows.slice(start, start + PAGE_SIZE); // hanya tampilan

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="brand-lockup"><div className="brand-mark"><span>α</span></div><div><div className="brand-name">nstax</div><div className="brand-caption">transaction intelligence</div></div></div>
        <div className="sidebar-divider" />
        <nav className="sidebar-nav">
          <button className="nav-item" type="button" onClick={onBack}><ArrowLeft size={18} /><span>Kembali pilih mode</span></button>
          <div className="nav-item is-active"><FileSpreadsheet size={18} /><span>CEK KLAND · Bulanan</span></div>
        </nav>
        <div className="sidebar-footer"><div className="privacy-badge"><ShieldCheck size={16} /><div><strong>Local-first</strong><span>Data tidak keluar dari browser</span></div></div></div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <button className="button button-secondary compact" type="button" onClick={onBack}><ArrowLeft size={15} /> Kembali</button>
          <div className="breadcrumb"><span>Workspace</span><span>›</span><strong>CEK KLAND · Bulanan</strong></div>
        </header>
        <div className="page-container">
          <section className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> CEK KLAND · UPLOAD BULANAN</div>
              <h1>Periksa satu bulan<br /><em>sekaligus.</em></h1>
              <p>Setiap file diproses sendiri (header, sheet, dan Sheet1 milik file itu), seluruh row digabung menjadi satu dataset bulanan, lalu summary dihitung dari dataset lengkap — bukan dari preview.</p>
            </div>
            <div className="heading-meta">
              <span className="meta-label">DATASET BULANAN</span>
              <strong>{summary ? `${summary.totalFiles} file` : "Belum ada file"}</strong>
              <span className="meta-subtitle">{summary ? `${summary.rowCount.toLocaleString("id-ID")} row valid` : "Menunggu file Excel"}</span>
            </div>
          </section>

          <section className="input-panel panel-surface">
            <PeriodSwitch period={period} onChange={onPeriod} />
            <div className="panel-heading"><div className="panel-title-wrap"><span className="section-number">01</span><div><h2>Upload file bulanan KLAND</h2><p>Pilih atau seret seluruh file Excel satu bulan sekaligus.</p></div></div></div>
            <MonthlyDropZone accept=".xlsx,.xls" kindLabel="Excel" disabled={busy} hint="Hanya .XLSX dan .XLS · seluruh file dan seluruh row dihitung" onFiles={addFiles} />
            {staged.length > 0 && <div className="used-columns"><strong>{staged.length.toLocaleString("id-ID")} file dipilih</strong></div>}
            <StagedFileList files={staged} results={result?.monthlyFileResults ?? null} busy={busy} onRemove={(i) => { setStaged((prev) => prev.filter((_, idx) => idx !== i)); setResult(null); setNotice(""); }} onClearAll={clear} />
            <div className="input-actions"><ProcessAllButton count={staged.length} busy={busy} onClick={() => void run(staged)} /></div>
            {progress && <MonthlyProgressBar progress={progress} />}
            <div className="input-actions">
              <div className="privacy-note"><ShieldCheck size={15} /> Diproses lokal di browser</div>
              <button className="button button-ghost" type="button" onClick={clear}><Trash2 size={16} /> Clear</button>
            </div>
          </section>

          {notice && (
            <div className={`notice ${result?.ok ? "notice-success" : "notice-error"}`}>
              <span className="notice-icon">{result?.ok ? <Check size={17} /> : <AlertTriangle size={17} />}</span>{notice}
            </div>
          )}

          {result && <MonthlyFileList results={result.monthlyFileResults} />}

          {result?.ok && summary && active && (
            <>
              <section className="input-panel panel-surface">
                <div className="input-actions">
                  <label className="date-field">
                    <Filter size={15} /><span>Kategori</span>
                    <select value={categoryFilter} onChange={(e) => { setCategoryFilter(e.target.value as CategoryFilter | TransactionCategory); setPage(1); }}>
                      <option value="ALL">Semua Kategori</option>
                      {CATEGORY_DROPDOWN_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                      <option value={UNMAPPED_LABEL}>{UNMAPPED_LABEL}</option>
                    </select>
                  </label>
                </div>
              </section>

              <section className="analysis-section">
                <div className="section-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> HASIL BULANAN</div><h2>Summary {categoryFilter === "ALL" ? "seluruh data bulanan" : `kategori ${categoryDisplayLabel(categoryFilter)}`}</h2></div></div>
                <div className="metric-grid upl-metrics">
                  <Metric label="Total file" value={summary.successFiles + summary.warningFiles} />
                  <Metric label="Total data / row" value={active.rows} />
                  <Metric label="Total Day-qty" value={active.qty} />
                  <Metric label="Total Day-Gros" value={active.gross} money />
                  <Metric label="Total Tax" value={active.tax} money />
                </div>
                <div className="used-columns">
                  Rincian per kategori (dari seluruh data bulanan):{" "}
                  {[...MAIN_CATEGORIES, UNMAPPED_LABEL].map((cat) => (
                    <strong key={cat}>{cat} → {summary.perCategory[cat].quantityTotal.toLocaleString("id-ID")} qty / {summary.perCategory[cat].count.toLocaleString("id-ID")} row · {formatUplRupiah(summary.perCategory[cat].subtotalTotal)} · Tax {formatUplRupiah(summary.perCategory[cat].taxTotal)}</strong>
                  ))}
                </div>
              </section>

              <UplCandCPanel candc={candc} bucket={summary.perCategory["C&C"]} selectedCategory={categoryFilter} rows={filteredRows} prego={prego} kfood={kfood} pregoBucket={summary.perCategory["RESTO PREGO"]} kfoodBucket={summary.perCategory["K FOOD"]} />

              <MonthlyDebugPanel results={result.monthlyFileResults} allRowsLength={allMonthlyRows.length} extra={result.validation.categoryError} />

              <section className="excel-preview">
                <div className="section-heading">
                  <div><div className="eyebrow"><span className="eyebrow-line" /> DATASET BULANAN</div><h2>Description, Day-qty, Tax, Day-Gros, Kategori</h2></div>
                  <span className="result-count">Menampilkan {visibleRows.length.toLocaleString("id-ID")} dari {filteredRows.length.toLocaleString("id-ID")} row</span>
                </div>
                <div className="excel-scroll">
                  <table>
                    <thead><tr><th>No</th><th>File</th><th>Sheet</th><th>Baris</th><th>Description / Unit</th><th>Day-qty</th><th>Tax</th><th>Day-Gros</th><th>Kategori</th></tr></thead>
                    <tbody>
                      {visibleRows.map((row, i) => (
                        <tr key={`${row.fileIndex}-${row.sourceSheet}-${row.sourceRow}-${start + i}`}>
                          <td>{start + i + 1}</td><td>{row.fileName}</td><td>{row.sourceSheet}</td><td>{row.sourceRow}</td><td>{row.description || "—"}</td><td>{row.qty ?? "—"}</td><td>{formatUplRupiah(row.tax ?? 0)}</td><td>{formatUplRupiah(row.subtotal ?? 0)}</td><td>{row.category}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager page={page} pageSize={PAGE_SIZE} total={filteredRows.length} onPage={setPage} />
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
