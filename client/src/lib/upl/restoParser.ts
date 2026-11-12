import * as XLSX from "xlsx";
import { BUILT_IN_CATEGORY_CRITERIA, type CategoryBucket } from "./kategoriMapper";
import { dateFromFileName, fileBaseName, normalizeItem, numberFromCell } from "./candcParser";
import { findDuplicateFiles, sortMonthlyFiles, type MonthlyFileResult } from "../shared/monthlyCommon";
import { clean } from "./uplParser";
import { columnLettersOf, locateRecordColumns, type RecordColumns } from "./klandColumns";

/**
 * Record kategori KLAND RESTO (PREGO) dan KLAND RESTO / KFOOD untuk CEK UPL.
 *
 * Modul ini SENGAJA terpisah dari `uplParser.ts` / `uplMonthly.ts` /
 * `candcParser.ts`: parser kategori lain tidak disentuh. Pemetaan item ke
 * kategori tetap dari `BUILT_IN_CATEGORY_CRITERIA` (tanpa fuzzy matching);
 * modul ini hanya membentuk record berformat
 *   id_agent, no_struk, date_trans, subtotal, service_charge, discount,
 *   dpp, tax, total, keterangan
 * langsung dari cell Excel file yang sedang diproses.
 *
 * Mapping kolom (sama untuk PREGO dan KFOOD):
 *   B = keterangan, D = subtotal, E = service_charge, F = tax, G = total
 * Kolom C TIDAK dipakai sebagai subtotal.
 *
 * Tidak ada data/angka/tanggal hardcode, dan tidak ada kondisi berdasar nama file:
 * - baris dipilih dari NILAI kolom B yang cocok dengan item kategori;
 * - angka diambil dari cell mentah kolom D, E, F, G;
 * - tanggal & no_struk dihitung dari nama file yang sedang diproses.
 */

export type RestoKind = "PREGO" | "KFOOD";

export const RESTO_KINDS: Record<RestoKind, { id_agent: string; category: "RESTO PREGO" | "K FOOD"; label: string }> = {
  PREGO: { id_agent: "resto_kland_prego", category: "RESTO PREGO", label: "KLAND RESTO (PREGO)" },
  KFOOD: { id_agent: "resto_kland_kfood", category: "K FOOD", label: "KLAND RESTO / KFOOD" },
};

/** Huruf kolom CADANGAN, hanya dipakai jika header file tidak ditemukan (lihat klandColumns.ts). */
export const RESTO_COLUMNS = {
  keterangan: "B",
  subtotal: "D",
  service_charge: "E",
  tax: "F",
  total: "G",
} as const;

export type RestoRecord = {
  id_agent: string;
  no_struk: string;
  /** YYYY-MM-DD dari nama file (DDMMYY); null jika nama file tidak sesuai format. */
  date_trans: string | null;
  subtotal: number;
  service_charge: number;
  discount: number;
  dpp: number;
  tax: number;
  total: number;
  keterangan: string;
  /** Day-qty dari header; null jika header Day-qty tidak ada (mode kolom tetap). */
  qty: number | null;
  fileName: string;
  sourceSheet: string;
  sourceRow: number;
};

export type RestoTotals = {
  transactionCount: number;
  /** Total Day-qty; null jika ada record tanpa qty. Berbeda dari jumlah record (transactionCount). */
  quantity: number | null;
  subtotal: number;
  service_charge: number;
  discount: number;
  dpp: number;
  tax: number;
  total: number;
};

export type RestoFileResult = {
  fileName: string;
  ok: boolean;
  records: RestoRecord[];
  warnings: string[];
  /** Huruf kolom Excel yang benar-benar dipakai (field -> huruf). */
  columns?: Record<string, string>;
  /** "header" = dari nama header file ini; "fixed" = huruf kolom tetap (header tidak ditemukan). */
  columnSource?: "header" | "fixed";
};

export type RestoResult = {
  kind: RestoKind;
  files: RestoFileResult[];
  records: RestoRecord[];
  totals: RestoTotals;
  warnings: string[];
};


// Baris judul seksi ("1 - PREGO", "2 - KFOOD-HANBOK-CANTEEN", "3 - RESTO PADI - C&C-FAR",
// "11 - BANQUET") bukan item transaksi: parser KLAND utama juga melewatinya, sehingga
// tidak boleh menjadi record agar tidak terhitung dobel.
// "RESTO PADI - C&C-FAR" (nama KFOOD tanpa nomor) juga judul seksi: tanpa nilai, bukan transaksi.
const SECTION_HEADER_PATTERN = /^(\d+\s*-\s*\S|resto padi\s*-\s*c&c-far$)/;

