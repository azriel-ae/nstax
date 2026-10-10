import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { AlertTriangle, ArrowLeft, Check, FileText, Info, ShieldCheck, Trash2, Upload } from "lucide-react";
import { MonthlyDropZone, MonthlyProgressBar, Pager, PeriodSwitch, ProcessAllButton, StagedFileList, type Period } from "@/components/MonthlyUploadParts";
import { formatFileSize, type MonthlyProgress } from "@/lib/monthlyCommon";
import { formatOmalaMoney, OMALA_AGENT, parseOmalaFiles, type OmalaBatchResult, type OmalaCategory } from "@/lib/omalaParser";

const PAGE_SIZE = 100;
const STATUS_ICON = { success: "✓", warning: "⚠", error: "✕" } as const;

const Metric = ({ label, value }: { label: string; value: string }) => (
  <div className="metric-card"><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong></div>
);

const CATEGORY_INFO: Record<OmalaCategory, { title: string; file: string; pattern: string; columns: string; heading: string }> = {
  HOTEL: {
    title: "HOTEL",
    file: "FO Transaction Journal",
    pattern: "%_FO%",
    columns: "A=Date · B=Room Number · F=Bill Number · H=Description · M=Amount",
    heading: "hotel",
  },
  RESTO: {
    title: "RESTO",
    file: "Cashier Sales Report",
    pattern: "%_Cashier%",
    columns: "A=Bill Number · K=Total · tanggal dari 8 karakter awal nama file (YYYYMMDD)",
    heading: "resto",
  },
};

