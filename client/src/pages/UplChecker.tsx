import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { ArrowLeft, Check, FileSpreadsheet, FileText, Filter, Info, ShieldCheck, Trash2, Upload, AlertTriangle } from "lucide-react";
import {
  formatUplRupiah,
  parseUplFiles,
  type UplParseResult,
  type UplRow,
  type UplWorkbookInfo,
} from "@/lib/uplParser";
import {
  MAIN_CATEGORIES,
  UNMAPPED_LABEL,
  categorizeAllRows,
  createBuiltInKategoriResult,
  detectTransactionKategoriColumns,
  filterRowsByCategory,
  summarizeByCategory,
  validateCategoryTotals,
  type CategorizedUplRow,
  type CategoryBucket,
  type CategoryFilter,
  type TransactionCategory,
  type TransactionSourceColumns,
} from "@/lib/kategoriMapper";

type Props = { onBack: () => void };

const ROW_PREVIEW_LIMIT = 100;

function UplMetric({ label, value, money = false }: { label: string; value: number; money?: boolean }) {
  return (
    <div className="metric-card">
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{money ? formatUplRupiah(value) : value.toLocaleString("id-ID")}</strong>
      <span className="metric-helper">Data langsung dari seluruh baris Excel</span>
    </div>
  );
}

// Informasi jujur tentang apa yang benar-benar dibaca dari file: jumlah
// kolom, jumlah baris, baris valid, baris kosong, dan baris yang dilewati.
// Tidak pernah menampilkan angka "preview" seolah-olah itu adalah data
// perhitungan.
function UplStatsPanel({ result }: { result: UplParseResult }) {
  const stats = result.stats;
  if (!stats) return null;
  const items: { label: string; value: number }[] = [
    { label: "Total kolom dibaca", value: stats.totalColumnsRead },
    { label: "Total baris dibaca", value: stats.totalRowsRead },
    { label: "Baris transaksi valid", value: stats.validTransactionRows },
    { label: "Baris kosong", value: stats.emptyRows },
    { label: "Baris dilewati", value: stats.skippedRows },
  ];
  return (
    <>
      <div className="excel-meta upl-stats-grid">
        {items.map((item) => (
          <div key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value.toLocaleString("id-ID")}</strong>
          </div>
        ))}
      </div>
      <div className="mapping-panel upl-audit-panel">
        <div className="eyebrow"><span className="eyebrow-line" /> DEBUG CEK UPL</div>
        <div className="used-columns">
          <strong>Rows Excel terbaca: {stats.totalRowsRead.toLocaleString("id-ID")}</strong>
          <strong>Item rows detected: {stats.validTransactionRows.toLocaleString("id-ID")}</strong>
          <strong>Rows skipped: {stats.skippedRows.toLocaleString("id-ID")}</strong>
          <strong>Blank: {stats.skippedBlankRows.toLocaleString("id-ID")}</strong>
          <strong>Total: {stats.skippedTotalRows.toLocaleString("id-ID")}</strong>
          <strong>Section: {stats.skippedSectionRows.toLocaleString("id-ID")}</strong>
          <strong>Activity Parking: {stats.activityParkingDetected ? "YES" : "NO"}</strong>
          <strong>Parking category: PARKIR</strong>
          {stats.activityParkingDetected && <strong>Parking qty {stats.activityParkingQty ?? "—"} · Tax {stats.activityParkingTax ?? "—"} · Gross {stats.activityParkingGross ?? "—"}</strong>}
        </div>
      </div>
    </>
  );
}

// Struktur workbook secara lengkap: nama file, jumlah sheet, sheet aktif,
// rentang kolom asli (kolom pertama - kolom terakhir), dan rentang baris.
function UplWorkbookPanel({ workbook }: { workbook: UplWorkbookInfo }) {
  return (
    <div className="excel-meta upl-stats-grid">
      <div><span>Nama file</span><strong>{workbook.fileName}</strong></div>
      <div><span>Jumlah sheet</span><strong>{workbook.sheetNames.length}</strong></div>
      <div><span>Sheet aktif</span><strong>{workbook.activeSheet}</strong></div>
      <div><span>Rentang kolom</span><strong>{workbook.firstColumn} – {workbook.lastColumn}</strong></div>
      <div><span>Header terdeteksi</span><strong>Baris {workbook.headerRow}</strong></div>
      <div><span>Rentang baris data</span><strong>{workbook.firstDataRow} – {workbook.lastDataRow}</strong></div>
    </div>
  );
}