const restoItemKeys = (kind: RestoKind): Set<string> =>
  new Set(
    BUILT_IN_CATEGORY_CRITERIA[RESTO_KINDS[kind].category]
      .map(normalizeItem)
      .filter((key) => !SECTION_HEADER_PATTERN.test(key)),
  );

const emptyTotals = (): RestoTotals => ({ transactionCount: 0, quantity: 0, subtotal: 0, service_charge: 0, discount: 0, dpp: 0, tax: 0, total: 0 });

export function sumRestoRecords(records: RestoRecord[]): RestoTotals {
  const totals = emptyTotals();
  let quantityUnknown = false;
  for (const record of records) {
    totals.transactionCount += 1;
    if (record.qty === null) quantityUnknown = true;
    else if (totals.quantity !== null) totals.quantity += record.qty;
    totals.subtotal += record.subtotal;
    totals.service_charge += record.service_charge;
    totals.discount += record.discount;
    totals.dpp += record.dpp;
    totals.tax += record.tax;
    totals.total += record.total;
  }
  if (quantityUnknown) totals.quantity = null;
  return totals;
}

/** Cell mentah -> angka. Cell kosong dihitung 0 (setara SUM() di SQL yang mengabaikan NULL). */

export async function parseRestoFile(file: File, kind: RestoKind): Promise<RestoFileResult> {
  const warnings: string[] = [];
  const fail = (message: string): RestoFileResult => ({ fileName: file.name, ok: false, records: [], warnings: [message] });

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  } catch {
    return fail(`File Excel tidak dapat dibuka untuk pembacaan ${RESTO_KINDS[kind].label}.`);
  }
  // Sheet yang sama dengan parser KLAND utama (sheet pertama).
  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) return fail(`Worksheet tidak ditemukan untuk pembacaan ${RESTO_KINDS[kind].label}.`);

  const ref = sheet["!ref"] || "A1";
  const range = XLSX.utils.decode_range(ref);
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "", blankrows: true, range: ref }) as unknown[][];

  // Kolom ditentukan dari NAMA HEADER file ini (Description, Day-Nett, Service, Tax, Day-Gros) —
  // sama seperti parser KLAND utama, sehingga ringkasan dan detail membaca kolom yang sama walau
  // posisi kolom antar file berbeda. Huruf kolom tetap hanya dipakai jika header tidak ditemukan.
  const located = locateRecordColumns(matrix);
  const index = (letter: string) => XLSX.utils.decode_col(letter) - range.s.c;
  let col: RecordColumns;
  let startOffset = 0;
  let columnSource: "header" | "fixed";
  if (located) {
    col = located.cols;
    startOffset = located.headerIndex + 1; // hanya baris SETELAH header
    columnSource = "header";
  } else {
    col = {
      keterangan: index(RESTO_COLUMNS.keterangan),
      qty: null,
      subtotal: index(RESTO_COLUMNS.subtotal),
      service_charge: index(RESTO_COLUMNS.service_charge),
      tax: index(RESTO_COLUMNS.tax),
      total: index(RESTO_COLUMNS.total),
    };
    columnSource = "fixed";
    if ((["keterangan", "subtotal", "service_charge", "tax", "total"] as const).some((field) => col[field] < 0)) {
      return fail(`Kolom B, D, E, F, G tidak berada dalam rentang worksheet — data ${RESTO_KINDS[kind].label} tidak dapat dibaca.`);
    }
    warnings.push("Header Description/Day-Nett/Service/Tax/Day-Gros tidak ditemukan — memakai huruf kolom tetap; periksa hasilnya terhadap file sumber.");
  }
  const columns = columnLettersOf(col, range.s.c);

  const base = fileBaseName(file.name);
  const date = dateFromFileName(file.name);
  if (!date) warnings.push(`Nama file "${file.name}" bukan format DDMMYY — date_trans ${RESTO_KINDS[kind].label} dikosongkan.`);

  const keys = restoItemKeys(kind);
  if (kind === "KFOOD") {
    // Nama wajib dicocokkan persis pada kolom Description. Nama yang tidak ditemukan dilaporkan
    // (tidak diganti dengan nama lain yang mirip) agar hasil tidak tampak lengkap padahal tidak.
    const present = new Set<string>();
    matrix.forEach((row, offset) => {
      if (offset >= startOffset) present.add(normalizeItem(row[col.keterangan]));
    });
    const missing = BUILT_IN_CATEGORY_CRITERIA[RESTO_KINDS.KFOOD.category].filter((name) => {
      const key = normalizeItem(name);
      return !SECTION_HEADER_PATTERN.test(key) && !present.has(key);
    });
    if (missing.length > 0) {
      warnings.push(`Nama KFOOD tidak ditemukan pada kolom Description: ${missing.join("; ")}. Nilainya tidak dihitung; periksa file sumber.`);
    }
  }
  const records: RestoRecord[] = [];
  matrix.forEach((row, offset) => {
    if (offset < startOffset) return;
    if (!keys.has(normalizeItem(row[col.keterangan]))) return;
    const sourceRow = range.s.r + offset + 1; // nomor baris Excel, 1-based
    const keterangan = clean(row[col.keterangan]);
    const subtotal = numberFromCell(row[col.subtotal]);
    const service_charge = numberFromCell(row[col.service_charge]);
    records.push({
      id_agent: RESTO_KINDS[kind].id_agent,
      // id = nomor baris Excel sumber (file Excel tidak memiliki kolom id), sama seperti C&C.
      no_struk: `TRX-KW-${base}-${sourceRow}`,
      date_trans: date,
      subtotal,
      service_charge,
      discount: /disc/i.test(keterangan) ? subtotal : 0,
      dpp: subtotal + service_charge,
      tax: numberFromCell(row[col.tax]),
      total: numberFromCell(row[col.total]),
      keterangan,
      qty: col.qty === null ? null : numberFromCell(row[col.qty]),
      fileName: file.name,
      sourceSheet: sheetName,
      sourceRow,
    });
  });

  return { fileName: file.name, ok: true, records, warnings, columns, columnSource };
}

