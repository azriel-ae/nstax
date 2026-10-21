import * as XLSX from "xlsx";
import { validYmd, numberToPlain } from "../shared/parseHelpers";

// CEK UPL · PLATARAN (Plataran Bromo Resorts & Venue) — satu file Excel memuat EMPAT kategori transaksi yang diproses independen:
// HOTEL PLATARAN, SYAILENDRA VENUE AND DINING (dulu RESTO PLATARAN), RESTO PAMIRANTI LOUNGE, dan RESTO TERAS BROMO.
//
// Sumber  : sheet "BODY EMAIL" (sheet MACRO / DRR / BUDGET / STATISTIC / ROOMS bukan sumber transaksi dan tidak dibaca).
//           Kolom B = nama pos (menentukan kategori sekaligus menjadi keterangan dan bagian no_struk)
//           Kolom C = nilai subtotal
// Kategori (filter SQL acuan, nilai kolom B harus sama persis; huruf besar/kecil, spasi di tepi, dan spasi ganda diabaikan):
//   HOTEL      (id_agent hotel_plataran)                : ROOM REVENUE | ENCOUNTERS REVENUE | M.O.D REVENUE
//   SYAILENDRA (id_agent syailendra_venue_and_dining)   : FB REVENUE SYAILENDRA & KINANDARI | BANQUET
//   PAMIRANTI  (id_agent resto_pamiranti_lounge)        : FB REVENUE PAMIRANTI
//   TERAS_BROMO (id_agent resto_teras_bromo)            : FB REVENUE TERAS BROMO  (filter = nilai persis, bukan pencarian teks "TERAS"/"BROMO")
//   Setiap label kolom B hanya milik satu kategori (tidak ada label ganda → tidak ada transaksi yang dihitung dua kali).
//   Baris lain di sheet (statistik kamar, SPA, TOTAL HOTEL REVENUE, ringkasan pajak, dst.) diabaikan.
// Baris berlabel kategori yang BUKAN transaksi: header kolom (C berisi teks "TODAY", mis. judul blok "BANQUET") — dilewati dan dihitung.
//
// Rumus (sama untuk keempat kategori, sesuai SQL acuan — JANGAN diganti):
//   no_struk       = CONCAT(B, '-', REPLACE(filename, '.xlsx', ''))
//   date_trans     = tanggal dari nama file (DDMMYY / DDMMYYYY sebelum penanda "-Tax"), BUKAN tanggal upload / hari ini
//   subtotal       = C
//   service_charge = C * 0.1
//   discount       = 0
//   dpp            = C + (C * 0.1)
//   tax            = (C + (C * 0.1)) * 0.1
//   total          = (C + (C * 0.1)) + ((C + (C * 0.1)) * 0.1)
//   keterangan     = B
// Catatan TERAS BROMO: SQL-nya menulis dpp = C*1.1, tax = C*1.1*0.1, total = C*1.1*1.1 (bukan dpp + tax secara eksplisit). Secara aljabar
// C*1.1*1.1 = C*1.21 = dpp + tax, sehingga dengan aritmetika bilangan bulat eksak di bawah hasilnya identik digit demi digit dengan tiga kategori lain.
// SQL tidak memakai GROUP BY: setiap baris yang lolos filter menjadi tepat satu record (termasuk nilai 0 dan negatif).
//
// Akurasi: C dibaca sebagai desimal eksak (BigInt, skala 15) dan semua rumus dihitung dengan bilangan bulat pada skala 17,
// tanpa floating point dan tanpa pembulatan antara. Pembulatan 2 desimal hanya terjadi saat TAMPILAN (formatPlataranMoney);
// jumlah ringkasan dijumlahkan dari nilai penuh.
// C kosong / teks / error pada baris kategori TIDAK diam-diam dianggap 0: baris dilaporkan sebagai masalah dan tidak dihitung.

export type PlataranCategory = "HOTEL" | "SYAILENDRA" | "PAMIRANTI" | "TERAS_BROMO";

/** Urutan tampil kategori (UI, ringkasan, ekspor). */
export const PLATARAN_CATEGORIES: readonly PlataranCategory[] = ["HOTEL", "SYAILENDRA", "PAMIRANTI", "TERAS_BROMO"];

