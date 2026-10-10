import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import * as XLSX from "xlsx";
import { AlertTriangle, ArrowLeft, CheckCircle2, Download, FileText, Plus, RotateCcw, Search, ShieldCheck, Trash2, Wand2, X } from "lucide-react";
import { parseReceiptFile } from "@/lib/receiptParser";
import { DELIMITERS, FileReadError, loadTable, openSource, type OpenedSource, type TableData } from "@/lib/compareTable";
import {
  AMOUNT_KIND_LABEL, autoDetectConfig, buildExport, classifyAmount, compareFiles, inputSignature, keyOverlapInfo, MODE_LABEL, pairKeyColumns, readStats, toCsv, validateConfig,
  type AmountKind, type CompareConfig, type CompareRecord, type CompareResult, type CompareStatus, type MatchMode, type NumberFormat,
} from "@/lib/compareFilesEngine";

type Props = { onBack: () => void };
type SlotIdx = 0 | 1;
type SlotState = {
  phase: "empty" | "loading" | "ready" | "error";
  fileName: string; size: number; format: string;
  source: OpenedSource | null; table: TableData | null; error: string;
  sheet: string; headerRow: number | null; delimiter: string | null;
  /** naik setiap kali tabel dibangun ulang (file/sheet/header/delimiter berubah) → dasar penanda hasil kedaluwarsa */
  version: number;
};
type Snapshot = { result: CompareResult; ta: TableData; tb: TableData; names: { a: string; b: string }; sig: string };
type SortKey = "status" | "key" | "taxDelta" | "totalDelta";
/** Filter tampilan tabel detail. Kartu ringkasan dan filter memakai definisi yang sama, sehingga angka kartu = jumlah baris tabel. */
type ViewFilter = "ALL" | "COCOK" | "ONLY_A" | "ONLY_B" | "DUP" | "AMOUNT" | "TAX" | "REVIEW";
const FILTER_LABEL: Record<ViewFilter, string> = { ALL: "Semua transaksi", COCOK: "Cocok", ONLY_A: "Hanya di File A", ONLY_B: "Hanya di File B", DUP: "Duplikat", AMOUNT: "Nominal berbeda", TAX: "Tax berbeda", REVIEW: "Perlu ditinjau" };
const FILTERS: ViewFilter[] = ["ALL", "COCOK", "ONLY_A", "ONLY_B", "DUP", "AMOUNT", "TAX", "REVIEW"];
const matchFilter = (r: CompareRecord, f: ViewFilter): boolean => {
  switch (f) {
    case "ALL": return true;
    case "COCOK": return r.status === "COCOK";
    case "ONLY_A": return !r.noKey && r.idxA.length > 0 && r.idxB.length === 0;
    case "ONLY_B": return !r.noKey && r.idxB.length > 0 && r.idxA.length === 0;
    case "DUP": return r.status === "DUPLIKAT";
    case "AMOUNT": return r.amountDiff;
    case "TAX": return r.taxDiff;
    default: return r.status === "PERLU DITINJAU";
  }
};
const KIND_ROWS: AmountKind[] = ["subtotal", "dpp", "tax", "service", "discount", "total"];
const kindOfPair = (p: { a: number; b: number }, ta: TableData, tb: TableData): AmountKind => {
  const k = p.a >= 0 ? classifyAmount(ta.headers[p.a] ?? "") : "other";
  return k !== "other" ? k : p.b >= 0 ? classifyAmount(tb.headers[p.b] ?? "") : "other";
};
const NA = "tidak tersedia";
const showVal = (v: string | null | undefined, mapped: boolean) => (!mapped ? NA : v === null || v === undefined ? "—" : v.trim() === "" ? "(kosong)" : v);

const EMPTY: SlotState = { phase: "empty", fileName: "", size: 0, format: "", source: null, table: null, error: "", sheet: "", headerRow: null, delimiter: null, version: 0 };
const PAGE_SIZE = 50;
const fmtInt = (n: number) => n.toLocaleString("id-ID");
const fmtSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);
const fmtDelta = (n: number | null) => (n === null ? "" : `${n > 0 ? "+" : ""}${n.toLocaleString("id-ID", { maximumFractionDigits: 4 })}`);
const fmtMoney = (n: number) => n.toLocaleString("id-ID", { maximumFractionDigits: 4 });
const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
const pill = (s: CompareStatus) => (s === "COCOK" ? "is-same" : s === "NOMINAL BERBEDA" ? "is-diff" : s === "DUPLIKAT" || s === "PERLU DITINJAU" ? "is-dup" : "is-missing");
const CLEAN_NAME = (f: string) => f.replace(/\.[^.]+$/, "");

