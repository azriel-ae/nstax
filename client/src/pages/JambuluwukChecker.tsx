import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { ArrowLeft, CheckCircle2, Eraser, FileText, Play, RotateCcw, Save, ShieldCheck, Trash2, Upload, Wand2 } from "lucide-react";
import {
  formatJambuluwukMoney,
  parseJambuluwukWorkbook,
  type JambuluwukSource,
} from "@/lib/jambuluwukParser";
import {
  DEFAULT_QUERIES,
  initialQuery,
  JAMBULUWUK_PROFILES,
  PROFILE_LABEL,
  resetQuery,
  registryForSources,
  runProfileQueryMulti,
  saveQuery,
  type JambuluwukProfile,
  type StoredQuery,
} from "@/lib/jambuluwukQueries";
import {
  formatSql,
  isDec,
  locate,
  SqlError,
  sumResultColumn,
  validateSql,
  valueToString,
  type Value,
} from "@/lib/jambuluwukSql";
import { isMetadataStatement, runMetadata, validateStatement, type MetaResult } from "@/lib/jambuluwukMeta";
import { findDuplicate, fingerprintBuffer, formatBytes } from "@/lib/multiFile";
import { deriveView, finishRun, IDLE, startRun, type Failure, type RunInputs, type RunPhase } from "@/lib/jambuluwukRunState";

type Props = { onBack: () => void };

const PAGE_SIZE = 100; // hanya membatasi tampilan; ringkasan selalu dari seluruh hasil query

type FileEntry = {
  id: number;
  name: string;
  size: number;
  fingerprint: string | null;
  state: "ok" | "gagal" | "duplikat";
  source: JambuluwukSource | null;
  message?: string;
  duplicateOf?: number;
};

type MetaState = { sql: string; result: MetaResult | null; error: Failure | null };
type Note = { kind: "success" | "error"; text: string; warnings?: string[]; failure?: Failure } | null;

const toFailure = (err: unknown, sql: string): Failure =>
  err instanceof SqlError
    ? { message: err.message, pos: err.pos, length: err.length, row: err.row, sql }
    : { message: `Terjadi kesalahan tak terduga saat memproses query: ${err instanceof Error ? err.message : String(err)}`, pos: null, length: 1, row: null, sql };