/** CEK UPL THE OMALA — satu kategori (HOTEL atau RESTO), upload 1 file / banyak file. */
export default function OmalaChecker({ category, onBack }: { category: OmalaCategory; onBack: () => void }) {
  const info = CATEGORY_INFO[category];
  const money = (value: number) => formatOmalaMoney(value, category);

  const [period, setPeriod] = useState<Period>("daily");
  const [staged, setStaged] = useState<File[]>([]);
  const [result, setResult] = useState<OmalaBatchResult | null>(null);
  const [progress, setProgress] = useState<MonthlyProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [page, setPage] = useState(1);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = () => { setStaged([]); setResult(null); setNotice(""); setPage(1); setProgress(null); };

  const run = async (files: File[]) => {
    if (!files.length || busy) return;
    setBusy(true); setResult(null); setNotice(""); setPage(1);
    setProgress({ done: 0, total: files.length, fileName: files[0].name });
    try {
      const parsed = await parseOmalaFiles(files, category, setProgress);
      setResult(parsed);
      if (!parsed.ok) {
        setNotice(parsed.error || "Tidak ada file yang berhasil diproses.");
      } else {
        const failed = parsed.files.filter((f) => f.status === "error").length;
        setNotice(parsed.rows.length === 0
          ? `Tidak ada transaksi ${info.title} yang memenuhi filter SQL pada ${parsed.summary.fileCount} file yang terbaca.${failed ? ` ${failed} file gagal.` : ""}`
          : `✓ ${parsed.summary.fileCount} file diproses${failed ? ` · ${failed} file gagal` : ""} · ${parsed.rows.length.toLocaleString("id-ID")} transaksi ${info.title} digabung.`);
      }
    } catch {
      setNotice("Terjadi kesalahan saat memproses file.");
    } finally { setBusy(false); setProgress(null); }
  };

  // Harian: 1 file langsung diproses. >1 file otomatis masuk daftar bulanan.
  const handleDailyFiles = (files: File[]) => {
    if (!files.length || busy) return;
    if (files.length > 1) { setStaged(files); setResult(null); setNotice(""); setPeriod("monthly"); return; }
    setStaged(files);
    void run(files);
  };

  const addMonthlyFiles = (files: File[]) => {
    if (!files.length || busy) return;
    setStaged((prev) => [...prev, ...files]);
    setResult(null); setNotice("");
  };

  const changePeriod = (next: Period) => { if (next === "daily") reset(); setPeriod(next); };

  const summary = result?.ok ? result.summary : undefined;
  const allRows = result?.ok ? result.rows : [];
  const start = (page - 1) * PAGE_SIZE;
  const visibleRows = allRows.slice(start, start + PAGE_SIZE); // hanya tampilan; summary memakai seluruh baris
  const failedFiles = result?.files.filter((f) => f.status === "error") ?? [];
  const okFiles = result?.files.filter((f) => f.status !== "error" && !f.duplicate) ?? [];
  const showKeterangan = category === "HOTEL";

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="brand-lockup"><div className="brand-mark"><span>α</span></div><div><div className="brand-name">nstax</div><div className="brand-caption">transaction intelligence</div></div></div>
        <div className="sidebar-divider" />
        <nav className="sidebar-nav">
          <button className="nav-item" type="button" onClick={onBack}><ArrowLeft size={18} /><span>Kembali ke THE OMALA</span></button>
          <div className="nav-item is-active"><FileText size={18} /><span>THE OMALA · {info.title}</span></div>
        </nav>
        <div className="sidebar-footer"><div className="privacy-badge"><ShieldCheck size={16} /><div><strong>Local-first</strong><span>Data tidak keluar dari browser</span></div></div></div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <button className="button button-secondary compact" type="button" onClick={onBack}><ArrowLeft size={15} /> Kembali ke THE OMALA</button>
          <div className="breadcrumb"><span>CEK UPL</span><span>›</span><span>THE OMALA</span><span>›</span><strong>{info.title}</strong></div>
          <div className="status-chip"><span className="status-dot" /></div>
        </header>
        <div className="page-container">
          <section className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> CEK UPL THE OMALA · {info.title}</div>
              <h1>Periksa transaksi<br /><em>{info.heading} Omala.</em></h1>
              <p>Upload CSV {info.file} (delimiter titik koma). Header tabel dicari otomatis, baris judul dan baris total tidak dihitung, dan seluruh angka dihitung dari isi file sesuai rumus SQL {info.title}.</p>
            </div>
            <div className="heading-meta">
              <span className="meta-label">id_agent</span>
              <strong>{OMALA_AGENT[category]}</strong>
              <span className="meta-subtitle">{summary ? `${summary.transactionCount.toLocaleString("id-ID")} transaksi valid` : "Menunggu CSV"}</span>
            </div>
          </section>

          <section className="input-panel panel-surface">
            <PeriodSwitch period={period} onChange={changePeriod} />
            <div className="panel-heading">
              <div className="panel-title-wrap">
                <span className="section-number">01</span>
                <div>
                  <h2>{period === "daily" ? `Upload file ${info.file}` : `Upload banyak file ${info.file}`}</h2>
                  <p>Filter nama file: LIKE '{info.pattern}' · kolom: {info.columns}</p>
                </div>
              </div>
              {period === "daily" && staged[0] && <span className="file-pill"><FileText size={15} />{staged[0].name}</span>}
            </div>

            {period === "daily" ? (
              <div
                className={`drop-zone ${drag ? "is-dragging" : ""}`}
                onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
                onDragOver={(e) => e.preventDefault()}
                onDragLeave={() => setDrag(false)}
                onDrop={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDrag(false); handleDailyFiles(Array.from(e.dataTransfer.files)); }}
              >
                <div className="upload-symbol"><Upload size={20} /></div>
                <strong>{drag ? "Lepaskan file CSV di sini" : "Tarik satu file CSV ke sini"}</strong>
                <span>Lebih dari 1 file otomatis masuk daftar bulanan</span>
                <button className="button button-secondary" type="button" disabled={busy} onClick={() => inputRef.current?.click()}><FileText size={16} /> Pilih file CSV</button>
                <small>Hanya .CSV · delimiter ; · contoh: 20261006_{info.file}.csv</small>
                <input ref={inputRef} type="file" accept=".csv,text/csv" multiple hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { handleDailyFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
              </div>
            ) : (
              <>
                <MonthlyDropZone accept=".csv,text/csv" kindLabel="CSV" disabled={busy} hint={`Hanya .CSV · file ${info.file} · delimiter ;`} onFiles={addMonthlyFiles} />
                {staged.length > 0 && <div className="used-columns"><strong>{staged.length.toLocaleString("id-ID")} file dipilih</strong></div>}
                <StagedFileList files={staged} results={result?.files ?? null} busy={busy} onRemove={(i) => { setStaged((prev) => prev.filter((_, idx) => idx !== i)); setResult(null); setNotice(""); }} onClearAll={reset} />
                <div className="input-actions"><ProcessAllButton count={staged.length} busy={busy} onClick={() => void run(staged)} /></div>
              </>
            )}

            {progress && <MonthlyProgressBar progress={progress} />}
            {category === "RESTO" && (
              <div className="notice notice-warning">
                <span className="notice-icon"><Info size={17} /></span>
                <div>no_struk RESTO = Bill Number + "-" + id baris. File CSV tidak memiliki kolom id (d_file_data.id), sehingga id baris diisi dengan nomor baris pada file CSV. Nilai ini dapat dilacak ke file sumber tetapi tidak sama dengan id di database.</div>
              </div>
            )}
            <div className="input-actions">
              <div className="privacy-note"><ShieldCheck size={15} /> Diproses lokal di browser</div>
              <button className="button button-ghost" type="button" onClick={reset}><Trash2 size={16} /> Clear</button>
            </div>
          </section>

          {notice && (
            <div className={`notice ${result?.ok ? (allRows.length ? "notice-success" : "notice-warning") : "notice-error"}`}>
              <span className="notice-icon">{result?.ok ? <Check size={17} /> : <AlertTriangle size={17} />}</span>{notice}
            </div>
          )}

          {result && result.files.length > 0 && (
            <section className="excel-preview">
              <div className="section-heading">
                <div>
                  <div className="eyebrow"><span className="eyebrow-line" /> STATUS FILE</div>
                  <h2>{okFiles.length.toLocaleString("id-ID")} file berhasil diproses{failedFiles.length ? ` · ${failedFiles.length.toLocaleString("id-ID")} file gagal` : ""}</h2>
                </div>
                <span className="result-count">{result.files.length.toLocaleString("id-ID")} file</span>
              </div>
              <div className="excel-scroll">
                <table>
                  <thead><tr><th>No</th><th>Nama file</th><th>Ukuran</th><th>Status</th><th>Baris header</th><th>Transaksi valid</th><th>Total/kosong diabaikan</th><th>Bermasalah</th><th>Keterangan</th></tr></thead>
                  <tbody>
                    {result.files.map((f, i) => (
                      <tr key={`${f.index}-${f.name}`}>
                        <td>{i + 1}</td>
                        <td>{STATUS_ICON[f.status]} {f.name}</td>
                        <td>{formatFileSize(f.size)}</td>
                        <td>{f.duplicate ? "duplikat (tidak dihitung)" : f.status === "error" ? "gagal" : f.status === "warning" ? "berhasil (catatan)" : "berhasil"}</td>
                        <td>{f.headerRow ?? "—"}</td>
                        <td>{f.rowCount.toLocaleString("id-ID")}</td>
                        <td>{(f.skippedTotal + f.skippedBlank).toLocaleString("id-ID")}</td>
                        <td>{f.problemRows.toLocaleString("id-ID")}</td>
                        <td>{f.message ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {result?.ok && summary && (
            <>
              <div className="metric-grid upl-metrics">
                <Metric label="Total file" value={summary.fileCount.toLocaleString("id-ID")} />
                <Metric label="Total transaksi" value={summary.transactionCount.toLocaleString("id-ID")} />
                <Metric label="Total subtotal" value={money(summary.subtotal)} />
                <Metric label="Total service charge" value={money(summary.service_charge)} />
                <Metric label="Total discount" value={money(summary.discount)} />
                <Metric label="Total DPP" value={money(summary.dpp)} />
                <Metric label="Total tax" value={money(summary.tax)} />
                <Metric label="Total total" value={money(summary.total)} />
              </div>

              {result.issues.length > 0 && (
                <section className="excel-preview">
                  <div className="section-heading">
                    <div><div className="eyebrow"><span className="eyebrow-line" /> BARIS BERMASALAH</div><h2>{result.issues.length.toLocaleString("id-ID")} baris memenuhi filter tetapi tidak dihitung</h2></div>
                  </div>
                  <div className="excel-scroll">
                    <table>
                      <thead><tr><th>No</th><th>File</th><th>Baris</th><th>Alasan</th><th>Nilai asli</th></tr></thead>
                      <tbody>{result.issues.slice(0, PAGE_SIZE).map((issue, i) => <tr key={`${issue.fileName}-${issue.sourceRow}`}><td>{i + 1}</td><td>{issue.fileName}</td><td>{issue.sourceRow}</td><td>{issue.reason}</td><td>{issue.value ?? ""}</td></tr>)}</tbody>
                    </table>
                  </div>
                </section>
              )}

              <section className="excel-preview">
                <div className="section-heading">
                  <div><div className="eyebrow"><span className="eyebrow-line" /> 02 · DATASET PENUH</div><h2>Detail transaksi {info.title}</h2></div>
                  <span className="result-count">Menampilkan {visibleRows.length.toLocaleString("id-ID")} dari {allRows.length.toLocaleString("id-ID")} baris</span>
                </div>
                {allRows.length === 0 ? (
                  <div className="notice notice-warning">
                    <span className="notice-icon"><Info size={17} /></span>
                    Tidak ada transaksi yang memenuhi filter SQL. Baris judul laporan dan baris total tidak dihitung sebagai transaksi, dan tidak ada data pengganti yang dibuat.
                  </div>
                ) : (
                  <>
                    <div className="excel-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>No</th><th>filename</th><th>id_agent</th><th>no_struk</th><th>date_trans</th>
                            <th>subtotal</th><th>service_charge</th><th>discount</th><th>dpp</th><th>tax</th><th>total</th>
                            {showKeterangan && <th>keterangan</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {visibleRows.map((row, i) => (
                            <tr key={`${row.filename}-${row.sourceRow}`}>
                              <td>{start + i + 1}</td>
                              <td>{row.filename}</td>
                              <td>{row.id_agent}</td>
                              <td>{row.no_struk}</td>
                              <td>{row.date_trans}</td>
                              <td>{money(row.subtotal)}</td>
                              <td>{money(row.service_charge)}</td>
                              <td>{money(row.discount)}</td>
                              <td>{money(row.dpp)}</td>
                              <td>{money(row.tax)}</td>
                              <td>{money(row.total)}</td>
                              {showKeterangan && <td>{(row.keterangan ?? "").trim()}</td>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <Pager page={page} pageSize={PAGE_SIZE} total={allRows.length} onPage={setPage} />
                  </>
                )}
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