export default function ReceiptCompareChecker({ onBack }: Props) {
  const [slots, setSlots] = useState<[SlotState, SlotState]>([EMPTY, EMPTY]);
  const [cfg, setCfg] = useState<CompareConfig | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState<[boolean, boolean]>([false, false]);
  const [filter, setFilter] = useState<ViewFilter>("ALL");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<CompareRecord | null>(null);
  const [exportFormat, setExportFormat] = useState<"csv" | "xlsx">("csv");
  const [keyConfirmed, setKeyConfirmed] = useState(true);
  const [editKey, setEditKey] = useState(false);
  const inputs = useRef<[HTMLInputElement | null, HTMLInputElement | null]>([null, null]);
  const tokens = useRef<[number, number]>([0, 0]);
  const versions = useRef<[number, number]>([0, 0]);
  const lock = useRef(false);
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLElement | null>(null);

  const ready = slots[0].phase === "ready" && slots[1].phase === "ready";
  const tA = slots[0].table, tB = slots[1].table;
  const configErrors = useMemo(() => (cfg && tA && tB && ready ? validateConfig(cfg, tA, tB) : []), [cfg, tA, tB, ready]);
  const sigNow = inputSignature(slots[0].version, slots[1].version, cfg);
  const stale = !!snap && snap.sig !== sigNow;

  // Deteksi identitas transaksi (nama kolom + isi kolom + irisan nilai antar file) — dihitung dari seluruh baris, bukan preview.
  const pairing = useMemo(() => (ready && tA && tB ? pairKeyColumns(tA, tB) : null), [ready, tA, tB]);
  const keyInfo = useMemo(() => (cfg && ready && tA && tB ? keyOverlapInfo(tA, tB, cfg.a.key, cfg.b.key) : null), [cfg?.a.key, cfg?.b.key, ready, tA, tB]); // eslint-disable-line react-hooks/exhaustive-deps
  const needsKeyConfirm = !!pairing && pairing.confidence !== "high" && !keyConfirmed;
  const statsA = useMemo(() => (tA ? readStats(tA, cfg?.a.key ?? -1) : null), [tA, cfg?.a.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const statsB = useMemo(() => (tB ? readStats(tB, cfg?.b.key ?? -1) : null), [tB, cfg?.b.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── memuat / membangun ulang tabel per file ────────────────────────────────
  const redetect = (a: TableData | null, b: TableData | null) => {
    const both = !!a && !!b;
    setCfg(both ? autoDetectConfig(a as TableData, b as TableData) : null);
    setKeyConfirmed(both ? pairKeyColumns(a as TableData, b as TableData).confidence === "high" : true);
    setEditKey(false);
  };

  // Pemetaan kolom dideteksi ulang setiap kali tabel salah satu file (file/sheet/header/delimiter) berubah.
  useEffect(() => {
    redetect(slots[0].phase === "ready" && slots[1].phase === "ready" ? slots[0].table : null, slots[0].phase === "ready" && slots[1].phase === "ready" ? slots[1].table : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots[0].version, slots[1].version]);

  const applyTable = (i: SlotIdx, next: SlotState) => {
    versions.current[i]++;
    next.version = versions.current[i];
    setSlots((cur) => (i === 0 ? [next, cur[1]] : [cur[0], next]));
  };

  const rebuild = (i: SlotIdx, patch: Partial<Pick<SlotState, "sheet" | "headerRow" | "delimiter">>) => {
    const cur = slots[i];
    if (!cur.source) return;
    const merged = { ...cur, ...patch };
    try {
      const table = loadTable(cur.source, { sheet: merged.sheet || undefined, delimiter: merged.delimiter, headerRow: merged.headerRow });
      applyTable(i, { ...merged, phase: "ready", table, error: "", sheet: table.sheetName ?? merged.sheet });
    } catch (err) {
      applyTable(i, { ...merged, phase: "error", table: null, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const loadFile = async (i: SlotIdx, file?: File) => {
    if (!file) return;
    setError("");
    const token = ++tokens.current[i];
    const base: SlotState = { ...EMPTY, phase: "loading", fileName: file.name, size: file.size, format: (file.name.split(".").pop() ?? "").toUpperCase() };
    versions.current[i]++;
    setSlots((cur) => (i === 0 ? [{ ...base, version: versions.current[i] }, cur[1]] : [cur[0], { ...base, version: versions.current[i] }]));
    await nextPaint();
    try {
      const ext = file.name.toLowerCase().split(".").pop();
      if (ext === "pdf") {
        const parsed = await parseReceiptFile(file);
        if (token !== tokens.current[i]) return;
        if (!parsed.table || !parsed.table.rows.length) throw new FileReadError(parsed.warning ?? "PDF tidak berisi tabel transaksi yang dapat dibaca.");
        const t = parsed.table;
        const table: TableData = { headers: t.headers.map((h, c) => h || `Kolom ${c + 1}`), rows: t.rows, sourceRows: t.sourceRows, headerRow: 0, headerAuto: true, sheetName: null, delimiter: null, delimiterAuto: false, blankRows: 0, repeatedHeaders: 0, warnings: ["PDF dibaca dari teks halaman; periksa hasil pembacaan kolom."] };
        applyTable(i, { ...base, phase: "ready", table, version: 0 });
        return;
      }
      const source = openSource(await file.arrayBuffer(), file.name);
      if (token !== tokens.current[i]) return;
      const table = loadTable(source, {});
      applyTable(i, { ...base, phase: "ready", source, table, sheet: table.sheetName ?? "", delimiter: table.delimiter, headerRow: null, version: 0 });
    } catch (err) {
      if (token !== tokens.current[i]) return;
      applyTable(i, { ...base, phase: "error", error: err instanceof FileReadError ? err.message : `File tidak dapat dibaca: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const pick = (i: SlotIdx, file?: File) => {
    if (!file) return;
    if (!/\.(pdf|xlsx?|csv)$/i.test(file.name)) { setError(`File ${i === 0 ? "A" : "B"} tidak didukung. Gunakan CSV, XLSX, XLS, atau PDF.`); return; }
    void loadFile(i, file);
  };
  const removeFile = (i: SlotIdx) => {
    tokens.current[i]++;
    versions.current[i]++;
    setSlots((cur) => (i === 0 ? [{ ...EMPTY, version: versions.current[0] }, cur[1]] : [cur[0], { ...EMPTY, version: versions.current[1] }]));
    setError("");
    if (inputs.current[i]) inputs.current[i]!.value = "";
  };

  // ── aksi ───────────────────────────────────────────────────────────────────
  const runCompare = async () => {
    if (lock.current || !ready || !cfg || !tA || !tB || configErrors.length || needsKeyConfirm) return;
    lock.current = true;
    setError(""); setSelected(null);
    setBusy("Membandingkan transaksi...");
    const sig = inputSignature(slots[0].version, slots[1].version, cfg);
    try {
      await nextPaint();
      const result = await compareFiles(tA, tB, cfg, (m) => setBusy(m));
      setSnap({ result, ta: tA, tb: tB, names: { a: slots[0].fileName, b: slots[1].fileName }, sig });
      setFilter("ALL"); setSearch(""); setSort(null); setPage(1);
      setTimeout(() => summaryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch (err) {
      setSnap(null);
      setError(`Perbandingan gagal: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      lock.current = false; setBusy("");
    }
  };

  const resetAll = () => {
    tokens.current = [tokens.current[0] + 1, tokens.current[1] + 1];
    versions.current = [versions.current[0] + 1, versions.current[1] + 1];
    setSlots([{ ...EMPTY, version: versions.current[0] }, { ...EMPTY, version: versions.current[1] }]);
    setSnap(null); setError(""); setBusy(""); setFilter("ALL"); setSearch(""); setSort(null); setPage(1); setSelected(null);
    inputs.current.forEach((el) => { if (el) el.value = ""; });
  };

  const exportResult = () => {
    if (!snap || stale) return;
    const data = buildExport(snap.result, snap.ta, snap.tb, snap.names);
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `hasil-bandingkan-${CLEAN_NAME(snap.names.a)}-vs-${CLEAN_NAME(snap.names.b)}-${stamp}`.replace(/[^\w.-]+/g, "_");
    if (exportFormat === "csv") {
      const url = URL.createObjectURL(new Blob([toCsv(data)], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a"); a.href = url; a.download = `${base}.csv`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Ringkasan", "Nilai"], ...data.summary]), "Ringkasan");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([data.header, ...data.rows]), "Hasil");
      if (data.diffRows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([data.diffHeader, ...data.diffRows]), "Selisih per Kolom");
      if (data.pairRows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([data.pairHeader, ...data.pairRows]), "Detail Pemasangan");
      XLSX.writeFile(wb, `${base}.xlsx`);
    }
  };

  // ── tabel hasil: filter + cari + urut + halaman (hanya tampilan; ringkasan tidak berubah) ──
  const counts = useMemo(() => {
    const c = {} as Record<ViewFilter, number>;
    FILTERS.forEach((f) => { c[f] = 0; });
    snap?.result.records.forEach((r) => { FILTERS.forEach((f) => { if (matchFilter(r, f)) c[f]++; }); });
    return c;
  }, [snap]);
  const visible = useMemo(() => {
    if (!snap) return [];
    const term = search.trim().toLowerCase();
    let list = snap.result.records.filter((r) => matchFilter(r, filter) && (!term || [r.key, r.receipt, r.date, r.amountA ?? "", r.amountB ?? "", r.kinds.tax?.a ?? "", r.kinds.tax?.b ?? "", r.note].some((v) => v.toLowerCase().includes(term))));
    if (sort) {
      const val = (r: CompareRecord): string | number => {
        switch (sort.key) {
          case "status": return r.status;
          case "key": return r.key;
          case "taxDelta": return r.kinds.tax?.delta ?? -Infinity;
          default: return r.kinds.total?.delta ?? -Infinity;
        }
      };
      list = [...list].sort((x, y) => {
        const a = val(x), b = val(y);
        const c = typeof a === "number" && typeof b === "number" ? (a === b ? 0 : a < b ? -1 : 1) : String(a).localeCompare(String(b), "id", { numeric: true });
        return c * sort.dir || x.id - y.id;
      });
    }
    return list;
  }, [snap, filter, search, sort]);
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const curPage = Math.min(page, pageCount);
  const pageRows = visible.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [filter, search, sort]);
  useEffect(() => {
    if (!selected) return;
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selected]);

  const toggleSort = (key: SortKey) => setSort((cur) => (cur?.key === key ? (cur.dir === 1 ? { key, dir: -1 } : null) : { key, dir: 1 }));
  const th = (key: SortKey, label: string) => <th className="cmp2-th" onClick={() => toggleSort(key)} aria-sort={sort?.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>{label}{sort?.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}</th>;

  const openCategory = (f: ViewFilter) => {
    setFilter(f); setSearch("");
    setTimeout(() => tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 30);
  };
  const backToSummary = () => {
    setFilter("ALL"); setSearch("");
    setTimeout(() => summaryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 30);
  };

  // ── konfigurasi ────────────────────────────────────────────────────────────
  const setC = (patch: Partial<CompareConfig>) => setCfg((c) => (c ? { ...c, ...patch } : c));
  const setSide = (side: "a" | "b", patch: Partial<CompareConfig["a"]>) => { if ("key" in patch) setKeyConfirmed(true); setCfg((c) => (c ? { ...c, [side]: { ...c[side], ...patch } } : c)); };
  const setPair = (idx: number, patch: Partial<CompareConfig["amounts"][number]>) => setCfg((c) => (c ? { ...c, amounts: c.amounts.map((p, k) => (k === idx ? { ...p, ...patch } : p)) } : c));
  const colSelect = (label: string, table: TableData, value: number, onChange: (v: number) => void, optional = false) => (
    <label className="cmp-select"><span>{label}</span>
      <select value={value} disabled={!!busy} onChange={(e) => onChange(Number(e.target.value))}>
        <option value={-1}>{optional ? "— tidak dipakai —" : "— pilih kolom —"}</option>
        {table.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
      </select>
    </label>
  );

  // ── Langkah 1: kartu file + laporan pembacaan ──────────────────────────────
  const slotCard = (i: SlotIdx) => {
    const s = slots[i];
    const st = i === 0 ? statsA : statsB;
    const title = i === 0 ? "FILE A" : "FILE B";
    const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
    const hasWarning = !!s.table && (s.table.warnings.length > 0 || (st?.emptyKey ?? 0) > 0);
    const skipped = st ? [st.blank ? `${fmtInt(st.blank)} baris kosong` : "", st.repeatedHeaders ? `${fmtInt(st.repeatedHeaders)} header berulang` : "", st.summaryRows ? `${fmtInt(st.summaryRows)} baris ringkasan laporan (Total/Jumlah)` : ""].filter(Boolean) : [];
    return (
      <div
        role="button" tabIndex={0}
        className={`cmp2-slot ${dragging[i] ? "is-dragging" : ""} ${s.phase === "ready" ? "is-ready" : s.phase === "error" ? "is-error" : s.phase === "loading" ? "is-loading" : ""}`}
        onClick={() => inputs.current[i]?.click()}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); inputs.current[i]?.click(); } }}
        onDragEnter={(e) => { e.preventDefault(); if (e.dataTransfer.types.includes("Files")) setDragging((d) => (i === 0 ? [true, d[1]] : [d[0], true])); }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
        onDragLeave={(e) => { e.preventDefault(); if (e.currentTarget.contains(e.relatedTarget as Node | null)) return; setDragging((d) => (i === 0 ? [false, d[1]] : [d[0], false])); }}
        onDrop={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragging([false, false]); pick(i, e.dataTransfer.files?.[0]); }}
      >
        <span className="cmp2-slot-title">{title}</span>
        {s.phase === "empty" && <><strong style={{ fontSize: 16 }}>{dragging[i] ? "LEPAS FILE DI SINI" : "Seret file ke sini"}</strong><span className="mode-card-hint">atau klik untuk memilih · CSV, XLSX, XLS, PDF</span></>}
        {s.phase === "loading" && <><span className="cmp2-name">{s.fileName}</span><span className="mode-card-hint" role="status">Membaca seluruh isi file…</span></>}
        {(s.phase === "ready" || s.phase === "error") && (
          <>
            <span className="cmp2-name">{s.phase === "ready" ? "✓ " : "✕ "}{s.fileName}</span>
            <span className="cmp2-meta"><span>{s.format}</span><span>{fmtSize(s.size)}</span>{s.table && <span>{fmtInt(s.table.headers.length)} kolom</span>}</span>
            <strong style={{ fontSize: 12, color: s.phase === "error" ? "var(--danger)" : hasWarning ? "var(--warning)" : "var(--success)" }}>{s.phase === "error" ? "Gagal dibaca" : hasWarning ? "Dibaca dengan peringatan" : "Berhasil dibaca"}</strong>
            {s.phase === "error" && <span style={{ fontSize: 12, color: "var(--danger)" }}>{s.error}</span>}
            {s.table && st && (
              <div className="cmp3-read">
                <div><b>{fmtInt(st.rowsRead)}</b> baris data terbaca · <b>{fmtInt(st.valid)}</b> baris valid</div>
                <div>{skipped.length ? `Dilewati: ${skipped.join(", ")}.` : "Tidak ada baris yang dilewati."}</div>
                <div>Header di baris {s.table.headerRow || "—"}{s.table.sheetName ? ` · worksheet "${s.table.sheetName}"` : ""}</div>
                {st.emptyKey > 0 && <div style={{ color: "var(--warning)" }}>⚠ {fmtInt(st.emptyKey)} baris tanpa identitas transaksi — tetap dihitung, tetapi tidak dapat dicocokkan.</div>}
              </div>
            )}
            {s.table?.warnings.map((w) => <span key={w} style={{ fontSize: 11, color: "var(--warning)" }}>⚠ {w}</span>)}
            {s.source && (
              <div className="cmp2-opts" onClick={stop} onKeyDown={stop}>
                {s.source.sheets.length > 1 && (
                  <label className="cmp-select"><span>Worksheet</span><select value={s.sheet} disabled={!!busy} onChange={(e) => rebuild(i, { sheet: e.target.value, headerRow: null })}>{s.source.sheets.map((n) => <option key={n}>{n}</option>)}</select></label>
                )}
              </div>
            )}
            {s.table && (
              <details className="cmp3-details" onClick={stop} onKeyDown={stop}>
                <summary>Kolom terdeteksi & pengaturan pembacaan</summary>
                <div className="cmp3-chips">{s.table.headers.map((h, c) => <span key={c} className="cmp3-chip">{h}</span>)}</div>
                {s.source && (
                  <div className="cmp2-opts">
                    {s.source.format === "csv" && (
                      <label className="cmp-select"><span>Delimiter{s.table.delimiterAuto ? " (otomatis)" : ""}</span><select value={s.delimiter ?? ","} disabled={!!busy} onChange={(e) => rebuild(i, { delimiter: e.target.value })}>{DELIMITERS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}</select></label>
                    )}
                    <label className="cmp-select"><span>Baris header{s.headerRow === null ? " (otomatis)" : ""}</span>
                      <input type="number" min={1} placeholder="otomatis" value={s.headerRow ?? ""} disabled={!!busy} style={{ minHeight: 34, padding: "0 10px", border: "1px solid var(--line-strong)", borderRadius: 6, background: "var(--surface)", color: "var(--ink)", width: 110 }}
                        onChange={(e) => { const v = e.target.value; rebuild(i, { headerRow: v === "" ? null : Math.max(1, Math.floor(Number(v))) }); }} />
                    </label>
                  </div>
                )}
              </details>
            )}
          </>
        )}
        <span className="cmp-drop-actions" onClick={stop}>
          <button className="button button-secondary compact" type="button" disabled={s.phase === "loading"} onClick={() => inputs.current[i]?.click()}>{s.phase === "empty" ? "Pilih File" : "Ganti File"}</button>
          {s.phase !== "empty" && <button className="button button-ghost compact" type="button" onClick={() => removeFile(i)}><X size={13} /> Hapus</button>}
        </span>
        <input ref={(el) => { inputs.current[i] = el; }} type="file" accept=".csv,.xlsx,.xls,.pdf" hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { pick(i, e.target.files?.[0]); e.target.value = ""; }} />
      </div>
    );
  };

  const statusLine = busy ? busy
    : !slots[0].fileName && !slots[1].fileName ? "Belum ada file. Pilih File A dan File B."
    : slots[0].phase === "ready" && !slots[1].fileName ? "File A sudah dimuat. Pilih File B."
    : slots[1].phase === "ready" && !slots[0].fileName ? "File B sudah dimuat. Pilih File A."
    : ready ? (snap ? (stale ? "Hasil kedaluwarsa — jalankan perbandingan kembali." : "Perbandingan selesai.") : needsKeyConfirm ? "Pastikan kolom identitas transaksi di atas sudah benar." : "Kedua file valid. Klik Bandingkan File.")
    : "Salah satu file belum valid.";

  const S = snap?.result.summary;
  const hasTaxPair = !!snap && snap.result.totals.some((t) => t.kind === "tax");
  const blockRows = (table: TableData, idx: number[], record: CompareRecord, label: string) => {
    if (!idx.length) return <div className="cmp-empty">Tidak ada baris di {label}.</div>;
    const diffLabels = new Set(record.pairs.flatMap((p) => p.diffs.map((d) => d.label)));
    return idx.map((r, n) => (
      <div key={r}>
        <div className="cmp-occurrence">{label} · baris sumber {table.sourceRows[r]}{idx.length > 1 ? ` (muncul ke-${n + 1})` : ""}</div>
        {table.headers.map((h, c) => <div key={c} className={`cmp-kv ${diffLabels.has(h) ? "is-changed" : ""}`}><span>{h}</span><b>{table.rows[r][c] || "(kosong)"}</b></div>)}
      </div>
    ));
  };

  const cards: Array<{ f: ViewFilter; tone: string; hint: string }> = [
    { f: "COCOK", tone: "is-same", hint: "Identitas ada di kedua file dan semua nilai cocok" },
    { f: "ONLY_A", tone: "is-missing", hint: "Identitas tidak ditemukan di File B" },
    { f: "ONLY_B", tone: "is-missing", hint: "Identitas tidak ditemukan di File A" },
    { f: "DUP", tone: "is-dup", hint: "Identitas muncul lebih dari sekali" },
    { f: "AMOUNT", tone: "is-diff", hint: "Identitas sama, nominal berbeda" },
    { f: "TAX", tone: "is-diff", hint: "Identitas sama, tax/pajak berbeda" },
    { f: "REVIEW", tone: "is-dup", hint: "Identitas kosong / nilai ambigu" },
  ];

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
              <h1>Bandingkan dua<br /><em>file transaksi.</em></h1>
              <p>Cocokkan transaksi satu per satu berdasarkan nomor struk/order/ID, lalu lihat transaksi yang hilang, duplikat, atau berbeda nominal dan pajaknya. Semua diproses lokal di browser.</p>
            </div>
          </section>

          {/* Langkah 1 — upload */}
          <section className="input-panel panel-surface">
            <div className="panel-heading"><div className="panel-title-wrap"><span className="section-number">01</span><div><h2>Upload file</h2><p>Pilih dua file (CSV, Excel, atau PDF). Seluruh baris dibaca, bukan hanya preview.</p></div></div></div>
            <div className="cmp2-slots">{slotCard(0)}{slotCard(1)}</div>
            <div className="privacy-note" style={{ marginTop: 12 }}><ShieldCheck size={15} /> File asli tidak diubah · proses lokal</div>
          </section>

          {/* Langkah 2 — pencocokan */}
          {ready && cfg && tA && tB && (
            <section className="excel-preview cmp-identity" style={{ marginTop: 20 }}>
              <div className="section-heading">
                <div><h2><span className="section-number" style={{ marginRight: 8 }}>02</span>Pencocokan data</h2><span>Kolom identitas transaksi dan kolom nominal terdeteksi otomatis dari isi kedua file.</span></div>
                <div className="section-actions"><button className="button button-secondary compact" type="button" disabled={!!busy} onClick={() => redetect(tA, tB)}><Wand2 size={13} /> Deteksi ulang</button></div>
              </div>

              <div className="cmp3-block">
                <div className="cmp3-block-head">
                  <b>Identitas transaksi</b>
                  {pairing?.confidence === "high" && keyConfirmed
                    ? <span className="cmp3-badge is-ok"><CheckCircle2 size={12} /> Terdeteksi otomatis</span>
                    : <span className="cmp3-badge is-warn"><AlertTriangle size={12} /> {pairing?.confidence === "none" ? "Belum ditemukan — pilih kolom" : needsKeyConfirm ? "Belum meyakinkan — periksa kolom" : "Dipilih manual"}</span>}
                </div>
                <div className="cmp3-pairline">
                  <span><small>File A</small><b>{cfg.a.key >= 0 ? tA.headers[cfg.a.key] : "— belum dipilih —"}</b></span>
                  <span className="cmp3-arrow">↔</span>
                  <span><small>File B</small><b>{cfg.b.key >= 0 ? tB.headers[cfg.b.key] : "— belum dipilih —"}</b></span>
                  {pairing?.confidence === "high" && <button className="button button-ghost compact" type="button" onClick={() => setEditKey((v) => !v)}>{editKey ? "Sembunyikan pilihan" : "Ubah"}</button>}
                </div>
                {keyInfo && cfg.a.key >= 0 && cfg.b.key >= 0 && (
                  <div className="cmp3-hint">{fmtInt(keyInfo.matched)} identitas sama ditemukan di kedua file · {fmtInt(keyInfo.uniqueA)} identitas unik di File A · {fmtInt(keyInfo.uniqueB)} di File B.{keyInfo.matched === 0 ? " Tidak ada identitas yang sama — pastikan kolomnya benar atau file memang berisi transaksi yang berbeda." : ""}</div>
                )}
                {(editKey || pairing?.confidence !== "high") && (
                  <div className="cmp2-config" style={{ padding: "10px 0 0" }}>
                    <div className="cmp2-fields">{colSelect("Kolom identitas File A", tA, cfg.a.key, (v) => setSide("a", { key: v, receipt: v }))}</div>
                    <div className="cmp2-fields">{colSelect("Kolom identitas File B", tB, cfg.b.key, (v) => setSide("b", { key: v, receipt: v }))}</div>
                  </div>
                )}
                {needsKeyConfirm && (
                  <div style={{ marginTop: 10 }}>
                    <button className="button button-secondary compact" type="button" disabled={cfg.a.key < 0 || cfg.b.key < 0} onClick={() => setKeyConfirmed(true)}><CheckCircle2 size={13} /> Gunakan pasangan kolom ini</button>
                  </div>
                )}
              </div>

              <div className="cmp3-block">
                <div className="cmp3-block-head"><b>Nominal yang dibandingkan</b></div>
                <div className="cmp3-kinds">
                  {KIND_ROWS.map((k) => {
                    const p = cfg.amounts.find((x) => kindOfPair(x, tA, tB) === k);
                    return (
                      <div key={k} className={`cmp3-kind ${p ? "" : "is-missing"}`}>
                        <span>{AMOUNT_KIND_LABEL[k]}</span>
                        <b>{p && p.a >= 0 && p.b >= 0 ? `${tA.headers[p.a]} ↔ ${tB.headers[p.b]}` : "tidak ditemukan di kedua file"}</b>
                      </div>
                    );
                  })}
                  {cfg.amounts.filter((x) => kindOfPair(x, tA, tB) === "other").map((p, n) => (
                    <div key={`o${n}`} className="cmp3-kind"><span>Lainnya</span><b>{p.a >= 0 && p.b >= 0 ? `${tA.headers[p.a]} ↔ ${tB.headers[p.b]}` : "belum lengkap"}</b></div>
                  ))}
                </div>
                {!cfg.amounts.some((x) => kindOfPair(x, tA, tB) === "tax") && <div className="cmp3-hint" style={{ color: "var(--warning)" }}>⚠ Kolom tax/pajak tidak ditemukan di kedua file, sehingga selisih tax belum bisa dibandingkan. Tambahkan lewat Pengaturan lanjutan bila ada.</div>}
              </div>

              <details className="cmp3-details cmp3-advanced">
                <summary>Pengaturan lanjutan</summary>
                <div style={{ padding: "10px 0 4px" }}><h3 style={{ margin: 0, color: "var(--amber)", fontFamily: "var(--mono)", fontSize: 10.5, letterSpacing: ".14em" }}>PASANGAN KOLOM NOMINAL (File A ↔ File B)</h3></div>
                <div className="cmp2-pairs" style={{ padding: 0, marginTop: 8 }}>
                  {cfg.amounts.length === 0 && <span style={{ fontSize: 11.5, color: "var(--muted)" }}>Belum ada pasangan nominal. Tambahkan minimal satu agar nominal dibandingkan.</span>}
                  {cfg.amounts.map((p, k) => (
                    <div className="cmp2-pair" key={k}>
                      {colSelect("File A", tA, p.a, (v) => setPair(k, { a: v, label: v >= 0 ? tA.headers[v] : p.label }))}
                      {colSelect("File B", tB, p.b, (v) => setPair(k, { b: v }))}
                      <button className="button button-ghost compact" type="button" aria-label="Hapus pasangan nominal" onClick={() => setC({ amounts: cfg.amounts.filter((_, j) => j !== k) })}><Trash2 size={13} /></button>
                    </div>
                  ))}
                  <div><button className="button button-secondary compact" type="button" onClick={() => setC({ amounts: [...cfg.amounts, { a: -1, b: -1, label: "Nominal" }] })}><Plus size={13} /> Tambah pasangan nominal</button></div>
                </div>
                <div className="cmp2-config" style={{ padding: "14px 0 6px" }}>
                  {colSelect("Kolom tanggal File A", tA, cfg.a.date, (v) => setSide("a", { date: v }), true)}
                  {colSelect("Kolom tanggal File B", tB, cfg.b.date, (v) => setSide("b", { date: v }), true)}
                  {colSelect("Kolom nomor struk File A (opsional, dibandingkan terpisah)", tA, cfg.a.receipt, (v) => setSide("a", { receipt: v }), true)}
                  {colSelect("Kolom nomor struk File B (opsional, dibandingkan terpisah)", tB, cfg.b.receipt, (v) => setSide("b", { receipt: v }), true)}
                  <label className="cmp-select"><span>Mode pencocokan transaksi</span>
                    <select value={cfg.mode} onChange={(e) => setC({ mode: e.target.value as MatchMode })}>{(Object.keys(MODE_LABEL) as MatchMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}</select>
                  </label>
                  <label className="cmp-select"><span>Format angka</span>
                    <select value={cfg.numberFormat} onChange={(e) => setC({ numberFormat: e.target.value as NumberFormat })}>
                      <option value="auto">Otomatis (deteksi dari data)</option><option value="id">Indonesia (1.234,56)</option><option value="en">Internasional (1,234.56)</option>
                    </select>
                  </label>
                  <label className="cmp-select"><span>Toleransi nominal (0 = eksak)</span>
                    <input type="number" min={0} step="any" value={cfg.tolerance} onChange={(e) => setC({ tolerance: e.target.value === "" ? 0 : Number(e.target.value) })} style={{ minHeight: 34, padding: "0 10px", border: "1px solid var(--line-strong)", borderRadius: 6, background: "var(--surface)", color: "var(--ink)" }} />
                  </label>
                </div>
                <div className="cmp2-options" style={{ padding: "6px 0 10px" }}>
                  <label><input type="checkbox" checked={cfg.trim} onChange={(e) => setC({ trim: e.target.checked })} /> Abaikan spasi di awal/akhir</label>
                  <label><input type="checkbox" checked={cfg.normalizeDate} onChange={(e) => setC({ normalizeDate: e.target.checked })} /> Normalisasi format tanggal</label>
                  <label><input type="checkbox" checked={cfg.normalizeNumber} onChange={(e) => setC({ normalizeNumber: e.target.checked })} /> Normalisasi angka & pemisah ribuan</label>
                  <label><input type="checkbox" checked={cfg.caseSensitive} onChange={(e) => setC({ caseSensitive: e.target.checked })} /> Bedakan huruf besar/kecil</label>
                </div>
              </details>

              <div className="cmp-actions" style={{ padding: "6px 20px 18px" }}>
                <button className={`button button-primary ${busy ? "is-loading" : ""}`} type="button" disabled={!ready || !cfg || configErrors.length > 0 || needsKeyConfirm || !!busy} onClick={() => void runCompare()}>Bandingkan File</button>
                <button className="button button-secondary" type="button" disabled={!!busy} onClick={resetAll}><RotateCcw size={14} /> Reset</button>
              </div>
              <div role="status" aria-live="polite" style={{ padding: "0 20px 16px", fontSize: 12, color: "var(--muted)" }}>{statusLine}</div>
              {configErrors.length > 0 && <div className="notice notice-warning" style={{ flexDirection: "column", alignItems: "flex-start", gap: 2, margin: "0 20px 16px" }}>{configErrors.map((e) => <span key={e}>⚠ {e}</span>)}</div>}
            </section>
          )}
          {!(ready && cfg) && (
            <div role="status" aria-live="polite" style={{ marginTop: 14, fontSize: 12, color: "var(--muted)" }}>{statusLine}</div>
          )}

          {error && <div className="notice notice-error">{error}</div>}
          {stale && <div className="notice notice-warning"><AlertTriangle size={17} /> Hasil di bawah sudah kedaluwarsa karena file atau konfigurasi berubah. Klik Bandingkan File untuk memperbarui. Ekspor dinonaktifkan sampai hasil diperbarui.</div>}

          {/* Langkah 3 — hasil */}
          {snap && S && (
            <div className={stale ? "cmp2-stale" : ""} ref={summaryRef} style={{ scrollMarginTop: 12 }}>
              {snap.result.notes.map((n) => <div key={n} className="notice notice-warning"><AlertTriangle size={17} /> {n}</div>)}
              {!hasTaxPair && <div className="notice notice-warning"><AlertTriangle size={17} /> Kolom tax/pajak tidak dipetakan, jadi selisih tax tidak diperiksa pada perbandingan ini.</div>}
              <section className="cmp-summary" aria-label="Ringkasan hasil" style={{ marginTop: 18 }}>
                <div className="panel-title-wrap" style={{ marginBottom: 4 }}><span className="section-number">03</span><div><h2 style={{ margin: 0 }}>Hasil perbandingan</h2><p style={{ margin: 0, fontSize: 12, color: "var(--muted)" }}>Klik kartu untuk melihat daftar transaksinya.</p></div></div>
                <div className="cmp3-counts">
                  <table>
                    <thead><tr><th></th><th className="numeric">File A</th><th className="numeric">File B</th></tr></thead>
                    <tbody>
                      <tr><td>Baris valid</td><td className="numeric">{fmtInt(S.totalA)}</td><td className="numeric">{fmtInt(S.totalB)}</td></tr>
                      <tr><td>Identitas transaksi unik</td><td className="numeric">{fmtInt(S.uniqueKeysA)}</td><td className="numeric">{fmtInt(S.uniqueKeysB)}</td></tr>
                      <tr><td>Identitas ada di kedua file</td><td className="numeric" colSpan={2}>{fmtInt(S.keysBoth)}</td></tr>
                    </tbody>
                  </table>
                </div>
                <div className="cmp2-cards cmp3-cards">
                  {cards.map(({ f, tone, hint }) => (
                    <button key={f} type="button" className={`cmp-card cmp-card-btn ${tone} ${filter === f ? "is-active" : ""}`} onClick={() => openCategory(f)} aria-pressed={filter === f}>
                      <span className="cmp-card-title">{FILTER_LABEL[f]}</span><strong>{fmtInt(counts[f])}</strong><small>{hint}</small>
                    </button>
                  ))}
                </div>
                <div style={{ marginTop: 8, fontSize: 11, color: "var(--muted)" }}>
                  Kartu Cocok, Perlu ditinjau, dan Duplikat adalah status yang saling terpisah. Kartu Hanya di File A/B, Nominal berbeda, dan Tax berbeda dapat tumpang tindih dengan Duplikat, sehingga jangan dijumlahkan. Baris kosong ({fmtInt(S.blankRowsA)} di A, {fmtInt(S.blankRowsB)} di B) dan baris ringkasan laporan ({fmtInt(S.summaryRowsA)} di A, {fmtInt(S.summaryRowsB)} di B) tidak dihitung sebagai transaksi.
                </div>
              </section>

              <section className="excel-preview" style={{ marginTop: 18 }}>
                <div className="section-heading"><div><h2>Total nominal per file</h2><span>Dijumlahkan dari seluruh transaksi tiap file; nilai ambigu tidak ikut dijumlahkan dan dilaporkan terpisah. Selisih = File B − File A.</span></div></div>
                <div className="excel-scroll"><table>
                  <thead><tr><th>Jenis</th><th>Kolom</th><th className="numeric">File A</th><th className="numeric">File B</th><th className="numeric">Selisih</th><th>Nilai ambigu (A / B)</th></tr></thead>
                  <tbody>
                    {KIND_ROWS.map((k) => {
                      const t = snap.result.totals.find((x) => x.kind === k);
                      if (!t) return <tr key={k}><td><strong>{AMOUNT_KIND_LABEL[k]}</strong></td><td colSpan={5} className="cmp-none">{NA}</td></tr>;
                      const d = Math.round((t.sumB - t.sumA) * 1e4) / 1e4;
                      return <tr key={k}><td><strong>{AMOUNT_KIND_LABEL[k]}</strong></td><td>{t.label}</td><td className="numeric">{fmtMoney(t.sumA)}</td><td className="numeric">{fmtMoney(t.sumB)}</td><td className="numeric" style={d !== 0 ? { color: "var(--danger)", fontWeight: 700 } : undefined}>{fmtDelta(d) || "0"}</td><td>{t.ambiguousA} / {t.ambiguousB}</td></tr>;
                    })}
                    {snap.result.totals.filter((x) => x.kind === "other").map((t) => {
                      const d = Math.round((t.sumB - t.sumA) * 1e4) / 1e4;
                      return <tr key={`o-${t.label}`}><td><strong>Lainnya</strong></td><td>{t.label}</td><td className="numeric">{fmtMoney(t.sumA)}</td><td className="numeric">{fmtMoney(t.sumB)}</td><td className="numeric">{fmtDelta(d) || "0"}</td><td>{t.ambiguousA} / {t.ambiguousB}</td></tr>;
                    })}
                  </tbody>
                </table></div>
              </section>

              {/* tabel detail */}
              <section className="excel-preview mismatch-section" style={{ marginTop: 18, scrollMarginTop: 12 }} ref={tableRef}>
                <div className="section-heading">
                  <div><h2>{FILTER_LABEL[filter]}</h2><span>{fmtInt(visible.length)} transaksi{filter !== "ALL" || search.trim() ? ` (difilter dari ${fmtInt(counts.ALL)})` : ""}. Filter dan pencarian hanya mengubah tampilan tabel, bukan angka ringkasan.</span></div>
                  <div className="section-actions">
                    {filter !== "ALL" && <button className="button button-secondary compact" type="button" onClick={backToSummary}><ArrowLeft size={13} /> Kembali ke ringkasan</button>}
                    <button className="button button-secondary compact" type="button" disabled={!snap || stale || !!busy} onClick={exportResult} title={stale ? "Hasil kedaluwarsa" : "Ekspor seluruh hasil"}><Download size={13} /> Ekspor Hasil</button>
                    <select aria-label="Format ekspor" value={exportFormat} onChange={(e) => setExportFormat(e.target.value as "csv" | "xlsx")} style={{ minHeight: 32, border: "1px solid var(--line-strong)", borderRadius: 6, background: "var(--surface)", color: "var(--ink)", padding: "0 8px" }}><option value="csv">CSV</option><option value="xlsx">Excel (.xlsx)</option></select>
                  </div>
                </div>
                <div className="cmp-toolbar">
                  <label className="cmp-select" style={{ minWidth: 220 }}><span>Filter status</span>
                    <select value={filter} onChange={(e) => setFilter(e.target.value as ViewFilter)}>{FILTERS.map((f) => <option key={f} value={f}>{FILTER_LABEL[f]} ({fmtInt(counts[f])})</option>)}</select>
                  </label>
                  <label className="cmp-search"><Search size={14} /><input type="search" value={search} placeholder="Cari identitas, tanggal, nominal, alasan..." onChange={(e) => setSearch(e.target.value)} /></label>
                </div>
                {visible.length === 0 ? <div className="notice notice-success" style={{ margin: 16 }}>Tidak ada transaksi untuk filter ini.</div> : (
                  <div className="excel-scroll"><table className="cmp-table">
                    <thead><tr>{th("status", "STATUS")}{th("key", "IDENTITAS")}<th>TANGGAL</th><th className="numeric">TAX A</th><th className="numeric">TAX B</th>{th("taxDelta", "SELISIH TAX")}<th className="numeric">TOTAL A</th><th className="numeric">TOTAL B</th>{th("totalDelta", "SELISIH TOTAL")}<th>ALASAN</th></tr></thead>
                    <tbody>{pageRows.map((r) => {
                      const tax = r.kinds.tax, tot = r.kinds.total;
                      const dTax = tax?.delta ?? null, dTot = tot?.delta ?? null;
                      return (
                        <tr key={r.id} className="cmp-row" tabIndex={0} onClick={() => setSelected(r)} onKeyDown={(e) => { if (e.key === "Enter") setSelected(r); }}>
                          <td><span className={`status-pill ${pill(r.status)}`}>{r.status}</span>{r.taxDiff && <small className="cmp-sub" style={{ color: "var(--danger)", fontWeight: 700 }}>Tax berbeda</small>}</td>
                          <td className="cmp-number">{r.key}{r.receipt && r.receipt.trim().toLowerCase() !== r.key.toLowerCase() ? <small className="cmp-sub">no struk: {r.receipt}</small> : null}<small className="cmp-sub">A: {r.idxA.length ? `baris ${r.idxA.map((i) => snap.ta.sourceRows[i]).join(", ")}` : "tidak ada"} · B: {r.idxB.length ? `baris ${r.idxB.map((i) => snap.tb.sourceRows[i]).join(", ")}` : "tidak ada"}</small></td>
                          <td>{r.date || <span className="cmp-none">—</span>}</td>
                          <td className="numeric">{showVal(tax?.a, !!tax)}</td>
                          <td className="numeric">{showVal(tax?.b, !!tax)}</td>
                          <td className="numeric" style={dTax ? { color: "var(--danger)", fontWeight: 700 } : undefined}>{tax ? (dTax === null ? (tax.a !== null && tax.b !== null && tax.a.trim() !== tax.b.trim() ? "berbeda" : "") : fmtDelta(dTax)) : NA}</td>
                          <td className="numeric">{showVal(tot?.a, !!tot)}</td>
                          <td className="numeric">{showVal(tot?.b, !!tot)}</td>
                          <td className="numeric" style={dTot ? { color: "var(--danger)", fontWeight: 700 } : undefined}>{tot ? (dTot === null ? "" : fmtDelta(dTot)) : NA}</td>
                          <td style={{ minWidth: 220 }}><small className="cmp-note">{r.note}</small></td>
                        </tr>
                      );
                    })}</tbody>
                  </table></div>
                )}
                <div className="cmp-pager">
                  <span className="result-count">{visible.length ? `Menampilkan ${fmtInt((curPage - 1) * PAGE_SIZE + 1)}–${fmtInt(Math.min(curPage * PAGE_SIZE, visible.length))} dari ${fmtInt(visible.length)} transaksi` : `0 dari ${fmtInt(counts.ALL)} transaksi`}</span>
                  <div className="section-actions">
                    <button className="button button-secondary compact" type="button" disabled={curPage <= 1} onClick={() => setPage(curPage - 1)}>Sebelumnya</button>
                    <span className="result-count">Hal. {curPage} / {pageCount}</span>
                    <button className="button button-secondary compact" type="button" disabled={curPage >= pageCount} onClick={() => setPage(curPage + 1)}>Berikutnya</button>
                  </div>
                </div>
              </section>
            </div>
          )}
        </div>
      </main>

      {selected && snap && (
        <div className="modal-backdrop" onClick={() => setSelected(null)}>
          <div className="modal-card cmp-modal" role="dialog" aria-modal="true" aria-label={`Detail ${selected.key}`} onClick={(e) => e.stopPropagation()}>
            <div className="section-heading">
              <div><h2>{selected.key}</h2><span className={`status-pill ${pill(selected.status)}`}>{selected.status}</span>{selected.taxDiff && <span className="status-pill is-diff" style={{ marginLeft: 6 }}>Tax berbeda</span>}</div>
              <button className="button button-secondary compact" type="button" onClick={() => setSelected(null)}><X size={13} /> Tutup</button>
            </div>
            <p style={{ fontSize: 12, color: "var(--muted)" }}>{selected.note}</p>
            {selected.pairs.some((p) => p.diffs.length > 0) && (
              <div className="cmp-diff-box">
                <h3>KOLOM YANG BERBEDA</h3>
                <div className="excel-scroll"><table>
                  <thead><tr><th>Kolom</th><th className="numeric">File A</th><th className="numeric">File B</th><th className="numeric">Selisih (B − A)</th><th>Baris A / B</th></tr></thead>
                  <tbody>{selected.pairs.flatMap((p, n) => p.diffs.map((d) => (
                    <tr key={`${n}-${d.label}`}><td><strong>{d.label}</strong>{d.kind === "tax" ? <small className="cmp-sub" style={{ color: "var(--danger)" }}>Tax berbeda</small> : null}</td><td className="numeric">{d.a.trim() || "(kosong)"}</td><td className="numeric">{d.b.trim() || "(kosong)"}</td><td className="numeric">{d.delta !== null ? fmtDelta(d.delta) : "—"}</td><td>{p.a === null ? "—" : snap.ta.sourceRows[p.a]} / {p.b === null ? "—" : snap.tb.sourceRows[p.b]}</td></tr>
                  )))}</tbody>
                </table></div>
              </div>
            )}
            {selected.pairs.length > 0 && (
              <div className="cmp-diff-box">
                <h3>HASIL PER PASANGAN BARIS</h3>
                {selected.pairs.map((p, n) => (
                  <div className="cmp-diff" key={n} style={{ display: "block" }}>
                    <b>{p.outcome}</b> — File A baris {p.a === null ? "—" : snap.ta.sourceRows[p.a]} · File B baris {p.b === null ? "—" : snap.tb.sourceRows[p.b]}
                    {p.reasons.map((r) => <div key={r} style={{ fontSize: 11.5, color: "var(--warning)" }}>⚠ {r}</div>)}
                  </div>
                ))}
              </div>
            )}
            <div className="cmp-detail-grid">
              <div><h3>BARIS SUMBER FILE A</h3>{blockRows(snap.ta, selected.idxA, selected, "File A")}</div>
              <div><h3>BARIS SUMBER FILE B</h3>{blockRows(snap.tb, selected.idxB, selected, "File B")}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
