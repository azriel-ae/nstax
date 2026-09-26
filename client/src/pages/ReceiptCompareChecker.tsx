import { useMemo, useState, type ChangeEvent } from "react";
import { AlertTriangle, ArrowLeft, Check, FileText, ShieldCheck } from "lucide-react";
import { formatReceiptRupiah, parseReceiptFile, type ReceiptRow } from "@/lib/receiptParser";
import { compareReceiptTotals, type ReceiptTotalsLine } from "@/lib/receiptCompare";

type Props = { onBack: () => void };
type Slot = 0 | 1;

const formatCount = (value: number) => value.toLocaleString("id-ID");
const formatValue = (line: ReceiptTotalsLine, value: number) => (line.metric === "count" ? formatCount(value) : formatReceiptRupiah(value));
const formatDifference = (line: ReceiptTotalsLine) => {
  if (line.difference === 0) return line.metric === "count" ? "0" : formatReceiptRupiah(0);
  const sign = line.difference > 0 ? "+" : "";
  return line.metric === "count" ? `${sign}${formatCount(line.difference)}` : `${sign}${formatReceiptRupiah(line.difference)}`;
};

export default function ReceiptCompareChecker({ onBack }: Props) {
  const [files, setFiles] = useState<[ReceiptRow[], ReceiptRow[]]>([[], []]);
  const [names, setNames] = useState<[string, string]>(["", ""]);
  const [warnings, setWarnings] = useState<[string, string]>(["", ""]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  // Seluruh baris kedua file dihitung (jumlah transaksi, subtotal, tax, total).
  // No struk tidak dipakai untuk mencocokkan apa pun.
  const comparison = useMemo(() => (files[0].length && files[1].length ? compareReceiptTotals(files[0], files[1]) : null), [files]);

  const load = async (slot: Slot, file?: File) => {
    if (!file || !/\.(pdf|xlsx?|csv)$/i.test(file.name)) {
      setNotice(`File ${slot + 1} tidak didukung. Gunakan PDF, XLSX, XLS, atau CSV.`);
      return;
    }
    setBusy(`Membaca File ${slot + 1}...`);
    try {
      const parsed = await parseReceiptFile(file);
      if (!parsed.rows.length) {
        setNotice(`File ${slot + 1}: ${parsed.warning ?? "tidak ada transaksi valid."}`);
        return;
      }
      setNotice("");
      setFiles((current) => (slot === 0 ? [parsed.rows, current[1]] : [current[0], parsed.rows]));
      setNames((current) => (slot === 0 ? [file.name, current[1]] : [current[0], file.name]));
      setWarnings((current) => (slot === 0 ? [parsed.warning ?? "", current[1]] : [current[0], parsed.warning ?? ""]));
    } catch {
      setNotice(`File ${slot + 1} tidak dapat dibaca.`);
    } finally {
      setBusy("");
    }
  };

  const fileCard = (slot: Slot) => (
    <label className="mode-card">
      <span className="mode-card-label">FILE {slot + 1}</span>
      <strong>{names[slot] || (slot === 0 ? "Pilih file pertama" : "Pilih file kedua")}</strong>
      {files[slot].length > 0 && <span>{formatCount(files[slot].length)} transaksi dibaca</span>}
      <input type="file" accept=".pdf,.xlsx,.xls,.csv" onChange={(event: ChangeEvent<HTMLInputElement>) => { void load(slot, event.target.files?.[0]); event.target.value = ""; }} />
    </label>
  );

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
              <p>File dibaca seluruhnya, lalu sistem menghitung jumlah transaksi, subtotal, tax, dan total dari masing-masing file dan membandingkannya. Nomor struk tidak dipakai untuk pencocokan.</p>
            </div>
          </section>

          <section className="input-panel panel-surface">
            <div className="mode-cards">{fileCard(0)}{fileCard(1)}</div>
            <div className="privacy-note"><ShieldCheck size={15} /> File asli tidak diubah · proses lokal</div>
          </section>

          {busy && <div className="notice notice-success" role="status" aria-live="polite">{busy}</div>}
          {notice && <div className="notice notice-error">{notice}</div>}
          {([0, 1] as const).map((slot) => warnings[slot] && <div key={slot} className="notice notice-warning"><AlertTriangle size={17} /> File {slot + 1}: {warnings[slot]}</div>)}
          {!comparison && (files[0].length > 0 || files[1].length > 0) && <div className="notice notice-warning">Pilih {files[0].length ? "File 2" : "File 1"} untuk mulai membandingkan.</div>}

          {comparison && (
            <>
              <div className={`notice ${comparison.allMatch ? "notice-success" : "notice-error"}`}>
                <span className="notice-icon">{comparison.allMatch ? <Check size={17} /> : <AlertTriangle size={17} />}</span>
                {comparison.allMatch ? "Jumlah transaksi, subtotal, tax, dan total sama di kedua file." : `Ada perbedaan pada ${comparison.differentCount} dari ${comparison.lines.length} pembanding.`}
              </div>
              <div className="metric-grid">
                <div className="metric-card"><span className="metric-label">Pembanding diperiksa</span><strong className="metric-value">{comparison.lines.length}</strong></div>
                <div className="metric-card"><span className="metric-label">Cocok</span><strong className="metric-value">{comparison.lines.length - comparison.differentCount}</strong></div>
                <div className="metric-card"><span className="metric-label">Berbeda</span><strong className="metric-value">{comparison.differentCount}</strong></div>
              </div>
              <section className="excel-preview">
                <div className="section-heading">
                  <div><h2>Hasil perbandingan</h2><span>Dihitung dari seluruh baris tiap file. Selisih = File 2 − File 1. Total mengikuti aturan CEK STRUK (memakai Paid Amount jika ada).</span></div>
                </div>
                <div className="excel-scroll">
                  <table>
                    <thead><tr><th>Pembanding</th><th className="numeric">{names[0] || "File 1"}</th><th className="numeric">{names[1] || "File 2"}</th><th>Proporsi</th><th className="numeric">Selisih</th><th>Status</th></tr></thead>
                    <tbody>
                      {comparison.lines.map((line) => {
                        const larger = Math.max(Math.abs(line.file1), Math.abs(line.file2)) || 1;
                        const ratio = Math.min(100, Math.round((Math.abs(line.file1 - line.file2) / larger) * 100));
                        const isSame = line.status === "SAMA";
                        return (
                          <tr key={line.metric}>
                            <td><strong>{line.label}</strong></td>
                            <td className="numeric">{formatValue(line, line.file1)}</td>
                            <td className="numeric">{formatValue(line, line.file2)}</td>
                            <td style={{ minWidth: 110 }}>
                              <div className="diff-bar-track">
                                <span className={`diff-bar ${isSame ? "" : "is-different"}`}><span style={{ transform: `scaleX(${isSame ? 0 : Math.max(ratio, 4) / 100})` }} /></span>
                              </div>
                            </td>
                            <td className="numeric">{formatDifference(line)}</td>
                            <td><span className={`status-pill ${isSame ? "is-same" : "is-diff"}`}>{isSame ? "Sama" : "Berbeda"}</span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