// Audit sebelum SUM: menunjukkan kolom & header yang benar-benar dipakai,
// berapa nilai yang valid vs tidak dapat diparse, dan total akhirnya —
// supaya tidak ada nilai yang diam-diam diubah tanpa terlihat.
function UplAuditPanel({ result }: { result: UplParseResult }) {
  const stats = result.stats;
  const summary = result.summary;
  if (!stats || !summary) return null;
  const subtotalMapping = result.mappings.find((m) => m.field === "subtotal");
  const taxMapping = result.mappings.find((m) => m.field === "tax");
  return (
    <div className="mapping-panel upl-audit-panel">
      <div className="eyebrow"><span className="eyebrow-line" /> AUDIT SEBELUM SUM</div>
      <div className="mapping-grid upl-audit-grid">
        <div>
          <strong>Day-Gros</strong>
          <span>Kolom: <b>{subtotalMapping?.column ?? "—"}</b></span>
          <span>Header: {subtotalMapping?.header || "—"}</span>
          <span>Nilai valid: {stats.subtotalValidCount.toLocaleString("id-ID")}</span>
          {stats.subtotalInvalidCount > 0 && <span className="upl-audit-warning">Nilai tidak dapat diparse: {stats.subtotalInvalidCount.toLocaleString("id-ID")}</span>}
          <span>Total: <b>{formatUplRupiah(summary.subtotalTotal)}</b></span>
        </div>
        <div>
          <strong>Pajak</strong>
          <span>Kolom: <b>{taxMapping?.column ?? "—"}</b></span>
          <span>Header: {taxMapping?.header || "—"}</span>
          <span>Nilai valid: {stats.taxValidCount.toLocaleString("id-ID")}</span>
          {stats.taxInvalidCount > 0 && <span className="upl-audit-warning">Nilai tidak dapat diparse: {stats.taxInvalidCount.toLocaleString("id-ID")}</span>}
          <span>Total: <b>{formatUplRupiah(summary.taxTotal)}</b></span>
        </div>
      </div>
    </div>
  );
}

  // Informasi audit KATEGORI: kategori aktif, total data
// Excel, transaksi valid, transaksi kategori terpilih, dan jumlah yang tidak
// terpetakan — supaya user dapat memverifikasi bahwa filtering benar bekerja.
function UplKategoriAuditPanel({
  categoryFilter,
  perCategory,
  totalDataRows,
  validTransactionRows,
}: {
  categoryFilter: CategoryFilter;
  perCategory: Record<TransactionCategory, CategoryBucket>;
  totalDataRows: number;
  validTransactionRows: number;
}) {
  const activeLabel = categoryFilter === "ALL" ? "Semua Kategori" : categoryFilter;
  return (
    <div className="mapping-panel upl-audit-panel">
      <div className="eyebrow"><span className="eyebrow-line" /> INFORMASI AUDIT KATEGORI</div>
      <div className="mapping-grid upl-audit-grid">
        <div>
          <strong>Kategori aktif</strong>
          <span>{activeLabel}</span>
        </div>
        <div>
          <strong>Total data Excel</strong>
          <span>{totalDataRows.toLocaleString("id-ID")} baris</span>
        </div>
        <div>
          <strong>Transaksi valid</strong>
          <span>{validTransactionRows.toLocaleString("id-ID")}</span>
        </div>
        {categoryFilter !== "ALL" && (
          <div>
            <strong>Transaksi kategori {categoryFilter}</strong>
            <span>{perCategory[categoryFilter].quantityTotal.toLocaleString("id-ID")} qty · {perCategory[categoryFilter].count.toLocaleString("id-ID")} item</span>
          </div>
        )}
        <div>
          <strong>Tidak terpetakan</strong>
          <span>{perCategory[UNMAPPED_LABEL].count.toLocaleString("id-ID")}</span>
        </div>
      </div>
      <div className="used-columns">
        Rincian per kategori:{" "}
        {MAIN_CATEGORIES.map((cat) => (
          <strong key={cat}>{cat} → {perCategory[cat].quantityTotal.toLocaleString("id-ID")} qty / {perCategory[cat].count.toLocaleString("id-ID")} item</strong>
        ))}
        <strong>{UNMAPPED_LABEL} → {perCategory[UNMAPPED_LABEL].quantityTotal.toLocaleString("id-ID")} qty / {perCategory[UNMAPPED_LABEL].count.toLocaleString("id-ID")} item</strong>
      </div>
    </div>
  );
}

