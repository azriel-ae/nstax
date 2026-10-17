import { useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft, FileText, Info, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import { Pager } from "@/components/MonthlyUploadParts";
import { SidebarBrand } from "@/components/BrandLogo";
import { formatBytes } from "@/lib/shared/multiFile";
import {
  combineRoyalMonthly,
  compareRoyalFileNames,
  countRoyalByCategory,
  failRoyalSource,
  filterRoyalRows,
  formatRoyalMoney,
  parseRoyalSenyiurCsv,
  ROYAL_CATEGORIES,
  summarizeRoyalRows,
  type RoyalCategory,
  type RoyalExcluded,
  type RoyalHotelMultiRow,
  type RoyalMonthly,
  type RoyalSource,
} from "@/lib/parsers/royalSenyiurParser";

type Props = { onBack: () => void };

const PAGE_SIZE = 100; // hanya membatasi tampilan; ringkasan selalu dari seluruh record kategori
const LIST_PREVIEW_LIMIT = 100;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const LINES_PREVIEW = 6;

const Metric = ({ label, value, small = false }: { label: string; value: string; small?: boolean }) => (
  <div className="metric-card"><span className="metric-label">{label}</span><strong className="metric-value" style={small ? { fontSize: 15 } : undefined}>{value}</strong></div>
);

const linesText = (lines: number[]) =>
  lines.length <= LINES_PREVIEW ? lines.join(", ") : `${lines.slice(0, LINES_PREVIEW).join(", ")}, … (${lines.length} baris)`;

const REASON_LABEL: Record<RoyalExcluded["reason"], string> = { receipt_empty: "C kosong", tax_empty: "F kosong (RESTO)" };

/** Peringatan struk HOTEL dengan banyak baris (SQL: GROUP BY C tanpa agregat → baris pertama dipakai, sisanya tidak dijumlahkan). */
function HotelMultiNotice({ multi }: { multi: RoyalHotelMultiRow[] }) {
  if (multi.length === 0) return null;
  const conflicting = multi.filter((m) => m.conflicting);
  const ignoredRows = multi.reduce((n, m) => n + m.ignored.length, 0);
  const ignoredTotal = conflicting.reduce((n, m) => n + m.ignoredTotal, 0n);
  return (
    <>
      {conflicting.length > 0 && <span>⚠ {conflicting.length.toLocaleString("id-ID")} nomor struk HOTEL punya lebih dari satu baris dengan nilai BERBEDA (ambigu). Sesuai SQL (GROUP BY C tanpa SUM) hanya baris pertama yang dipakai; baris lain tidak dijumlahkan. Nilai (D+E+F) pada baris yang tidak dipakai: {formatRoyalMoney(ignoredTotal)} — lihat daftar di bawah.</span>}
      {multi.length > conflicting.length && <span>ℹ {(multi.length - conflicting.length).toLocaleString("id-ID")} nomor struk HOTEL muncul lebih dari sekali dengan isi identik; dihitung satu kali.</span>}
      <span>ℹ Total {ignoredRows.toLocaleString("id-ID")} baris HOTEL tambahan tidak dihitung pada {multi.length.toLocaleString("id-ID")} nomor struk.</span>
    </>
  );
}

function HotelMultiTable({ multi, showFile }: { multi: RoyalHotelMultiRow[]; showFile: boolean }) {
  if (multi.length === 0) return null;
  return (
    <section className="excel-preview">
      <div className="section-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> STRUK HOTEL BARIS GANDA</div><h2>{multi.length.toLocaleString("id-ID")} nomor struk HOTEL punya lebih dari satu baris sumber</h2></div>
        <span className="result-count">Hanya baris pertama yang dihitung · baris lain tidak dijumlahkan</span>
      </div>
      <div className="excel-scroll">
        <table>
          <thead><tr><th>No</th><th>no_struk</th>{showFile && <th>File dipakai</th>}<th>Baris dipakai</th><th>Baris tidak dipakai</th><th>Kode A (tidak dipakai)</th><th>D+E+F tidak dipakai</th><th>Nilai berbeda?</th></tr></thead>
          <tbody>
            {multi.slice(0, LIST_PREVIEW_LIMIT).map((m, i) => (
              <tr key={`hm#${m.noStruk}`}>
                <td>{i + 1}</td>
                <td style={{ whiteSpace: "pre" }}>{m.noStruk}</td>
                {showFile && <td>{m.used.fileName}</td>}
                <td>{m.used.line}</td>
                <td>{m.ignored.map((x) => (showFile ? `${x.fileName}:${x.line}` : String(x.line))).join(", ")}</td>
                <td>{[...new Set(m.ignored.map((x) => x.code))].join(", ")}</td>
                <td>{formatRoyalMoney(m.ignoredTotal)}</td>
                <td>{m.conflicting ? "Ya (ambigu)" : "Tidak (identik)"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {multi.length > LIST_PREVIEW_LIMIT && <div style={{ margin: "8px 2px 0", fontSize: 11, color: "var(--muted)" }}>Menampilkan {LIST_PREVIEW_LIMIT} dari {multi.length.toLocaleString("id-ID")} nomor struk.</div>}
    </section>
  );
}

function ExcludedTable({ excluded, fileOf }: { excluded: Array<RoyalExcluded & { fileName?: string }>; fileOf: boolean }) {
  if (excluded.length === 0) return null;
  return (
    <section className="excel-preview">
      <div className="section-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> DIKECUALIKAN FILTER SQL</div><h2>{excluded.length.toLocaleString("id-ID")} baris tidak lolos filter HOTEL/RESTO</h2></div>
        <span className="result-count">Tidak dihitung pada kategori mana pun</span>
      </div>
      <div className="excel-scroll">
        <table>
          <thead><tr><th>No</th>{fileOf && <th>File</th>}<th>Baris CSV</th><th>Kode (kolom A)</th><th>No struk (C)</th><th>Subtotal (D)</th><th>Tax (F)</th><th>Keterangan (G)</th><th>Alasan</th></tr></thead>
          <tbody>{excluded.slice(0, LIST_PREVIEW_LIMIT).map((u, i) => <tr key={`x#${u.fileName ?? ""}#${u.row}`}><td>{i + 1}</td>{fileOf && <td>{u.fileName}</td>}<td>{u.row}</td><td>{u.code || "(kosong)"}</td><td>{u.noStruk || "(kosong)"}</td><td>{u.subtotal}</td><td>{u.tax || "(kosong)"}</td><td>{u.keterangan}</td><td>{REASON_LABEL[u.reason]}</td></tr>)}</tbody>
        </table>
      </div>
      {excluded.length > LIST_PREVIEW_LIMIT && <div style={{ margin: "8px 2px 0", fontSize: 11, color: "var(--muted)" }}>Menampilkan {LIST_PREVIEW_LIMIT} dari {excluded.length.toLocaleString("id-ID")} baris.</div>}
    </section>
  );
}

const RULE_NOTE = "Klasifikasi mengikuti nomor struk (kolom C): awalan PC = HOTEL; selain itu (tidak kosong, tax F tidak kosong) = RESTO.";

type RoyalMode = "HARIAN" | "BULANAN";

/** Kerangka halaman (sidebar + topbar) bersama untuk mode HARIAN dan BULANAN. */
function RoyalShell({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <SidebarBrand />
        <div className="sidebar-divider" />
        <nav className="sidebar-nav">
          <button className="nav-item" type="button" onClick={onBack}><ArrowLeft size={18} /><span>Kembali ke CEK UPL</span></button>
          <div className="nav-item is-active"><FileText size={18} /><span>CEK ROYAL SENYIUR</span></div>
        </nav>
        <div className="sidebar-footer"><div className="privacy-badge"><ShieldCheck size={16} /><div><strong>Local-first</strong><span>Data tidak keluar dari browser</span></div></div></div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <button className="button button-secondary compact" type="button" onClick={onBack}><ArrowLeft size={15} /> Kembali ke CEK UPL</button>
          <div className="breadcrumb"><span>CEK UPL</span><span>›</span><strong>CEK ROYAL SENYIUR</strong></div>
          <div className="status-chip"><span className="status-dot" /></div>
        </header>
        <div className="page-container">{children}</div>
      </main>
    </div>
  );
}

/** Pilihan mode. Berpindah mode memulai alur upload yang baru (kedua mode terpisah). */
function RoyalModeSwitch({ mode, onMode }: { mode: RoyalMode; onMode: (mode: RoyalMode) => void }) {
  return (
    <div className="cmp-chips" role="group" aria-label="Mode Royal Senyiur" style={{ marginBottom: 14 }}>
      {(["HARIAN", "BULANAN"] as const).map((item) => (
        <button key={item} type="button" className={`cmp-chip ${mode === item ? "is-active" : ""}`} aria-pressed={mode === item} onClick={() => mode !== item && onMode(item)}>{item}</button>
      ))}
    </div>
  );
}

/** CEK UPL ROYAL SENYIUR — pilihan mode HARIAN (satu file) atau BULANAN (banyak file harian). */
export default function RoyalSenyiurChecker({ onBack }: Props) {
  const [mode, setMode] = useState<RoyalMode>("HARIAN");
  const modeSwitch = <RoyalModeSwitch mode={mode} onMode={setMode} />;
  return mode === "HARIAN"
    ? <RoyalDailyChecker onBack={onBack} modeSwitch={modeSwitch} />
    : <RoyalMonthlyChecker onBack={onBack} modeSwitch={modeSwitch} />;
}

type ModeProps = Props & { modeSwitch: ReactNode };

/** Mode HARIAN — satu file CSV tanpa header berisi HOTEL dan RESTO; kategori dipilih setelah file dibaca. (Alur lama, tidak diubah.) */
function RoyalDailyChecker({ onBack, modeSwitch }: ModeProps) {
  const [fileInfo, setFileInfo] = useState<{ name: string; size: number } | null>(null);
  const [source, setSource] = useState<RoyalSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState<RoyalCategory>("HOTEL");
  const [page, setPage] = useState(1);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const loadToken = useRef(0); // mencegah hasil file lama menimpa file yang lebih baru

  const reset = () => {
    loadToken.current++;
    setFileInfo(null); setSource(null); setBusy(false); setCategory("HOTEL"); setPage(1); setError("");
  };

  const handleFiles = async (picked: File[]) => {
    if (!picked.length || busy) return;
    setError("");
    if (picked.length > 1) { setError("Pilih satu file CSV saja. HOTEL dan RESTO berada dalam file yang sama."); return; }
    const file = picked[0];
    if (!/\.csv$/i.test(file.name)) { setError("Hanya file dengan ekstensi .csv yang dapat di-upload."); return; }
    if (file.size > MAX_FILE_BYTES) { setError("Ukuran file terlalu besar. Batas maksimal adalah 10 MB."); return; }
    const token = ++loadToken.current;
    setBusy(true);
    let parsed: RoyalSource;
    try {
      parsed = parseRoyalSenyiurCsv(await file.text(), file.name);
    } catch {
      parsed = failRoyalSource(file.name, "File tidak dapat dibaca.");
    }
    if (token !== loadToken.current) return; // Clear ditekan saat membaca
    setFileInfo({ name: file.name, size: file.size });
    setSource(parsed);
    setCategory("HOTEL");
    setPage(1);
    setBusy(false);
  };

  const rows = useMemo(() => (source?.ok ? source.rows : []), [source]);
  const counts = useMemo(() => countRoyalByCategory(rows), [rows]);
  const filteredRows = useMemo(() => filterRoyalRows(rows, category), [rows, category]);
  const summary = useMemo(() => summarizeRoyalRows(filteredRows), [filteredRows]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * PAGE_SIZE;
  const visibleRows = filteredRows.slice(start, start + PAGE_SIZE);

  const stats = source?.stats;
  const ready = !!source?.ok && !busy;
  const status = busy ? "Membaca file…" : !fileInfo ? "Belum ada file" : source?.ok ? "File berhasil dibaca" : "Gagal membaca file";
  const money = formatRoyalMoney;
  const isResto = category === "RESTO";

  return (
    <RoyalShell onBack={onBack}>
          {modeSwitch}
          <section className="page-heading">
            <div>
              <h1>Cek <em>Royal Senyiur</em></h1>
              <p>Upload satu file CSV. HOTEL dan RESTO dipilih setelah file dibaca.</p>
            </div>
            <div className="heading-meta">
              <span className="meta-label">CURRENT SOURCE</span>
              <strong>{fileInfo?.name || "Belum ada file"}</strong>
              <span className="meta-subtitle">{ready ? `${category} · ${summary.count.toLocaleString("id-ID")} record` : busy ? "Memproses file…" : "Menunggu file CSV"}</span>
            </div>
          </section>

          <section className="input-panel panel-surface">
            <div className="panel-heading">
              <div className="panel-title-wrap"><span className="section-number">01</span><div><h2>Upload File CSV Royal Senyiur</h2><p>File tanpa header; baris pertama adalah transaksi.</p></div></div>
              {fileInfo && <span className="file-pill"><FileText size={15} />{fileInfo.name}</span>}
            </div>
            <div
              className={`drop-zone ${drag ? "is-dragging" : ""}`}
              onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={() => setDrag(false)}
              onDrop={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDrag(false); void handleFiles(Array.from(e.dataTransfer.files)); }}
            >
              <div className="upload-symbol"><Upload size={20} /></div>
              <strong>{drag ? "Lepaskan file CSV di sini" : "Tarik satu file CSV ke sini"}</strong>
              <span>atau pilih dari perangkat Anda</span>
              <button className="button button-secondary" type="button" disabled={busy} onClick={() => inputRef.current?.click()}><FileText size={16} /> Pilih file CSV</button>
              <small>Kolom: A Kode · B Tanggal · C No struk · D Subtotal · E Service · F Tax · G Keterangan</small>
              <input ref={inputRef} type="file" accept=".csv,text/csv" hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { void handleFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
            </div>
            <div className="used-columns">
              <strong>Status: {status}</strong>
              {ready && source?.ok && stats && <>
                <span>✓ {stats.sourceRecords.toLocaleString("id-ID")} baris data dibaca (termasuk baris pertama){fileInfo ? ` · ${formatBytes(fileInfo.size)}` : ""}</span>
                <span>HOTEL {stats.hotelRecords.toLocaleString("id-ID")} struk dari {stats.hotelSourceRows.toLocaleString("id-ID")} baris · RESTO {stats.restoGroups.toLocaleString("id-ID")} struk dari {stats.restoSourceRows.toLocaleString("id-ID")} baris{stats.excludedRows ? ` · ${stats.excludedRows.toLocaleString("id-ID")} baris dikecualikan filter SQL` : ""}{stats.issueRows ? ` · ${stats.issueRows.toLocaleString("id-ID")} baris bermasalah` : ""}{stats.blankLines ? ` · ${stats.blankLines.toLocaleString("id-ID")} baris kosong dilewati` : ""}</span>
              </>}
            </div>
            <div className="input-actions">
              <div className="privacy-note"><ShieldCheck size={15} /> Diproses lokal di browser</div>
              <button className="button button-ghost" type="button" onClick={reset}><Trash2 size={16} /> Clear</button>
            </div>
          </section>

          {error && <div className="notice notice-error" role="alert"><span className="notice-icon"><AlertTriangle size={17} /></span>{error}</div>}

          {busy && <div className="notice notice-success" role="status" aria-live="polite"><span className="notice-icon"><Info size={17} /></span>Membaca dan memproses file CSV…</div>}

          {!busy && source && !source.ok && (
            <div className="notice notice-error"><span className="notice-icon"><AlertTriangle size={17} /></span>{source.error}</div>
          )}

          {!busy && !source && !error && (
            <div style={{ margin: "18px 2px 0", padding: "12px 14px", border: "1px dashed var(--line-strong)", borderRadius: 6, fontSize: 12, color: "var(--muted)" }}>
              Upload file CSV untuk melihat ringkasan dan detail transaksi.
            </div>
          )}

          {ready && source?.ok && stats && <>
            {(source.excluded.length > 0 || source.issues.length > 0 || source.hotelMulti.length > 0) && (
              <div className="notice notice-warning" style={{ alignItems: "flex-start", flexDirection: "column", gap: 4 }}>
                {source.excluded.length > 0 && <span>ℹ {source.excluded.length.toLocaleString("id-ID")} baris tidak lolos filter SQL (C kosong, atau RESTO dengan F kosong) dan tidak dimasukkan ke HOTEL maupun RESTO — lihat daftar di bawah.</span>}
                {source.issues.length > 0 && <span>⚠ {source.issues.length.toLocaleString("id-ID")} masalah data pada {stats.issueRows.toLocaleString("id-ID")} baris; baris tersebut tidak dihitung — lihat daftar di bawah.</span>}
                <HotelMultiNotice multi={source.hotelMulti} />
              </div>
            )}

            {rows.length === 0 ? (
              <div className="notice notice-warning" role="status">
                <span className="notice-icon"><Info size={17} /></span>
                Tidak ada baris yang dapat dimasukkan ke HOTEL atau RESTO pada file ini. Tidak ada data pengganti yang dibuat.
              </div>
            ) : (
              <>
                <section className="panel-surface" style={{ marginTop: 20, padding: 20 }}>
                  <div className="panel-heading">
                    <div className="panel-title-wrap"><span className="section-number">02</span><div><h2>Kategori</h2><p>Pilih kategori yang ingin diperiksa; file tidak perlu diunggah ulang.</p></div></div>
                  </div>
                  <div className="cmp-chips" role="group" aria-label="Kategori Royal Senyiur" style={{ marginTop: 14 }}>
                    {ROYAL_CATEGORIES.map((item) => (
                      <button key={item} type="button" className={`cmp-chip ${category === item ? "is-active" : ""}`} onClick={() => { setCategory(item); setPage(1); }}>
                        {item}<b>{counts[item].toLocaleString("id-ID")}</b>
                      </button>
                    ))}
                  </div>
                </section>

                <div className="metric-grid upl-metrics">
                  <Metric label="Profil" value="ROYAL SENYIUR" small />
                  <Metric label="Nama file" value={fileInfo?.name ?? ""} small />
                  <Metric label="Kategori aktif" value={category} small />
                  <Metric label={isResto ? "Jumlah record (nomor struk)" : "Jumlah record"} value={summary.count.toLocaleString("id-ID")} />
                  {isResto && <Metric label="Baris sumber digabung" value={summary.sourceRows.toLocaleString("id-ID")} />}
                  <Metric label="Total subtotal" value={money(summary.subtotal)} />
                  <Metric label="Total DPP" value={money(summary.dpp)} />
                  <Metric label="Total discount" value={money(summary.discount)} />
                  <Metric label="Total service charge" value={money(summary.service_charge)} />
                  <Metric label="Total tax" value={money(summary.tax)} />
                  <Metric label="Total keseluruhan" value={money(summary.total)} />
                </div>

                <section className="excel-preview">
                  <div className="section-heading">
                    <div><div className="eyebrow"><span className="eyebrow-line" /> 03 · DATASET PENUH</div><h2>Detail transaksi Royal Senyiur · {category}</h2></div>
                    <span className="result-count">Menampilkan {visibleRows.length.toLocaleString("id-ID")} dari {filteredRows.length.toLocaleString("id-ID")} record · ringkasan dihitung dari seluruh record</span>
                  </div>
                  {filteredRows.length === 0 ? (
                    <div className="notice notice-warning" role="status">
                      <span className="notice-icon"><Info size={17} /></span>
                      Tidak ada transaksi {category} pada file ini.
                    </div>
                  ) : (
                    <>
                      <div className="excel-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>No</th><th>id_agent</th><th>no_struk</th><th>date_trans</th><th>subtotal</th><th>service_charge</th><th>discount</th>
                              <th>dpp</th><th>tax</th><th>total</th><th>keterangan</th><th>Baris CSV</th>
                            </tr>
                          </thead>
                          <tbody>
                            {visibleRows.map((row, i) => (
                              <tr key={`${row.category}#${row.no_struk}#${row.sourceRows[0]}`}>
                                <td>{start + i + 1}</td>
                                <td>{row.id_agent}</td>
                                <td style={{ whiteSpace: "pre" }}>{row.no_struk}</td>
                                <td>{row.date_trans}</td>
                                <td>{money(row.subtotal)}</td>
                                <td>{money(row.service_charge)}</td>
                                <td>{money(row.discount)}</td>
                                <td>{money(row.dpp)}</td>
                                <td>{money(row.tax)}</td>
                                <td>{money(row.total)}</td>
                                <td>{row.keterangan}</td>
                                <td>{linesText(row.sourceRows)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <Pager page={safePage} pageSize={PAGE_SIZE} total={filteredRows.length} onPage={setPage} />
                      <div style={{ margin: "8px 2px 0", fontSize: 11, color: "var(--muted)" }}>
                        {RULE_NOTE}{" "}
                        {isResto
                          ? "RESTO digabung per nomor struk (kolom C): nilai dijumlahkan, tanggal = tanggal terbesar, keterangan = jumlah baris."
                          : "HOTEL: satu record per nomor struk (baris pertama); dpp = D + E, tax = F, total = D + E + F."}
                      </div>
                    </>
                  )}
                </section>
              </>
            )}

            <HotelMultiTable multi={source.hotelMulti} showFile={false} />
            <ExcludedTable excluded={source.excluded} fileOf={false} />

            {source.issues.length > 0 && (
              <section className="excel-preview">
                <div className="section-heading">
                  <div><div className="eyebrow"><span className="eyebrow-line" /> BARIS BERMASALAH</div><h2>{source.issues.length.toLocaleString("id-ID")} masalah data — baris tidak dihitung</h2></div>
                </div>
                <div className="excel-scroll">
                  <table>
                    <thead><tr><th>No</th><th>Baris CSV</th><th>Kode</th><th>No struk</th><th>Nilai asli</th><th>Alasan</th></tr></thead>
                    <tbody>{source.issues.slice(0, LIST_PREVIEW_LIMIT).map((it, i) => <tr key={`i#${it.row}-${it.kind}-${i}`}><td>{i + 1}</td><td>{it.row}</td><td>{it.code}</td><td>{it.noStruk}</td><td>{it.value || "(kosong)"}</td><td>{it.message}</td></tr>)}</tbody>
                  </table>
                </div>
                {source.issues.length > LIST_PREVIEW_LIMIT && <div style={{ margin: "8px 2px 0", fontSize: 11, color: "var(--muted)" }}>Menampilkan {LIST_PREVIEW_LIMIT} dari {source.issues.length.toLocaleString("id-ID")} masalah.</div>}
              </section>
            )}
          </>}
    </RoyalShell>
  );
}

type Picked = { key: string; file: File };

const fileKey = (f: File) => `${f.name.toLowerCase()}|${f.size}|${f.lastModified}`;

/** Mode BULANAN — banyak file harian (CSV tanpa header) dipilih sekaligus, dibaca satu per satu, lalu digabung sebelum RESTO dikelompokkan. */
function RoyalMonthlyChecker({ onBack, modeSwitch }: ModeProps) {
  const [picked, setPicked] = useState<Picked[]>([]);
  const [notes, setNotes] = useState<string[]>([]); // file yang ditolak saat dipilih (bukan .csv, terlalu besar, nama sama)
  const [result, setResult] = useState<RoyalMonthly | null>(null);
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState<RoyalCategory>("HOTEL");
  const [page, setPage] = useState(1);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const runToken = useRef(0); // mencegah hasil proses lama menimpa pilihan/Clear yang lebih baru

  const invalidate = () => { runToken.current++; setResult(null); setBusy(false); setPage(1); };

  const reset = () => { invalidate(); setPicked([]); setNotes([]); setCategory("HOTEL"); };

  /** Menambah file ke daftar (tidak menimpa). Nama yang sama tidak diterima agar satu file tidak terhitung dua kali. */
  const addFiles = (incoming: File[]) => {
    if (!incoming.length || busy) return;
    const msgs: string[] = [];
    const next = [...picked];
    const names = new Set(next.map((p) => p.file.name.toLowerCase()));
    for (const file of incoming) {
      if (!/\.csv$/i.test(file.name)) { msgs.push(`${file.name}: bukan file .csv — dilewati.`); continue; }
      if (file.size > MAX_FILE_BYTES) { msgs.push(`${file.name}: lebih dari 10 MB — dilewati.`); continue; }
      if (names.has(file.name.toLowerCase())) { msgs.push(`${file.name}: nama file sudah ada di daftar — dilewati agar tidak terhitung dua kali.`); continue; }
      names.add(file.name.toLowerCase());
      next.push({ key: fileKey(file), file });
    }
    next.sort((a, b) => compareRoyalFileNames(a.file.name, b.file.name));
    setNotes(msgs);
    if (next.length !== picked.length) { invalidate(); setPicked(next); }
  };

  const removeFile = (key: string) => { if (busy) return; invalidate(); setNotes([]); setPicked((list) => list.filter((p) => p.key !== key)); };

  const processAll = async () => {
    if (!picked.length || busy) return;
    const token = ++runToken.current;
    setBusy(true); setResult(null); setPage(1); setCategory("HOTEL");
    const sources: RoyalSource[] = [];
    for (const { file } of picked) {
      let parsed: RoyalSource;
      try {
        parsed = parseRoyalSenyiurCsv(await file.text(), file.name);
      } catch {
        parsed = failRoyalSource(file.name, "File tidak dapat dibaca.");
      }
      if (token !== runToken.current) return; // Clear / perubahan pilihan saat membaca
      sources.push(parsed);
    }
    setResult(combineRoyalMonthly(sources));
    setBusy(false);
  };

  const statusByName = useMemo(() => new Map((result?.files ?? []).map((f) => [f.fileName, f])), [result]);
  const rows = useMemo(() => result?.rows ?? [], [result]);
  const counts = useMemo(() => countRoyalByCategory(rows), [rows]);
  const filteredRows = useMemo(() => filterRoyalRows(rows, category), [rows, category]);
  const summary = useMemo(() => summarizeRoyalRows(filteredRows), [filteredRows]);
  const totalBytes = useMemo(() => picked.reduce((n, p) => n + p.file.size, 0), [picked]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * PAGE_SIZE;
  const visibleRows = filteredRows.slice(start, start + PAGE_SIZE);

  const money = formatRoyalMoney;
  const stats = result?.stats;
  const isResto = category === "RESTO";
  const status = busy ? "Memproses file…" : result ? (result.complete ? "Semua file terpilih berhasil dibaca" : `${result.failedFiles} file gagal dibaca`) : picked.length ? `${picked.length} file dipilih, belum diproses` : "Belum ada file";

  return (
    <RoyalShell onBack={onBack}>
      {modeSwitch}
      <section className="page-heading">
        <div>
          <h1>Cek <em>Royal Senyiur</em> · Bulanan</h1>
          <p>Pilih banyak file harian sekaligus. Setiap file dibaca terpisah, lalu seluruh record valid digabung sebelum dihitung.</p>
        </div>
        <div className="heading-meta">
          <span className="meta-label">CURRENT SOURCE</span>
          <strong>{picked.length ? `${picked.length.toLocaleString("id-ID")} file` : "Belum ada file"}</strong>
          <span className="meta-subtitle">{result ? `${category} · ${summary.count.toLocaleString("id-ID")} record` : busy ? "Memproses file…" : "Menunggu file CSV"}</span>
        </div>
      </section>

      <section className="input-panel panel-surface">
        <div className="panel-heading">
          <div className="panel-title-wrap"><span className="section-number">01</span><div><h2>Upload File CSV Harian Royal Senyiur</h2><p>Banyak file tanpa header; tidak perlu digabung manual. Gunakan Ctrl + A di dialog untuk memilih semua file.</p></div></div>
          {picked.length > 0 && <span className="file-pill"><FileText size={15} />{picked.length.toLocaleString("id-ID")} file · {formatBytes(totalBytes)}</span>}
        </div>
        <div
          className={`drop-zone ${drag ? "is-dragging" : ""}`}
          onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => setDrag(false)}
          onDrop={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDrag(false); addFiles(Array.from(e.dataTransfer.files)); }}
        >
          <div className="upload-symbol"><Upload size={20} /></div>
          <strong>{drag ? "Lepaskan file CSV di sini" : "Tarik banyak file CSV ke sini"}</strong>
          <span>atau pilih dari perangkat Anda</span>
          <button className="button button-secondary" type="button" disabled={busy} onClick={() => inputRef.current?.click()}><FileText size={16} /> Pilih file CSV (banyak)</button>
          <small>Kolom: A Kode · B Tanggal · C No struk · D Subtotal · E Service · F Tax · G Keterangan</small>
          <input ref={inputRef} type="file" accept=".csv,text/csv" multiple hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        </div>

        {picked.length > 0 && (
          <div className="excel-scroll" style={{ marginTop: 14 }}>
            <table>
              <thead><tr><th>No</th><th>Nama file</th><th>Ukuran</th><th>Status</th><th>Baris data</th><th>Catatan</th><th /></tr></thead>
              <tbody>
                {picked.map((p, i) => {
                  const st = statusByName.get(p.file.name);
                  return (
                    <tr key={p.key}>
                      <td>{i + 1}</td>
                      <td>{p.file.name}</td>
                      <td>{formatBytes(p.file.size)}</td>
                      <td>{busy ? "Memproses…" : !st ? "Belum diproses" : st.ok ? "Berhasil" : "Gagal"}</td>
                      <td>{st?.ok ? st.stats.sourceRecords.toLocaleString("id-ID") : ""}</td>
                      <td>{st && !st.ok ? st.error : st?.ok && (st.issueCount > 0 || st.stats.excludedRows > 0) ? `${st.stats.issueRows} baris bermasalah · ${st.stats.excludedRows} dikecualikan filter SQL` : ""}</td>
                      <td><button className="button button-ghost compact" type="button" disabled={busy} aria-label={`Hapus ${p.file.name} dari daftar`} onClick={() => removeFile(p.key)}><X size={14} /></button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="used-columns">
          <strong>Status: {status}</strong>
          {picked.length > 0 && <span>{picked.length.toLocaleString("id-ID")} file akan diproses (urut nama file){result ? "" : " — tekan “Proses semua file”."}</span>}
        </div>
        <div className="input-actions">
          <div className="privacy-note"><ShieldCheck size={15} /> Diproses lokal di browser</div>
          <button className="button button-primary" type="button" disabled={busy || picked.length === 0} onClick={() => void processAll()}><Upload size={16} /> Proses {picked.length > 0 ? `${picked.length.toLocaleString("id-ID")} file` : "semua file"}</button>
          <button className="button button-ghost" type="button" onClick={reset}><Trash2 size={16} /> Clear</button>
        </div>
      </section>

      {notes.length > 0 && (
        <div className="notice notice-warning" role="alert" style={{ alignItems: "flex-start", flexDirection: "column", gap: 4 }}>
          {notes.map((n, i) => <span key={i}>⚠ {n}</span>)}
        </div>
      )}

      {busy && <div className="notice notice-success" role="status" aria-live="polite"><span className="notice-icon"><Info size={17} /></span>Membaca dan memproses {picked.length.toLocaleString("id-ID")} file…</div>}

      {!busy && !result && picked.length === 0 && notes.length === 0 && (
        <div style={{ margin: "18px 2px 0", padding: "12px 14px", border: "1px dashed var(--line-strong)", borderRadius: 6, fontSize: 12, color: "var(--muted)" }}>
          Pilih beberapa file CSV harian untuk melihat ringkasan dan detail bulanan.
        </div>
      )}

      {!busy && result && stats && <>
        {result.failedFiles > 0 && (
          <div className="notice notice-error" role="alert" style={{ alignItems: "flex-start", flexDirection: "column", gap: 4 }}>
            <span><span className="notice-icon"><AlertTriangle size={17} /></span> Periode belum lengkap: {result.failedFiles.toLocaleString("id-ID")} dari {result.files.length.toLocaleString("id-ID")} file gagal diproses dan tidak masuk hasil. Angka di bawah hanya dari {result.okFiles.toLocaleString("id-ID")} file yang berhasil.</span>
            {result.files.filter((f) => !f.ok).map((f) => <span key={f.fileName}>• {f.fileName}: {f.error}</span>)}
          </div>
        )}
        {(result.excluded.length > 0 || result.issues.length > 0 || result.hotelMulti.length > 0 || result.restoReceiptsAcrossFiles > 0) && (
          <div className="notice notice-warning" style={{ alignItems: "flex-start", flexDirection: "column", gap: 4 }}>
            {result.excluded.length > 0 && <span>ℹ {result.excluded.length.toLocaleString("id-ID")} baris tidak lolos filter SQL (C kosong, atau RESTO dengan F kosong) dan tidak dimasukkan ke HOTEL maupun RESTO — lihat daftar di bawah.</span>}
            {result.issues.length > 0 && <span>⚠ {result.issues.length.toLocaleString("id-ID")} masalah data pada {stats.issueRows.toLocaleString("id-ID")} baris; baris tersebut tidak dihitung — lihat daftar di bawah.</span>}
            {result.restoReceiptsAcrossFiles > 0 && <span>ℹ {result.restoReceiptsAcrossFiles.toLocaleString("id-ID")} nomor struk RESTO muncul di lebih dari satu file; dikelompokkan menjadi satu record sesuai aturan SQL (tidak dibuang).</span>}
            {result.hotelReceiptsAcrossFiles > 0 && <span>ℹ {result.hotelReceiptsAcrossFiles.toLocaleString("id-ID")} nomor struk HOTEL muncul di lebih dari satu file; dikelompokkan menjadi satu record sesuai SQL (urutan file, baris pertama dipakai).</span>}
            <HotelMultiNotice multi={result.hotelMulti} />
          </div>
        )}

        {rows.length === 0 ? (
          <div className="notice notice-warning" role="status">
            <span className="notice-icon"><Info size={17} /></span>
            Tidak ada baris yang dapat dimasukkan ke HOTEL atau RESTO dari file yang dipilih. Tidak ada data pengganti yang dibuat.
          </div>
        ) : (
          <>
            <div className="metric-grid upl-metrics" style={{ marginTop: 20 }}>
              <Metric label="File berhasil diproses" value={result.okFiles.toLocaleString("id-ID")} />
              <Metric label="File gagal diproses" value={result.failedFiles.toLocaleString("id-ID")} />
              <Metric label="Baris sumber valid" value={(stats.hotelSourceRows + stats.restoSourceRows).toLocaleString("id-ID")} />
              <Metric label="Struk HOTEL (unik)" value={stats.hotelRecords.toLocaleString("id-ID")} />
              <Metric label="Grup nomor struk RESTO" value={stats.restoGroups.toLocaleString("id-ID")} />
              <Metric label="Rentang tanggal data valid" value={result.dateMin ? (result.dateMin === result.dateMax ? result.dateMin : `${result.dateMin} s/d ${result.dateMax}`) : "-"} small />
            </div>

            <section className="panel-surface" style={{ marginTop: 20, padding: 20 }}>
              <div className="panel-heading">
                <div className="panel-title-wrap"><span className="section-number">02</span><div><h2>Kategori</h2><p>Pilih kategori yang ingin diperiksa; file tidak perlu diunggah ulang.</p></div></div>
              </div>
              <div className="cmp-chips" role="group" aria-label="Kategori Royal Senyiur" style={{ marginTop: 14 }}>
                {ROYAL_CATEGORIES.map((item) => (
                  <button key={item} type="button" className={`cmp-chip ${category === item ? "is-active" : ""}`} onClick={() => { setCategory(item); setPage(1); }}>
                    {item}<b>{counts[item].toLocaleString("id-ID")}</b>
                  </button>
                ))}
              </div>
            </section>

            <div className="metric-grid upl-metrics">
              <Metric label="Profil" value="ROYAL SENYIUR · BULANAN" small />
              <Metric label="Kategori aktif" value={category} small />
              <Metric label={isResto ? "Jumlah record (nomor struk)" : "Jumlah record"} value={summary.count.toLocaleString("id-ID")} />
              {isResto && <Metric label="Baris sumber digabung" value={summary.sourceRows.toLocaleString("id-ID")} />}
              <Metric label="Total subtotal" value={money(summary.subtotal)} />
              <Metric label="Total DPP" value={money(summary.dpp)} />
              <Metric label="Total discount" value={money(summary.discount)} />
              <Metric label="Total service charge" value={money(summary.service_charge)} />
              <Metric label="Total tax" value={money(summary.tax)} />
              <Metric label="Total keseluruhan" value={money(summary.total)} />
            </div>

            <section className="excel-preview">
              <div className="section-heading">
                <div><div className="eyebrow"><span className="eyebrow-line" /> 03 · DATASET PENUH</div><h2>Detail transaksi Royal Senyiur bulanan · {category}</h2></div>
                <span className="result-count">Menampilkan {visibleRows.length.toLocaleString("id-ID")} dari {filteredRows.length.toLocaleString("id-ID")} record · ringkasan dihitung dari seluruh record</span>
              </div>
              {filteredRows.length === 0 ? (
                <div className="notice notice-warning" role="status">
                  <span className="notice-icon"><Info size={17} /></span>
                  Tidak ada transaksi {category} pada file yang dipilih.
                </div>
              ) : (
                <>
                  <div className="excel-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>No</th><th>id_agent</th><th>no_struk</th><th>date_trans</th><th>subtotal</th><th>service_charge</th><th>discount</th>
                          <th>dpp</th><th>tax</th><th>total</th><th>keterangan</th><th>File</th><th>Baris CSV</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleRows.map((row, i) => (
                          <tr key={`${row.category}#${row.no_struk}#${row.sourceFiles[0]}#${row.sourceRows[0]}`}>
                            <td>{start + i + 1}</td>
                            <td>{row.id_agent}</td>
                            <td style={{ whiteSpace: "pre" }}>{row.no_struk}</td>
                            <td>{row.date_trans}</td>
                            <td>{money(row.subtotal)}</td>
                            <td>{money(row.service_charge)}</td>
                            <td>{money(row.discount)}</td>
                            <td>{money(row.dpp)}</td>
                            <td>{money(row.tax)}</td>
                            <td>{money(row.total)}</td>
                            <td>{row.keterangan}</td>
                            <td>{row.sourceFiles.join(", ")}</td>
                            <td>{linesText(row.sourceRows)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Pager page={safePage} pageSize={PAGE_SIZE} total={filteredRows.length} onPage={setPage} />
                  <div style={{ margin: "8px 2px 0", fontSize: 11, color: "var(--muted)" }}>
                    {RULE_NOTE}{" "}
                    {isResto
                      ? "RESTO: baris sumber seluruh file digabung dulu, lalu dikelompokkan per nomor struk (kolom C): nilai dijumlahkan, tanggal = tanggal terbesar, keterangan = jumlah baris."
                      : "HOTEL: baris seluruh file digabung dulu, lalu satu record per nomor struk (baris pertama); dpp = D + E, tax = F, total = D + E + F."}
                  </div>
                </>
              )}
            </section>
          </>
        )}

        <HotelMultiTable multi={result.hotelMulti} showFile />
        <ExcludedTable excluded={result.excluded} fileOf />

        {result.issues.length > 0 && (
          <section className="excel-preview">
            <div className="section-heading">
              <div><div className="eyebrow"><span className="eyebrow-line" /> BARIS BERMASALAH</div><h2>{result.issues.length.toLocaleString("id-ID")} masalah data — baris tidak dihitung</h2></div>
            </div>
            <div className="excel-scroll">
              <table>
                <thead><tr><th>No</th><th>File</th><th>Baris CSV</th><th>Kode</th><th>No struk</th><th>Nilai asli</th><th>Alasan</th></tr></thead>
                <tbody>{result.issues.slice(0, LIST_PREVIEW_LIMIT).map((it, i) => <tr key={`i#${it.fileName}#${it.row}-${it.kind}-${i}`}><td>{i + 1}</td><td>{it.fileName}</td><td>{it.row}</td><td>{it.code}</td><td>{it.noStruk}</td><td>{it.value || "(kosong)"}</td><td>{it.message}</td></tr>)}</tbody>
              </table>
            </div>
            {result.issues.length > LIST_PREVIEW_LIMIT && <div style={{ margin: "8px 2px 0", fontSize: 11, color: "var(--muted)" }}>Menampilkan {LIST_PREVIEW_LIMIT} dari {result.issues.length.toLocaleString("id-ID")} masalah.</div>}
          </section>
        )}
      </>}
    </RoyalShell>
  );
}
