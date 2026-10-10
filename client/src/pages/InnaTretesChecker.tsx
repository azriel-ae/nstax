import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { AlertTriangle, ArrowLeft, FileText, Info, ShieldCheck, Trash2, Upload } from "lucide-react";
import { Pager, PeriodSwitch } from "@/components/MonthlyUploadParts";
import PeriodModeHost, { type PeriodModeProps } from "@/components/PeriodModeHost";
import { findDuplicate, fingerprintBuffer, formatBytes } from "@/lib/multiFile";
import {
  countInnaByCategory,
  filterInnaRows,
  formatInnaMoney,
  formatInnaPeriod,
  INNA_CATEGORIES,
  INNA_CATEGORY_LABEL,
  listInnaPeriods,
  mergeInnaSources,
  MONTH_NAMES_ID,
  parseInnaTretesWorkbook,
  summarizeInnaRows,
  type InnaCategoryFilter,
  type InnaPeriod,
  type InnaSource,
} from "@/lib/innaTretesParser";

type Props = { onBack: () => void };
type InnerProps = Props & PeriodModeProps;

const PAGE_SIZE = 100; // hanya membatasi tampilan; ringkasan selalu dari seluruh hasil filter
const ISSUE_PREVIEW_LIMIT = 100;
const CATEGORY_OPTIONS: InnaCategoryFilter[] = ["ALL", ...INNA_CATEGORIES];

const Metric = ({ label, value, small = false }: { label: string; value: string; small?: boolean }) => (
  <div className="metric-card"><span className="metric-label">{label}</span><strong className="metric-value" style={small ? { fontSize: 15 } : undefined}>{value}</strong></div>
);

type InnaFileEntry = {
  id: number;
  name: string;
  size: number;
  fingerprint: string | null;
  state: "ok" | "gagal" | "duplikat";
  source: InnaSource | null;
  message?: string;
  duplicateOf?: number;
};

const failedSource = (name: string, error: string): InnaSource => ({ ok: false, error, fileName: name, sheetName: "", headerRow: 0, ignoredSheets: [], rows: [], unmapped: [], issues: [], stats: { dataRows: 0, blankRows: 0, repeatedHeaders: 0, nonTransactionRows: 0, validRows: 0, unmappedRows: 0, invalidAmountRows: 0, invalidDateRows: 0, missingFolioRows: 0, missingNameRows: 0 } });

/** CEK UPL INNA TRETES — mode HARIAN (1 file Excel) dan BULANAN (banyak file Excel) dipisah; parser dan perhitungan sama untuk keduanya. */
export default function InnaTretesChecker({ onBack }: Props) {
  return <PeriodModeHost render={(mode) => <InnaTretesPanel onBack={onBack} {...mode} />} />;
}

