import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import * as XLSX from "xlsx";
import { AlertTriangle, ArrowLeft, CheckCircle2, Copy, Download, FileText, RotateCcw, Search, ShieldCheck, X } from "lucide-react";
import { FileReadError, openSourceExact, sniffFormat } from "@/lib/compare/compareTable";
import {
  allUnmatchedText, buildExportWorkbook, compareEsbVsFile, consistencyErrors, readEsb, readFile, unmatchedToText,
  type EsbVsFileResult, type SideRead, type Unmatched,
} from "@/lib/compare/esbVsFile";
import { SidebarBrand } from "@/components/BrandLogo";

// Mode ESB vs File — halaman terpisah dari Compare 2 File (tidak berbagi state/engine dengan ReceiptCompareChecker).

type Props = { onBack: () => void };
type Side = "esb" | "file";
type Slot = { phase: "empty" | "loading" | "ready" | "error"; fileName: string; size: number; format: string; read: SideRead | null; error: string };
type CopyKey = "all" | "notInEsb" | "notInFile";

const EMPTY: Slot = { phase: "empty", fileName: "", size: 0, format: "", read: null, error: "" };
const ACCEPT = ".xlsx,.xls,.csv,.tsv,.txt,.json,text/*,application/json";
const PAGE = 100;
const fmtInt = (n: number) => n.toLocaleString("id-ID");
const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);
const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