function UplItemAuditTable({ rows }: { rows: CategorizedUplRow[] }) {
  return (
    <section className="excel-preview upl-item-audit">
      <div className="section-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> AUDIT ITEM FULL DATASET</div>
          <h2>Description, Day-qty, Tax, Day-Gros, Kategori</h2>
        </div>
        <span className="result-count">{rows.length.toLocaleString("id-ID")} item terbaca</span>
      </div>
      <div className="excel-scroll">
        <table>
          <thead><tr><th>No</th><th>Source Sheet</th><th>Source Row</th><th>Description / Unit</th><th>Day-qty</th><th>Tax</th><th>Day-Gros</th><th>Kategori</th></tr></thead>
          <tbody>{rows.map((row, index) => <tr key={`${row.sourceSheet}-${row.sourceRow}-${index}`}><td>{index + 1}</td><td>{row.sourceSheet}</td><td>{row.sourceRow}</td><td>{row.description || "—"}</td><td>{row.qty ?? "—"}</td><td>{formatUplRupiah(row.tax ?? 0)}</td><td>{formatUplRupiah(row.subtotal ?? 0)}</td><td>{row.category}</td></tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}

// Tabel seluruh kolom (A sampai kolom terakhir, mis. AAA) dengan horizontal
// scroll, header sticky, dan nomor baris sticky. Baris boleh dibatasi secara
// VISUAL untuk performa (dengan tombol untuk menampilkan semuanya), tetapi
// ini murni tampilan — perhitungan di atas selalu memakai seluruh dataset.
// Kolom "Kategori" (opsional) murni tampilan tambahan; tidak mengubah cara
// Day-Gros/Tax dihitung maupun jumlah baris yang diproses.
function UplFullTable({
  workbook,
  fullRows,
  categoryLabel,
}: {
  workbook: UplWorkbookInfo;
  fullRows: (UplRow & { category?: TransactionCategory })[];
  categoryLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const rowsToShow = expanded ? fullRows : fullRows.slice(0, ROW_PREVIEW_LIMIT);
  const hasMore = fullRows.length > ROW_PREVIEW_LIMIT;
  const showCategoryColumn = fullRows.some((row) => row.category !== undefined);

  return (
    <div className="excel-preview upl-full-preview">
      <div className="section-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-line" /> SELURUH KOLOM & BARIS EXCEL</div>
          <h2>Kolom {workbook.firstColumn} sampai {workbook.lastColumn}</h2>
        </div>
        <span className="result-count">
          Menampilkan {rowsToShow.length.toLocaleString("id-ID")} dari {fullRows.length.toLocaleString("id-ID")} baris transaksi valid
          {categoryLabel ? ` · Kategori: ${categoryLabel}` : ""}
          {" · "}
          {workbook.totalColumns.toLocaleString("id-ID")} kolom
        </span>
      </div>
      <div className="excel-scroll upl-table-scroll">
        <table className="excel-table upl-full-table">
          <thead>
            <tr>
              <th className="upl-sticky-col upl-sticky-corner"><span>#</span><small>Baris Excel</small></th>
              {showCategoryColumn && <th><span>Kategori</span></th>}
              {workbook.columnNames.map((column, index) => (
                <th key={column}>
                  <span>{column}</span>
                  <small>{workbook.headerValues[index] || ""}</small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowsToShow.map((row) => (
              <tr key={row.sourceRow}>
                <td className="upl-sticky-col">{row.sourceRow}</td>
                {showCategoryColumn && <td>{row.category ?? ""}</td>}
                {row.cells.map((cell, index) => (
                  <td key={index}>{cell || ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasMore && (
        <div className="upl-expand-row">
          <button className="button button-ghost compact" type="button" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "Tampilkan sebagian saja" : `Tampilkan seluruh ${fullRows.length.toLocaleString("id-ID")} baris`}
          </button>
        </div>
      )}
    </div>
  );
}

export default function UplChecker({ onBack }: Props) {
  const [source, setSource] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [result, setResult] = useState<UplParseResult | null>(null);
  const [notice, setNotice] = useState("");
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("ALL");

  const usedColumnBadges = useMemo(() => {
    if (!result?.mappings.length) return [];
    return result.mappings.map((mapping) => ({
      key: mapping.field,
      label: mapping.field === "tax" ? "Pajak" : mapping.field === "no_struk" ? "No Struk" : "Day-Gros",
      column: mapping.column,
    }));
  }, [result]);

  const analyze = async (file?: File) => { if (file) return analyzeFiles([file]); };
  const analyzeFiles = async (files: File[]) => {
    if (!files.length) return;
    const invalid = files.find((file) => !/\.(xlsx|xls)$/i.test(file.name));
    if (invalid) {
      setNotice("CEK UPL hanya menerima file Excel .xlsx atau .xls.");
      return;
    }
    try {
      const parsed = await parseUplFiles(files);
      setSource(files.length === 1 ? files[0].name : `${files.length} file Excel`);
      setSelectedFiles(files.map((file) => file.name));
      setResult(parsed);
      if (!parsed.ok) {
        setNotice(parsed.error || "File Excel tidak dapat dibaca.");
      } else {
        const count = parsed.summary?.transactionCount ?? 0;
        setNotice(`${files.length} file diproses · ${count.toLocaleString("id-ID")} transaksi valid dihitung dari seluruh dataset.`);
      }
    } catch {
      setResult(null);
      setNotice("File Excel tidak dapat dibaca. Periksa workbook dan worksheet.");
    }
  };

  const clear = () => {
    setSource("");
    setSelectedFiles([]);
    setResult(null);
    setNotice("");
  };

  const summary = result?.ok ? result.summary : undefined;
  const workbook = result?.ok ? result.workbook : undefined;

  // Kategori selalu memakai kriteria internal; user tidak perlu upload master.
  const builtInMaster = useMemo(() => createBuiltInKategoriResult(), []);
  const kategoriActive = Boolean(result?.ok);

  const sourceCols: TransactionSourceColumns | null = useMemo(() => {
    if (!kategoriActive || !workbook) return null;
    return detectTransactionKategoriColumns(workbook.headerValues);
  }, [kategoriActive, workbook]);

  // Urutan wajib: (1) seluruh worksheet & baris sudah dibaca oleh parseUplFile
  // di atas (fullRows), (2) header & mapping kolom Day-Gros/Tax sudah
  // dilakukan oleh parseUplFile, (3) di sinilah mapping kategori per
  // transaksi dilakukan terhadap fullRows — SEBELUM filter/hitung, dan
  // SELALU dari dataset penuh, tidak pernah dari preview.
  const categorizedRows: CategorizedUplRow[] = useMemo(() => {
    if (!kategoriActive || !result?.ok || !sourceCols) return [];
    return categorizeAllRows(result.fullRows, builtInMaster, sourceCols);
  }, [kategoriActive, result, builtInMaster, sourceCols]);

  const perCategory = useMemo(() => summarizeByCategory(categorizedRows), [categorizedRows]);

  // Validasi: seluruh kategori spesifik + Tidak Terpetakan
  // harus sama dengan seluruh transaksi valid. Jika gagal, hasil kategori
  // tidak ditampilkan sampai diperbaiki.
  const categoryValidationError = useMemo(() => {
    if (!kategoriActive || !categorizedRows.length) return null;
    return validateCategoryTotals(categorizedRows, perCategory);
  }, [kategoriActive, categorizedRows, perCategory]);

  const kategoriUsable = kategoriActive && !categoryValidationError;

  // (6) Filter berdasarkan kategori pilihan dilakukan terhadap dataset penuh
  // yang SUDAH dikategorikan, baru (7) dihitung — tidak pernah dihitung dari
  // seluruh data lalu "dibagi", dan tidak pernah dari 8 baris preview.
  const filteredCategorizedRows = useMemo(() => {
    if (!kategoriUsable) return [];
    return filterRowsByCategory(categorizedRows, categoryFilter);
  }, [kategoriUsable, categorizedRows, categoryFilter]);

  // Jika "Semua Kategori" dipilih (atau kategori belum aktif), hasil PERSIS
  // sama dengan sistem CEK UPL yang sudah ada — summary asli dari
  // parseUplFile dipakai apa adanya, tidak dihitung ulang.
  const activeSummary = useMemo(() => {
    if (!summary) return undefined;
    if (!kategoriUsable || categoryFilter === "ALL") return summary;
    const bucket = perCategory[categoryFilter];
    return { transactionCount: bucket.quantityTotal, subtotalTotal: bucket.subtotalTotal, taxTotal: bucket.taxTotal };
  }, [summary, kategoriUsable, categoryFilter, perCategory]);

  const tableRows = useMemo(() => {
    if (!result?.ok) return [];
    if (!kategoriUsable) return result.fullRows;
    return filteredCategorizedRows;
  }, [result, kategoriUsable, filteredCategorizedRows]);

  const kategoriSourceBadges = useMemo(() => {
    if (!kategoriUsable || !workbook || !sourceCols) return [];
    const pick = (indices: number[], label: string) =>
      indices.map((index) => ({ label, header: workbook.headerValues[index] || "—", column: workbook.columnNames[index] }));
    return pick(sourceCols.subCols, "Rincian / Item");
  }, [kategoriUsable, workbook, sourceCols]);

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><span>α</span></div>
          <div>
            <div className="brand-name">nstax</div>
            <div className="brand-caption">transaction intelligence</div>
          </div>
        </div>
        <div className="sidebar-divider" />
        <nav className="sidebar-nav">
          <button className="nav-item" type="button" onClick={onBack}><ArrowLeft size={18} /><span>Kembali pilih mode</span></button>
          <div className="nav-item is-active"><FileSpreadsheet size={18} /><span>CEK UPL</span></div>
        </nav>
        <div className="sidebar-footer">
          <div className="privacy-badge"><ShieldCheck size={16} /><div><strong>Local-first</strong><span>Data tidak keluar dari browser</span></div></div>
          <div className="version-label">nstax / CEK UPL</div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <button className="button button-secondary compact" type="button" onClick={onBack}><ArrowLeft size={15} /> Kembali</button>
          <div className="breadcrumb"><span>Workspace</span><span>›</span><strong>CEK UPL</strong></div>
          <div className="status-chip"><span className="status-dot" /></div>
        </header>
        <div className="page-container">
          <section className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> CEK UPL · UPLOAD FILE AUDIT</div>
              <h1>Periksa upload<br /><em>secara menyeluruh.</em></h1>
              <p>Upload Excel dengan ribuan baris dan ratusan kolom. CEK UPL membaca seluruh kolom & seluruh baris apa adanya, mencari header secara dinamis, lalu menghitung Day-Gros dan pajak dari seluruh dataset — bukan dari preview.</p>
            </div>
            <div className="heading-meta">
              <span className="meta-label">CURRENT SOURCE</span>
              <strong>{source || "Belum ada file"}</strong>
              <span className="meta-subtitle">{summary ? `${summary.transactionCount.toLocaleString("id-ID")} transaksi valid` : "Menunggu file Excel"}</span>
            </div>
          </section>
          <section className="input-panel panel-surface">
            <div className="panel-heading">
              <div className="panel-title-wrap">
                <span className="section-number">01</span>
                <div><h2>Upload file UPL</h2><p>Pilih workbook Excel untuk membaca seluruh struktur dan transaksi.</p></div>
              </div>
              {source && <span className="file-pill"><FileText size={15} />{source}</span>}
            </div>
            <div
              className={`drop-zone ${drag ? "is-dragging" : ""}`}
              onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={() => setDrag(false)}
                  onDrop={(e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setDrag(false); void analyzeFiles(Array.from(e.dataTransfer.files)); }}
            >
              <div className="upload-symbol"><Upload size={20} /></div>
              <strong>{drag ? "Lepaskan file Excel di sini" : "Tarik satu atau beberapa file Excel ke sini"}</strong>
              <span>atau pilih dari perangkat Anda</span>
              <button className="button button-secondary" type="button" onClick={() => inputRef.current?.click()}><FileSpreadsheet size={16} /> Pilih file bulanan</button>
              <small>Hanya .XLSX dan .XLS · seluruh kolom & baris dihitung</small>
              <input ref={inputRef} type="file" accept=".xlsx,.xls" multiple hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { void analyzeFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
            </div>
            {selectedFiles.length > 0 && <div className="used-columns"><strong>File diproses: {selectedFiles.length}</strong>{selectedFiles.map((name) => <span key={name}>✓ {name}</span>)}</div>}
            <div className="input-actions">
              <div className="privacy-note"><ShieldCheck size={15} /> Diproses lokal di browser</div>
              <button className="button button-ghost" type="button" onClick={clear}><Trash2 size={16} /> Clear</button>
            </div>
          </section>

          {notice && (
            <div className={`notice ${result?.ok ? "notice-success" : "notice-error"}`}>
              <span className="notice-icon">{result?.ok ? <Check size={17} /> : <AlertTriangle size={17} />}</span>
              {notice}
            </div>
          )}

          {result?.warnings && result.warnings.length > 0 && (
            <div className="notice notice-warning">
              <span className="notice-icon"><Info size={17} /></span>
              <div>{result.warnings.map((warning) => <div key={warning}>{warning}</div>)}</div>
            </div>
          )}

          {workbook && <UplWorkbookPanel workbook={workbook} />}
          {result?.ok && <UplStatsPanel result={result} />}
          {result?.ok && <UplAuditPanel result={result} />}

          {/* ============ KATEGORI BERDASARKAN KRITERIA BAWAAN ============ */}
          <section className="input-panel panel-surface">
            <div className="panel-heading">
              <div className="panel-title-wrap">
                <span className="section-number">02</span>
                <div>
                  <h2>Pilih kategori perhitungan</h2>
                  <p>Kategori ditentukan hanya dari Rincian / Item yang cocok persis dengan master-item bawaan.</p>
                </div>
              </div>
            </div>
            <div className="input-actions">
              <label className="date-field">
                <Filter size={15} />
                <span>Kategori</span>
                <select value={categoryFilter} disabled={!kategoriUsable} onChange={(e) => setCategoryFilter(e.target.value as CategoryFilter)}>
                  <option value="ALL">Semua Kategori</option>
                  {MAIN_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
              </label>
              <div className="privacy-note"><ShieldCheck size={15} /> Diproses lokal di browser</div>
            </div>
          </section>

          {categoryValidationError && (
            <div className="notice notice-error">
              <span className="notice-icon"><AlertTriangle size={17} /></span>
              {categoryValidationError}
            </div>
          )}
          {/* ============ akhir fitur KATEGORI ============ */}

          {activeSummary && (
            <section className="analysis-section">
              <div className="section-heading">
                <div>
                  <div className="eyebrow"><span className="eyebrow-line" /> 03 · HASIL CEK UPL</div>
                  <h2>Hasil perhitungan {kategoriUsable && categoryFilter !== "ALL" ? `kategori ${categoryFilter}` : "seluruh transaksi"}</h2>
                </div>
              </div>
              <div className="metric-grid upl-metrics">
                <UplMetric label="Jumlah transaksi" value={activeSummary.transactionCount} />
                <UplMetric label="Total Day-Gros" value={activeSummary.subtotalTotal} money />
                <UplMetric label="Total pajak" value={activeSummary.taxTotal} money />
              </div>
              <div className="used-columns">
                Kolom yang terdeteksi:{" "}
                {usedColumnBadges.map((badge) => (
                  <strong key={badge.key}>{badge.label} → {badge.column}</strong>
                ))}
              </div>
              {kategoriUsable && kategoriSourceBadges.length > 0 && (
                <div className="used-columns">
                  Kolom Rincian / Item sumber kategori terdeteksi:{" "}
                  {kategoriSourceBadges.map((badge, index) => (
                    <strong key={`${badge.label}-${index}`}>{badge.label} ({badge.header}) → {badge.column}</strong>
                  ))}
                </div>
              )}
              {kategoriUsable && kategoriSourceBadges.length === 0 && (
                <div className="notice notice-warning">
                  <span className="notice-icon"><Info size={17} /></span>
                  Tidak ditemukan kolom Rincian / Item pada file transaksi untuk pemetaan kategori — seluruh transaksi akan ditandai "{UNMAPPED_LABEL}".
                </div>
              )}
            </section>
          )}

          {kategoriUsable && workbook && (
            <UplKategoriAuditPanel
              categoryFilter={categoryFilter}
              perCategory={perCategory}
              totalDataRows={workbook.totalSheetRows}
              validTransactionRows={categorizedRows.length}
            />
          )}

          {kategoriUsable && <UplItemAuditTable rows={categorizedRows} />}

          {workbook && result?.ok && !categoryValidationError && (
            <UplFullTable
              workbook={workbook}
              fullRows={tableRows}
              categoryLabel={kategoriUsable ? (categoryFilter === "ALL" ? "Semua Kategori" : categoryFilter) : undefined}
            />
          )}
        </div>
      </main>
    </div>
  );
}