export function combineResto(kind: RestoKind, files: RestoFileResult[]): RestoResult {
  const records = files.flatMap((file) => file.records);
  return {
    kind,
    files,
    records,
    totals: sumRestoRecords(records),
    warnings: files.flatMap((file) => file.warnings.map((warning) => `${file.fileName}: ${warning}`)),
  };
}

/** Semua file diproses (bukan hanya pertama/terakhir) lalu digabung. */
export async function parseRestoFiles(files: File[], kind: RestoKind): Promise<RestoResult> {
  const results: RestoFileResult[] = [];
  for (const file of files) {
    try {
      results.push(await parseRestoFile(file, kind));
    } catch {
      results.push({ fileName: file.name, ok: false, records: [], warnings: [`Gagal membaca data ${RESTO_KINDS[kind].label}.`] });
    }
  }
  return combineResto(kind, results);
}

/**
 * Jalur bulanan: urutan & aturan duplikat/error sama dengan parseUplMonthly,
 * sehingga file yang tidak dihitung di dataset bulanan juga tidak dihitung di sini.
 */
export async function parseRestoForMonthly(inputFiles: File[], fileResults: MonthlyFileResult[], kind: RestoKind): Promise<RestoResult> {
  const sorted = sortMonthlyFiles(inputFiles);
  const duplicates = findDuplicateFiles(sorted);
  const accepted = sorted.filter((_, i) => {
    const result = fileResults[i];
    return Boolean(result) && result.status !== "error" && !result.duplicate && !duplicates.has(i);
  });
  return parseRestoFiles(accepted, kind);
}

/**
 * Pemeriksaan silang antara kategori dari parser KLAND (header Day-Gros/Tax)
 * dan record dari kolom B, D–G. Selisih berarti letak kolom pada file berbeda
 * dari mapping, dan harus dicek user sebelum angka dipakai.
 */
export function restoCrossCheck(kind: RestoKind, bucket: CategoryBucket | undefined, records: RestoRecord[]): string[] {
  if (!bucket) return [];
  const label = RESTO_KINDS[kind].label;
  const totals = sumRestoRecords(records);
  const issues: string[] = [];
  if (bucket.count !== totals.transactionCount) {
    issues.push(`Jumlah baris ${label} pada kategori KLAND (${bucket.count}) berbeda dengan record kolom B (${totals.transactionCount}).`);
  }
  // Ringkasan memakai Day-Gros; padanannya pada record adalah `total` (Day-Gros), bukan `subtotal` (Day-Nett).
  if (Math.abs(bucket.subtotalTotal - totals.total) > 0.5) {
    issues.push(`Total Day-Gros ${label} pada kategori KLAND berbeda dengan SUM total (kolom Day-Gros) pada record.`);
  }
  if (Math.abs(bucket.taxTotal - totals.tax) > 0.5) {
    issues.push(`Total Tax ${label} pada kategori KLAND berbeda dengan SUM tax pada record.`);
  }
  return issues;
}
