import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { FileSpreadsheet, FileText, Upload } from "lucide-react";
import { formatFileSize, type MonthlyFileResult, type MonthlyProgress } from "@/lib/monthlyCommon";

export type Period = "daily" | "monthly";

/** Pilihan Harian (1 file) / Bulanan (banyak file). */
export function PeriodSwitch({ period, onChange }: { period: Period; onChange: (period: Period) => void }) {
  return (
    <div className="input-actions" role="tablist" aria-label="Mode upload">
      <button className={`button compact ${period === "daily" ? "button-secondary" : "button-ghost"}`} type="button" role="tab" aria-selected={period === "daily"} onClick={() => onChange("daily")}>
        Upload 1 file / Harian
      </button>
      <button className={`button compact ${period === "monthly" ? "button-secondary" : "button-ghost"}`} type="button" role="tab" aria-selected={period === "monthly"} onClick={() => onChange("monthly")}>
        Upload banyak file / Bulanan
      </button>
    </div>
  );
}

/** Dropzone multiple-file (drag & drop + pilih banyak file). */
export function MonthlyDropZone({ accept, kindLabel, hint, disabled, onFiles }: { accept: string; kindLabel: string; hint: string; disabled?: boolean; onFiles: (files: File[]) => void }) {
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const Icon = kindLabel === "CSV" ? FileText : FileSpreadsheet;
  return (
    <div
      className={`drop-zone ${drag ? "is-dragging" : ""}`}
      onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => setDrag(false)}
      onDrop={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDrag(false); if (!disabled) onFiles(Array.from(e.dataTransfer.files)); }}
    >
      <div className="upload-symbol"><Upload size={20} /></div>
      <strong>{drag ? "Lepaskan file bulanan di sini" : "Seret file bulanan ke sini"}</strong>
      <span>atau</span>
      <button className="button button-secondary" type="button" disabled={disabled} onClick={() => inputRef.current?.click()}><Icon size={16} /> Pilih banyak file</button>
      <small>{hint}</small>
      <input ref={inputRef} type="file" accept={accept} multiple hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { onFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
    </div>
  );
}

export function MonthlyProgressBar({ progress }: { progress: MonthlyProgress }) {
  const current = Math.min(progress.done + 1, progress.total);
  const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div className="used-columns" role="status" aria-live="polite">
      <strong>Memproses file {current} dari {progress.total}...</strong>
      <div style={{ width: "100%", height: 8, borderRadius: 4, background: "rgba(128,128,128,.25)", overflow: "hidden" }}>
        <div style={{ width: `${percent}%`, height: "100%", background: "currentColor", transition: "width .15s" }} />
      </div>
      <span>{progress.done} / {progress.total}{progress.fileName ? ` · ${progress.fileName}` : ""}</span>
    </div>
  );
}

const STATUS_ICON = { success: "✓", warning: "⚠", error: "✕" } as const;
const STATUS_LABEL = { success: "berhasil", warning: "warning", error: "error" } as const;