export const PLATARAN_HOTEL_AGENT_ID = "hotel_plataran";
export const PLATARAN_SYAILENDRA_AGENT_ID = "syailendra_venue_and_dining"; // menggantikan "resto_plataran"
export const PLATARAN_PAMIRANTI_AGENT_ID = "resto_pamiranti_lounge";
export const PLATARAN_TERAS_BROMO_AGENT_ID = "resto_teras_bromo";
export const PLATARAN_AGENT_IDS: Record<PlataranCategory, string> = {
  HOTEL: PLATARAN_HOTEL_AGENT_ID,
  SYAILENDRA: PLATARAN_SYAILENDRA_AGENT_ID,
  PAMIRANTI: PLATARAN_PAMIRANTI_AGENT_ID,
  TERAS_BROMO: PLATARAN_TERAS_BROMO_AGENT_ID,
};
/** Nama kategori yang ditampilkan di UI. */
export const PLATARAN_CATEGORY_NAMES: Record<PlataranCategory, string> = {
  HOTEL: "HOTEL PLATARAN",
  SYAILENDRA: "SYAILENDRA VENUE AND DINING",
  PAMIRANTI: "RESTO PAMIRANTI LOUNGE",
  TERAS_BROMO: "RESTO TERAS BROMO",
};
export const PLATARAN_SHEET_NAME = "BODY EMAIL";

/** Nilai kolom B per kategori (urutan = urutan pada SQL acuan). */
export const PLATARAN_CATEGORY_LABELS: Record<PlataranCategory, readonly string[]> = {
  HOTEL: ["ROOM REVENUE", "ENCOUNTERS REVENUE", "M.O.D REVENUE"],
  SYAILENDRA: ["FB REVENUE SYAILENDRA & KINANDARI", "BANQUET"],
  PAMIRANTI: ["FB REVENUE PAMIRANTI"],
  TERAS_BROMO: ["FB REVENUE TERAS BROMO"],
};

/** Skala C saat dibaca (digit desimal). Hasil rumus memakai skala C + 2. */
const INPUT_SCALE = 15;
export const PLATARAN_SCALE = INPUT_SCALE + 2;

const COL_B = 2;
const COL_C = 3;

export type PlataranRow = {
  category: PlataranCategory;
  id_agent: string;
  no_struk: string;
  date_trans: string; // YYYY-MM-DD
  /** Semua nilai uang: bilangan bulat berskala 10^-PLATARAN_SCALE (eksak). */
  subtotal: bigint;
  service_charge: bigint;
  discount: bigint;
  dpp: bigint;
  tax: bigint;
  total: bigint;
  keterangan: string;
  filename: string; // nama file asal baris (selalu terisi, juga pada mode harian)
  sourceRow: number; // nomor baris di sheet BODY EMAIL (1-based)
  notes: string[]; // catatan validasi; data tidak diubah
};

export type PlataranIssue = { file: string; row: number; label: string; value: string; message: string };

export type PlataranStats = {
  files: number; // file yang berhasil dibaca
  sourceRows: number; // baris sheet yang berisi sesuatu di kolom B atau C
  hotelRows: number; // record HOTEL yang lolos filter
  syailendraRows: number; // record SYAILENDRA VENUE AND DINING yang lolos filter
  pamirantiRows: number; // record RESTO PAMIRANTI LOUNGE yang lolos filter
  terasBromoRows: number; // record RESTO TERAS BROMO yang lolos filter
  ignoredRows: number; // baris berisi di luar semua label kategori (tidak dihitung)
  headerRows: number; // baris berlabel kategori tetapi C = "TODAY" (header kolom, bukan transaksi)
  invalidAmountRows: number; // baris kategori dengan C kosong / bukan angka valid (tidak dihitung, dilaporkan)
  zeroRows: number; // dari record yang dihitung: berapa yang bernilai 0 (tetap dihitung, sesuai SQL)
  validRows: number; // record yang masuk ke hasil (hotelRows + syailendraRows + pamirantiRows + terasBromoRows)
};