/** Kategori HOTEL / HIBURAN / RESTO, filter bulan + tahun. */
function InnaTretesPanel({ onBack, period: uploadMode, onPeriod: onUploadMode, onMultiple, initialFiles }: InnerProps) {
  const monthly = uploadMode === "monthly";
  const [files, setFiles] = useState<InnaFileEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [period, setPeriod] = useState<InnaPeriod | null>(null);
  const [category, setCategory] = useState<InnaCategoryFilter>("ALL");
  const [page, setPage] = useState(1);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const loadToken = useRef(0); // mencegah hasil file lama menimpa file yang lebih baru
  const fileIdRef = useRef(0);

  // Semua file yang berhasil dibaca digabung menjadi satu dataset; satu file = perilaku seperti sebelumnya.
  const source = useMemo<InnaSource | null>(() => {
    if (!files.length) return null;
    const ok = files.filter((f) => f.state === "ok" && f.source?.ok).map((f) => f.source!);
    if (ok.length) return mergeInnaSources(ok);
    const failed = files.filter((f) => f.state === "gagal");
    return failed.length === 1 && failed[0].source ? failed[0].source : failedSource(files.map((f) => f.name).join(", "), failed.map((f) => `${f.name}: ${f.message ?? "gagal dibaca"}`).join(" | ") || "Tidak ada file yang dapat dihitung.");
  }, [files]);
  const okFiles = files.filter((f) => f.state === "ok");
  const failedFiles = files.filter((f) => f.state === "gagal");
  const dupFiles = files.filter((f) => f.state === "duplikat");
  const fileName = !files.length ? "" : okFiles.length === 1 ? okFiles[0].name : okFiles.length > 1 ? `${okFiles.length} file` : files[0].name;

  const resetView = (nextSource: InnaSource | null) => {
    setCategory("ALL");
    setPage(1);
    const available = nextSource?.ok ? listInnaPeriods(nextSource.rows) : [];
    setPeriod(available.length ? { year: available[available.length - 1].year, month: available[available.length - 1].month } : null);
  };

  const reset = () => {
    loadToken.current++;
    setFiles([]); setBusy(false); setPeriod(null); setCategory("ALL"); setPage(1);
  };

  const applyFiles = (next: InnaFileEntry[]) => {
    setFiles(next);
    const ok = next.filter((f) => f.state === "ok" && f.source?.ok).map((f) => f.source!);
    resetView(ok.length ? mergeInnaSources(ok) : null);
  };

  // Menambah satu atau banyak file (file picker multi-pilih / Ctrl+A / drag & drop). Setiap file dibaca dengan parser yang sama.
  const handleFiles = async (picked: File[]) => {
    if (!picked.length || busy) return;
    // HARIAN: tepat 1 file dan menggantikan file sebelumnya; banyak file dialihkan ke mode BULANAN.
    if (!monthly && picked.length > 1) { onMultiple(picked); return; }
    const base: InnaFileEntry[] = monthly ? files : [];
    const token = ++loadToken.current;
    setBusy(true);
    const added: InnaFileEntry[] = [];
    const replaced = new Set<number>();
    for (const file of picked) {
      const id = ++fileIdRef.current;
      let buffer: ArrayBuffer;
      try { buffer = await file.arrayBuffer(); } catch {
        added.push({ id, name: file.name, size: file.size, fingerprint: null, state: "gagal", source: failedSource(file.name, "File tidak dapat dibaca."), message: "File tidak dapat dibaca." });
        continue;
      }
      const fingerprint = await fingerprintBuffer(buffer);
      const probes = [...base, ...added].map((f) => ({ id: f.id, name: f.name, fingerprint: f.fingerprint, usable: f.state === "ok" }));
      const dup = findDuplicate(probes, file.name, fingerprint);
      if (dup) {
        added.push({ id, name: file.name, size: file.size, fingerprint, state: "duplikat", source: null, duplicateOf: dup.id, message: `Duplikat dari ${dup.name} (nama atau isi sama); tidak dihitung ulang.` });
        continue;
      }
      base.forEach((f) => { if (f.state === "gagal" && f.name.toLowerCase() === file.name.toLowerCase()) replaced.add(f.id); });
      let parsed: InnaSource;
      try {
        parsed = parseInnaTretesWorkbook(buffer, file.name);
      } catch {
        parsed = failedSource(file.name, "Terjadi kesalahan saat membaca file.");
      }
      added.push(parsed.ok
        ? { id, name: file.name, size: file.size, fingerprint, state: "ok", source: parsed }
        : { id, name: file.name, size: file.size, fingerprint, state: "gagal", source: parsed, message: parsed.error });
    }
    if (token !== loadToken.current) return; // Clear ditekan saat membaca
    applyFiles([...base.filter((f) => !replaced.has(f.id)), ...added]);
    setBusy(false);
  };

  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current || !initialFiles.length) return;
    startedRef.current = true; // cegah pemrosesan ganda (StrictMode)
    void handleFiles(initialFiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const removeFile = (id: number) => {
    if (busy) return;
    applyFiles(files.filter((f) => f.id !== id && f.duplicateOf !== id));
  };

  const periods = useMemo(() => (source?.ok ? listInnaPeriods(source.rows) : []), [source]);
  const years = useMemo(() => [...new Set(periods.map((p) => p.year))], [periods]);
  const monthsOfYear = useMemo(() => periods.filter((p) => p.year === period?.year), [periods, period]);

  // Satu sumber kebenaran: ringkasan dan tabel memakai himpunan baris yang sama.
  const periodRows = useMemo(() => (source?.ok && period ? filterInnaRows(source.rows, period, "ALL") : []), [source, period]);
  const categoryCounts = useMemo(() => countInnaByCategory(periodRows), [periodRows]);
  const filteredRows = useMemo(() => (source?.ok && period ? filterInnaRows(source.rows, period, category) : []), [source, period, category]);
  const summary = useMemo(() => summarizeInnaRows(filteredRows), [filteredRows]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * PAGE_SIZE;
  const visibleRows = filteredRows.slice(start, start + PAGE_SIZE);

  const changeYear = (year: number) => {
    const inYear = periods.filter((p) => p.year === year);
    if (!inYear.length) return;
    setPeriod({ year, month: inYear[inYear.length - 1].month });
    setPage(1);
  };
  const changeMonth = (month: number) => { if (period) { setPeriod({ year: period.year, month }); setPage(1); } };
  const changeCategory = (next: InnaCategoryFilter) => { setCategory(next); setPage(1); };

  const stats = source?.stats;
  const ready = !!source?.ok && !busy;
  const status = busy ? "Membaca file…" : !files.length ? "Belum ada file" : source?.ok ? `${okFiles.length} file berhasil dibaca${failedFiles.length ? ` · ${failedFiles.length} gagal` : ""}${dupFiles.length ? ` · ${dupFiles.length} duplikat dilewati` : ""}` : "Gagal membaca file";
  const money = formatInnaMoney;
  const activePeriodText = period ? formatInnaPeriod(period) : "—";
  const activeCategoryText = INNA_CATEGORY_LABEL[category];

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="brand-lockup"><div className="brand-mark"><span>α</span></div><div><div className="brand-name">nstax</div><div className="brand-caption">transaction intelligence</div></div></div>
        <div className="sidebar-divider" />
        <nav className="sidebar-nav">
          <button className="nav-item" type="button" onClick={onBack}><ArrowLeft size={18} /><span>Kembali ke CEK UPL</span></button>
          <div className="nav-item is-active"><FileText size={18} /><span>CEK INNA TRETES</span></div>
        </nav>
        <div className="sidebar-footer"><div className="privacy-badge"><ShieldCheck size={16} /><div><strong>Local-first</strong><span>Data tidak keluar dari browser</span></div></div></div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <button className="button button-secondary compact" type="button" onClick={onBack}><ArrowLeft size={15} /> Kembali ke CEK UPL</button>
          <div className="breadcrumb"><span>CEK UPL</span><span>›</span><strong>CEK INNA TRETES</strong></div>
          <div className="status-chip"><span className="status-dot" /></div>
        </header>
        <div className="page-container">
          <section className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> CEK UPL INNA TRETES · EXCEL · {monthly ? "BULANAN" : "HARIAN"}</div>
              <h1>Periksa transaksi<br /><em>Inna Tretes.</em></h1>
              <p>{monthly ? "Mode bulanan: upload banyak file Excel Detail Night Audit Report sekaligus. " : "Mode harian: upload satu file Excel Detail Night Audit Report. "}HOTEL, HIBURAN, dan RESTO dibaca dari file yang sama; ganti kategori atau bulan tanpa upload ulang.</p>
            </div>
            <div className="heading-meta">
              <span className="meta-label">CURRENT SOURCE</span>
              <strong>{fileName || "Belum ada file"}</strong>
              <span className="meta-subtitle">{ready && period ? `${activePeriodText} · ${activeCategoryText} · ${summary.count.toLocaleString("id-ID")} transaksi` : busy ? "Memproses file…" : "Menunggu file Excel"}</span>
            </div>
          </section>

          <section className="input-panel panel-surface">
            <div className="panel-heading">
              <div className="panel-title-wrap"><span className="section-number">01</span><div><h2>{monthly ? "Upload File Excel Inna Tretes · Bulanan" : "Upload File Excel Inna Tretes · Harian"}</h2><p>{monthly ? "Banyak file untuk ketiga kategori." : "Satu file untuk ketiga kategori; file baru menggantikan file sebelumnya."} Tanggal diambil dari kolom D (Trn Date), bukan dari nama file.</p></div></div>
              {fileName && <span className="file-pill"><FileText size={15} />{fileName}</span>}
            </div>
            <PeriodSwitch period={uploadMode} onChange={onUploadMode} />
            <div
              className={`drop-zone ${drag ? "is-dragging" : ""}`}
              onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={() => setDrag(false)}
              onDrop={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDrag(false); void handleFiles(Array.from(e.dataTransfer.files)); }}
            >
              <div className="upload-symbol"><Upload size={20} /></div>
              <strong>{drag ? "Lepaskan file Excel di sini" : monthly ? "Tarik banyak file Excel ke sini" : "Tarik satu file Excel ke sini"}</strong>
              <span>{monthly ? "Di dialog pilih file, tekan Ctrl+A (setelah dialog aktif) untuk memilih semua file. Semua file dipakai untuk HOTEL, HIBURAN, dan RESTO." : "Jika Anda memilih lebih dari satu file, tampilan otomatis pindah ke mode bulanan."}</span>
              <button className="button button-secondary" type="button" disabled={busy} onClick={() => inputRef.current?.click()}><FileText size={16} /> {monthly ? "Pilih banyak file Excel" : "Pilih file Excel"}</button>
              <small>Kolom dibaca berdasarkan posisi: A = Class · B = Folio · D = Trn Date · E = Trans ID · G = Trans Name · L = Trans Nett.</small>
              <input ref={inputRef} type="file" multiple={monthly} accept=".xlsx,.xls,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { void handleFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
            </div>
            <div className="used-columns">
              <strong>Status: {status}</strong>
              {ready && source?.ok && stats && <>
                <span>{okFiles.length > 1 ? `✓ ${okFiles.length} file digabung (sheet ${source.sheetName})` : `✓ Sheet "${source.sheetName}" · header di baris ${source.headerRow}`} · {stats.validRows.toLocaleString("id-ID")} transaksi valid dibaca dari {stats.dataRows.toLocaleString("id-ID")} baris data</span>
                <span>{[
                  stats.blankRows ? `${stats.blankRows.toLocaleString("id-ID")} baris kosong dilewati` : "",
                  stats.repeatedHeaders ? `${stats.repeatedHeaders.toLocaleString("id-ID")} header berulang dilewati` : "",
                  stats.nonTransactionRows ? `${stats.nonTransactionRows.toLocaleString("id-ID")} baris non-transaksi / total dilewati (Trans ID kosong)` : "",
                ].filter(Boolean).join(" · ") || "Tidak ada baris yang dilewati"}</span>
                {source.ignoredSheets.length > 0 && <span>Sheet tanpa header transaksi diabaikan: {source.ignoredSheets.join(", ")}</span>}
              </>}
            </div>
            {files.length > 0 && (
              <div className="mapping-panel upl-audit-panel">
                <div className="eyebrow"><span className="eyebrow-line" /> {files.length.toLocaleString("id-ID")} FILE DIPILIH</div>
                <div className="excel-scroll" style={{ maxHeight: 320 }}>
                  <table>
                    <thead><tr><th>No</th><th>Nama file</th><th>Ukuran</th><th>Status</th><th>Hapus</th></tr></thead>
                    <tbody>
                      {files.map((f, i) => (
                        <tr key={f.id}>
                          <td>{i + 1}</td>
                          <td>{f.name}</td>
                          <td>{formatBytes(f.size)}</td>
                          <td>{f.state === "ok" && f.source?.ok ? `✓ berhasil · ${f.source.stats.validRows.toLocaleString("id-ID")} transaksi` : f.state === "duplikat" ? `⚠ dilewati: ${f.message}` : `✕ gagal: ${f.message ?? "tidak dapat dibaca"}`}</td>
                          <td><button className="button button-ghost compact" type="button" disabled={busy} onClick={() => removeFile(f.id)} aria-label={`Hapus ${f.name}`}>✕ Hapus</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <div className="input-actions">
              <div className="privacy-note"><ShieldCheck size={15} /> Diproses lokal di browser</div>
              <button className="button button-ghost" type="button" onClick={reset}><Trash2 size={16} /> Clear</button>
            </div>
          </section>

          {busy && <div className="notice notice-success" role="status" aria-live="polite"><span className="notice-icon"><Info size={17} /></span>Membaca dan memproses file Excel…</div>}

          {!busy && source?.ok && failedFiles.length > 0 && (
            <div className="notice notice-error"><span className="notice-icon"><AlertTriangle size={17} /></span>{failedFiles.length} file gagal dibaca dan tidak ikut dihitung: {failedFiles.map((f) => `${f.name} (${f.message ?? "gagal"})`).join(" | ")}</div>
          )}

          {!busy && source && !source.ok && (
            <div className="notice notice-error"><span className="notice-icon"><AlertTriangle size={17} /></span>{source.error}</div>
          )}

          {!busy && !source && (
            <div style={{ margin: "18px 2px 0", padding: "12px 14px", border: "1px dashed var(--line-strong)", borderRadius: 6, fontSize: 12, color: "var(--muted)" }}>
              Upload file Excel untuk melihat ringkasan dan detail transaksi.
            </div>
          )}

          {ready && source?.ok && stats && <>
            {(source.unmapped.length > 0 || source.issues.length > 0 || stats.missingFolioRows > 0 || stats.missingNameRows > 0) && (
              <div className="notice notice-warning" style={{ alignItems: "flex-start", flexDirection: "column", gap: 4 }}>
                {source.unmapped.length > 0 && <span>⚠ {source.unmapped.length.toLocaleString("id-ID")} baris punya kode kategori (kolom A) yang tidak dikenal dan tidak dimasukkan ke HOTEL, HIBURAN, maupun RESTO — lihat daftar di bawah.</span>}
                {source.issues.length > 0 && <span>⚠ {source.issues.length.toLocaleString("id-ID")} masalah data pada {(stats.invalidAmountRows + stats.invalidDateRows).toLocaleString("id-ID")} baris (nilai L atau tanggal D tidak valid); baris tersebut tidak dihitung — lihat daftar di bawah.</span>}
                {stats.missingFolioRows > 0 && <span>ℹ {stats.missingFolioRows.toLocaleString("id-ID")} transaksi tidak memiliki Folio (kolom B kosong); sesuai rumus, no_struk menjadi " - &lt;Trans ID&gt;" dan keterangan memuat Folio kosong.</span>}
                {stats.missingNameRows > 0 && <span>ℹ {stats.missingNameRows.toLocaleString("id-ID")} transaksi tidak memiliki Trans Name (kolom G kosong); tetap dihitung.</span>}
              </div>
            )}

            {periods.length === 0 ? (
              <div className="notice notice-warning" role="status">
                <span className="notice-icon"><Info size={17} /></span>
                Tidak ditemukan transaksi valid dengan kategori dan tanggal yang dapat dibaca pada file ini. Tidak ada data pengganti yang dibuat.
              </div>
            ) : (
              <>
                <section className="panel-surface" style={{ marginTop: 20, padding: 20 }}>
                  <div className="panel-heading">
                    <div className="panel-title-wrap"><span className="section-number">02</span><div><h2>Periode dan kategori</h2><p>{periods.length === 1 ? `Bulan terdeteksi pada file: ${formatInnaPeriod(periods[0])}.` : `File berisi ${periods.length} bulan: ${periods.map(formatInnaPeriod).join(", ")}.`} Filter periode dan kategori berlaku bersamaan.</p></div></div>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end", marginTop: 14 }}>
                    <label className="cmp-select">Tahun
                      <select value={period?.year ?? ""} onChange={(e) => changeYear(Number(e.target.value))} aria-label="Tahun">
                        {years.map((y) => <option key={y} value={y}>{y}</option>)}
                      </select>
                    </label>
                    <label className="cmp-select">Bulan
                      <select value={period?.month ?? ""} onChange={(e) => changeMonth(Number(e.target.value))} aria-label="Bulan">
                        {monthsOfYear.map((p) => <option key={p.month} value={p.month}>{MONTH_NAMES_ID[p.month - 1]} ({p.count.toLocaleString("id-ID")})</option>)}
                      </select>
                    </label>
                  </div>
                  <div className="cmp-chips" role="group" aria-label="Kategori Inna Tretes" style={{ marginTop: 14 }}>
                    {CATEGORY_OPTIONS.map((item) => (
                      <button key={item} type="button" className={`cmp-chip ${category === item ? "is-active" : ""}`} onClick={() => changeCategory(item)}>
                        {INNA_CATEGORY_LABEL[item]}<b>{(item === "ALL" ? periodRows.length : categoryCounts[item]).toLocaleString("id-ID")}</b>
                      </button>
                    ))}
                  </div>
                </section>

                <div className="metric-grid upl-metrics">
                  <Metric label="Profil" value="INNA TRETES" small />
                  <Metric label="Nama file" value={fileName} small />
                  <Metric label="Periode aktif" value={activePeriodText} small />
                  <Metric label="Kategori aktif" value={activeCategoryText} small />
                  <Metric label="Jumlah transaksi" value={summary.count.toLocaleString("id-ID")} />
                  <Metric label="Total subtotal" value={money(summary.subtotal)} />
                  <Metric label="Total DPP" value={money(summary.dpp)} />
                  <Metric label="Total discount" value={money(summary.discount)} />
                  <Metric label="Total service charge" value={money(summary.service_charge)} />
                  <Metric label="Total tax" value={money(summary.tax)} />
                  <Metric label="Total keseluruhan" value={money(summary.total)} />
                </div>

                <section className="excel-preview">
                  <div className="section-heading">
                    <div><div className="eyebrow"><span className="eyebrow-line" /> 03 · DATASET PENUH</div><h2>Detail transaksi Inna Tretes · {activeCategoryText} · {activePeriodText}</h2></div>
                    <span className="result-count">Menampilkan {visibleRows.length.toLocaleString("id-ID")} dari {filteredRows.length.toLocaleString("id-ID")} baris · ringkasan dihitung dari seluruh hasil filter</span>
                  </div>
                  {filteredRows.length === 0 ? (
                    <div className="notice notice-warning" role="status">
                      <span className="notice-icon"><Info size={17} /></span>
                      Tidak ada transaksi yang cocok dengan periode {activePeriodText} dan kategori {activeCategoryText}.
                    </div>
                  ) : (
                    <>
                      <div className="excel-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>No</th><th>id_agent</th><th>no_struk</th><th>date_trans</th><th>dpp</th><th>subtotal</th><th>discount</th>
                              <th>service_charge</th><th>tax</th><th>total</th><th>keterangan</th><th>Baris Excel</th>
                            </tr>
                          </thead>
                          <tbody>
                            {visibleRows.map((row, i) => (
                              <tr key={`${row.sourceFile ?? ""}#${row.sourceRow}`}>
                                <td>{start + i + 1}</td>
                                <td>{row.id_agent}</td>
                                <td style={{ whiteSpace: "pre" }}>{row.no_struk}</td>
                                <td>{row.date_trans}</td>
                                <td>{money(row.dpp)}</td>
                                <td>{money(row.subtotal)}</td>
                                <td>{money(row.discount)}</td>
                                <td>{money(row.service_charge)}</td>
                                <td>{money(row.tax)}</td>
                                <td>{money(row.total)}</td>
                                <td>{row.keterangan}</td>
                                <td>{row.sourceFile ? `${row.sourceFile} · ${row.sourceRow}` : row.sourceRow}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <Pager page={safePage} pageSize={PAGE_SIZE} total={filteredRows.length} onPage={setPage} />
                      <div style={{ margin: "8px 2px 0", fontSize: 11, color: "var(--muted)" }}>
                        Nilai dihitung dengan presisi penuh dari kolom L dan hanya ditampilkan dengan 2 desimal. Rumus mengikuti query acuan: dpp = 1,1 × L, service_charge = −0,1 × L, tax = 0,11 × L, total = 1,21 × L.
                      </div>
                    </>
                  )}
                </section>
              </>
            )}

            {source.unmapped.length > 0 && (
              <section className="excel-preview">
                <div className="section-heading">
                  <div><div className="eyebrow"><span className="eyebrow-line" /> BELUM TERPETAKAN</div><h2>{source.unmapped.length.toLocaleString("id-ID")} baris dengan kode kategori tidak dikenal</h2></div>
                  <span className="result-count">Tidak dihitung pada kategori mana pun</span>
                </div>
                <div className="excel-scroll">
                  <table>
                    <thead><tr><th>No</th><th>Baris Excel</th><th>Kode (kolom A)</th><th>Trans ID</th><th>Trans Name</th></tr></thead>
                    <tbody>{source.unmapped.slice(0, ISSUE_PREVIEW_LIMIT).map((u, i) => <tr key={`${u.file ?? ""}#${u.row}`}><td>{i + 1}</td><td>{u.file ? `${u.file} · ${u.row}` : u.row}</td><td>{u.code || "(kosong)"}</td><td>{u.transId}</td><td>{u.transName}</td></tr>)}</tbody>
                  </table>
                </div>
                {source.unmapped.length > ISSUE_PREVIEW_LIMIT && <div style={{ margin: "8px 2px 0", fontSize: 11, color: "var(--muted)" }}>Menampilkan {ISSUE_PREVIEW_LIMIT} dari {source.unmapped.length.toLocaleString("id-ID")} baris.</div>}
              </section>
            )}

            {source.issues.length > 0 && (
              <section className="excel-preview">
                <div className="section-heading">
                  <div><div className="eyebrow"><span className="eyebrow-line" /> BARIS BERMASALAH</div><h2>{source.issues.length.toLocaleString("id-ID")} masalah data — baris tidak dihitung</h2></div>
                </div>
                <div className="excel-scroll">
                  <table>
                    <thead><tr><th>No</th><th>Baris Excel</th><th>Kode</th><th>Trans ID</th><th>Nilai asli</th><th>Alasan</th></tr></thead>
                    <tbody>{source.issues.slice(0, ISSUE_PREVIEW_LIMIT).map((it, i) => <tr key={`${it.file ?? ""}#${it.row}-${it.kind}-${i}`}><td>{i + 1}</td><td>{it.file ? `${it.file} · ${it.row}` : it.row}</td><td>{it.code}</td><td>{it.transId}</td><td>{it.value || "(kosong)"}</td><td>{it.message}</td></tr>)}</tbody>
                  </table>
                </div>
                {source.issues.length > ISSUE_PREVIEW_LIMIT && <div style={{ margin: "8px 2px 0", fontSize: 11, color: "var(--muted)" }}>Menampilkan {ISSUE_PREVIEW_LIMIT} dari {source.issues.length.toLocaleString("id-ID")} masalah.</div>}
              </section>
            )}
          </>}
        </div>
      </main>
    </div>
  );
}
