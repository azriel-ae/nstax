import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import * as XLSX from "xlsx";
import { AlertTriangle, ArrowLeft, Check, Download, FileText, RotateCcw, Search, ShieldCheck, X } from "lucide-react";
import { formatReceiptRupiah, parseReceiptFile, type ReceiptRawTable, type ReceiptRow } from "@/lib/receiptParser";
import { compareReceiptTotals, type ReceiptTotalsLine } from "@/lib/receiptCompare";
import { buildExportRows, compareTables, describeDifference, detectKeys, formatCellValue, rowsToCsv, type CompareRecord, type CompareResult, type CompareStatus } from "@/lib/receiptCompareEngine";

type Props = { onBack: () => void };
type Slot = 0 | 1;
type Dataset = { rows: ReceiptRow[]; table: ReceiptRawTable; warning: string };
type Filter = "ALL" | CompareStatus;

const PAGE_SIZE = 50;
const formatCount = (value: number) => value.toLocaleString("id-ID");
const formatFileSize = (value: number) => value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;
const formatValue = (line: ReceiptTotalsLine, value: number) => (line.metric === "count" ? formatCount(value) : formatReceiptRupiah(value));
const formatDifference = (line: ReceiptTotalsLine) => {
  if (line.difference === 0) return line.metric === "count" ? "0" : formatReceiptRupiah(0);
  const sign = line.difference > 0 ? "+" : "";
  return line.metric === "count" ? `${sign}${formatCount(line.difference)}` : `${sign}${formatReceiptRupiah(line.difference)}`;
};
const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
const pillClass = (status: CompareStatus) => (status === "SAMA" ? "is-same" : status === "BERBEDA" ? "is-diff" : status === "DUPLIKAT" ? "is-dup" : "is-missing");
const FILTERS: Array<[Filter, string]> = [["ALL", "Semua"], ["SAMA", "Data sama"], ["BERBEDA", "Data berbeda"], ["HANYA DI FILE 1", "Hanya ada di File 1"], ["HANYA DI FILE 2", "Hanya ada di File 2"], ["DUPLIKAT", "Data ganda"]];
const STATUS_LABEL: Record<CompareStatus, string> = { SAMA: "DATA SAMA", BERBEDA: "DATA BERBEDA", "HANYA DI FILE 1": "HANYA ADA DI FILE 1", "HANYA DI FILE 2": "HANYA ADA DI FILE 2", DUPLIKAT: "DATA GANDA" };
const presence = (count: number) => (count === 0 ? "Tidak ada" : count > 1 ? `Muncul ${count} kali` : "Ada");
const noteFor = (record: CompareRecord): { text: string; detail?: string } => {
  if (record.status === "SAMA") return { text: "Data sama." };
  if (record.status === "BERBEDA") return { text: "Ada nilai yang berbeda.", detail: record.diffs.map((diff) => diff.label).join(", ") };
  if (record.status === "HANYA DI FILE 1") return { text: "Data ini tidak ditemukan di File 2." };
  if (record.status === "HANYA DI FILE 2") return { text: "Data ini tidak ditemukan di File 1." };
  const parts = [record.idx1.length > 1 ? `${record.idx1.length} kali di File 1` : "", record.idx2.length > 1 ? `${record.idx2.length} kali di File 2` : ""].filter(Boolean);
  return { text: `Nomor ini muncul ${parts.join(" dan ")}.` };
};

