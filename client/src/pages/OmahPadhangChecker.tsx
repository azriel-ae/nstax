import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { ArrowLeft, FileText, ShieldCheck, Trash2, Upload } from "lucide-react";
import { formatOmahPadhangMoney, parseOmahPadhangZips, type OmahPadhangResult, type OmahPadhangZipStatus } from "@/lib/omahPadhangParser";
import { fileSignature, formatFileSize } from "@/lib/monthlyCommon";
import PeriodModeHost, { type PeriodModeProps } from "@/components/PeriodModeHost";
import { PeriodSwitch } from "@/components/MonthlyUploadParts";

type Props = { onBack: () => void };
type InnerProps = Props & PeriodModeProps;

const PAGE_SIZE = 100; // hanya membatasi tampilan; ringkasan selalu dari seluruh dataset

// Wrapper: mode HARIAN (1 ZIP) dan BULANAN (banyak ZIP) dipisah; parser dan perhitungan sama untuk keduanya.
export default function OmahPadhangChecker({ onBack }: Props) {
  return <PeriodModeHost render={(mode) => <OmahPadhangPanel onBack={onBack} {...mode} />} />;
}

function OmahPadhangPanel({ onBack, period, onPeriod, onMultiple, initialFiles }: InnerProps) {
  const monthly = period === "monthly";
  const [result, setResult] = useState<OmahPadhangResult | null>(null);
  const [zipFiles, setZipFiles] = useState<File[]>([]);
  const [zipStatus, setZipStatus] = useState<OmahPadhangZipStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [page, setPage] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const runToken = useRef(0); // hanya pemrosesan terbaru yang boleh menulis hasil

  const fileName = zipFiles.length === 0 ? "" : zipFiles.length === 1 ? zipFiles[0].name : `${zipFiles.length} file ZIP`;

  // Selalu memproses ULANG seluruh daftar ZIP dari nol, sehingga menambah/menghapus file tidak pernah menggandakan transaksi.
  const processAll = async (list: File[]) => {
    const token = ++runToken.current;
    setPage(0);
    if (!list.length) { setResult(null); setZipStatus([]); setBusy(false); return; }
    setBusy(true);
    setResult(null); // hasil lama disembunyikan selama pemrosesan
    try {
      const inputs = await Promise.all(list.map(async (file) => ({ name: file.name, data: await file.arrayBuffer() })));
      const out = await parseOmahPadhangZips(inputs);
      if (token !== runToken.current) return;
      setResult(out.result);
      setZipStatus(out.zips);
    } catch {
      if (token !== runToken.current) return;
      setResult({ ok: false, error: "Gagal membaca file.", zipName: list.map((f) => f.name).join(", "), zipExtracted: false, csvFound: 0, files: [], rows: [], issues: [], duplicateReceipts: 0, summary: { files: 0, count: 0, subtotal: 0, service_charge: 0, discount: 0, dpp: 0, tax: 0, total: 0 } });
      setZipStatus([]);
    } finally {
      if (token === runToken.current) setBusy(false);
    }
  };

  // HARIAN: tepat 1 ZIP; file baru menggantikan yang lama. Bila banyak ZIP dipilih, dialihkan ke mode BULANAN.
  // BULANAN: menambah file ke daftar (pilih banyak / Ctrl+A / drag & drop); file identik (nama+ukuran+tanggal ubah) tidak ditambahkan dua kali.
  const handleFiles = (picked: File[]) => {
    if (!picked.length) return;
    if (!monthly) {
      if (picked.length > 1) { onMultiple(picked); return; }
      setZipFiles(picked);
      void processAll(picked);
      return;
    }
    const known = new Set(zipFiles.map(fileSignature));
    const fresh = picked.filter((f) => { const k = fileSignature(f); if (known.has(k)) return false; known.add(k); return true; });
    if (!fresh.length) return;
    const next = [...zipFiles, ...fresh];
    setZipFiles(next);
    void processAll(next);
  };
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current || !initialFiles.length) return;
    startedRef.current = true; // cegah pemrosesan ganda (StrictMode)
    handleFiles(initialFiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const removeFile = (index: number) => { const next = zipFiles.filter((_, i) => i !== index); setZipFiles(next); void processAll(next); };
  const clearAll = () => { setZipFiles([]); void processAll([]); };

  const rows = result?.rows ?? [];
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const money = formatOmahPadhangMoney;
  const flagged = rows.filter((row) => row.issues.length).length;
  const invalidTotal = result?.files.reduce((sum, f) => sum + f.invalidRows, 0) ?? 0;
  const status = busy ? "Mengekstrak ZIP…" : !result ? "Belum ada file" : result.zipExtracted ? (zipFiles.length > 1 ? `${zipStatus.filter((z) => z.status === "processed").length} dari ${zipFiles.length} ZIP berhasil diproses` : "ZIP berhasil diekstrak") : "Gagal mengekstrak ZIP";

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="brand-lockup"><div className="brand-mark"><span>α</span></div><div><div className="brand-name">nstax</div><div className="brand-caption">transaction intelligence</div></div></div>
        <div className="sidebar-divider" />
        <nav className="sidebar-nav">
          <button className="nav-item" type="button" onClick={onBack}><ArrowLeft size={18} /><span>Kembali ke CEK UPL</span></button>
          <div className="nav-item is-active"><FileText size={18} /><span>CEK OMAH PADHANG</span></div>
        </nav>
        <div className="sidebar-footer"><div className="privacy-badge"><ShieldCheck size={16} /><div><strong>Local-first</strong><span>Data tidak keluar dari browser</span></div></div></div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <button className="button button-secondary compact" type="button" onClick={onBack}><ArrowLeft size={15} /> Kembali ke CEK UPL</button>
          <div className="breadcrumb"><span>CEK UPL</span><span>›</span><strong>CEK OMAH PADHANG</strong></div>
          <div className="status-chip"><span className="status-dot" /></div>
        </header>
        <div className="page-container">
          <section className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> CEK OMAH PADHANG · ZIP CSV · {monthly ? "BULANAN" : "HARIAN"}</div>
              <h1>Periksa transaksi<br /><em>Omah Padhang.</em></h1>
              <p>{monthly ? "Mode bulanan: upload banyak file ZIP laporan transaksi (misalnya satu ZIP per hari dalam satu bulan). Seluruh CSV di dalamnya diekstrak, dibaca berdasarkan header, digabung, lalu dihitung." : "Mode harian: upload satu file ZIP laporan transaksi. Seluruh CSV di dalamnya diekstrak, dibaca berdasarkan header, lalu dihitung."}</p>
            </div>
            <div className="heading-meta"><span className="meta-label">CURRENT SOURCE</span><strong>{fileName || "Belum ada file"}</strong><span className="meta-subtitle">{result?.ok ? `${result.rows.length} transaksi terbaca` : "Menunggu ZIP"}</span></div>
          </section>

          <section className="input-panel panel-surface">
            <div className="panel-heading">
              <div className="panel-title-wrap"><span className="section-number">01</span><div><h2>{monthly ? "Upload ZIP Omah Padhang · Bulanan" : "Upload ZIP Omah Padhang · Harian"}</h2><p>{monthly ? "Banyak ZIP; setiap ZIP harus berisi CSV laporan transaksi (delimiter koma)." : "Satu ZIP berisi CSV laporan transaksi (delimiter koma). File baru menggantikan file sebelumnya."}</p></div></div>
              {fileName && <span className="file-pill"><FileText size={15} />{fileName}</span>}
            </div>
            <PeriodSwitch period={period} onChange={onPeriod} />
            <div
              className={`drop-zone ${drag ? "is-dragging" : ""}`}
              onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={() => setDrag(false)}
              onDrop={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDrag(false); handleFiles(Array.from(e.dataTransfer.files)); }}
            >
              <div className="upload-symbol"><Upload size={20} /></div>
              <strong>{drag ? "Lepaskan file ZIP di sini" : monthly ? "Pilih banyak file ZIP" : "Pilih satu file ZIP"}</strong>
              <span>{monthly ? "Semua CSV di dalam semua ZIP diproses dan digabung. Di dialog pilih file, tekan Ctrl+A (setelah dialog aktif) untuk memilih semua file." : "Semua CSV di dalam ZIP diproses dan digabung. Jika Anda memilih lebih dari satu ZIP, tampilan otomatis pindah ke mode bulanan."}</span>
              <button className="button button-secondary" type="button" disabled={busy} onClick={() => inputRef.current?.click()}><FileText size={16} /> {monthly ? "Pilih banyak file ZIP" : "Pilih file ZIP"}</button>
              <small>Kolom dibaca dari header: Date, Time, Discounts, Net Sales, Gratuity, Tax, Total Amount, Receipt Number, Items</small>
              <input ref={inputRef} type="file" multiple={monthly} accept=".zip,application/zip,application/x-zip-compressed" hidden onChange={(event: ChangeEvent<HTMLInputElement>) => { handleFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
            </div>
            <div className="used-columns">
              <strong>Status: {status}</strong>
              {result && <span>{result.zipExtracted ? "✓" : "✗"} Ekstraksi ZIP · {result.csvFound} file CSV ditemukan · {result.rows.length.toLocaleString("id-ID")} transaksi berhasil dibaca</span>}
              {result?.files.map((file) => <span key={file.filename}>{file.status === "processed" ? "✓" : file.status === "duplicate" ? "↺" : "✗"} {file.filename}{file.status === "processed" ? ` — ${file.transactions} transaksi${file.invalidRows ? `, ${file.invalidRows} baris tidak valid` : ""}${file.summaryRowsSkipped ? `, ${file.summaryRowsSkipped} baris ringkasan dilewati` : ""}` : file.message ? ` — ${file.message}` : ""}</span>)}
            </div>
            {zipFiles.length > 0 && (
              <div className="mapping-panel upl-audit-panel">
                <div className="eyebrow"><span className="eyebrow-line" /> {zipFiles.length.toLocaleString("id-ID")} FILE ZIP DIPILIH</div>
                <div className="excel-scroll" style={{ maxHeight: 320 }}>
                  <table>
                    <thead><tr><th>No</th><th>Nama file</th><th>Ukuran</th><th>Status</th><th>Hapus</th></tr></thead>
                    <tbody>
                      {zipFiles.map((file, index) => {
                        const st = zipStatus.find((z) => z.zipName === file.name);
                        const text = busy ? "⏳ diproses..." : !st ? "• menunggu" : st.status === "processed" ? `✓ berhasil · ${st.csvFound} CSV · ${st.transactions.toLocaleString("id-ID")} transaksi` : st.status === "skipped" ? `⚠ dilewati: ${st.message}` : `✕ gagal: ${st.message ?? "tidak dapat diproses"}`;
                        return (
                          <tr key={`${index}-${file.name}`}>
                            <td>{index + 1}</td><td>{file.name}</td><td>{formatFileSize(file.size)}</td><td>{text}</td>
                            <td><button className="button button-ghost compact" type="button" disabled={busy} onClick={() => removeFile(index)} aria-label={`Hapus ${file.name}`}>✕ Hapus</button></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="input-actions">
                  <span className="privacy-note">Total ukuran: {formatFileSize(zipFiles.reduce((sum, f) => sum + f.size, 0))}</span>
                  <button className="button button-ghost compact" type="button" disabled={busy} onClick={clearAll}><Trash2 size={14} /> Kosongkan daftar</button>
                </div>
              </div>
            )}
            <div className="privacy-note"><ShieldCheck size={15} /> Diproses lokal di browser</div>
          </section>

          {result && !result.ok && <div className="notice notice-error">{result.error}</div>}

          {result?.ok && <>
            <div className="metric-grid upl-metrics">
              <div className="metric-card"><span className="metric-label">File CSV diproses</span><strong className="metric-value">{result.summary.files}</strong></div>
              <div className="metric-card"><span className="metric-label">Total transaksi</span><strong className="metric-value">{result.summary.count.toLocaleString("id-ID")}</strong></div>
              <div className="metric-card"><span className="metric-label">Total subtotal</span><strong className="metric-value">{money(result.summary.subtotal)}</strong></div>
              <div className="metric-card"><span className="metric-label">Total service charge</span><strong className="metric-value">{money(result.summary.service_charge)}</strong></div>
              <div className="metric-card"><span className="metric-label">Total discount</span><strong className="metric-value">{money(result.summary.discount)}</strong></div>
              <div className="metric-card"><span className="metric-label">Total DPP</span><strong className="metric-value">{money(result.summary.dpp)}</strong></div>
              <div className="metric-card"><span className="metric-label">Total tax</span><strong className="metric-value">{money(result.summary.tax)}</strong></div>
              <div className="metric-card"><span className="metric-label">Total total</span><strong className="metric-value">{money(result.summary.total)}</strong></div>
            </div>
            {invalidTotal > 0 && <div className="notice notice-warning">{invalidTotal} baris tidak valid dilewati: {result.issues.filter((i) => i.row !== null).slice(0, 5).map((i) => `${i.filename} baris ${i.row}: ${i.message}`).join(" | ")}{invalidTotal > 5 ? " …" : ""}</div>}
            {result.duplicateReceipts > 0 && <div className="notice notice-warning">{result.duplicateReceipts} nomor struk muncul lebih dari sekali (data tetap dipertahankan, ditandai di tabel).</div>}
            {flagged > 0 && result.duplicateReceipts === 0 && <div className="notice notice-warning">{flagged} baris perlu diperiksa (lihat kolom Catatan).</div>}

            <section className="excel-preview">
              <div className="section-heading">
                <div><div className="eyebrow"><span className="eyebrow-line" /> 02 · DATASET PENUH</div><h2>Detail transaksi Omah Padhang</h2></div>
                <span className="result-count">{rows.length.toLocaleString("id-ID")} baris · ringkasan dihitung dari seluruh data</span>
              </div>
              <div className="excel-scroll">
                <table>
                  <thead><tr><th>No</th><th>Filename</th><th>ID Agent</th><th>No Struk</th><th>Date Trans</th><th>Subtotal</th><th>Service Charge</th><th>Discount</th><th>DPP</th><th>Tax</th><th>Total</th><th>Keterangan</th><th>Catatan</th></tr></thead>
                  <tbody>
                    {pageRows.map((row, index) => (
                      <tr key={`${row.filename}-${row.sourceRow}-${index}`}>
                        <td>{page * PAGE_SIZE + index + 1}</td>
                        <td>{row.filename}</td>
                        <td>{row.id_agent}</td>
                        <td>{row.no_struk || "—"}</td>
                        <td>{row.date_trans}</td>
                        <td>{money(row.subtotal)}</td>
                        <td>{money(row.service_charge)}</td>
                        <td>{money(row.discount)}</td>
                        <td>{money(row.dpp)}</td>
                        <td>{money(row.tax)}</td>
                        <td>{money(row.total)}</td>
                        <td>{row.keterangan}</td>
                        <td>{row.issues.join("; ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {pageCount > 1 && (
                <div className="section-heading">
                  <button className="button button-secondary compact" type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>← Sebelumnya</button>
                  <span className="result-count">Halaman {page + 1} / {pageCount}</span>
                  <button className="button button-secondary compact" type="button" disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)}>Berikutnya →</button>
                </div>
              )}
            </section>
          </>}
        </div>
      </main>
    </div>
  );
}