export type PlataranSource = {
  ok: boolean;
  error?: string;
  fileName: string;
  sheetName: string;
  dates: string[]; // tanggal dari nama file tiap file yang berhasil dibaca
  rows: PlataranRow[];
  issues: PlataranIssue[];
  warnings: string[]; // peringatan non-blokir (kategori tidak ditemukan, tanggal dalam sheet berbeda, dll.)
  stats: PlataranStats;
};

const emptyStats = (): PlataranStats => ({
  files: 0, sourceRows: 0, hotelRows: 0, syailendraRows: 0, pamirantiRows: 0, terasBromoRows: 0, ignoredRows: 0, headerRows: 0, invalidAmountRows: 0, zeroRows: 0, validRows: 0,
});

export const failPlataranSource = (fileName: string, error: string, extra: Partial<PlataranSource> = {}): PlataranSource => ({
  ok: false, error, fileName, sheetName: "", dates: [], rows: [], issues: [], warnings: [], stats: emptyStats(), ...extra,
});

const CATEGORY_STAT_KEY: Record<PlataranCategory, "hotelRows" | "syailendraRows" | "pamirantiRows" | "terasBromoRows"> = {
  HOTEL: "hotelRows",
  SYAILENDRA: "syailendraRows",
  PAMIRANTI: "pamirantiRows",
  TERAS_BROMO: "terasBromoRows",
};

const CATEGORY_BY_LABEL: ReadonlyMap<string, PlataranCategory> = new Map(
  PLATARAN_CATEGORIES.flatMap((cat) => PLATARAN_CATEGORY_LABELS[cat].map((label) => [label, cat] as const)),
);
if (CATEGORY_BY_LABEL.size !== PLATARAN_CATEGORIES.reduce((n, cat) => n + PLATARAN_CATEGORY_LABELS[cat].length, 0)) {
  throw new Error("Label kolom B PLATARAN ganda antar kategori: satu label hanya boleh milik satu kategori.");
}

const normalizeLabel = (value: string): string => value.replace(/\s+/g, " ").trim().toUpperCase();

/** Desimal polos → bigint berskala INPUT_SCALE (setengah menjauhi nol). null = bukan angka valid. */
export function parsePlataranDecimal(text: string): bigint | null {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!m) return null;
  const intPart = m[2] ?? "";
  const fracPart = m[3] ?? "";
  if (intPart === "" && fracPart === "") return null;
  const kept = (fracPart + "0".repeat(INPUT_SCALE)).slice(0, INPUT_SCALE);
  let scaled = BigInt(intPart === "" ? "0" : intPart) * 10n ** BigInt(INPUT_SCALE) + BigInt(kept);
  if (fracPart.charAt(INPUT_SCALE) !== "" && fracPart.charAt(INPUT_SCALE) >= "5") scaled += 1n;
  return m[1] === "-" ? -scaled : scaled;
}

/** Semua rumus PLATARAN (ketiga kategori sama) dari satu nilai C (bigint skala INPUT_SCALE) → bigint skala PLATARAN_SCALE. Eksak. */
export function computePlataranAmounts(c: bigint) {
  return {
    subtotal: c * 100n, //        C
    service_charge: c * 10n, //   C * 0.1
    discount: 0n, //              0
    dpp: c * 110n, //             C + (C * 0.1)
    tax: c * 11n, //              (C + (C * 0.1)) * 0.1
    total: c * 121n, //           (C + (C * 0.1)) + ((C + (C * 0.1)) * 0.1)
  };
}

/** Bigint skala PLATARAN_SCALE → "Rp1.234,56" (2 desimal hanya untuk tampilan, setengah menjauhi nol, tanpa floating point). */
export function formatPlataranMoney(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const unit = 10n ** BigInt(PLATARAN_SCALE - 2);
  let cents = abs / unit;
  if (abs % unit >= unit / 2n) cents += 1n;
  const intText = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const frac = (cents % 100n).toString().padStart(2, "0");
  return `Rp${negative && cents !== 0n ? "-" : ""}${intText},${frac}`;
}

