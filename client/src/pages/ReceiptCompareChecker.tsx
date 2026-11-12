import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import * as XLSX from "xlsx";
import { AlertTriangle, ArrowLeft, CheckCircle2, Copy, Download, FileText, Plus, RotateCcw, Search, ShieldCheck, Trash2, Wand2, X } from "lucide-react";
import { parseReceiptFile } from "@/lib/compare/receiptParser";
import { DELIMITERS, FileReadError, loadTable, openSourceExact, sniffFormat, type OpenedSource, type TableData } from "@/lib/compare/compareTable";
import {
  AMOUNT_KIND_LABEL, autoDetectConfig, buildExport, classifyAmount, compareFiles, DEFAULT_KEY_RULE, inputSignature, keyOverlapInfo, KEY_RULE_LABEL, KEY_RULES, readStats, REVIEW_REASON_LABEL, validateConfig,
  type AmountKind, type CompareConfig, type KeyRule, type CompareRecord, type CompareResult, type CompareStatus,
} from "@/lib/compare/compareFilesEngine";
import { autoIdentity } from "@/lib/compare/identityDetect";
import {
  LIST_CATEGORIES, LIST_HINT, LIST_LABEL, buildCategoryExport, buildCategoryList, categoryToCsv, columnWidths, exportDataToCsv, forceTextCells, receiptsToText,
  type CategoryList, type ListCategory,
} from "@/lib/compare/compareCategoryLists";
import { SidebarBrand } from "@/components/BrandLogo";

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
type SortKey = "status" | "key";
/** Filter tampilan tabel detail. Kartu ringkasan dan filter memakai definisi yang sama, sehingga angka kartu = jumlah baris tabel. */
type ViewFilter = "ALL" | "COCOK" | "ONLY_A" | "ONLY_B" | "DUP" | "REVIEW";
const FILTER_LABEL: Record<ViewFilter, string> = { ALL: "Semua transaksi", COCOK: "Cocok", ONLY_A: "Hanya di File A", ONLY_B: "Hanya di File B", DUP: "Duplikat", REVIEW: "Perlu ditinjau" };
const FILTERS: ViewFilter[] = ["ALL", "COCOK", "ONLY_A", "ONLY_B", "DUP", "REVIEW"];
const matchFilter = (r: CompareRecord, f: ViewFilter): boolean => {
  switch (f) {
    case "ALL": return true;
    case "COCOK": return r.status === "COCOK";
    case "ONLY_A": return !r.noKey && r.idxA.length > 0 && r.idxB.length === 0;
    case "ONLY_B": return !r.noKey && r.idxB.length > 0 && r.idxA.length === 0;
    case "DUP": return r.status === "DUPLIKAT";
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
  const [reviewPage, setReviewPage] = useState(1);
  const [selected, setSelected] = useState<CompareRecord | null>(null);
  const [exportFormat, setExportFormat] = useState<"csv" | "xlsx">("csv");
  const [forceManual, setForceManual] = useState(false);
  const [editKey, setEditKey] = useState(false);
  const [zeroAck, setZeroAck] = useState("");
  const [copied, setCopied] = useState<ListCategory | null>(null);
  const [copyFailed, setCopyFailed] = useState<ListCategory | null>(null);
  const inputs = useRef<[HTMLInputElement | null, HTMLInputElement | null]>([null, null]);
  const tokens = useRef<[number, number]>([0, 0]);
  const versions = useRef<[number, number]>([0, 0]);
  const lock = useRef(false);
  const summaryRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLElement | null>(null);

  const ready = slots[0].phase === "ready" && slots[1].phase === "ready";
  const rawA = slots[0].table, rawB = slots[1].table;
  // Identitas dideteksi otomatis dari SELURUH kolom kedua file (lihat identityDetect.ts).
  const ident = useMemo(() => (ready && rawA && rawB ? autoIdentity(rawA, rawB) : null), [ready, rawA, rawB]);
  const composite = ident?.kind === "composite" && !forceManual ? ident : null;
  const tA = composite ? composite.tableA! : rawA, tB = composite ? composite.tableB! : rawB;
  const configErrors = useMemo(() => (cfg && tA && tB && ready ? validateConfig(cfg, tA, tB) : []), [cfg, tA, tB, ready]);
  const sigNow = inputSignature(slots[0].version, slots[1].version, cfg);
  const stale = !!snap && snap.sig !== sigNow;

  const keyInfo = useMemo(() => (cfg && ready && tA && tB ? keyOverlapInfo(tA, tB, cfg.a.key, cfg.b.key, cfg.keyRule ?? DEFAULT_KEY_RULE, cfg.caseSensitive) : null), [cfg?.a.key, cfg?.b.key, cfg?.keyRule, cfg?.caseSensitive, ready, tA, tB]); // eslint-disable-line react-hooks/exhaustive-deps
  const keyRatio = keyInfo && Math.min(keyInfo.uniqueA, keyInfo.uniqueB) > 0 ? keyInfo.matched / Math.min(keyInfo.uniqueA, keyInfo.uniqueB) : 1;
  const lowOverlap = !!keyInfo && cfg !== null && cfg.a.key >= 0 && cfg.b.key >= 0 && keyRatio < 0.5;
  const zeroSig = cfg ? `${cfg.a.key}|${cfg.b.key}|${cfg.keyRule ?? DEFAULT_KEY_RULE}|${slots[0].version}|${slots[1].version}` : "";
  const zeroBlocked = !!keyInfo && keyInfo.matched === 0 && keyInfo.uniqueA > 0 && keyInfo.uniqueB > 0 && zeroAck !== zeroSig;
  const needsKeyConfirm = zeroBlocked;
  const statsA = useMemo(() => (tA ? readStats(tA, cfg?.a.key ?? -1) : null), [tA, cfg?.a.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const statsB = useMemo(() => (tB ? readStats(tB, cfg?.b.key ?? -1) : null), [tB, cfg?.b.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const redetect = () => {
    if (!ready || !tA || !tB || !ident) { setCfg(null); setEditKey(false); return; }
    const base = { ...autoDetectConfig(tA, tB), compareValues: false };
    if (ident.kind !== "none" && !forceManual) {
      base.a = { ...base.a, key: ident.a, receipt: ident.a }; base.b = { ...base.b, key: ident.b, receipt: ident.b };
      base.keyRule = ident.rule;
    }
    setCfg(base); setEditKey(false);
  };
  // Pemetaan dideteksi ulang setiap kali identitas/tabel berubah.
  useEffect(() => { redetect(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ident, forceManual]);

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
      const buffer = await file.arrayBuffer();
      if (token !== tokens.current[i]) return;
      if (sniffFormat(buffer) === "pdf") {
        const parsed = await parseReceiptFile(file);
        if (token !== tokens.current[i]) return;
        if (!parsed.table || !parsed.table.rows.length) throw new FileReadError(parsed.warning ?? "PDF tidak berisi tabel transaksi yang dapat dibaca (PDF hasil scan/gambar tidak didukung; tidak ada OCR).");
        const t = parsed.table;
        const table: TableData = { headers: t.headers.map((h, c) => h || `Kolom ${c + 1}`), rows: t.rows, sourceRows: t.sourceRows, headerRow: 0, headerAuto: true, sheetName: null, delimiter: null, delimiterAuto: false, blankRows: 0, repeatedHeaders: 0, warnings: ["PDF dibaca dari teks halaman; hasil ekstraksi kolom tidak dijamin, periksa kolom terdeteksi sebelum membandingkan."] };
        applyTable(i, { ...base, phase: "ready", table, version: 0 });
        return;
      }
      const source = await openSourceExact(buffer, file.name);
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
    void loadFile(i, file);
  };
  const removeFile = (i: SlotIdx) => {
    tokens.current[i]++;
    versions.current[i]++;
    setSlots((cur) => (i === 0 ? [{ ...EMPTY, version: versions.current[0] }, cur[1]] : [cur[0], { ...EMPTY, version: versions.current[1] }]));
    setError("");
    if (inputs.current[i]) inputs.current[i]!.value = "";
  };

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
      setFilter("ALL"); setSearch(""); setSort(null); setPage(1); setReviewPage(1);
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
      const url = URL.createObjectURL(new Blob([exportDataToCsv(data)], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a"); a.href = url; a.download = `${base}.csv`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, sheetOf([["Ringkasan", "Nilai"], ...data.summary]), "Ringkasan");
      XLSX.utils.book_append_sheet(wb, sheetOf([data.header, ...data.rows], true), "Hasil");
      if (data.diffRows.length) XLSX.utils.book_append_sheet(wb, sheetOf([data.diffHeader, ...data.diffRows], true), "Selisih per Kolom");
      if (data.pairRows.length) XLSX.utils.book_append_sheet(wb, sheetOf([data.pairHeader, ...data.pairRows], true), "Detail Pemasangan");
      if (data.reviewRows.length) XLSX.utils.book_append_sheet(wb, sheetOf([data.reviewHeader, ...data.reviewRows], true), "Perlu Ditinjau");
      XLSX.writeFile(wb, `${base}.xlsx`);
    }
  };

  // ── Salin & ekspor daftar per kategori (fitur tambahan: hanya membaca hasil, tidak mengubah perhitungan) ──
  const lists = useMemo(() => {
    if (!snap) return null;
    const m = {} as Record<ListCategory, CategoryList>;
    LIST_CATEGORIES.forEach((c) => { m[c] = buildCategoryList(snap.result, snap.ta, snap.tb, c); });
    return m;
  }, [snap]);
  /** Sheet Excel rapi: sel teks-angka tetap teks, lebar kolom menyesuaikan isi, dan (untuk tabel) filter di baris judul. */
  const sheetOf = (rows: unknown[][], filter = false) => {
    const ws = XLSX.utils.aoa_to_sheet(rows as never[][]);
    forceTextCells(ws as unknown as Record<string, unknown>);
    const widths = columnWidths(rows as never[][]);
    ws["!cols"] = widths.map((wch) => ({ wch }));
    if (filter && rows.length > 1 && widths.length > 0) ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: widths.length - 1 } }) };
    return ws;
  };
  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const listFileBase = (suffix: string) => `${suffix}-${CLEAN_NAME(snap?.names.a ?? "A")}-vs-${CLEAN_NAME(snap?.names.b ?? "B")}-${new Date().toISOString().slice(0, 10)}`.replace(/[^\w.-]+/g, "_");
  const copyList = async (cat: ListCategory) => {
    if (!lists) return;
    const text = receiptsToText(lists[cat]);
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
    setCopied(ok ? cat : null); setCopyFailed(ok ? null : cat);
    setTimeout(() => { setCopied(null); setCopyFailed(null); }, 2500);
  };
  const exportList = (cat: ListCategory, format: "csv" | "xlsx") => {
    if (!snap || !lists || stale) return;
    const list = lists[cat];
    if (!list.items.length) return;
    const ex = buildCategoryExport(list, snap.ta, snap.tb);
    const base = listFileBase(list.label);
    if (format === "csv") {
      downloadBlob(new Blob([categoryToCsv(ex)], { type: "text/csv;charset=utf-8" }), `${base}.csv`);
    } else {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, sheetOf([["Daftar", list.label], ["File A", snap.names.a], ["File B", snap.names.b], ["Jumlah baris", list.items.length], ["Jumlah nomor struk unik", list.receipts.length]]), "Ringkasan");
      XLSX.utils.book_append_sheet(wb, sheetOf([ex.header, ...ex.rows], true), list.label.slice(0, 31));
      XLSX.writeFile(wb, `${base}.xlsx`);
    }
  };
  const exportAllLists = () => {
    if (!snap || !lists || stale) return;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheetOf([["Daftar", "Jumlah baris", "Nomor struk unik"], ...LIST_CATEGORIES.map((c) => [LIST_LABEL[c], lists[c].items.length, lists[c].receipts.length]), [], ["File A", snap.names.a], ["File B", snap.names.b]], false), "Ringkasan");
    LIST_CATEGORIES.forEach((c) => {
      if (!lists[c].items.length) return;
      const ex = buildCategoryExport(lists[c], snap.ta, snap.tb);
      XLSX.utils.book_append_sheet(wb, sheetOf([ex.header, ...ex.rows], true), LIST_LABEL[c].slice(0, 31));
    });
    XLSX.writeFile(wb, `${listFileBase("semua-daftar")}.xlsx`);
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
    let list = snap.result.records.filter((r) => matchFilter(r, filter) && (!term || [r.key, r.receipt, r.date, r.amountA ?? "", r.amountB ?? "", r.note].some((v) => v.toLowerCase().includes(term))));
    if (sort) {
      const val = (r: CompareRecord): string | number => {
        switch (sort.key) {
          case "status": return r.status;
          case "key": return r.key;
          default: return r.key;
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
  const review = snap?.result.review ?? [];
  const reviewPageCount = Math.max(1, Math.ceil(review.length / PAGE_SIZE));
  const curReviewPage = Math.min(reviewPage, reviewPageCount);
  const reviewRows = review.slice((curReviewPage - 1) * PAGE_SIZE, curReviewPage * PAGE_SIZE);
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

  const setC = (patch: Partial<CompareConfig>) => setCfg((c) => (c ? { ...c, ...patch } : c));
  const setSide = (side: "a" | "b", patch: Partial<CompareConfig["a"]>) => { setCfg((c) => (c ? { ...c, [side]: { ...c[side], ...patch } } : c)); };
  const setPair = (idx: number, patch: Partial<CompareConfig["amounts"][number]>) => setCfg((c) => (c ? { ...c, amounts: c.amounts.map((p, k) => (k === idx ? { ...p, ...patch } : p)) } : c));
  const colSelect = (label: string, table: TableData, value: number, onChange: (v: number) => void, optional = false) => (
    <label className="cmp-select"><span>{label}</span>
      <select value={value} disabled={!!busy} onChange={(e) => onChange(Number(e.target.value))}>
        <option value={-1}>{optional ? "— tidak dipakai —" : "— pilih kolom —"}</option>
        {table.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
      </select>
    </label>
  );

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
        {s.phase === "empty" && <><strong style={{ fontSize: 16 }}>{dragging[i] ? "LEPAS FILE DI SINI" : "Seret file ke sini"}</strong><span className="mode-card-hint">atau klik untuk memilih · CSV, TXT, JSON, XLSX, XLS, PDF (teks)</span></>}
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
                  <label className="cmp-select"><span>{s.source.format === "json" ? "Daftar data JSON" : "Worksheet"}</span><select value={s.sheet} disabled={!!busy} onChange={(e) => rebuild(i, { sheet: e.target.value, headerRow: null })}>{s.source.sheets.map((n) => <option key={n}>{n}</option>)}</select></label>
                )}
              </div>
            )}
            {s.table && (
              <details className="cmp3-details" onClick={stop} onKeyDown={stop}>
                <summary>Kolom terdeteksi & pengaturan pembacaan</summary>
                <div className="cmp3-chips">{s.table.headers.map((h, c) => <span key={c} className="cmp3-chip">{h}</span>)}</div>
                {s.source && (
                  <div className="cmp2-opts">
                    {(s.source.format === "csv" || s.source.format === "txt") && (
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
        <input ref={(el) => { inputs.current[i] = el; }} type="file" accept=".csv,.tsv,.txt,.json,.xlsx,.xls,.pdf,text/*,application/json" hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { pick(i, e.target.files?.[0]); e.target.value = ""; }} />
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
    { f: "COCOK", tone: "is-same", hint: "Identitas ada di kedua file" },
    { f: "ONLY_A", tone: "is-missing", hint: "Identitas tidak ditemukan di File B" },
    { f: "ONLY_B", tone: "is-missing", hint: "Identitas tidak ditemukan di File A" },
    { f: "DUP", tone: "is-dup", hint: "Identitas muncul lebih dari sekali" },
    { f: "REVIEW", tone: "is-dup", hint: "Identitas kosong / nilai ambigu" },
  ];

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <SidebarBrand />
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
              <h1>Bandingkan <em>2 file</em></h1>
              <p>Upload dua file (CSV, TXT, JSON, Excel, atau PDF) lalu bandingkan hasilnya. Diproses lokal di browser.</p>
            </div>
          </section>

          {/* Langkah 1 — upload */}
          <section className="input-panel panel-surface">
            <div className="panel-heading"><div className="panel-title-wrap"><span className="section-number">01</span><div><h2>Upload file</h2><p>Pilih dua file (CSV, TXT, JSON, Excel, atau PDF berteks; format boleh berbeda antar file). Seluruh baris dibaca, bukan hanya preview.</p></div></div></div>
            <div className="notice notice-warning" role="note" style={{ margin: "0 0 14px" }}><AlertTriangle size={15} /> File ESB tidak didukung pada fitur Compare 2 File.</div>
            <div className="cmp2-slots">{slotCard(0)}{slotCard(1)}</div>
            <div className="privacy-note" style={{ marginTop: 12 }}><ShieldCheck size={15} /> File asli tidak diubah · proses lokal</div>
          </section>

          {/* Langkah 2 — pencocokan */}
          {ready && cfg && tA && tB && (
            <section className="excel-preview cmp-identity" style={{ marginTop: 20 }}>
              <div className="section-heading">
                <div><h2><span className="section-number" style={{ marginRight: 8 }}>02</span>Pencocokan data</h2><span>Kolom identitas transaksi dan kolom nominal terdeteksi otomatis dari isi kedua file.</span></div>
                <div className="section-actions"><button className="button button-secondary compact" type="button" disabled={!!busy} onClick={() => { setForceManual(false); redetect(); }}><Wand2 size={13} /> Deteksi ulang</button></div>
              </div>

              <div className="cmp3-block">
                <div className="cmp3-block-head">
                  <b>Identitas transaksi</b>
                  {ident && ident.kind !== "none" && !lowOverlap
                    ? <span className={`cmp3-badge ${ident.confidence === "high" ? "is-ok" : "is-warn"}`}>{ident.confidence === "high" ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />} {composite ? "Identitas alternatif" : "Terdeteksi otomatis"}</span>
                    : <span className="cmp3-badge is-warn"><AlertTriangle size={12} /> {ident?.kind === "none" ? "Belum ditemukan — pilih kolom" : "Kecocokan rendah — periksa"}</span>}
                </div>
                <div className="cmp3-pairline">
                  <span><small>File A</small><b>{cfg.a.key >= 0 ? tA.headers[cfg.a.key] : "— belum dipilih —"}</b></span>
                  <span className="cmp3-arrow">↔</span>
                  <span><small>File B</small><b>{cfg.b.key >= 0 ? tB.headers[cfg.b.key] : "— belum dipilih —"}</b></span>
                  <button className="button button-ghost compact" type="button" onClick={() => setEditKey((v) => !v)}>{editKey ? "Tutup" : "Ubah"}</button>
                </div>
                {ident && ident.kind !== "none" && !forceManual && <div className="cmp3-hint">{ident.explain}</div>}
                {keyInfo && cfg.a.key >= 0 && cfg.b.key >= 0 && (
                  <div className="cmp3-hint"><b>{fmtInt(keyInfo.matched)}</b> dari {fmtInt(Math.min(keyInfo.uniqueA, keyInfo.uniqueB))} identitas cocok ({Math.round(keyRatio * 100)}%) · {fmtInt(keyInfo.uniqueA)} unik di File A · {fmtInt(keyInfo.uniqueB)} di File B.</div>
                )}
                {ident && (ident.sampleA.length > 0 || ident.sampleB.length > 0) && !forceManual && (
                  <div className="cmp3-hint">Contoh identitas — File A: <code>{ident.sampleA.join("  ·  ")}</code> · File B: <code>{ident.sampleB.join("  ·  ")}</code></div>
                )}
                {composite && <div className="notice notice-warning" style={{ margin: "8px 0 0" }}><AlertTriangle size={15} /> Tidak ada nomor struk yang sama di kedua file, jadi pencocokan memakai tanggal + total. Hasil kurang pasti dan “nominal berbeda” tidak dapat terdeteksi. Jika file seharusnya punya nomor struk yang sama, klik Ubah dan pilih kolomnya.</div>}
                {lowOverlap && !composite && <div className="notice notice-warning" style={{ margin: "8px 0 0" }}><AlertTriangle size={15} /> {keyInfo!.matched === 0 ? "Tidak ada identitas yang sama." : "Hanya sebagian kecil identitas yang sama."} Bandingkan contoh di atas: jika nomor struknya memang berbeda sistem, hasil “Hanya di File A/B” bukan indikasi transaksi berbeda. Klik Ubah untuk memilih kolom lain.</div>}
                {(editKey || ident?.kind === "none") && (
                  <div className="cmp2-config" style={{ padding: "10px 0 0" }}>
                    <div className="cmp2-fields">{colSelect("Kolom identitas File A", tA, cfg.a.key, (v) => setSide("a", { key: v, receipt: v }))}</div>
                    <div className="cmp2-fields">{colSelect("Kolom identitas File B", tB, cfg.b.key, (v) => setSide("b", { key: v, receipt: v }))}</div>
                    <label className="cmp-select"><span>Cara mencocokkan nomor</span>
                      <select value={cfg.keyRule ?? DEFAULT_KEY_RULE} onChange={(e) => setC({ keyRule: e.target.value as KeyRule })}>{KEY_RULES.map((r) => <option key={r} value={r}>{KEY_RULE_LABEL[r]}</option>)}</select>
                    </label>
                    {composite && <div><button className="button button-secondary compact" type="button" onClick={() => setForceManual(true)}>Pakai kolom pilihan saya (bukan tanggal+total)</button></div>}
                  </div>
                )}
                {zeroBlocked && (
                  <div style={{ marginTop: 10 }}><button className="button button-secondary compact" type="button" onClick={() => setZeroAck(zeroSig)}>Tetap bandingkan (file memang berisi transaksi berbeda)</button></div>
                )}
              </div>

              <details className="cmp3-details cmp3-advanced">
                <summary>Kolom nominal untuk total per file (jika salah deteksi)</summary>
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
                  Kartu Cocok, Perlu ditinjau, dan Duplikat adalah status yang saling terpisah. Kartu Hanya di File A/B dapat tumpang tindih dengan Duplikat, sehingga jangan dijumlahkan. Baris kosong ({fmtInt(S.blankRowsA)} di A, {fmtInt(S.blankRowsB)} di B) dan baris ringkasan laporan ({fmtInt(S.summaryRowsA)} di A, {fmtInt(S.summaryRowsB)} di B) tidak dihitung sebagai transaksi.
                </div>
              </section>

              {/* Salin & ekspor daftar nomor struk per kategori */}
              {lists && (
                <section className="excel-preview" style={{ marginTop: 18 }} aria-label="Salin dan ekspor daftar nomor struk">
                  <div className="section-heading">
                    <div><h2>Salin &amp; Ekspor Nomor Struk</h2><span>Salin semua nomor struk satu kategori sekaligus (satu nomor per baris, siap ditempel ke Excel), atau ekspor beserta isi lengkap barisnya. Angka di sini hanya membaca hasil perbandingan di atas; tidak mengubah perhitungan.</span></div>
                    <div className="section-actions">
                      <button className="button button-secondary compact" type="button" disabled={stale || !!busy || LIST_CATEGORIES.every((c) => lists[c].items.length === 0)} onClick={exportAllLists} title="Satu file Excel berisi semua daftar (satu sheet per kategori)"><Download size={13} /> Ekspor semua daftar (Excel)</button>
                    </div>
                  </div>
                  <div className="excel-scroll"><table className="cmp-table">
                    <thead><tr><th>DAFTAR</th><th className="numeric">BARIS</th><th className="numeric">NOMOR STRUK UNIK</th><th>AKSI</th></tr></thead>
                    <tbody>
                      {LIST_CATEGORIES.map((c) => {
                        const l = lists[c];
                        return (
                          <tr key={c}>
                            <td><strong>{LIST_LABEL[c]}</strong><small className="cmp-sub">{LIST_HINT[c]}</small>{l.emptyReceiptRows > 0 && <small className="cmp-sub" style={{ color: "var(--warning)" }}>{fmtInt(l.emptyReceiptRows)} baris tanpa nomor struk tidak ikut disalin (tetap ada di ekspor).</small>}</td>
                            <td className="numeric">{fmtInt(l.items.length)}</td>
                            <td className="numeric">{fmtInt(l.receipts.length)}</td>
                            <td style={{ whiteSpace: "nowrap" }}>
                              <button className="button button-secondary compact" type="button" disabled={l.receipts.length === 0} onClick={() => void copyList(c)}><Copy size={13} /> {copied === c ? "Tersalin ✓" : "Salin nomor struk"}</button>{" "}
                              <span style={{ fontSize: 11.5, color: "var(--muted)", marginRight: 4 }}>Ekspor:</span>
                              <button className="button button-secondary compact" type="button" disabled={l.items.length === 0 || stale || !!busy} onClick={() => exportList(c, "xlsx")} title="Unduh sebagai Excel (.xlsx)"><Download size={13} /> Excel</button>{" "}
                              <button className="button button-secondary compact" type="button" disabled={l.items.length === 0 || stale || !!busy} onClick={() => exportList(c, "csv")} title="Unduh sebagai CSV"><Download size={13} /> CSV</button>
                              {copyFailed === c && <small className="cmp-sub" style={{ color: "var(--danger)" }}>Browser menolak menyalin. Izinkan akses clipboard atau gunakan Ekspor.</small>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table></div>
                  <div style={{ padding: "8px 16px 14px", fontSize: 11, color: "var(--muted)" }}>Hanya di File A/B dapat tumpang tindih dengan Duplikat (nomor yang sama bisa muncul di dua daftar). Hasil ekspor berupa satu tabel: No, Nomor Struk, Sumber File, Baris Sumber, Alasan, lalu seluruh kolom asli baris tersebut. Excel: baris judul punya filter dan lebar kolom otomatis.</div>
                </section>
              )}

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

              {/* Perlu Ditinjau: SETIAP baris transaksi tanpa pasangan / duplikat / benturan / kosong / ambigu, dari File A maupun File B */}
              <section className="excel-preview" style={{ marginTop: 18 }} aria-label="Perlu ditinjau">
                <div className="section-heading"><div><h2>Perlu Ditinjau</h2><span>{fmtInt(review.length)} baris transaksi (File A + File B): tidak ditemukan pasangan, nomor struk duplikat, benturan normalisasi, nomor kosong, atau nilai ambigu. Ini bukan vonis salah/hilang — tinjau manual terhadap file sumber.</span></div></div>
                {review.length === 0 ? <div className="notice notice-success" style={{ margin: 16 }}>Semua transaksi berpasangan dan tidak ada yang perlu ditinjau.</div> : (
                  <>
                    <div className="excel-scroll"><table className="cmp-table">
                      <thead><tr><th>SUMBER</th><th>NOMOR STRUK (ASLI)</th><th>TERNORMALISASI</th><th className="numeric">BARIS</th><th>ALASAN</th></tr></thead>
                      <tbody>{reviewRows.map((it) => (
                        <tr key={`${it.source}-${it.row}-${it.recordId}`}>
                          <td><span className={`status-pill ${it.source === "A" ? "is-missing" : "is-diff"}`}>File {it.source}</span></td>
                          <td className="cmp-number">{it.receipt || <span className="cmp-none">(kosong)</span>}</td>
                          <td className="cmp-number">{it.normalized || <span className="cmp-none">—</span>}</td>
                          <td className="numeric">{fmtInt(it.row)}</td>
                          <td style={{ minWidth: 260 }}><strong style={{ fontSize: 12 }}>{it.reasons.map((x) => REVIEW_REASON_LABEL[x]).join("; ")}</strong><small className="cmp-note" style={{ display: "block" }}>{it.detail}</small></td>
                        </tr>
                      ))}</tbody>
                    </table></div>
                    <div className="cmp-pager">
                      <span className="result-count">Menampilkan {fmtInt((curReviewPage - 1) * PAGE_SIZE + 1)}–{fmtInt(Math.min(curReviewPage * PAGE_SIZE, review.length))} dari {fmtInt(review.length)} baris</span>
                      <div className="section-actions">
                        <button className="button button-secondary compact" type="button" disabled={curReviewPage <= 1} onClick={() => setReviewPage(curReviewPage - 1)}>Sebelumnya</button>
                        <span className="result-count">Hal. {curReviewPage} / {reviewPageCount}</span>
                        <button className="button button-secondary compact" type="button" disabled={curReviewPage >= reviewPageCount} onClick={() => setReviewPage(curReviewPage + 1)}>Berikutnya</button>
                      </div>
                    </div>
                  </>
                )}
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
                    <thead><tr>{th("status", "STATUS")}{th("key", "IDENTITAS")}<th>TANGGAL</th><th className="numeric">TOTAL A</th><th className="numeric">TOTAL B</th><th>KETERANGAN</th></tr></thead>
                    <tbody>{pageRows.map((r) => {
                      const tot = r.kinds.total;
                      return (
                        <tr key={r.id} className="cmp-row" tabIndex={0} onClick={() => setSelected(r)} onKeyDown={(e) => { if (e.key === "Enter") setSelected(r); }}>
                          <td><span className={`status-pill ${pill(r.status)}`}>{r.status}</span></td>
                          <td className="cmp-number">{r.key}{r.receipt && r.receipt.trim().toLowerCase() !== r.key.toLowerCase() ? <small className="cmp-sub">no struk: {r.receipt}</small> : null}<small className="cmp-sub">A: {r.idxA.length ? `baris ${r.idxA.map((i) => snap.ta.sourceRows[i]).join(", ")}` : "tidak ada"} · B: {r.idxB.length ? `baris ${r.idxB.map((i) => snap.tb.sourceRows[i]).join(", ")}` : "tidak ada"}</small></td>
                          <td>{r.date || <span className="cmp-none">—</span>}</td>
                          <td className="numeric">{showVal(tot?.a, !!tot)}</td>
                          <td className="numeric">{showVal(tot?.b, !!tot)}</td>
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
              <div><h2>{selected.key}</h2><span className={`status-pill ${pill(selected.status)}`}>{selected.status}</span></div>
              <button className="button button-secondary compact" type="button" onClick={() => setSelected(null)}><X size={13} /> Tutup</button>
            </div>
            <p style={{ fontSize: 12, color: "var(--muted)" }}>{selected.note}</p>
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