export default function EsbVsFileChecker({ onBack }: Props) {
  const [slots, setSlots] = useState<Record<Side, Slot>>({ esb: EMPTY, file: EMPTY });
  const [dragging, setDragging] = useState<Side | null>(null);
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState<{ notInEsb: boolean; notInFile: boolean }>({ notInEsb: false, notInFile: false });
  const [copied, setCopied] = useState<CopyKey | null>(null);
  const [copyFailed, setCopyFailed] = useState<CopyKey | null>(null);
  const inputs = useRef<Record<Side, HTMLInputElement | null>>({ esb: null, file: null });
  const tokens = useRef<Record<Side, number>>({ esb: 0, file: 0 });

  const esbRead = slots.esb.phase === "ready" ? slots.esb.read : null;
  const fileRead = slots.file.phase === "ready" ? slots.file.read : null;
  const result: EsbVsFileResult | null = useMemo(() => (esbRead && fileRead ? compareEsbVsFile(esbRead, fileRead) : null), [esbRead, fileRead]);
  const problems = useMemo(() => (result ? consistencyErrors(result) : []), [result]);

  const loadFile = async (side: Side, file?: File) => {
    if (!file) return;
    const token = ++tokens.current[side];
    const base: Slot = { ...EMPTY, phase: "loading", fileName: file.name, size: file.size, format: (file.name.split(".").pop() ?? "").toUpperCase() };
    setSlots((cur) => ({ ...cur, [side]: base }));
    setSearch(""); setShowAll({ notInEsb: false, notInFile: false });
    await nextPaint();
    try {
      const buffer = await file.arrayBuffer();
      if (token !== tokens.current[side]) return;
      if (sniffFormat(buffer) === "pdf") throw new FileReadError("File PDF tidak didukung pada mode ESB vs File. Gunakan Excel (XLSX/XLS), CSV, TXT, atau JSON.");
      const source = await openSourceExact(buffer, file.name);
      if (token !== tokens.current[side]) return;
      const read = side === "esb" ? readEsb(source) : readFile(source);
      setSlots((cur) => ({ ...cur, [side]: { ...base, phase: "ready", read } }));
    } catch (err) {
      if (token !== tokens.current[side]) return;
      setSlots((cur) => ({ ...cur, [side]: { ...base, phase: "error", error: err instanceof FileReadError ? err.message : `File tidak dapat dibaca: ${err instanceof Error ? err.message : String(err)}` } }));
    }
  };
  const removeFile = (side: Side) => {
    tokens.current[side]++;
    setSlots((cur) => ({ ...cur, [side]: EMPTY }));
    if (inputs.current[side]) inputs.current[side]!.value = "";
  };
  const resetAll = () => { removeFile("esb"); removeFile("file"); setSearch(""); setShowAll({ notInEsb: false, notInFile: false }); };

  const copyText = async (key: CopyKey, text: string) => {
    if (!text) return;
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch { /* lanjut ke cara cadangan */ }
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch { ok = false; }
    }
    setCopied(ok ? key : null); setCopyFailed(ok ? null : key);
    setTimeout(() => { setCopied(null); setCopyFailed(null); }, 2500);
  };

  const exportExcel = () => {
    if (!result || !esbRead || !fileRead) return;
    const wb = buildExportWorkbook(result, { esb: esbRead.fileName, file: fileRead.fileName });
    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `hasil-esb-vs-file-${stamp}.xlsx`);
  };

  const q = search.trim().toLowerCase();
  const filterList = (list: Unmatched[]) => (q ? list.filter((u) => u.value.toLowerCase().includes(q)) : list);

  const slotCard = (side: Side) => {
    const s = slots[side];
    const title = side === "esb" ? "FILE ESB" : "FILE PEMBANDING";
    const need = side === "esb" ? "kolom Bill Number dan Sales Number" : "kolom no_struk";
    const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
    const r = s.read;
    return (
      <div
        role="button" tabIndex={0}
        className={`cmp2-slot ${dragging === side ? "is-dragging" : ""} ${s.phase === "ready" ? "is-ready" : s.phase === "error" ? "is-error" : s.phase === "loading" ? "is-loading" : ""}`}
        onClick={() => inputs.current[side]?.click()}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); inputs.current[side]?.click(); } }}
        onDragEnter={(e) => { e.preventDefault(); if (e.dataTransfer.types.includes("Files")) setDragging(side); }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
        onDragLeave={(e) => { e.preventDefault(); if (e.currentTarget.contains(e.relatedTarget as Node | null)) return; setDragging(null); }}
        onDrop={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragging(null); void loadFile(side, e.dataTransfer.files?.[0]); }}
      >
        <span className="cmp2-slot-title">{title}</span>
        {s.phase === "empty" && <><strong style={{ fontSize: 16 }}>{dragging === side ? "LEPAS FILE DI SINI" : "Seret file ke sini"}</strong><span className="mode-card-hint">atau klik untuk memilih · XLSX, XLS, CSV, TXT, JSON · harus memiliki {need}</span></>}
        {s.phase === "loading" && <><span className="cmp2-name">{s.fileName}</span><span className="mode-card-hint" role="status">Membaca seluruh isi file…</span></>}
        {(s.phase === "ready" || s.phase === "error") && (
          <>
            <span className="cmp2-name">{s.phase === "ready" ? "✓ " : "✕ "}{s.fileName}</span>
            <span className="cmp2-meta"><span>{s.format}</span><span>{fmtSize(s.size)}</span></span>
            <strong style={{ fontSize: 12, color: s.phase === "error" ? "var(--danger)" : r && (r.skipped.length > 0 || r.warnings.length > 0) ? "var(--warning)" : "var(--success)" }}>
              {s.phase === "error" ? "Gagal dibaca" : r && (r.skipped.length > 0 || r.warnings.length > 0) ? "Dibaca dengan peringatan" : "Berhasil dibaca"}
            </strong>
            {s.phase === "error" && <span style={{ fontSize: 12, color: "var(--danger)" }}>{s.error}</span>}
            {r && (
              <div className="cmp3-read">
                <div><b>{fmtInt(r.items.length)}</b> baris valid dari <b>{fmtInt(r.rowsRead)}</b> baris data terbaca</div>
                <div>Header di baris {r.headerRow}{r.sheet ? ` · worksheet "${r.sheet}"` : ""}</div>
                <div>{r.blankRows > 0 ? `${fmtInt(r.blankRows)} baris kosong diabaikan. ` : ""}{r.skipped.length > 0 ? `${fmtInt(r.skipped.length)} baris tidak valid dilewati.` : "Tidak ada baris tidak valid."}</div>
                {r.skipped.length > 0 && (
                  <details className="cmp3-details" onClick={stop} onKeyDown={stop}>
                    <summary>Lihat baris yang dilewati</summary>
                    <div style={{ fontSize: 11, lineHeight: 1.6 }}>{r.skipped.slice(0, 50).map((x) => <div key={x.row}>Baris {x.row}: {x.reason}{x.detail ? ` (${x.detail})` : ""}</div>)}{r.skipped.length > 50 && <div>… dan {fmtInt(r.skipped.length - 50)} baris lain.</div>}</div>
                  </details>
                )}
              </div>
            )}
            {r?.warnings.map((w) => <span key={w} style={{ fontSize: 11, color: "var(--warning)" }}>⚠ {w}</span>)}
          </>
        )}
        <span className="cmp-drop-actions" onClick={stop}>
          <button className="button button-secondary compact" type="button" disabled={s.phase === "loading"} onClick={() => inputs.current[side]?.click()}>{s.phase === "empty" ? "Pilih File" : "Ganti File"}</button>
          {s.phase !== "empty" && <button className="button button-ghost compact" type="button" onClick={() => removeFile(side)}><X size={13} /> Hapus</button>}
        </span>
        <input ref={(el) => { inputs.current[side] = el; }} type="file" accept={ACCEPT} hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { void loadFile(side, e.target.files?.[0]); e.target.value = ""; }} />
      </div>
    );
  };

  const copyBtn = (key: CopyKey, label: string, text: string) => (
    <button className="button button-secondary compact" type="button" disabled={!text} onClick={() => void copyText(key, text)}><Copy size={13} /> {copied === key ? "Tersalin ✓" : label}</button>
  );

  const table = (kind: "notInEsb" | "notInFile", title: string, hint: string, list: Unmatched[], withParts: boolean) => {
    const rows = filterList(list);
    const shown = showAll[kind] ? rows : rows.slice(0, PAGE);
    return (
      <section className="excel-preview" style={{ marginTop: 18 }} aria-label={title}>
        <div className="section-heading">
          <div><h2>{title}</h2><span>{hint}</span></div>
          <div className="section-actions">{copyBtn(kind, "Salin daftar", unmatchedToText(list))}</div>
        </div>
        {copyFailed === kind && <div className="notice notice-warning" style={{ margin: "0 16px 12px" }}>Browser menolak menyalin. Izinkan akses clipboard.</div>}
        {list.length === 0 ? <div className="notice notice-success" style={{ margin: 16 }}><CheckCircle2 size={15} /> Tidak ada data.</div> : (
          <>
            <div className="excel-scroll"><table className="cmp-table">
              <thead><tr><th className="numeric">NO</th><th>{withParts ? "BILL NUMBER + SALES NUMBER" : "NO_STRUK"}</th><th className="numeric">BARIS</th><th>KETERANGAN</th></tr></thead>
              <tbody>
                {shown.map((u, i) => (
                  <tr key={`${u.row}-${i}`}>
                    <td className="numeric">{fmtInt(i + 1)}</td>
                    <td className="cmp-number">{u.value}{withParts && u.bill !== undefined && <small className="cmp-sub">Bill: {u.bill} · Sales: {u.sales}</small>}</td>
                    <td className="numeric">{fmtInt(u.row)}</td>
                    <td><small className="cmp-note">{u.total > 1 ? `Duplikat: kemunculan ke-${u.occurrence} dari ${u.total}, tidak ada pasangan` : "Tidak ada pasangan"}</small></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
            <div className="cmp-pager">
              <span className="result-count">Menampilkan {fmtInt(shown.length)} dari {fmtInt(rows.length)}{q ? ` (hasil pencarian; total ${fmtInt(list.length)})` : ""}</span>
              {rows.length > PAGE && <button className="button button-secondary compact" type="button" onClick={() => setShowAll((s) => ({ ...s, [kind]: !s[kind] }))}>{showAll[kind] ? `Tampilkan ${PAGE} pertama` : "Tampilkan semua"}</button>}
            </div>
          </>
        )}
      </section>
    );
  };

  const statusLine = !slots.esb.fileName && !slots.file.fileName ? "Belum ada file. Pilih File ESB dan File Pembanding."
    : slots.esb.phase === "loading" || slots.file.phase === "loading" ? "Membaca file…"
    : slots.esb.phase === "error" || slots.file.phase === "error" ? "Ada file yang gagal dibaca. Perbaiki file lalu unggah ulang."
    : !esbRead ? "File Pembanding sudah dimuat. Pilih File ESB."
    : !fileRead ? "File ESB sudah dimuat. Pilih File Pembanding."
    : "Kedua file siap. Hasil perbandingan ada di bawah.";

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <SidebarBrand />
        <div className="sidebar-divider" />
        <nav className="sidebar-nav">
          <button className="nav-item" type="button" onClick={onBack}><ArrowLeft size={18} /><span>Kembali ke Beranda</span></button>
          <div className="nav-item is-active"><FileText size={18} /><span>ESB VS FILE</span></div>
        </nav>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <button className="button button-secondary compact" type="button" onClick={onBack}><ArrowLeft size={15} /> Kembali ke Beranda</button>
          <div className="breadcrumb"><span>BERANDA</span><span>›</span><strong>ESB VS FILE</strong></div>
          <div className="status-chip"><span className="status-dot" /></div>
        </header>
        <div className="page-container">
          <section className="page-heading">
            <div>
              <h1>ESB <em>vs File</em></h1>
              <p>Cocokkan <code>Bill Number - Sales Number</code> dari file ESB dengan kolom <code>no_struk</code> pada file pembanding. Diproses lokal di browser.</p>
            </div>
          </section>

          <section className="input-panel panel-surface">
            <div className="panel-heading"><div className="panel-title-wrap"><span className="section-number">01</span><div><h2>Upload file</h2><p>Header dicari otomatis berdasarkan nama kolom, di baris dan kolom mana pun. Pencocokan exact (hanya spasi di awal/akhir yang dipangkas); jumlah kemunculan duplikat ikut dihitung.</p></div></div></div>
            <div className="cmp2-slots">{slotCard("esb")}{slotCard("file")}</div>
            <div className="privacy-note" style={{ marginTop: 12 }}><ShieldCheck size={15} /> File asli tidak diubah · proses lokal</div>
            <div className="cmp-actions" style={{ paddingTop: 12 }}>
              <span className="result-count" role="status">{statusLine}</span>
              <button className="button button-secondary" type="button" onClick={resetAll}><RotateCcw size={14} /> Reset</button>
            </div>
          </section>

          {result && esbRead && fileRead && (
            <>
              {problems.length > 0 && <div className="notice notice-error" style={{ marginTop: 18 }}><AlertTriangle size={17} /> Jumlah hasil tidak konsisten dengan data yang diproses: {problems.join("; ")}.</div>}
              <section className="cmp-summary" aria-label="Ringkasan hasil" style={{ marginTop: 18 }}>
                <div className="panel-title-wrap" style={{ marginBottom: 4 }}><span className="section-number">02</span><div><h2 style={{ margin: 0 }}>Ringkasan</h2></div></div>
                <div className="cmp2-cards cmp3-cards">
                  <div className="cmp-card"><span className="cmp-card-title">Data valid ESB</span><strong>{fmtInt(result.esbValid)}</strong><small>Bill Number + Sales Number</small></div>
                  <div className="cmp-card"><span className="cmp-card-title">Data valid File</span><strong>{fmtInt(result.fileValid)}</strong><small>Baris no_struk terisi</small></div>
                  <div className="cmp-card is-same"><span className="cmp-card-title">Transaksi cocok</span><strong>{fmtInt(result.matched)}</strong><small>Exact match</small></div>
                  <div className="cmp-card is-missing"><span className="cmp-card-title">Tidak ditemukan di ESB</span><strong>{fmtInt(result.notInEsb.length)}</strong><small>Ada di file, tidak ada di ESB</small></div>
                  <div className="cmp-card is-missing"><span className="cmp-card-title">Tidak ditemukan di File</span><strong>{fmtInt(result.notInFile.length)}</strong><small>Ada di ESB, tidak ada di file</small></div>
                  <div className="cmp-card is-dup"><span className="cmp-card-title">Duplikat</span><strong>{fmtInt(result.esbDuplicates.length + result.fileDuplicates.length)}</strong><small>ESB: {fmtInt(result.esbDuplicates.length)} · File: {fmtInt(result.fileDuplicates.length)} nomor unik</small></div>
                </div>
                {(result.esbDuplicates.length > 0 || result.fileDuplicates.length > 0) && (
                  <details className="cmp3-details" style={{ marginTop: 12 }}>
                    <summary>Detail nomor duplikat</summary>
                    <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                      {result.esbDuplicates.map((d) => <div key={`e-${d.value}`}>ESB · <code>{d.value}</code> muncul {d.count}× (baris {d.rows.join(", ")})</div>)}
                      {result.fileDuplicates.map((d) => <div key={`f-${d.value}`}>File · <code>{d.value}</code> muncul {d.count}× (baris {d.rows.join(", ")})</div>)}
                    </div>
                  </details>
                )}
                {result.matched === 0 && result.esbValid > 0 && result.fileValid > 0 && <div className="notice notice-warning" style={{ marginTop: 12 }}><AlertTriangle size={15} /> Tidak ada nomor yang cocok. Periksa apakah kedua file berasal dari periode/outlet yang sama.</div>}
                <div className="cmp-actions" style={{ paddingTop: 14 }}>
                  {copyBtn("all", "Salin semua yang tidak cocok", allUnmatchedText(result))}
                  {copyBtn("notInEsb", "Salin Tidak Ditemukan di ESB", unmatchedToText(result.notInEsb))}
                  {copyBtn("notInFile", "Salin Tidak Ditemukan di File", unmatchedToText(result.notInFile))}
                  <button className="button button-primary" type="button" onClick={exportExcel}><Download size={14} /> Export Excel</button>
                  {(copyFailed === "all") && <small className="cmp-sub" style={{ color: "var(--danger)" }}>Browser menolak menyalin. Izinkan akses clipboard atau gunakan Export Excel.</small>}
                </div>
              </section>

              <div className="cmp-toolbar" style={{ marginTop: 18 }}>
                <label className="cmp-search"><Search size={14} /><input type="search" value={search} placeholder="Cari nomor struk pada daftar di bawah..." onChange={(e) => setSearch(e.target.value)} /></label>
              </div>
              {table("notInEsb", "A. Tidak Ditemukan di ESB", "Ada di file pembanding (no_struk) tetapi tidak punya pasangan pada hasil gabungan Bill Number + Sales Number ESB.", result.notInEsb, false)}
              {table("notInFile", "B. Tidak Ditemukan di File", "Hasil gabungan Bill Number + Sales Number dari ESB yang tidak punya pasangan pada kolom no_struk file pembanding.", result.notInFile, true)}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