/** Representasi desimal penuh (untuk audit/pengujian), tanpa nol di belakang. */
export function plataranToPlain(value: bigint): string {
  const negative = value < 0n;
  const abs = (negative ? -value : value).toString().padStart(PLATARAN_SCALE + 1, "0");
  const int = abs.slice(0, abs.length - PLATARAN_SCALE);
  const frac = abs.slice(abs.length - PLATARAN_SCALE).replace(/0+$/, "");
  return `${negative ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

export type PlataranFilenameDate = { ok: true; date: string } | { ok: false; error: string };

// Penanda "-Tax" pada SQL. Nama file sampel berbentuk "DRR_PLBR_300926- Tax.xlsx" (ada spasi setelah tanda hubung) dan sebagian
// sistem mengganti spasi itu dengan "_" ("-_Tax"); ketiganya dibaca sebagai penanda yang sama. Huruf besar/kecil diabaikan.
const TAX_MARKER = /-[\s_]*tax/i;

/**
 * Meniru SQL:
 *   DATE_FORMAT(STR_TO_DATE(SUBSTRING_INDEX(SUBSTRING_INDEX(filename, '-Tax', 1), '_', -1), '%d%m%Y'), '%Y-%m-%d')
 * 1) ambil teks sebelum penanda "-Tax" (bila tidak ada: seluruh nama file, sama seperti SUBSTRING_INDEX);
 * 2) ambil bagian setelah underscore terakhir;
 * 3) baca DDMMYY (6 digit, tahun 2 digit: <70 → 20xx, ≥70 → 19xx seperti MySQL) atau DDMMYYYY (8 digit) dari awal bagian itu.
 * Jumlah digit lain, tanggal kalender yang tidak ada (mis. 31 Feb), atau tidak ada angka → tidak valid. Tidak pernah memakai
 * tanggal upload / hari ini sebagai pengganti.
 */
export function parsePlataranFilenameDate(fileName: string): PlataranFilenameDate {
  const marker = TAX_MARKER.exec(fileName);
  const before = marker ? fileName.slice(0, marker.index) : fileName;
  const segment = before.slice(before.lastIndexOf("_") + 1);
  const digits = /^\d+/.exec(segment)?.[0] ?? "";
  const hint = 'Nama file harus berbentuk "..._DDMMYY- Tax.xlsx", contoh "DRR_PLBR_300926- Tax.xlsx" (tanggal 6 digit sebelum "-Tax").';
  if (digits.length !== 6 && digits.length !== 8) {
    return { ok: false, error: `Tanggal tidak dapat diambil dari nama file "${fileName}": ${digits ? `ditemukan ${digits.length} digit ("${digits}"), dibutuhkan 6 (DDMMYY) atau 8 (DDMMYYYY)` : "tidak ada angka tanggal setelah underscore terakhir"}. ${hint}` };
  }
  const day = Number(digits.slice(0, 2));
  const month = Number(digits.slice(2, 4));
  const yearText = digits.slice(4);
  const yearNumber = Number(yearText);
  const year = yearText.length === 2 ? (yearNumber < 70 ? 2000 + yearNumber : 1900 + yearNumber) : yearNumber;
  const date = validYmd(year, month, day);
  if (!date) return { ok: false, error: `Tanggal "${digits.slice(0, 2)}-${digits.slice(2, 4)}-${yearText}" pada nama file "${fileName}" bukan tanggal kalender yang valid. ${hint}` };
  return { ok: true, date };
}

/** Bagian nama file pada no_struk: REPLACE(filename, '.xlsx', '') — semua kemunculan ".xlsx", bagian lain nama file tidak diubah. */
export const plataranFileStem = (fileName: string): string => fileName.replace(/\.xlsx/gi, "");

export const buildPlataranNoStruk = (b: string, fileName: string): string => `${b}-${plataranFileStem(fileName)}`;

/** Sel minimal (kompatibel dengan CellObject SheetJS): t = tipe ("n" angka, "s" teks, "e" error, "b" boolean, "z" kosong), v = nilai, f = rumus. */
export type PlataranCell = { t: string; v?: unknown; f?: string; w?: string };

/** Akses sel sheet (baris dan kolom 1-based: kolom 2 = B, kolom 3 = C). Memisahkan aturan parser dari pustaka pembaca Excel. */
export type PlataranGrid = {
  sheetName: string;
  lastRow: number;
  getCell: (row: number, col: number) => PlataranCell | undefined;
};

const cellText = (cell: PlataranCell | undefined): string => {
  if (!cell || cell.v === undefined || cell.v === null) return "";
  if (cell.t === "e") return cell.w ?? "";
  if (typeof cell.v === "number") return numberToPlain(cell.v) ?? String(cell.v);
  return String(cell.v);
};

type Amount = { kind: "empty" } | { kind: "header" } | { kind: "invalid"; raw: string } | { kind: "ok"; value: bigint };

/** Format angka yang diterima pada kolom C bertipe teks: desimal polos saja ("1234.5"). Pemisah ribuan / koma desimal ditolak, bukan ditebak. */
const PLAIN_DECIMAL_TEXT = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

const readAmount = (cell: PlataranCell | undefined): Amount => {
  if (!cell || cell.t === "z" || cell.v === undefined || cell.v === null) return { kind: "empty" };
  if (cell.t === "e") return { kind: "invalid", raw: cell.w ?? "#ERROR" };
  if (typeof cell.v === "number") {
    const plain = numberToPlain(cell.v);
    const value = plain === null ? null : parsePlataranDecimal(plain);
    return value === null ? { kind: "invalid", raw: String(cell.v) } : { kind: "ok", value };
  }
  if (typeof cell.v === "string") {
    const text = cell.v.trim();
    if (text === "") return { kind: "empty" };
    if (normalizeLabel(text) === "TODAY") return { kind: "header" };
    const value = PLAIN_DECIMAL_TEXT.test(text) ? parsePlataranDecimal(text) : null;
    return value === null ? { kind: "invalid", raw: text } : { kind: "ok", value };
  }
  return { kind: "invalid", raw: String(cell.v) };
};

const parseSheetDateText = (cell: PlataranCell | undefined): string | null => {
  if (!cell || cell.v === undefined || cell.v === null) return null;
  if (typeof cell.v === "number") {
    if (!Number.isFinite(cell.v) || cell.v < 61) return null;
    const probe = new Date(Date.UTC(1899, 11, 30) + Math.floor(cell.v) * 86400000);
    return validYmd(probe.getUTCFullYear(), probe.getUTCMonth() + 1, probe.getUTCDate());
  }
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(String(cell.v).trim());
  return m ? validYmd(Number(m[3]), Number(m[2]), Number(m[1])) : null;
};

/**
 * Aturan baca satu sheet BODY EMAIL. Kegagalan struktur (tanggal nama file tidak valid, tidak satu pun baris kategori ditemukan)
 * menghasilkan ok=false dengan pesan yang jelas; tidak ada tebakan kolom atau data pengganti.
 */
export function parsePlataranGrid(grid: PlataranGrid, fileName: string): PlataranSource {
  const where = `sheet "${grid.sheetName}"`;
  const dateResult = parsePlataranFilenameDate(fileName);
  if (!dateResult.ok) return failPlataranSource(fileName, dateResult.error, { sheetName: grid.sheetName });
  const date = dateResult.date;

  const stats = emptyStats();
  const rows: PlataranRow[] = [];
  const issues: PlataranIssue[] = [];
  const warnings: string[] = [];
  const seenLabels = new Set<string>(); // label kategori yang punya minimal satu record valid
  const foundLabels = new Set<string>(); // label kategori yang muncul di kolom B (apa pun isi C)
  let firstMatchRow = 0;

  for (let r = 1; r <= grid.lastRow; r++) {
    const bCell = grid.getCell(r, COL_B);
    const cCell = grid.getCell(r, COL_C);
    const label = cellText(bCell); // dipakai apa adanya pada no_struk dan keterangan (sesuai SQL: kolom B)
    const labelNorm = normalizeLabel(label);
    const amount = readAmount(cCell);
    if (labelNorm === "" && amount.kind === "empty") continue;
    stats.sourceRows++;

    const category = CATEGORY_BY_LABEL.get(labelNorm);
    if (!category) { stats.ignoredRows++; continue; }
    foundLabels.add(labelNorm);
    if (!firstMatchRow) firstMatchRow = r;

    if (amount.kind === "header") { stats.headerRows++; continue; } // judul blok (C = "TODAY"), bukan transaksi
    if (amount.kind === "empty" || amount.kind === "invalid") {
      stats.invalidAmountRows++;
      const raw = amount.kind === "invalid" ? amount.raw : "";
      issues.push({
        file: fileName, row: r, label, value: raw,
        message: amount.kind === "empty"
          ? `Nominal kolom C pada "${label.trim()}" (${PLATARAN_CATEGORY_NAMES[category]}) kosong — baris tidak dihitung.`
          : `Nominal kolom C "${raw}" pada "${label.trim()}" (${PLATARAN_CATEGORY_NAMES[category]}) bukan angka valid — baris tidak dihitung.`,
      });
      continue;
    }

    const notes: string[] = [];
    if (amount.value === 0n) { stats.zeroRows++; notes.push("Nominal 0"); }
    if (amount.value < 0n) notes.push("Nominal negatif");
    rows.push({
      category,
      id_agent: PLATARAN_AGENT_IDS[category],
      no_struk: buildPlataranNoStruk(label, fileName), // CONCAT(B, '-', REPLACE(filename, '.xlsx', ''))
      date_trans: date,
      ...computePlataranAmounts(amount.value),
      keterangan: label, // B
      filename: fileName,
      sourceRow: r,
      notes,
    });
    seenLabels.add(labelNorm);
    stats[CATEGORY_STAT_KEY[category]]++;
    stats.validRows++;
  }
  stats.files = 1;

  if (foundLabels.size === 0) {
    return failPlataranSource(
      fileName,
      `Struktur ${where} tidak sesuai: tidak ada baris dengan kolom B bernilai ${Object.values(PLATARAN_CATEGORY_LABELS).flat().map((l) => `"${l}"`).join(", ")}. File tidak diproses.`,
      { sheetName: grid.sheetName },
    );
  }

  for (const cat of PLATARAN_CATEGORIES) {
    const missing = PLATARAN_CATEGORY_LABELS[cat].filter((label) => !seenLabels.has(label));
    if (missing.length) warnings.push(`Kategori ${PLATARAN_CATEGORY_NAMES[cat]}: ${missing.map((l) => `"${l}"`).join(", ")} tidak menghasilkan record pada ${where}${missing.some((l) => foundLabels.has(l)) ? " (nominal tidak valid, lihat daftar masalah)" : " (label tidak ditemukan di kolom B)"}.`);
  }

  // Tanggal laporan di dalam sheet (bila ada, sebelum baris kategori pertama) hanya dibandingkan; tanggal yang dipakai tetap dari nama file sesuai SQL.
  for (let r = 1; r < firstMatchRow; r++) {
    const sheetDate = parseSheetDateText(grid.getCell(r, COL_C));
    if (sheetDate === null) continue;
    if (sheetDate !== date) warnings.push(`Tanggal laporan di dalam sheet (${sheetDate}, baris ${r}) berbeda dari tanggal pada nama file (${date}). Yang dipakai adalah tanggal dari nama file.`);
    break;
  }

  return { ok: true, fileName, sheetName: grid.sheetName, dates: [date], rows, issues, warnings, stats };
}

/** Membaca satu workbook Excel (.xlsx). Hanya sheet "BODY EMAIL" yang diparse; sheet lain tidak pernah dianggap sumber transaksi. */
export function parseHotelPlataranWorkbook(buffer: ArrayBuffer, fileName: string): PlataranSource {
  let sheetNames: string[];
  try {
    sheetNames = XLSX.read(buffer, { type: "array", bookSheets: true }).SheetNames;
  } catch {
    return failPlataranSource(fileName, "File tidak dapat dibaca sebagai workbook Excel (.xlsx).");
  }
  const candidates = sheetNames.filter((name) => name.trim().toUpperCase() === PLATARAN_SHEET_NAME);
  if (candidates.length === 0) return failPlataranSource(fileName, `Sheet "${PLATARAN_SHEET_NAME}" tidak ditemukan. Sheet pada file: ${sheetNames.join(", ") || "(tidak ada)"}.`);
  if (candidates.length > 1) return failPlataranSource(fileName, `Ada ${candidates.length} sheet bernama "${PLATARAN_SHEET_NAME}" (${candidates.join(", ")}). Tidak dapat dipastikan sheet mana yang dipakai.`);
  const sheetName = candidates[0];

  let sheet: XLSX.WorkSheet | undefined;
  try {
    sheet = XLSX.read(buffer, { type: "array", sheets: sheetName }).Sheets[sheetName];
  } catch {
    return failPlataranSource(fileName, `Sheet "${sheetName}" tidak dapat dibaca.`, { sheetName });
  }
  const ref = sheet?.["!ref"];
  if (!sheet || !ref) return failPlataranSource(fileName, `Sheet "${sheetName}" kosong.`, { sheetName });
  const range = XLSX.utils.decode_range(ref);
  return parsePlataranGrid({
    sheetName,
    lastRow: range.e.r + 1,
    getCell: (row, col) => sheet![XLSX.utils.encode_cell({ r: row - 1, c: col - 1 })] as XLSX.CellObject | undefined,
  }, fileName);
}

/**
 * Menggabungkan beberapa file yang SUDAH diparse (mode BULANAN) menjadi satu hasil. Setiap record tetap membawa no_struk,
 * date_trans, keterangan, dan nama file asalnya sendiri; tidak ada pengelompokan atau penjumlahan antar record. Hanya file ok
 * yang digabung; file gagal dilaporkan oleh pemanggil (jangan menyebut proses lengkap bila ada yang gagal).
 */
export function mergePlataranSources(sources: readonly PlataranSource[]): PlataranSource {
  const ok = sources.filter((src) => src.ok);
  if (ok.length === 1) return ok[0];
  if (ok.length === 0) return failPlataranSource(sources.map((src) => src.fileName).join(", "), sources.map((src) => `${src.fileName}: ${src.error ?? "gagal dibaca"}`).join(" | ") || "Tidak ada file yang dapat dihitung.");
  const stats = emptyStats();
  for (const src of ok) (Object.keys(stats) as Array<keyof PlataranStats>).forEach((key) => { stats[key] += src.stats[key]; });
  return {
    ok: true,
    fileName: `${ok.length} file`,
    sheetName: [...new Set(ok.map((src) => src.sheetName))].join(", "),
    dates: ok.flatMap((src) => src.dates),
    rows: ok.flatMap((src) => src.rows),
    issues: ok.flatMap((src) => src.issues),
    warnings: ok.flatMap((src) => src.warnings.map((w) => `${src.fileName}: ${w}`)),
    stats,
  };
}

export type PlataranSummary = {
  count: number;
  subtotal: bigint;
  service_charge: bigint;
  discount: bigint;
  dpp: bigint;
  tax: bigint;
  total: bigint;
};

/** Ringkasan per kategori dari SELURUH record (bukan halaman preview); kategori tanpa record tetap muncul dengan nilai 0. */
export function summarizePlataranByCategory(rows: readonly PlataranRow[]): Record<PlataranCategory, PlataranSummary> {
  return {
    HOTEL: summarizePlataranRows(rows.filter((r) => r.category === "HOTEL")),
    SYAILENDRA: summarizePlataranRows(rows.filter((r) => r.category === "SYAILENDRA")),
    PAMIRANTI: summarizePlataranRows(rows.filter((r) => r.category === "PAMIRANTI")),
    TERAS_BROMO: summarizePlataranRows(rows.filter((r) => r.category === "TERAS_BROMO")),
  };
}

/** Ringkasan dari SELURUH record yang diberikan (bukan halaman preview). */
export function summarizePlataranRows(rows: readonly PlataranRow[]): PlataranSummary {
  const s: PlataranSummary = { count: 0, subtotal: 0n, service_charge: 0n, discount: 0n, dpp: 0n, tax: 0n, total: 0n };
  for (const row of rows) {
    s.count++;
    s.subtotal += row.subtotal;
    s.service_charge += row.service_charge;
    s.discount += row.discount;
    s.dpp += row.dpp;
    s.tax += row.tax;
    s.total += row.total;
  }
  return s;
}

/** no_struk yang muncul lebih dari sekali (label kategori yang sama bernilai angka lebih dari sekali dalam satu file). Data tidak diubah. */
export function findDuplicatePlataranNoStruk(rows: readonly PlataranRow[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const row of rows) { if (seen.has(row.no_struk)) dup.add(row.no_struk); else seen.add(row.no_struk); }
  return dup;
}
