import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { AlertTriangle, ArrowLeft, FileText, Info, ShieldCheck, Trash2, Upload } from "lucide-react";
import { Pager, PeriodSwitch } from "@/components/MonthlyUploadParts";
import PeriodModeHost, { type PeriodModeProps } from "@/components/PeriodModeHost";
import { findDuplicate, fingerprintBuffer, formatBytes } from "@/lib/shared/multiFile";
import {
  failPlataranSource,
  findDuplicatePlataranNoStruk,
  formatPlataranMoney,
  mergePlataranSources,
  parseHotelPlataranWorkbook,
  PLATARAN_AGENT_IDS,
  PLATARAN_CATEGORIES,
  PLATARAN_CATEGORY_NAMES,
  summarizePlataranByCategory,
  summarizePlataranRows,
  type PlataranCategory,
  type PlataranSource,
} from "@/lib/parsers/hotelPlataranParser";
import { SidebarBrand } from "@/components/BrandLogo";

type Props = { onBack: () => void };
type InnerProps = Props & PeriodModeProps;

const PAGE_SIZE = 100; // hanya membatasi tampilan; ringkasan selalu dari seluruh record
const ISSUE_PREVIEW_LIMIT = 10;
const WARNING_PREVIEW_LIMIT = 10;
const num = (value: number) => value.toLocaleString("id-ID");

const Metric = ({ label, value, small = false }: { label: string; value: string; small?: boolean }) => (
  <div className="metric-card"><span className="metric-label">{label}</span><strong className="metric-value" style={small ? { fontSize: 15 } : undefined}>{value}</strong></div>
);

type PlataranFileEntry = {
  id: number;
  name: string;
  size: number;
  fingerprint: string | null;
  state: "ok" | "gagal" | "duplikat";
  source: PlataranSource | null;
  message?: string;
  duplicateOf?: number;
};

/** CEK UPL PLATARAN — satu file Excel menghasilkan empat kategori (HOTEL PLATARAN, SYAILENDRA VENUE AND DINING, RESTO PAMIRANTI LOUNGE, RESTO TERAS BROMO). Mode HARIAN (1 file) dan BULANAN (banyak file) memakai parser dan perhitungan yang sama. */
export default function HotelPlataranChecker({ onBack }: Props) {
  return <PeriodModeHost render={(mode) => <HotelPlataranPanel onBack={onBack} {...mode} />} />;
}