export default function ReceiptCompareChecker({ onBack }: Props) {
  // File 1 dan File 2 selalu terpisah: file1/file2 (File) dan dataFile1/dataFile2 (dataset).
  const [files, setFiles] = useState<[File | null, File | null]>([null, null]);
  const [datasets, setDatasets] = useState<[Dataset | null, Dataset | null]>([null, null]);
  const [keys, setKeys] = useState<[number, number]>([-1, -1]);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [dragging, setDragging] = useState<[boolean, boolean]>([false, false]);
  const [notice, setNotice] = useState("");
  const [keyNote, setKeyNote] = useState("");
  const [busy, setBusy] = useState("");
  const [filter, setFilter] = useState<Filter>("ALL");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<CompareRecord | null>(null);
  const inputRefs = useRef<[HTMLInputElement | null, HTMLInputElement | null]>([null, null]);

  const setSlot = <T,>(setter: (updater: (current: [T, T]) => [T, T]) => void, slot: Slot, value: T) => setter((current) => (slot === 0 ? [value, current[1]] : [current[0], value]));
  const clearResult = () => { setResult(null); setSelected(null); setFilter("ALL"); setSearch(""); setPage(1); setKeyNote(""); setNotice(""); };

  const pick = (slot: Slot, file?: File) => {
    if (!file) return;
    if (!/\.(pdf|xlsx?|csv)$/i.test(file.name)) { setNotice(`File ${slot + 1} tidak didukung. Gunakan PDF, XLSX, XLS, atau CSV.`); return; }
    clearResult();
    setSlot(setFiles, slot, file);
    setSlot(setDatasets, slot, null);
    setKeys([-1, -1]);
  };
  const remove = (slot: Slot) => {
    clearResult();
    setSlot(setFiles, slot, null);
    setSlot(setDatasets, slot, null);
    setKeys([-1, -1]);
  };
  const resetAll = () => {
    setFiles([null, null]); setDatasets([null, null]); setKeys([-1, -1]);
    clearResult(); setBusy("");
    inputRefs.current.forEach((input) => { if (input) input.value = ""; });
  };

  const runCompare = async (d1: Dataset, d2: Dataset, k1: number, k2: number) => {
    const output = await compareTables(d1.table, d2.table, k1, k2, async (message) => setBusy(message));
    setResult(output);
    setPage(1);
  };

  const start = async () => {
    const [f1, f2] = files;
    if (!f1 || !f2 || busy) return;
    clearResult();
    try {
      const loaded: Array<Dataset | null> = [datasets[0], datasets[1]];
      for (const slot of [0, 1] as const) {
        if (loaded[slot]) continue;
        setBusy(`Memproses File ${slot + 1}...`);
        await nextPaint();
        const parsed = await parseReceiptFile(files[slot]!);
        if (!parsed.rows.length || !parsed.table) { setNotice(`File ${slot + 1}: ${parsed.warning ?? "tidak ada transaksi valid."}`); setBusy(""); return; }
        loaded[slot] = { rows: parsed.rows, table: parsed.table, warning: parsed.warning ?? "" };
      }
      const d1 = loaded[0]!, d2 = loaded[1]!;
      setDatasets([d1, d2]);
      const detection = detectKeys(d1.table, d2.table);
      setKeys([detection.key1, detection.key2]);
      if (!detection.detected) {
        setKeyNote("Kolom identitas transaksi tidak terdeteksi. Pilih kolom identitas untuk masing-masing file, lalu klik Terapkan & bandingkan.");
        setBusy("");
        return;
      }
      setKeyNote(detection.sameName ? `Kolom identitas terdeteksi otomatis: ${d1.table.headers[detection.key1]}.` : `Kolom identitas terdeteksi otomatis, namanya berbeda: ${d1.table.headers[detection.key1]} (File 1) dan ${d2.table.headers[detection.key2]} (File 2). Ubah pilihan di bawah jika kurang tepat.`);
      setBusy("Mencocokkan transaksi...");
      await nextPaint();
      await runCompare(d1, d2, detection.key1, detection.key2);
    } catch {
      setNotice("File tidak dapat dibaca atau dibandingkan.");
    } finally {
      setBusy("");
    }
  };

  const applyKeys = async () => {
    const [d1, d2] = datasets;
    if (!d1 || !d2 || keys[0] < 0 || keys[1] < 0 || busy) return;
    setResult(null); setSelected(null); setPage(1); setNotice("");
    setBusy("Mencocokkan transaksi...");
    await nextPaint();
    try { await runCompare(d1, d2, keys[0], keys[1]); } catch { setNotice("Perbandingan gagal diproses."); } finally { setBusy(""); }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, slot: Slot) => {
    event.preventDefault(); event.stopPropagation();
    setSlot(setDragging, slot, false);
    pick(slot, event.dataTransfer.files?.[0]);
  };

  const dropCard = (slot: Slot) => {
    const file = files[slot];
    const data = datasets[slot];
    return (
      <div
        role="button" tabIndex={0}
        className={`mode-card cmp-drop ${dragging[slot] ? "is-dragging" : ""} ${file ? "has-file" : ""}`}
        onClick={() => inputRefs.current[slot]?.click()}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); inputRefs.current[slot]?.click(); } }}
        onDragEnter={(event) => { event.preventDefault(); event.stopPropagation(); if (event.dataTransfer.types.includes("Files")) setSlot(setDragging, slot, true); }}
        onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; }}
        onDragLeave={(event) => { event.preventDefault(); event.stopPropagation(); if (event.currentTarget.contains(event.relatedTarget as Node | null)) return; setSlot(setDragging, slot, false); }}
        onDrop={(event) => handleDrop(event, slot)}
      >
        <span className="mode-card-label">FILE {slot + 1}</span>
        {dragging[slot] ? <strong className="cmp-drop-title">LEPAS FILE DI SINI</strong> : file ? (
          <>
            <strong className="cmp-file-name">✓ {file.name}</strong>
            <span className="cmp-file-meta">✓ {formatFileSize(file.size)}{data ? ` · ${formatCount(data.table.rows.length)} transaksi dibaca` : ""}</span>
          </>
        ) : (
          <>
            <strong>Seret file ke sini</strong>
            <span className="mode-card-hint">atau klik untuk upload · PDF, XLSX, XLS, CSV</span>
          </>
        )}
        <span className="cmp-drop-actions">
          <button className="button button-secondary compact" type="button" onClick={(event) => { event.stopPropagation(); inputRefs.current[slot]?.click(); }}>{file ? "Ganti File" : "Pilih File"}</button>
          {file && <button className="button button-ghost compact" type="button" onClick={(event) => { event.stopPropagation(); remove(slot); }}><X size={13} /> Hapus</button>}
        </span>
        <input ref={(element) => { inputRefs.current[slot] = element; }} type="file" accept=".pdf,.xlsx,.xls,.csv" hidden onChange={(event: ChangeEvent<HTMLInputElement>) => { pick(slot, event.target.files?.[0]); event.target.value = ""; }} />
      </div>
    );
  };

  // ---- hasil: filter + search + pagination (hanya untuk tampilan; perbandingan memakai seluruh data) ----
  const counts = useMemo(() => {
    const base: Record<Filter, number> = { ALL: 0, SAMA: 0, BERBEDA: 0, "HANYA DI FILE 1": 0, "HANYA DI FILE 2": 0, DUPLIKAT: 0 };
    result?.records.forEach((record) => { base.ALL++; base[record.status]++; });
    return base;
  }, [result]);
  const visible = useMemo(() => {
    if (!result) return [];
    const term = search.trim().toLowerCase();
    return result.records.filter((record) => (filter === "ALL" || record.status === filter) && (!term || record.key.toLowerCase().includes(term)));
  }, [result, filter, search]);
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageRows = visible.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [filter, search]);
  useEffect(() => {
    if (!selected) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selected]);

  const totals = useMemo(() => (datasets[0] && datasets[1] ? compareReceiptTotals(datasets[0].rows, datasets[1].rows) : null), [datasets]);

  const exportResult = (format: "csv" | "xlsx") => {
    if (!result || !datasets[0] || !datasets[1]) return;
    const rows = buildExportRows(result, datasets[0].table, datasets[1].table);
    if (format === "csv") {
      const url = URL.createObjectURL(new Blob([rowsToCsv(rows)], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url; link.download = "hasil-bandingkan-2-file.csv"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Perbandingan");
      XLSX.writeFile(workbook, "hasil-bandingkan-2-file.xlsx");
    }
  };

  const blockOf = (table: ReceiptRawTable, indexes: number[], record: CompareRecord, keyCol: number, slot: Slot) => {
    if (!indexes.length) return <div className="cmp-empty">Data tidak ditemukan di File {slot + 1}</div>;
    const diffFields = new Set(record.diffs.map((diff) => diff.field));
    return indexes.map((rowIndex, occurrence) => (
      <div className="cmp-block-rows" key={rowIndex}>
        {indexes.length > 1 && <div className="cmp-occurrence">Muncul ke-{occurrence + 1} · baris {table.sourceRows[rowIndex]}</div>}
        {table.headers.map((header, col) => header ? (
          <div className={`cmp-kv ${col === keyCol ? "is-key" : ""} ${occurrence === 0 && diffFields.has(header) ? "is-changed" : ""}`} key={col}><span>{header}</span><b>{formatCellValue(header, table.rows[rowIndex][col] ?? "")}</b></div>
        ) : null)}
      </div>
    ));
  };
  const diffFieldSet = (record: CompareRecord) => new Set(record.diffs.map((diff) => diff.label));

  const mismatchSummary = result?.summary;
  const ready = Boolean(files[0] && files[1]);
  const needsKey = datasets[0] && datasets[1] && !result;

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="brand-lockup"><div className="brand-mark"><span>α</span></div><div><div className="brand-name">nstax</div><div className="brand-caption">transaction intelligence</div></div></div>
        <div className="sidebar-divider" />
        <nav className="sidebar-nav">
          <button className="nav-item" type="button" onClick={onBack}><ArrowLeft size={18} /><span>Kembali ke CEK STRUK</span></button>
          <div className="nav-item is-active"><FileText size={18} /><span>BANDINGKAN 2 FILE</span></div>
        </nav>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <button className="button button-secondary compact" type="button" onClick={onBack}><ArrowLeft size={15} /> Kembali ke CEK STRUK</button>
          <div className="breadcrumb"><span>CEK STRUK</span><span>›</span><strong>BANDINGKAN 2 FILE</strong></div>
          <div className="status-chip"><span className="status-dot" /></div>
        </header>
        <div className="page-container">
          <section className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> CEK STRUK · BANDINGKAN DATA</div>
              <h1>Bandingkan dua<br /><em>file struk.</em></h1>
              <p>Seret dua file, lalu sistem mencocokkan transaksi berdasarkan nomor struk / no order (bukan nomor baris) dan membandingkan field yang sama. Jumlah transaksi kedua file boleh berbeda.</p>
            </div>
          </section>

          <section className="input-panel panel-surface">
            <div className="cmp-drops">
              {dropCard(0)}
              <div className="cmp-vs" aria-hidden="true">VS</div>
              {dropCard(1)}
            </div>
            <div className="cmp-actions">
              <button className={`button button-primary ${busy ? "is-loading" : ""}`} type="button" disabled={!ready || Boolean(busy)} onClick={() => void start()}>BANDINGKAN FILE</button>
              <button className="button button-secondary" type="button" onClick={resetAll}><RotateCcw size={14} /> RESET PERBANDINGAN</button>
              <div className="privacy-note"><ShieldCheck size={15} /> File asli tidak diubah · proses lokal</div>
            </div>
          </section>

          {busy && <div className="notice notice-success" role="status" aria-live="polite">{busy}</div>}
          {notice && <div className="notice notice-error">{notice}</div>}
          {([0, 1] as const).map((slot) => datasets[slot]?.warning && <div key={slot} className="notice notice-warning"><AlertTriangle size={17} /> File {slot + 1}: {datasets[slot]!.warning}</div>)}
          {!ready && (files[0] || files[1]) && <div className="notice notice-warning">Pilih {files[0] ? "File 2" : "File 1"} untuk mulai membandingkan.</div>}

          {datasets[0] && datasets[1] && (
            <section className="excel-preview cmp-identity">
              <div className="section-heading"><div><h2>Identitas transaksi</h2><span>{keyNote || "Kolom ini dipakai untuk mencocokkan data antar file."}</span></div></div>
              <div className="cmp-identity-body">
                {([0, 1] as const).map((slot) => (
                  <label className="cmp-select" key={slot}>
                    <span>File {slot + 1}</span>
                    <select value={keys[slot]} disabled={Boolean(busy)} onChange={(event) => setKeys((current) => (slot === 0 ? [Number(event.target.value), current[1]] : [current[0], Number(event.target.value)]))}>
                      <option value={-1}>— pilih kolom —</option>
                      {datasets[slot]!.table.headers.map((header, index) => header ? <option key={index} value={index}>{header}</option> : null)}
                    </select>
                  </label>
                ))}
                <button className="button button-secondary" type="button" disabled={keys[0] < 0 || keys[1] < 0 || Boolean(busy)} onClick={() => void applyKeys()}>{needsKey ? "Terapkan & bandingkan" : "Bandingkan ulang"}</button>
              </div>
            </section>
          )}

          {result && mismatchSummary && (
            <>
              {(result.emptyKey1 > 0 || result.emptyKey2 > 0) && <div className="notice notice-warning"><AlertTriangle size={17} /> Baris tanpa nomor struk / no order tidak dapat dicocokkan: {formatCount(result.emptyKey1)} di File 1, {formatCount(result.emptyKey2)} di File 2.</div>}
              {result.fields.length === 0 && <div className="notice notice-warning"><AlertTriangle size={17} /> Tidak ada kolom lain yang sama di kedua file, sehingga hanya keberadaan nomor struk / no order yang dibandingkan.</div>}
              <section className="cmp-summary" aria-label="Ringkasan hasil">
                <div className="cmp-totals">
                  <div><span>Jumlah transaksi di File 1</span><strong>{formatCount(mismatchSummary.total1)}</strong></div>
                  <div><span>Jumlah transaksi di File 2</span><strong>{formatCount(mismatchSummary.total2)}</strong></div>
                </div>
                <div className="cmp-cards">
                  <div className="cmp-card is-same"><span className="cmp-card-title">Data sama</span><strong>{formatCount(mismatchSummary.same)}</strong><small>Ada di kedua file dan nilainya sama</small></div>
                  <div className="cmp-card is-diff"><span className="cmp-card-title">Data berbeda</span><strong>{formatCount(mismatchSummary.different)}</strong><small>Nomor sama, tetapi ada nilai yang berbeda</small></div>
                  <div className="cmp-card is-missing"><span className="cmp-card-title">Hanya ada di File 1</span><strong>{formatCount(mismatchSummary.only1)}</strong><small>Tidak ditemukan di File 2</small></div>
                  <div className="cmp-card is-missing"><span className="cmp-card-title">Hanya ada di File 2</span><strong>{formatCount(mismatchSummary.only2)}</strong><small>Tidak ditemukan di File 1</small></div>
                  <div className="cmp-card is-dup"><span className="cmp-card-title">Data ganda</span><strong>{formatCount(counts.DUPLIKAT)}</strong><small>File 1: {formatCount(mismatchSummary.dupKeys1)} · File 2: {formatCount(mismatchSummary.dupKeys2)}</small></div>
                </div>
              </section>

              <section className="excel-preview mismatch-section">
                <div className="section-heading">
                  <div><h2>Hasil perbandingan</h2><span>Data dicocokkan berdasarkan nomor struk atau nomor order. Urutan baris tidak berpengaruh.</span></div>
                  <div className="section-actions">
                    <button className="button button-secondary compact" type="button" onClick={() => exportResult("csv")}><Download size={13} /> Unduh CSV</button>
                    <button className="button button-secondary compact" type="button" onClick={() => exportResult("xlsx")}><Download size={13} /> Unduh Excel</button>
                  </div>
                </div>
                <div className="cmp-toolbar">
                  <div className="cmp-chips" role="group" aria-label="Filter status">
                    {FILTERS.map(([value, label]) => <button key={value} type="button" className={`cmp-chip ${filter === value ? "is-active" : ""}`} onClick={() => setFilter(value)}>{label} <b>{formatCount(counts[value])}</b></button>)}
                  </div>
                  <label className="cmp-search"><Search size={14} /><input type="search" value={search} placeholder="Cari nomor struk / no order..." onChange={(event) => setSearch(event.target.value)} /></label>
                </div>
                {visible.length === 0 ? <div className="notice notice-success" style={{ margin: 16 }}>Tidak ada hasil untuk filter ini.</div> : (
                  <div className="excel-scroll">
                    <table className="cmp-table">
                      <thead><tr><th>HASIL</th><th>NOMOR STRUK / NO ORDER</th><th>FILE 1</th><th>FILE 2</th><th>KETERANGAN</th></tr></thead>
                      <tbody>{pageRows.map((record) => {
                        const note = noteFor(record);
                        return (
                          <tr key={`${record.status}-${record.key}`} className="cmp-row" tabIndex={0} onClick={() => setSelected(record)} onKeyDown={(event) => { if (event.key === "Enter") setSelected(record); }}>
                            <td><span className={`status-pill ${pillClass(record.status)}`}>{STATUS_LABEL[record.status]}</span></td>
                            <td className="cmp-number">{record.key}</td>
                            <td className={record.idx1.length ? "" : "cmp-none"}>{presence(record.idx1.length)}</td>
                            <td className={record.idx2.length ? "" : "cmp-none"}>{presence(record.idx2.length)}</td>
                            <td><span className="cmp-note">{note.text}</span>{note.detail && <small className="cmp-note-detail">{note.detail}</small>}</td>
                          </tr>
                        );
                      })}</tbody>
                    </table>
                  </div>
                )}
                <div className="cmp-pager">
                  <span className="result-count">{visible.length ? `${formatCount((currentPage - 1) * PAGE_SIZE + 1)}–${formatCount(Math.min(currentPage * PAGE_SIZE, visible.length))} dari ${formatCount(visible.length)}` : "0 hasil"}</span>
                  <div className="section-actions">
                    <button className="button button-secondary compact" type="button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Sebelumnya</button>
                    <span className="result-count">Hal. {currentPage} / {pageCount}</span>
                    <button className="button button-secondary compact" type="button" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>Berikutnya</button>
                  </div>
                </div>
              </section>

              {totals && (
                <section className="excel-preview">
                  <div className="section-heading">
                    <div><h2>Ringkasan total</h2><span>Dihitung dari seluruh baris tiap file. Selisih = File 2 − File 1. Total mengikuti aturan CEK STRUK (memakai Paid Amount jika ada).</span></div>
                  </div>
                  <div className="excel-scroll">
                    <table>
                      <thead><tr><th>Pembanding</th><th className="numeric">{files[0]?.name || "File 1"}</th><th className="numeric">{files[1]?.name || "File 2"}</th><th className="numeric">Selisih</th><th>Status</th></tr></thead>
                      <tbody>{totals.lines.map((line) => (
                        <tr key={line.metric}>
                          <td><strong>{line.label}</strong></td>
                          <td className="numeric">{formatValue(line, line.file1)}</td>
                          <td className="numeric">{formatValue(line, line.file2)}</td>
                          <td className="numeric">{formatDifference(line)}</td>
                          <td><span className={`status-pill ${line.status === "SAMA" ? "is-same" : "is-diff"}`}>{line.status === "SAMA" ? "Sama" : "Berbeda"}</span></td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </main>

      {selected && datasets[0] && datasets[1] && (
        <div className="modal-backdrop" onClick={() => setSelected(null)}>
          <div className="modal-card cmp-modal" role="dialog" aria-modal="true" aria-label={`Detail ${selected.key}`} onClick={(event) => event.stopPropagation()}>
            <div className="section-heading">
              <div><h2>{selected.key}</h2><span className={`status-pill ${pillClass(selected.status)}`}>{STATUS_LABEL[selected.status]}</span></div>
              <button className="button button-secondary compact" type="button" onClick={() => setSelected(null)}><X size={13} /> Tutup</button>
            </div>
            {selected.status === "DUPLIKAT" && (
              <div className="notice notice-warning"><AlertTriangle size={17} />
                {[selected.idx1.length > 1 ? `${selected.key} muncul ${selected.idx1.length} kali di File 1.` : "", selected.idx2.length > 1 ? `${selected.key} muncul ${selected.idx2.length} kali di File 2.` : ""].filter(Boolean).join(" ")}
                {" "}Nilai dibandingkan memakai data yang muncul pertama.
              </div>
            )}
            <div className="cmp-detail-grid">
              <div><h3>FILE 1</h3>{blockOf(datasets[0].table, selected.idx1, selected, keys[0], 0)}</div>
              <div><h3>FILE 2</h3>{blockOf(datasets[1].table, selected.idx2, selected, keys[1], 1)}</div>
            </div>
            <div className="cmp-diff-box">
              <h3>YANG BERBEDA</h3>
              {selected.diffs.length === 0 ? <div className="cmp-empty">{selected.idx1.length && selected.idx2.length ? "Tidak ada nilai yang berbeda." : "Data ini tidak ada di file lainnya, jadi tidak ada yang dibandingkan."}</div> : selected.diffs.map((diff) => (
                <div className="cmp-diff" key={diff.field}><b>{diff.label}</b><span>{formatCellValue(diff.field, diff.v1)} → {formatCellValue(diff.field, diff.v2)}</span></div>
              ))}
              {selected.diffs.length > 0 && <small className="cmp-sub">{diffFieldSet(selected).size} nilai berbeda</small>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