export function MonthlyFileList({ results }: { results: MonthlyFileResult[] }) {
  if (!results.length) return null;
  const success = results.filter((r) => r.status !== "error").length;
  const failed = results.length - success;
  const problems = results.filter((r) => r.status !== "success");
  return (
    <section className="excel-preview">
      <div className="section-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> FILE BULANAN</div>
          <h2>{success.toLocaleString("id-ID")} file berhasil diproses{failed ? ` · ${failed.toLocaleString("id-ID")} file gagal` : ""}</h2>
        </div>
        <span className="result-count">{results.length.toLocaleString("id-ID")} file</span>
      </div>
      {problems.length > 0 && (
        <div className="notice notice-warning">
          <div>
            {problems.map((r) => (
              <div key={`${r.index}-${r.name}`}>
                <strong>Nama file: {r.name}</strong>{" — "}
                {r.status === "error" ? "Error: " : r.duplicate ? "" : "Warning: "}
                {r.message}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="excel-scroll">
        <table>
          <thead><tr><th>No</th><th>Nama file</th><th>Ukuran</th><th>Status</th><th>Row masuk</th></tr></thead>
          <tbody>
            {results.map((r, i) => (
              <tr key={`${r.index}-${r.name}`}>
                <td>{i + 1}</td>
                <td>{STATUS_ICON[r.status]} {r.name}</td>
                <td>{formatFileSize(r.size)}</td>
                <td>{STATUS_ICON[r.status]} {r.duplicate ? "duplikat (tidak dihitung)" : STATUS_LABEL[r.status]}</td>
                <td>{r.rowCount.toLocaleString("id-ID")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Informasi debug/validasi: row per file + total, dibandingkan dengan panjang dataset lengkap. */
export function MonthlyDebugPanel({ results, allRowsLength, extra }: { results: MonthlyFileResult[]; allRowsLength: number; extra?: string | null }) {
  const sum = results.reduce((s, r) => s + r.rowCount, 0);
  const ok = sum === allRowsLength;
  return (
    <div className="mapping-panel upl-audit-panel">
      <div className="eyebrow"><span className="eyebrow-line" /> DEBUG & VALIDASI BULANAN</div>
      <div className="used-columns">
        {results.map((r) => <span key={`${r.index}-${r.name}`}>File: {r.name} · Rows: {r.rowCount.toLocaleString("id-ID")}</span>)}
        <strong>TOTAL: {results.filter((r) => r.status !== "error" && !r.duplicate).length} file · {allRowsLength.toLocaleString("id-ID")} rows</strong>
        <strong>{ok ? `✓ Validasi row: jumlah row per file (${sum.toLocaleString("id-ID")}) = seluruh dataset (${allRowsLength.toLocaleString("id-ID")})` : `✕ Validasi row GAGAL: jumlah row per file ${sum.toLocaleString("id-ID")} ≠ dataset ${allRowsLength.toLocaleString("id-ID")}`}</strong>
        {extra && <strong>{extra}</strong>}
      </div>
    </div>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="upl-expand-row">
      <button className="button button-ghost compact" type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>← Sebelumnya</button>
      <span> Halaman {page} dari {pages} </span>
      <button className="button button-ghost compact" type="button" disabled={page >= pages} onClick={() => onPage(page + 1)}>Berikutnya →</button>
    </div>
  );
}

const sig = (f: { name: string; size: number; lastModified: number }) => `${f.name}|${f.size}|${f.lastModified}`;

/** Daftar file yang DIPILIH (sebelum/ sesudah diproses): nama, ukuran, status, tombol hapus. */
export function StagedFileList({ files, results, busy, onRemove, onClearAll }: { files: File[]; results: MonthlyFileResult[] | null; busy: boolean; onRemove: (index: number) => void; onClearAll: () => void }) {
  if (!files.length) return null;
  // Cocokkan status per file berdasarkan name+size+lastModified (urutan kemunculan dijaga untuk file kembar).
  const bySig = new Map<string, MonthlyFileResult[]>();
  (results ?? []).forEach((r) => { const k = sig(r); bySig.set(k, [...(bySig.get(k) ?? []), r]); });
  const seen = new Map<string, number>();
  const rows = files.map((file, index) => {
    const k = sig(file);
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return { file, index, result: bySig.get(k)?.[n] };
  });
  const statusText = (r?: MonthlyFileResult) => {
    if (busy) return "⏳ diproses...";
    if (!r) return results ? "— tidak diproses" : "• menunggu diproses";
    if (r.duplicate) return "⚠ duplikat (tidak dihitung)";
    if (r.status === "success") return `✓ berhasil · ${r.rowCount.toLocaleString("id-ID")} row`;
    if (r.status === "warning") return `⚠ warning · ${r.rowCount.toLocaleString("id-ID")} row`;
    return `✕ error: ${r.message ?? "gagal"}`;
  };
  return (
    <div className="mapping-panel upl-audit-panel">
      <div className="eyebrow"><span className="eyebrow-line" /> {files.length.toLocaleString("id-ID")} FILE DIPILIH</div>
      <div className="excel-scroll" style={{ maxHeight: 320 }}>
        <table>
          <thead><tr><th>No</th><th>Nama file</th><th>Ukuran</th><th>Status</th><th>Hapus</th></tr></thead>
          <tbody>
            {rows.map(({ file, index, result }) => (
              <tr key={`${index}-${file.name}`}>
                <td>{index + 1}</td>
                <td>{file.name}</td>
                <td>{formatFileSize(file.size)}</td>
                <td>{statusText(result)}</td>
                <td><button className="button button-ghost compact" type="button" disabled={busy} onClick={() => onRemove(index)} aria-label={`Hapus ${file.name}`}>✕ Hapus</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="input-actions">
        <span className="privacy-note">Total ukuran: {formatFileSize(files.reduce((sum, f) => sum + f.size, 0))}</span>
        <button className="button button-ghost compact" type="button" disabled={busy} onClick={onClearAll}>Kosongkan daftar</button>
      </div>
    </div>
  );
}

export function ProcessAllButton({ count, busy, onClick }: { count: number; busy: boolean; onClick: () => void }) {
  return (
    <button className="button button-primary" type="button" disabled={busy || count === 0} onClick={onClick}>
      {busy ? "MEMPROSES..." : `PROSES SEMUA FILE${count ? ` (${count})` : ""}`}
    </button>
  );
}