function HotelPlataranPanel({ onBack, period, onPeriod, onMultiple, initialFiles }: InnerProps) {
  const monthly = period === "monthly";
  const [files, setFiles] = useState<PlataranFileEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef(false); // true = pilihan file berikutnya MENGGANTI seluruh daftar (tombol "Ganti semua file")
  const loadToken = useRef(0); // mencegah hasil file lama menimpa file yang lebih baru
  const fileIdRef = useRef(0);

  const okFiles = files.filter((f) => f.state === "ok");
  const failedFiles = files.filter((f) => f.state === "gagal");
  const dupFiles = files.filter((f) => f.state === "duplikat");

  // Semua file yang berhasil dibaca digabung menjadi satu hasil; tiap record tetap membawa nama file dan tanggalnya sendiri.
  const source = useMemo<PlataranSource | null>(() => {
    if (!files.length) return null;
    const ok = files.filter((f) => f.state === "ok" && f.source?.ok).map((f) => f.source!);
    if (ok.length) return mergePlataranSources(ok);
    const failed = files.filter((f) => f.state === "gagal");
    return failed.length === 1 && failed[0].source ? failed[0].source : failPlataranSource(files.map((f) => f.name).join(", "), failed.map((f) => `${f.name}: ${f.message ?? "gagal dibaca"}`).join(" | ") || "Tidak ada file yang dapat dihitung.");
  }, [files]);

  const rows = useMemo(() => (source?.ok ? source.rows : []), [source]);
  const summary = useMemo(() => summarizePlataranRows(rows), [rows]);
  const byCategory = useMemo(() => summarizePlataranByCategory(rows), [rows]);
  const [categoryFilter, setCategoryFilter] = useState<"ALL" | PlataranCategory>("ALL");
  const shownRows = useMemo(() => (categoryFilter === "ALL" ? rows : rows.filter((r) => r.category === categoryFilter)), [rows, categoryFilter]);
  const duplicateNoStruk = useMemo(() => findDuplicatePlataranNoStruk(rows), [rows]);
  const months = useMemo(() => (source?.ok ? [...new Set(source.dates.map((date) => date.slice(0, 7)))].sort() : []), [source]);

  const pageCount = Math.max(1, Math.ceil(shownRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visibleRows = shownRows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const fileName = !files.length ? "" : okFiles.length === 1 ? okFiles[0].name : okFiles.length > 1 ? `${okFiles.length} file` : files[0].name;
  const ready = !!source?.ok && !busy;
  const stats = source?.stats;
  const incomplete = failedFiles.length > 0;
  const skippedText = stats
    ? [
        stats.ignoredRows ? `${num(stats.ignoredRows)} baris di luar kategori` : "",
        stats.headerRows ? `${num(stats.headerRows)} header kolom (TODAY)` : "",
        stats.invalidAmountRows ? `${num(stats.invalidAmountRows)} nominal kosong/tidak valid` : "",
      ].filter(Boolean).join(" · ")
    : "";
  const status = busy
    ? "Membaca file…"
    : !files.length
      ? "Belum ada file"
      : source?.ok
        ? `${okFiles.length} file berhasil dibaca${failedFiles.length ? ` · ${failedFiles.length} gagal` : ""}${dupFiles.length ? ` · ${dupFiles.length} duplikat dilewati` : ""}`
        : "Gagal membaca file";

  const reset = () => {
    loadToken.current++;
    setFiles([]); setBusy(false); setPage(1);
  };

  // Menambah satu atau banyak file (file picker multi-pilih / Ctrl+A / drag & drop). Setiap file dibaca dengan parser yang sama.
  const handleFiles = async (picked: File[], replaceAll = false) => {
    if (!picked.length || busy) return;
    // HARIAN: tepat 1 file dan menggantikan file sebelumnya; banyak file dialihkan ke mode BULANAN.
    if (!monthly && picked.length > 1) { onMultiple(picked); return; }
    const base: PlataranFileEntry[] = monthly && !replaceAll ? files : [];
    const token = ++loadToken.current;
    setBusy(true);
    const added: PlataranFileEntry[] = [];
    const replaced = new Set<number>();
    for (const file of picked) {
      const entryId = ++fileIdRef.current;
      if (!/\.xlsx$/i.test(file.name)) {
        const message = "Format file harus .xlsx.";
        added.push({ id: entryId, name: file.name, size: file.size, fingerprint: null, state: "gagal", source: failPlataranSource(file.name, message), message });
        continue;
      }
      let buffer: ArrayBuffer;
      try { buffer = await file.arrayBuffer(); } catch {
        const message = "File tidak dapat dibaca.";
        added.push({ id: entryId, name: file.name, size: file.size, fingerprint: null, state: "gagal", source: failPlataranSource(file.name, message), message });
        continue;
      }
      const fingerprint = await fingerprintBuffer(buffer);
      const probes = [...base, ...added].map((f) => ({ id: f.id, name: f.name, fingerprint: f.fingerprint, usable: f.state === "ok" }));
      const dup = findDuplicate(probes, file.name, fingerprint);
      if (dup) {
        added.push({ id: entryId, name: file.name, size: file.size, fingerprint, state: "duplikat", source: null, duplicateOf: dup.id, message: `Duplikat dari ${dup.name} (nama atau isi sama); tidak dihitung ulang.` });
        continue;
      }
      base.forEach((f) => { if (f.state === "gagal" && f.name.toLowerCase() === file.name.toLowerCase()) replaced.add(f.id); });
      let parsed: PlataranSource;
      try {
        parsed = parseHotelPlataranWorkbook(buffer, file.name);
      } catch {
        parsed = failPlataranSource(file.name, "Terjadi kesalahan saat membaca file.");
      }
      added.push(parsed.ok
        ? { id: entryId, name: file.name, size: file.size, fingerprint, state: "ok", source: parsed }
        : { id: entryId, name: file.name, size: file.size, fingerprint, state: "gagal", source: parsed, message: parsed.error });
    }
    if (token !== loadToken.current) return; // Clear ditekan saat membaca
    setFiles([...base.filter((f) => !replaced.has(f.id)), ...added]);
    setPage(1);
    setBusy(false);
  };

  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current || !initialFiles.length) return;
    startedRef.current = true; // cegah pemrosesan ganda (StrictMode)
    void handleFiles(initialFiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const removeFile = (fileId: number) => {
    if (busy) return;
    setFiles(files.filter((f) => f.id !== fileId && f.duplicateOf !== fileId));
    setPage(1);
  };
  const openPicker = (replaceAll: boolean) => { replaceRef.current = replaceAll; inputRef.current?.click(); };

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <SidebarBrand />
        <div className="sidebar-divider" />
        <nav className="sidebar-nav">
          <button className="nav-item" type="button" onClick={onBack}><ArrowLeft size={18} /><span>Kembali ke CEK UPL</span></button>
          <div className="nav-item is-active"><FileText size={18} /><span>CEK HOTEL PLATARAN</span></div>
        </nav>
        <div className="sidebar-footer"><div className="privacy-badge"><ShieldCheck size={16} /><div><strong>Local-first</strong><span>Data tidak keluar dari browser</span></div></div></div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <button className="button button-secondary compact" type="button" onClick={onBack}><ArrowLeft size={15} /> Kembali ke CEK UPL</button>
          <div className="breadcrumb"><span>CEK UPL</span><span>›</span><strong>CEK HOTEL PLATARAN</strong></div>
          <div className="status-chip"><span className="status-dot" /></div>
        </header>
        <div className="page-container">
          <section className="page-heading">
            <div>
              <h1>Cek <em>Hotel Plataran</em></h1>
              <p>{monthly ? "Upload banyak file Excel Plataran; tiap file berisi empat kategori (HOTEL, SYAILENDRA, PAMIRANTI, TERAS BROMO)." : "Upload satu file Excel Plataran; berisi empat kategori (HOTEL, SYAILENDRA, PAMIRANTI, TERAS BROMO)."}</p>
            </div>
            <div className="heading-meta">
              <span className="meta-label">CURRENT SOURCE</span>
              <strong>{fileName || "Belum ada file"}</strong>
              <span className="meta-subtitle">{ready ? `${num(summary.count)} record terbaca` : busy ? "Memproses file…" : "Menunggu file Excel"}</span>
            </div>
          </section>

          <section className="input-panel panel-surface">
            <div className="panel-heading">
              <div className="panel-title-wrap"><span className="section-number">01</span><div><h2>{monthly ? "Upload File Excel Hotel Plataran · Bulanan" : "Upload File Excel Hotel Plataran · Harian"}</h2><p>Tanggal diambil dari nama file.</p></div></div>
              {fileName && <span className="file-pill"><FileText size={15} />{fileName}</span>}
            </div>
            <PeriodSwitch period={period} onChange={onPeriod} />
            <div
              className={`drop-zone ${drag ? "is-dragging" : ""}`}
              onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={() => setDrag(false)}
              onDrop={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDrag(false); void handleFiles(Array.from(e.dataTransfer.files)); }}
            >
              <div className="upload-symbol"><Upload size={20} /></div>
              <strong>{drag ? "Lepaskan file Excel di sini" : monthly ? "Tarik banyak file Excel ke sini" : "Tarik satu file Excel ke sini"}</strong>
              <span>{monthly ? "Bisa pilih banyak file sekaligus (Ctrl + A di dialog)." : "Lebih dari satu file otomatis ke mode bulanan."}</span>
              <button className="button button-secondary" type="button" disabled={busy} onClick={() => openPicker(false)}><FileText size={16} /> {monthly ? "Pilih banyak file Excel" : "Pilih file Excel"}</button>
              <small>Sheet BODY EMAIL · kolom B = kategori / keterangan / no struk · kolom C = subtotal · nama file contoh: DRR_PLBR_300926- Tax.xlsx</small>
              <input
                ref={inputRef}
                type="file"
                multiple={monthly}
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                hidden
                onChange={(e: ChangeEvent<HTMLInputElement>) => { const replaceAll = replaceRef.current; replaceRef.current = false; void handleFiles(Array.from(e.target.files ?? []), replaceAll); e.target.value = ""; }}
              />
            </div>
            <div className="used-columns">
              <strong>Status: {status}</strong>
              {ready && source?.ok && stats && <>
                <span>✓ Sheet "{source.sheetName}" · {num(stats.validRows)} record valid (HOTEL {num(stats.hotelRows)} · SYAILENDRA {num(stats.syailendraRows)} · PAMIRANTI {num(stats.pamirantiRows)} · TERAS BROMO {num(stats.terasBromoRows)}) dari {num(stats.sourceRows)} baris sumber</span>
                <span>{skippedText ? `Tidak dihitung: ${skippedText}` : "Semua baris sumber dihitung"}</span>
              </>}
            </div>
            {files.length > 0 && (
              <div className="mapping-panel upl-audit-panel">
                <div className="eyebrow"><span className="eyebrow-line" /> {num(files.length)} FILE DIPILIH</div>
                <div className="excel-scroll" style={{ maxHeight: 320 }}>
                  <table>
                    <thead><tr><th>No</th><th>Nama file</th><th>Ukuran</th><th>Status</th><th>Hapus</th></tr></thead>
                    <tbody>
                      {files.map((f, i) => (
                        <tr key={f.id}>
                          <td>{i + 1}</td>
                          <td>{f.name}</td>
                          <td>{formatBytes(f.size)}</td>
                          <td>{f.state === "ok" && f.source?.ok ? `✓ berhasil · ${f.source.dates[0] ?? ""} · ${num(f.source.stats.validRows)} record${f.source.warnings.length ? ` · ⚠ ${f.source.warnings.length} peringatan` : ""}` : f.state === "duplikat" ? `⚠ dilewati: ${f.message}` : `✕ gagal: ${f.message ?? "tidak dapat dibaca"}`}</td>
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
              {monthly && files.length > 0 && <button className="button button-secondary compact" type="button" disabled={busy} onClick={() => openPicker(true)}><FileText size={14} /> Ganti semua file</button>}
              <button className="button button-ghost" type="button" onClick={reset}><Trash2 size={16} /> Clear</button>
            </div>
          </section>

          {busy && <div className="notice notice-success" role="status" aria-live="polite"><span className="notice-icon"><Info size={17} /></span>Membaca dan memproses file Excel…</div>}

          {!busy && source?.ok && incomplete && (
            <div className="notice notice-error"><span className="notice-icon"><AlertTriangle size={17} /></span>Hasil belum lengkap: {failedFiles.length} file gagal dibaca dan tidak ikut dihitung — {failedFiles.map((f) => `${f.name} (${f.message ?? "gagal"})`).join(" | ")}</div>
          )}

          {!busy && source && !source.ok && (
            <div className="notice notice-error"><span className="notice-icon"><AlertTriangle size={17} /></span>{source.error}</div>
          )}

          {!busy && !source && (
            <div style={{ margin: "18px 2px 0", padding: "12px 14px", border: "1px dashed var(--line-strong)", borderRadius: 6, fontSize: 12, color: "var(--muted)" }}>
              Upload file Excel untuk melihat ringkasan dan detail record.
            </div>
          )}

          {ready && source?.ok && stats && <>
            {(source.warnings.length > 0 || source.issues.length > 0 || duplicateNoStruk.size > 0 || months.length > 1) && (
              <div className="notice notice-warning" style={{ alignItems: "flex-start", flexDirection: "column", gap: 4 }}>
                {source.warnings.slice(0, WARNING_PREVIEW_LIMIT).map((w, i) => <span key={`w${i}`}>⚠ {w}</span>)}
                {source.warnings.length > WARNING_PREVIEW_LIMIT && <span>… dan {num(source.warnings.length - WARNING_PREVIEW_LIMIT)} peringatan lain.</span>}
                {source.issues.slice(0, ISSUE_PREVIEW_LIMIT).map((issue, i) => <span key={`i${i}`}>⚠ {issue.file} baris {issue.row}: {issue.message}</span>)}
                {source.issues.length > ISSUE_PREVIEW_LIMIT && <span>… dan {num(source.issues.length - ISSUE_PREVIEW_LIMIT)} masalah data lain.</span>}
                {duplicateNoStruk.size > 0 && <span>ℹ {num(duplicateNoStruk.size)} no struk muncul lebih dari sekali (label kategori yang sama bernilai angka lebih dari sekali di satu file). Data tidak digabung dan ditandai di kolom Catatan.</span>}
                {months.length > 1 && <span>ℹ File berasal dari {months.length} bulan berbeda: {months.join(", ")}.</span>}
              </div>
            )}

            <div className="metric-grid upl-metrics">
              <Metric label="Profil" value="PLATARAN (4 kategori)" small />
              <Metric label="File berhasil" value={num(okFiles.length)} />
              <Metric label="File gagal" value={num(failedFiles.length)} />
              <Metric label="Total record" value={num(summary.count)} />
              <Metric label="Total subtotal" value={formatPlataranMoney(summary.subtotal)} small />
              <Metric label="Total service charge" value={formatPlataranMoney(summary.service_charge)} small />
              <Metric label="Total discount" value={formatPlataranMoney(summary.discount)} small />
              <Metric label="Total DPP" value={formatPlataranMoney(summary.dpp)} small />
              <Metric label="Total tax" value={formatPlataranMoney(summary.tax)} small />
              <Metric label="Total transaksi" value={formatPlataranMoney(summary.total)} small />
            </div>

            <section className="excel-preview">
              <div className="section-heading">
                <div><div className="eyebrow"><span className="eyebrow-line" /> RINGKASAN PER KATEGORI</div><h2>HOTEL, SYAILENDRA, PAMIRANTI, dan TERAS BROMO</h2></div>
                <span className="result-count">{num(summary.count)} record · {num(stats.ignoredRows)} baris di luar kategori tidak dihitung</span>
              </div>
              <div className="excel-scroll">
                <table>
                  <thead><tr><th>Kategori</th><th>id_agent</th><th>record</th><th>subtotal</th><th>service_charge</th><th>discount</th><th>dpp</th><th>tax</th><th>total</th></tr></thead>
                  <tbody>
                    {PLATARAN_CATEGORIES.map((cat) => (
                      <tr key={cat}>
                        <td>{PLATARAN_CATEGORY_NAMES[cat]}</td>
                        <td>{PLATARAN_AGENT_IDS[cat]}</td>
                        <td>{num(byCategory[cat].count)}</td>
                        <td>{formatPlataranMoney(byCategory[cat].subtotal)}</td>
                        <td>{formatPlataranMoney(byCategory[cat].service_charge)}</td>
                        <td>{formatPlataranMoney(byCategory[cat].discount)}</td>
                        <td>{formatPlataranMoney(byCategory[cat].dpp)}</td>
                        <td>{formatPlataranMoney(byCategory[cat].tax)}</td>
                        <td>{formatPlataranMoney(byCategory[cat].total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="excel-preview">
              <div className="section-heading">
                <div><div className="eyebrow"><span className="eyebrow-line" /> 02 · DETAIL RECORD</div><h2>Detail record Plataran</h2></div>
                <span className="result-count">{num(shownRows.length)} record{categoryFilter === "ALL" ? "" : ` ${PLATARAN_CATEGORY_NAMES[categoryFilter]}`} · ringkasan dihitung dari seluruh data</span>
              </div>
              <div className="input-actions" style={{ justifyContent: "flex-start", gap: 8, marginBottom: 8 }}>
                {(["ALL", ...PLATARAN_CATEGORIES] as const).map((cat) => (
                  <button key={cat} type="button" className={`button compact ${categoryFilter === cat ? "button-secondary" : "button-ghost"}`} aria-pressed={categoryFilter === cat} onClick={() => { setCategoryFilter(cat); setPage(1); }}>
                    {cat === "ALL" ? `Semua (${num(rows.length)})` : `${PLATARAN_CATEGORY_NAMES[cat]} (${num(byCategory[cat].count)})`}
                  </button>
                ))}
              </div>
              <div className="excel-scroll">
                <table>
                  <thead><tr><th>No</th><th>File</th><th>Kategori</th><th>id_agent</th><th>no_struk</th><th>date_trans</th><th>subtotal</th><th>service_charge</th><th>discount</th><th>dpp</th><th>tax</th><th>total</th><th>keterangan</th><th>Catatan</th></tr></thead>
                  <tbody>
                    {visibleRows.map((row, index) => (
                      <tr key={`${row.filename}-${row.sourceRow}`}>
                        <td>{(safePage - 1) * PAGE_SIZE + index + 1}</td>
                        <td>{row.filename}</td>
                        <td>{PLATARAN_CATEGORY_NAMES[row.category]}</td>
                        <td>{row.id_agent}</td>
                        <td>{row.no_struk}</td>
                        <td>{row.date_trans}</td>
                        <td>{formatPlataranMoney(row.subtotal)}</td>
                        <td>{formatPlataranMoney(row.service_charge)}</td>
                        <td>{formatPlataranMoney(row.discount)}</td>
                        <td>{formatPlataranMoney(row.dpp)}</td>
                        <td>{formatPlataranMoney(row.tax)}</td>
                        <td>{formatPlataranMoney(row.total)}</td>
                        <td>{row.keterangan}</td>
                        <td>{[...row.notes, duplicateNoStruk.has(row.no_struk) ? "no struk ganda" : ""].filter(Boolean).join("; ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={safePage} pageSize={PAGE_SIZE} total={shownRows.length} onPage={setPage} />
            </section>
          </>}
        </div>
      </main>
    </div>
  );
}