/** Angka desimal eksak → format id-ID tanpa melalui floating point. */
const formatDecimalText = (plain: string): string => {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(plain);
  if (!m) return plain;
  const int = m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${m[1]}${int}${m[3] ? `,${m[3]}` : ""}`;
};
const formatCell = (v: Value): string => (v === null ? "NULL" : isDec(v) ? formatDecimalText(valueToString(v)) : valueToString(v));

const SUMMARY_COLUMNS: Array<[string, string]> = [
  ["subtotal", "Total subtotal"],
  ["dpp", "Total DPP"],
  ["discount", "Total discount"],
  ["service_charge", "Total service charge"],
  ["tax", "Total tax"],
  ["total", "Total keseluruhan"],
];

const mono = { fontFamily: "var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace)" } as const;

export default function JambuluwukChecker({ onBack }: Props) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileIdRef = useRef(0);
  const [profile, setProfile] = useState<JambuluwukProfile>("HOTEL");
  const [init] = useState(() => ({ HOTEL: initialQuery("HOTEL"), RESTO: initialQuery("RESTO") }));
  const [drafts, setDrafts] = useState<Record<JambuluwukProfile, string>>({ HOTEL: init.HOTEL.sql, RESTO: init.RESTO.sql });
  const [saved, setSaved] = useState<Record<JambuluwukProfile, StoredQuery | null>>({ HOTEL: init.HOTEL.saved, RESTO: init.RESTO.saved });
  const [phase, setPhase] = useState<RunPhase>(IDLE);
  const [sourceVersion, setSourceVersion] = useState(0);
  const [meta, setMeta] = useState<MetaState | null>(null);
  const [confirm, setConfirm] = useState<"save" | "reset" | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [page, setPage] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const runCounter = useRef(0);

  const draft = drafts[profile];
  const persisted = saved[profile]?.sql ?? DEFAULT_QUERIES[profile];
  const dirty = draft !== persisted;
  const isDefault = draft === DEFAULT_QUERIES[profile];
  // Hanya file yang berhasil dibaca (bukan gagal / duplikat) yang masuk ke tabel virtual d_file_data.
  const readySources = useMemo(() => files.flatMap((f) => (f.state === "ok" && f.source?.ok ? [f.source] : [])), [files]);
  const hasSource = readySources.length > 0;
  const fileName = files.length === 0 ? "" : readySources.length === 1 ? readySources[0].fileName : `${readySources.length} file`;

  // Satu-satunya SQL yang dijalankan = isi editor apa adanya. Filter tanggal ditulis pengguna sebagai klausa WHERE
  // date_trans di editor; tidak ada filter tanggal tersembunyi dari UI dan tidak ada penulisan ulang query.
  const inputs: RunInputs = { profile, sql: draft, sourceVersion: hasSource ? sourceVersion : null };
  const view = deriveView(phase, inputs);
  const running = phase.kind === "running";
  const draftIsMeta = isMetadataStatement(draft);

  const setDraft = (value: string) => {
    setDrafts((d) => ({ ...d, [profile]: value }));
    setConfirm(null);
  };

  // Menjalankan query terhadap baris Excel yang sudah dibaca. Hanya dipanggil oleh tombol/shortcut "Jalankan Query":
  // mengunggah file atau berganti profil TIDAK menjalankan query dan TIDAK menampilkan hasil.
  const execute = async (sql: string, srcs: JambuluwukSource[], label: string) => {
    const id = ++runCounter.current;
    const runInputs: RunInputs = { profile, sql, sourceVersion };
    setPhase(startRun(id, runInputs)); // hasil sebelumnya dibuang selama eksekusi
    setNote(null);
    await new Promise<void>((resolve) => setTimeout(resolve, 0)); // beri kesempatan UI menampilkan status
    try {
      const result = await runProfileQueryMulti(sql, srcs);
      setPhase((p) => finishRun(p, id, { kind: "success", runId: id, inputs: runInputs, result, fileName: label }));
      setPage(0);
    } catch (err) {
      setPhase((p) => finishRun(p, id, { kind: "error", runId: id, inputs: runInputs, failure: toFailure(err, sql) }));
    }
  };

  const invalidateRuns = () => { runCounter.current++; setPhase(IDLE); setMeta(null); };

  const bumpSources = () => {
    setPage(0);
    setNote(null);
    invalidateRuns(); // hasil lama kedaluwarsa dan disembunyikan sampai query dijalankan kembali
    setSourceVersion((v) => v + 1);
  };

  // Menambahkan satu atau banyak file (file picker multi-pilih / Ctrl+A / drag & drop). Setiap file dibaca dengan parser yang sama.
  const handleFiles = async (picked: File[]) => {
    if (!picked.length || busy) return;
    setBusy(true);
    bumpSources();
    try {
      const probes = files.map((f) => ({ id: f.id, name: f.name, fingerprint: f.fingerprint, usable: f.state === "ok" }));
      const replaced = new Set<number>();
      const added: FileEntry[] = [];
      for (const file of picked) {
        const id = ++fileIdRef.current;
        let buffer: ArrayBuffer;
        try { buffer = await file.arrayBuffer(); } catch {
          added.push({ id, name: file.name, size: file.size, fingerprint: null, state: "gagal", source: null, message: "File tidak dapat dibaca." });
          continue;
        }
        const fingerprint = await fingerprintBuffer(buffer);
        const dup = findDuplicate([...probes, ...added.map((a) => ({ id: a.id, name: a.name, fingerprint: a.fingerprint, usable: a.state === "ok" }))], file.name, fingerprint);
        if (dup) {
          added.push({ id, name: file.name, size: file.size, fingerprint, state: "duplikat", source: null, duplicateOf: dup.id, message: `Duplikat dari ${dup.name} (nama atau isi sama); tidak dihitung ulang.` });
          continue;
        }
        // File lama bernama sama yang gagal dibaca digantikan oleh file baru ini.
        files.forEach((f) => { if (f.state === "gagal" && f.name.toLowerCase() === file.name.toLowerCase()) replaced.add(f.id); });
        let parsed: JambuluwukSource;
        try {
          parsed = parseJambuluwukWorkbook(buffer, file.name);
        } catch {
          parsed = { ok: false, error: "Gagal membaca file.", fileName: file.name, dateTrans: null, sheetName: "", headerRow: 0, ignoredSheets: [], rows: [], stats: { dataRows: 0, blankRows: 0, repeatedHeaders: 0, summaryRows: 0, missingFolio: 0, usedRows: 0, unmatchedRows: 0 } };
        }
        added.push(parsed.ok
          ? { id, name: file.name, size: file.size, fingerprint, state: "ok", source: parsed }
          : { id, name: file.name, size: file.size, fingerprint, state: "gagal", source: parsed, message: parsed.error });
      }
      setFiles((prev) => [...prev.filter((f) => !replaced.has(f.id)), ...added]);
    } finally {
      setBusy(false);
    }
  };

  const removeFile = (id: number) => {
    if (busy) return;
    bumpSources();
    // Duplikat yang merujuk file ini ikut dilepas agar tidak menggantung; pengguna bisa memilihnya lagi.
    setFiles((prev) => prev.filter((f) => f.id !== id && f.duplicateOf !== id));
  };

  const clearFiles = () => {
    if (busy) return;
    bumpSources();
    setFiles([]);
  };

  const selectProfile = (p: JambuluwukProfile) => {
    setProfile(p);
    setPage(0);
    setConfirm(null);
    setNote(null);
    // Tidak ada eksekusi otomatis: hasil profil sebelumnya otomatis tersembunyi karena identitas input berubah.
  };

  const doRun = () => {
    setNote(null);
    setConfirm(null);
    if (running) return;
    if (isMetadataStatement(draft)) {
      // Perintah metadata dijalankan terhadap registry tabel virtual aktual; tidak menghasilkan ringkasan transaksi.
      try {
        setMeta({ sql: draft, result: runMetadata(draft, registryForSources(readySources)), error: null });
      } catch (err) {
        setMeta({ sql: draft, result: null, error: toFailure(err, draft) });
      }
      return;
    }
    if (!hasSource) { setNote({ kind: "error", text: "Upload file Excel yang valid terlebih dahulu sebelum menjalankan query." }); return; }
    setMeta(null);
    void execute(draft, readySources, fileName);
  };

  const resetResults = () => { invalidateRuns(); setPage(0); setNote(null); };

  const doValidate = () => {
    setConfirm(null);
    const v = validateStatement(draft);
    setNote(v.ok
      ? { kind: "success", text: v.metadata ? "Perintah metadata valid." : "Query valid: sintaks serta nama tabel, kolom, dan fungsi sudah diperiksa. Data Excel belum diproses.", warnings: v.warnings }
      : { kind: "error", text: v.error.message, failure: toFailure(v.error, draft) });
  };

  const doFormat = () => {
    setConfirm(null);
    try {
      setDrafts((d) => ({ ...d, [profile]: formatSql(draft) }));
      setNote(null);
    } catch (err) {
      setNote({ kind: "error", text: `Query tidak dapat dirapikan: ${err instanceof Error ? err.message : String(err)}`, failure: toFailure(err, draft) });
    }
  };

  const commitSave = () => {
    const res = saveQuery(profile, draft);
    setConfirm(null);
    if (res.ok) {
      setSaved((s) => ({ ...s, [profile]: { sql: draft, savedAt: res.savedAt } }));
      setNote({ kind: "success", text: `Query ${PROFILE_LABEL[profile]} disimpan di browser ini.` });
    } else {
      setNote({ kind: "error", text: res.error });
    }
  };

  const doSave = () => {
    if (isMetadataStatement(draft)) {
      setConfirm(null);
      setNote({ kind: "error", text: "Perintah metadata (SHOW/DESCRIBE) tidak disimpan sebagai query profil. Simpan query SELECT untuk profil ini." });
      return;
    }
    const v = validateSql(draft);
    if (!v.ok) {
      setConfirm(null);
      setNote({ kind: "error", text: `Query belum disimpan karena belum valid: ${v.error.message}`, failure: toFailure(v.error, draft) });
      return;
    }
    if (saved[profile] && saved[profile]!.sql !== draft) setConfirm("save");
    else commitSave();
  };

  const commitReset = () => {
    const res = resetQuery(profile);
    setConfirm(null);
    if (res.ok) {
      setDrafts((d) => ({ ...d, [profile]: DEFAULT_QUERIES[profile] }));
      setSaved((s) => ({ ...s, [profile]: null }));
      setNote({ kind: "success", text: `Query ${PROFILE_LABEL[profile]} dikembalikan ke default.` });
    } else {
      setNote({ kind: "error", text: res.error });
    }
  };

  const showInEditor = (f: Failure) => {
    const ta = editorRef.current;
    if (!ta || f.pos === null) return;
    ta.focus();
    ta.setSelectionRange(f.pos, Math.min(ta.value.length, f.pos + f.length));
  };

  const renderFailure = (f: Failure) => {
    const loc = f.pos !== null ? locate(f.sql, f.pos) : null;
    return (
      <>
        {loc && (
          <div style={{ marginTop: 6 }}>
            <div>Baris {loc.line}, kolom {loc.column}</div>
            <pre style={{ ...mono, margin: "4px 0 0", whiteSpace: "pre-wrap", fontSize: 11 }}>{loc.lineText}{"\n"}{" ".repeat(Math.max(0, loc.column - 1))}{"^".repeat(Math.max(1, Math.min(f.length, 40)))}</pre>
          </div>
        )}
        {f.row !== null && <div style={{ marginTop: 4 }}>Terjadi pada data baris Excel {f.row}.</div>}
      </>
    );
  };

  const money = formatJambuluwukMoney;
  const result = view.kind === "ready" || view.kind === "empty" ? view.result : null;
  const summary = useMemo(() => {
    if (!result) return null;
    return SUMMARY_COLUMNS.map(([key, label]) => ({ key, label, value: sumResultColumn(result, key) }));
  }, [result]);
  const rows = result?.rows ?? [];
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const okCount = files.filter((f) => f.state === "ok").length;
  const failedCount = files.filter((f) => f.state === "gagal").length;
  const dupCount = files.filter((f) => f.state === "duplikat").length;
  const totalDetailRows = readySources.reduce((sum, s) => sum + s.stats.usedRows, 0);
  const status = busy ? "Membaca file…" : files.length === 0 ? "Belum ada file" : `${okCount} file berhasil dibaca${failedCount ? ` · ${failedCount} gagal` : ""}${dupCount ? ` · ${dupCount} duplikat dilewati` : ""}`;
  const queryState = dirty ? "Diubah, belum disimpan" : saved[profile] ? "Tersimpan" : "Query default";
  const savedAtText = saved[profile]?.savedAt ? new Date(saved[profile]!.savedAt).toLocaleString("id-ID") : "";
  const dirtyOf = (p: JambuluwukProfile) => drafts[p] !== (saved[p]?.sql ?? DEFAULT_QUERIES[p]);

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="brand-lockup"><div className="brand-mark"><span>α</span></div><div><div className="brand-name">nstax</div><div className="brand-caption">transaction intelligence</div></div></div>
        <div className="sidebar-divider" />
        <nav className="sidebar-nav">
          <button className="nav-item" type="button" onClick={onBack}><ArrowLeft size={18} /><span>Kembali ke CEK UPL</span></button>
          <div className="nav-item is-active"><FileText size={18} /><span>CEK JAMBULUWUK</span></div>
        </nav>
        <div className="sidebar-footer"><div className="privacy-badge"><ShieldCheck size={16} /><div><strong>Local-first</strong><span>Data tidak keluar dari browser</span></div></div></div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <button className="button button-secondary compact" type="button" onClick={onBack}><ArrowLeft size={15} /> Kembali ke CEK UPL</button>
          <div className="breadcrumb"><span>CEK UPL</span><span>›</span><strong>CEK JAMBULUWUK</strong></div>
          <div className="status-chip"><span className="status-dot" /></div>
        </header>
        <div className="page-container">
          <section className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> CEK JAMBULUWUK · EXCEL</div>
              <h1>Periksa transaksi<br /><em>Jambuluwuk.</em></h1>
              <p>Upload satu atau banyak file Excel laporan folio (harian atau satu bulan sekaligus), pilih profil HOTEL atau RESTO, atur filter tanggal langsung lewat klausa WHERE di query, lalu jalankan query-nya. Berganti profil tidak perlu upload ulang.</p>
            </div>
            <div className="heading-meta"><span className="meta-label">CURRENT SOURCE</span><strong>{fileName || "Belum ada file"}</strong><span className="meta-subtitle">{view.kind === "ready" ? `${PROFILE_LABEL[profile]} · ${view.result.rows.length} baris hasil` : view.kind === "empty" ? `${PROFILE_LABEL[profile]} · 0 baris hasil` : hasSource ? "Jalankan query" : "Menunggu file Excel"}</span></div>
          </section>

          <section className="input-panel panel-surface">
            <div className="panel-heading">
              <div className="panel-title-wrap"><span className="section-number">01</span><div><h2>Upload File Excel Jambuluwuk</h2><p>Satu file harian atau banyak file sekaligus. Nama file harus berformat tanggal DD.MM.YYYY, contoh 01.09.2026.xls.</p></div></div>
              {fileName && <span className="file-pill"><FileText size={15} />{fileName}</span>}
            </div>
            <div
              className={`drop-zone ${drag ? "is-dragging" : ""}`}
              onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={() => setDrag(false)}
              onDrop={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDrag(false); void handleFiles(Array.from(e.dataTransfer.files)); }}
            >
              <div className="upload-symbol"><Upload size={20} /></div>
              <strong>{drag ? "Lepaskan file Excel di sini" : "Pilih satu atau banyak file Excel"}</strong>
              <span>Di dialog pilih file, tekan Ctrl+A (setelah dialog aktif) untuk memilih semua file dalam folder. Semua file dipakai untuk profil HOTEL dan RESTO.</span>
              <button className="button button-secondary" type="button" disabled={busy} onClick={() => inputRef.current?.click()}><FileText size={16} /> Pilih file Excel</button>
              <small>Kolom dibaca berdasarkan posisi: A = FOLIO, E = NAME, J = NETT. Tanggal diambil dari nama file. File dengan nama atau isi yang sama hanya dihitung sekali.</small>
              <input ref={inputRef} type="file" multiple accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(event: ChangeEvent<HTMLInputElement>) => { void handleFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
            </div>
            <div className="used-columns">
              <strong>Status: {status}</strong>
              {hasSource && <span>{totalDetailRows.toLocaleString("id-ID")} baris detail dibaca dari {okCount} file (baris kosong, header berulang, dan baris total laporan tidak dihitung)</span>}
            </div>
            {files.length > 0 && (
              <div className="mapping-panel upl-audit-panel">
                <div className="eyebrow"><span className="eyebrow-line" /> {files.length.toLocaleString("id-ID")} FILE DIPILIH</div>
                <div className="excel-scroll" style={{ maxHeight: 320 }}>
                  <table>
                    <thead><tr><th>No</th><th>Nama file</th><th>Ukuran</th><th>Tanggal file</th><th>Status</th><th>Hapus</th></tr></thead>
                    <tbody>
                      {files.map((f, i) => (
                        <tr key={f.id}>
                          <td>{i + 1}</td>
                          <td>{f.name}</td>
                          <td>{formatBytes(f.size)}</td>
                          <td>{f.source?.ok ? f.source.dateTrans : "—"}</td>
                          <td>{f.state === "ok" && f.source?.ok ? `✓ berhasil · sheet "${f.source.sheetName}" · ${f.source.stats.usedRows.toLocaleString("id-ID")} baris detail` : f.state === "duplikat" ? `⚠ dilewati: ${f.message}` : `✕ gagal: ${f.message ?? "tidak dapat dibaca"}`}</td>
                          <td><button className="button button-ghost compact" type="button" disabled={busy} onClick={() => removeFile(f.id)} aria-label={`Hapus ${f.name}`}>✕ Hapus</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="input-actions">
                  <span className="privacy-note">Total ukuran: {formatBytes(files.reduce((sum, f) => sum + f.size, 0))}</span>
                  <button className="button button-ghost compact" type="button" disabled={busy} onClick={clearFiles}><Trash2 size={14} /> Kosongkan daftar</button>
                </div>
              </div>
            )}
            <div className="privacy-note"><ShieldCheck size={15} /> Diproses lokal di browser</div>
          </section>

          {failedCount > 0 && <div className="notice notice-error">{failedCount} file gagal dibaca dan tidak ikut dihitung: {files.filter((f) => f.state === "gagal").map((f) => `${f.name} (${f.message ?? "gagal"})`).join(" | ")}</div>}

          <section className="panel-surface" style={{ marginTop: 20, padding: 20 }}>
            <div className="panel-heading">
              <div className="panel-title-wrap"><span className="section-number">02</span><div><h2>Editor query</h2><p>Query HOTEL dan RESTO disimpan terpisah di browser ini. Hasil selalu dihitung dari baris yang lolos WHERE pada query yang Anda jalankan.</p></div></div>
            </div>
            <div className="cmp-chips" role="group" aria-label="Profil query Jambuluwuk" style={{ marginTop: 14 }}>
              {JAMBULUWUK_PROFILES.map((item) => (
                <button key={item} type="button" className={`cmp-chip ${profile === item ? "is-active" : ""}`} onClick={() => selectProfile(item)}>
                  {PROFILE_LABEL[item]}{dirtyOf(item) ? <b title="Ada perubahan yang belum disimpan">●</b> : null}
                </button>
              ))}
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", margin: "14px 0 8px", fontSize: 11.5 }}>
              <strong style={{ color: dirty ? "var(--warning)" : "var(--ink)" }}>{dirty ? "● " : ""}{queryState}</strong>
              {!dirty && savedAtText && <span style={{ color: "var(--muted)" }}>disimpan {savedAtText}</span>}
              {dirty && <span style={{ color: "var(--muted)" }}>Perubahan hilang jika halaman ditutup sebelum disimpan.</span>}
            </div>

            <div style={{ margin: "16px 0 10px", fontSize: 11.5, color: "var(--muted)", lineHeight: 1.6 }}>
              Filter tanggal diatur langsung di query: ubah klausa <code style={mono}>WHERE date_trans …</code> di bagian bawah editor (contoh tanggal tertentu, satu bulan, dan rentang tanggal ada di komentar query), lalu tekan Jalankan Query.
            </div>

            <textarea
              ref={editorRef}
              value={draft}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setDraft(e.target.value)}
              onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); doRun(); } }}
              spellCheck={false}
              wrap="off"
              aria-label={`Query ${PROFILE_LABEL[profile]}`}
              style={{ ...mono, width: "100%", minHeight: 420, height: "55vh", resize: "vertical", padding: 14, fontSize: 12.5, lineHeight: 1.55, tabSize: 4, whiteSpace: "pre", overflow: "auto", background: "var(--surface)", color: "var(--ink)", border: "1px solid var(--line-strong)", borderRadius: 6 }}
            />

            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
              <button className="button button-secondary compact" type="button" onClick={doFormat}><Wand2 size={15} /> Format Query</button>
              <button className="button button-secondary compact" type="button" onClick={doValidate}><CheckCircle2 size={15} /> Validasi Query</button>
              <button className="button button-primary compact" type="button" onClick={doRun} disabled={running || (!hasSource && !draftIsMeta)} title={hasSource || draftIsMeta ? "Ctrl/⌘ + Enter" : "Upload file Excel terlebih dahulu"}><Play size={15} /> {running ? "Memproses…" : "Jalankan Query"}</button>
              <button className="button button-secondary compact" type="button" onClick={resetResults} disabled={phase.kind === "idle" && !meta} title="Sembunyikan ringkasan dan tabel; file dan query tidak dihapus"><Eraser size={15} /> Reset Hasil</button>
              <button className="button button-secondary compact" type="button" onClick={doSave} disabled={!dirty}><Save size={15} /> Simpan Query</button>
              <button className="button button-secondary compact" type="button" onClick={() => setConfirm("reset")} disabled={isDefault && !saved[profile]}><RotateCcw size={15} /> Kembalikan ke Default</button>
            </div>

            {confirm === "save" && (
              <div className="notice notice-warning" role="alertdialog">
                <span>Timpa query {PROFILE_LABEL[profile]} yang tersimpan{savedAtText ? ` (${savedAtText})` : ""} dengan isi editor saat ini?</span>
                <button type="button" onClick={commitSave}>Ya, timpa</button>
                <button type="button" onClick={() => setConfirm(null)}>Batal</button>
              </div>
            )}
            {confirm === "reset" && (
              <div className="notice notice-warning" role="alertdialog">
                <span>Kembalikan query {PROFILE_LABEL[profile]} ke default bawaan? Isi editor dan query tersimpan untuk profil ini akan hilang.</span>
                <button type="button" onClick={commitReset}>Ya, kembalikan</button>
                <button type="button" onClick={() => setConfirm(null)}>Batal</button>
              </div>
            )}

            {note && (
              <div className={`notice ${note.kind === "success" ? "notice-success" : "notice-error"}`} style={{ alignItems: "flex-start", flexDirection: "column", gap: 4 }}>
                <span>{note.text}</span>
                {note.failure && renderFailure(note.failure)}
                {note.failure && note.failure.pos !== null && note.failure.sql === draft && (
                  <button type="button" style={{ marginLeft: 0 }} onClick={() => showInEditor(note.failure!)}>Tunjuk di editor</button>
                )}
                {note.warnings?.map((w) => <span key={w} style={{ color: "var(--warning)" }}>⚠ {w}</span>)}
              </div>
            )}

            <details style={{ marginTop: 14, fontSize: 11.5 }}>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>Sintaks yang didukung dan batasannya</summary>
              <div style={{ marginTop: 8, lineHeight: 1.6 }}>
                <p style={{ margin: "0 0 6px" }}>Ini bukan database SQL penuh, melainkan mesin query TypeScript yang berjalan di browser dengan subset sintaks berikut.</p>
                <p style={{ margin: "0 0 6px" }}><strong>Didukung:</strong> WITH (CTE), SELECT dengan alias, FROM, WHERE, GROUP BY, CASE WHEN … THEN … ELSE … END; operator + − * / %, = &lt;&gt; != &lt; &gt; &lt;= &gt;=, AND, OR, NOT, IS [NOT] NULL, [NOT] IN, [NOT] LIKE, [NOT] REGEXP, BETWEEN; fungsi SUM, COUNT, ROUND, TRIM, CAST(… AS DECIMAL(p,s)/SIGNED/CHAR), STR_TO_DATE, DATE_FORMAT (%d %e %m %c %Y %y), SUBSTRING_INDEX, CONCAT, COALESCE, IFNULL, ABS, UPPER, LOWER.</p>
                <p style={{ margin: "0 0 6px" }}><strong>Tabel virtual:</strong> d_file_data dengan kolom A (FOLIO), E (NAME), J (NETT), filename (nama file yang diunggah), dan id_command (selalu 'UPL0192', hanya konteks pemrosesan — bukan tabel database).</p>
                <p style={{ margin: "0 0 6px" }}><strong>Metadata:</strong> SHOW TABLES; · DESCRIBE d_file_data; · SHOW COLUMNS FROM d_file_data; — membaca registry tabel virtual dari file yang sedang dimuat (bukan database server). Tanpa file, SHOW TABLES menghasilkan daftar kosong.</p>
                <p style={{ margin: "0 0 6px" }}><strong>Tidak didukung (ditolak dengan pesan error):</strong> JOIN, UNION, DISTINCT, HAVING, ORDER BY, LIMIT, subquery dalam ekspresi, dan perintah selain SELECT.</p>
                <p style={{ margin: 0 }}><strong>Perilaku:</strong> REGEXP memakai RegExp JavaScript dan tidak membedakan huruf besar/kecil. Kolom non-agregat di luar GROUP BY diambil dari baris pertama grup (peringatan ditampilkan). Nilai J yang bukan angka menghentikan query dengan error. Query tersimpan hanya di localStorage browser ini (tidak tersinkron antarperangkat); isi file Excel tidak pernah disimpan.</p>
              </div>
            </details>
          </section>

          {meta && meta.sql === draft && (
            meta.error ? (
              <div className="notice notice-error" style={{ alignItems: "flex-start", flexDirection: "column", gap: 4 }}>
                <strong>Perintah metadata gagal.</strong>
                <span>{meta.error.message}</span>
                {renderFailure(meta.error)}
              </div>
            ) : meta.result && (
              <section className="excel-preview">
                <div className="section-heading">
                  <div><div className="eyebrow"><span className="eyebrow-line" /> HASIL METADATA</div><h2>{meta.result.statement}</h2></div>
                  <span className="result-count">{meta.result.rows.length.toLocaleString("id-ID")} baris · bukan data transaksi</span>
                </div>
                {meta.result.rows.length === 0
                  ? <div className="table-empty"><strong>Tidak ada tabel</strong></div>
                  : <div className="excel-scroll"><table><thead><tr>{meta.result.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead><tbody>{meta.result.rows.map((r, i) => <tr key={i}>{r.map((c, ci) => <td key={ci}>{c}</td>)}</tr>)}</tbody></table></div>}
                {meta.result.notes.map((n) => <div key={n} style={{ margin: "8px 2px 0", fontSize: 11, color: "var(--muted)" }}>{n}</div>)}
              </section>
            )
          )}

          {view.kind === "none" && !meta && !running && (
            <div style={{ margin: "18px 2px 0", padding: "12px 14px", border: "1px dashed var(--line-strong)", borderRadius: 6, fontSize: 12, color: "var(--muted)" }}>
              Upload file dan jalankan query untuk melihat ringkasan serta detail transaksi.
            </div>
          )}

          {view.kind === "running" && <div className="notice notice-success" role="status" aria-live="polite">Memproses query {PROFILE_LABEL[profile]}…</div>}

          {view.kind === "stale" && (
            <div className="notice notice-warning" role="status">
              Hasil sebelumnya disembunyikan karena {view.reason === "file" ? "file sumber diganti" : view.reason === "profil" ? `profil berganti (hasil ${PROFILE_LABEL[view.previousProfile as JambuluwukProfile] ?? view.previousProfile})` : "isi query (termasuk filter tanggal pada WHERE) diubah"}. Tekan Jalankan Query untuk menghasilkan ringkasan dan detail terbaru.
            </div>
          )}

          {view.kind === "error" && (
            <div className="notice notice-error" style={{ alignItems: "flex-start", flexDirection: "column", gap: 4 }}>
              <strong>Query gagal dijalankan. Tidak ada hasil terbaru yang ditampilkan.</strong>
              <span>{view.failure.message}</span>
              {renderFailure(view.failure)}
              {view.failure.pos !== null && view.failure.sql === draft && <button type="button" style={{ marginLeft: 0 }} onClick={() => showInEditor(view.failure)}>Tunjuk di editor</button>}
            </div>
          )}

          {(view.kind === "ready" || view.kind === "empty") && result && summary && <>
            {result.warnings.length > 0 && <div className="notice notice-warning" style={{ alignItems: "flex-start", flexDirection: "column", gap: 4 }}>{result.warnings.map((w) => <span key={w}>⚠ {w}</span>)}</div>}

            <div role="status" style={{ margin: "18px 2px 8px", fontSize: 12, color: "var(--muted)" }}>✓ Query berhasil dijalankan — hasil di bawah dihitung dari {result.rows.length.toLocaleString("id-ID")} baris yang lolos WHERE.</div>
            <div className="metric-grid upl-metrics">
              <div className="metric-card"><span className="metric-label">Profil</span><strong className="metric-value" style={{ fontSize: 15 }}>{PROFILE_LABEL[profile]}</strong></div>
              <div className="metric-card"><span className="metric-label">Nama file</span><strong className="metric-value" style={{ fontSize: 15 }}>{view.fileName}</strong></div>
              <div className="metric-card"><span className="metric-label">Jumlah transaksi</span><strong className="metric-value">{result.rows.length.toLocaleString("id-ID")}</strong></div>
              {summary.map((m) => (
                <div className="metric-card" key={m.key}>
                  <span className="metric-label">{m.label}</span>
                  <strong className="metric-value" title={m.value === null ? `Query tidak menghasilkan kolom numerik "${m.key}"` : undefined}>{m.value === null ? "—" : money(m.value)}</strong>
                </div>
              ))}
            </div>
            <div style={{ margin: "8px 2px 0", fontSize: 11, color: "var(--muted)" }}>
              {result.stages.map((st) => `${st.name}: ${st.inputRows.toLocaleString("id-ID")} baris dibaca → ${st.matchedRows.toLocaleString("id-ID")} lolos WHERE → ${st.outputRows.toLocaleString("id-ID")} baris`).join("  ·  ")}
            </div>

            <section className="excel-preview">
              <div className="section-heading">
                <div><div className="eyebrow"><span className="eyebrow-line" /> 03 · HASIL QUERY</div><h2>Detail transaksi Jambuluwuk {profile}</h2></div>
                <span className="result-count">{rows.length.toLocaleString("id-ID")} baris · ringkasan dihitung dari seluruh hasil</span>
              </div>
              {rows.length === 0 ? (
                <div className="table-empty"><strong>Tidak ada transaksi yang cocok dengan kondisi query</strong><span>Periksa klausa WHERE (misalnya tanggal pada date_trans) dan pastikan file yang diunggah memuat tanggal tersebut.</span></div>
              ) : <div className="excel-scroll">
                <table>
                  <thead><tr><th>No</th>{result.columns.map((c, i) => <th key={`${c}-${i}`}>{c}</th>)}</tr></thead>
                  <tbody>
                    {pageRows.map((row, index) => (
                      <tr key={page * PAGE_SIZE + index}>
                        <td>{page * PAGE_SIZE + index + 1}</td>
                        {row.map((cell, ci) => (
                          <td key={ci} style={cell === null ? { color: "var(--muted)", fontStyle: "italic" } : isDec(cell) ? { textAlign: "right" } : undefined}>{formatCell(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>}
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
