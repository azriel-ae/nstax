import * as XLSX from "xlsx";
import { BUILT_IN_CATEGORY_CRITERIA, type CategoryBucket } from "./kategoriMapper";
import { findDuplicateFiles, sortMonthlyFiles, type MonthlyFileResult } from "./monthlyCommon";
import { clean, parseIndonesianNumber } from "./uplParser";

/**
 * Record kategori C&C untuk CEK UPL KLAND.
 *
 * Modul ini SENGAJA terpisah dari `uplParser.ts` / `uplMonthly.ts`: parser
 * lama tidak disentuh. Kategorisasi C&C (qty / Day-Gros / tax) tetap dikerjakan
 * `kategoriMapper.ts`; modul ini hanya membentuk record berformat
 *   id_agent, no_struk, date_trans, subtotal, service_charge, discount,
 *   dpp, tax, total, keterangan
 * langsung dari cell Excel file yang sedang diproses.
 *
 * Tidak ada data/angka/tanggal hardcode:
 * - baris dipilih dari NILAI kolom B (keterangan) yang cocok dengan item C&C,
 *   bukan dari nomor baris;
 * - angka diambil dari cell mentah kolom C, D, E, F;
 * - tanggal & nomor struk dihitung dari nama file yang sedang diproses.
 */

export const CANDC_ID_AGENT = "kland_CandC";

/** Mapping kolom Excel -> field (sesuai spesifikasi). */
export const CANDC_COLUMNS = {
  keterangan: "B",
  subtotal: "C",
  service_charge: "D",
  tax: "E",
  total: "F",
} as const;

export type CandCRecord = {
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
  fileName: string;
  sourceSheet: string;
  sourceRow: number;
};

export type CandCTotals = {
  transactionCount: number;
  subtotal: number;
  service_charge: number;
  discount: number;
  dpp: number;
  tax: number;
  total: number;
};

export type CandCFileResult = {
  fileName: string;
  ok: boolean;
  records: CandCRecord[];
  warnings: string[];
};

export type CandCResult = {
  files: CandCFileResult[];
  records: CandCRecord[];
  totals: CandCTotals;
  warnings: string[];
};

const normalizeItem = (value: unknown): string => clean(value).toLowerCase().replace(/\s+/g, " ").trim();

const candcItemKeys = (): Set<string> => new Set(BUILT_IN_CATEGORY_CRITERIA["C&C"].map(normalizeItem));

/** MySQL: TRIM(SUBSTRING_INDEX(filename, '.', 1)) -> teks sebelum titik pertama. */
export function fileBaseName(fileName: string): string {
  return fileName.split(".")[0].trim();
}

/**
 * STR_TO_DATE(base, '%d%m%y'). Tahun 2 digit mengikuti MySQL: 00-69 -> 2000-2069,
 * 70-99 -> 1970-1999. Mengembalikan null jika format/tanggal tidak valid.
 */
export function dateFromFileName(fileName: string): string | null {
  const match = /^(\d{2})(\d{2})(\d{2})$/.exec(fileBaseName(fileName));
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const yy = Number(match[3]);
  const year = yy < 70 ? 2000 + yy : 1900 + yy;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const emptyTotals = (): CandCTotals => ({ transactionCount: 0, subtotal: 0, service_charge: 0, discount: 0, dpp: 0, tax: 0, total: 0 });

export function sumCandCRecords(records: CandCRecord[]): CandCTotals {
  const totals = emptyTotals();
  for (const record of records) {
    totals.transactionCount += 1;
    totals.subtotal += record.subtotal;
    totals.service_charge += record.service_charge;
    totals.discount += record.discount;
    totals.dpp += record.dpp;
    totals.tax += record.tax;
    totals.total += record.total;
  }
  return totals;
}

/** Cell mentah -> angka. Cell kosong dihitung 0 (setara SUM() di SQL yang mengabaikan NULL). */
const numberFromCell = (value: unknown): number => parseIndonesianNumber(value).value ?? 0;

export async function parseCandCFile(file: File): Promise<CandCFileResult> {
  const warnings: string[] = [];
  const fail = (message: string): CandCFileResult => ({ fileName: file.name, ok: false, records: [], warnings: [message] });

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  } catch {
    return fail("File Excel tidak dapat dibuka untuk pembacaan C&C.");
  }
  // Sheet yang sama dengan parser KLAND utama (sheet pertama).
  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) return fail("Worksheet tidak ditemukan untuk pembacaan C&C.");

  const ref = sheet["!ref"] || "A1";
  const range = XLSX.utils.decode_range(ref);
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "", blankrows: true, range: ref }) as unknown[][];

  // Letter kolom absolut -> index pada matrix (matrix dimulai dari kolom pertama ref).
  const index = (letter: string) => XLSX.utils.decode_col(letter) - range.s.c;
  const col = {
    keterangan: index(CANDC_COLUMNS.keterangan),
    subtotal: index(CANDC_COLUMNS.subtotal),
    service_charge: index(CANDC_COLUMNS.service_charge),
    tax: index(CANDC_COLUMNS.tax),
    total: index(CANDC_COLUMNS.total),
  };
  if (Object.values(col).some((value) => value < 0)) {
    return fail("Kolom B–F tidak berada dalam rentang worksheet — data C&C tidak dapat dibaca.");
  }

  const base = fileBaseName(file.name);
  const date = dateFromFileName(file.name);
  if (!date) warnings.push(`Nama file "${file.name}" bukan format DDMMYY — date_trans C&C dikosongkan.`);

  const keys = candcItemKeys();
  const records: CandCRecord[] = [];
  matrix.forEach((row, offset) => {
    if (!keys.has(normalizeItem(row[col.keterangan]))) return;
    const sourceRow = range.s.r + offset + 1; // nomor baris Excel, 1-based
    const keterangan = clean(row[col.keterangan]);
    const subtotal = numberFromCell(row[col.subtotal]);
    const service_charge = numberFromCell(row[col.service_charge]);
    records.push({
      id_agent: CANDC_ID_AGENT,
      // id = nomor baris Excel sumber (file Excel tidak memiliki kolom id).
      no_struk: `TRX-KW-${base}-${sourceRow}`,
      date_trans: date,
      subtotal,
      service_charge,
      discount: /disc/i.test(keterangan) ? subtotal : 0,
      dpp: subtotal + service_charge,
      tax: numberFromCell(row[col.tax]),
      total: numberFromCell(row[col.total]),
      keterangan,
      fileName: file.name,
      sourceSheet: sheetName,
      sourceRow,
    });
  });

  return { fileName: file.name, ok: true, records, warnings };
}

export function combineCandC(files: CandCFileResult[]): CandCResult {
  const records = files.flatMap((file) => file.records);
  return {
    files,
    records,
    totals: sumCandCRecords(records),
    warnings: files.flatMap((file) => file.warnings.map((warning) => `${file.fileName}: ${warning}`)),
  };
}

/** Semua file diproses (bukan hanya pertama/terakhir) lalu digabung. */
export async function parseCandCFiles(files: File[]): Promise<CandCResult> {
  const results: CandCFileResult[] = [];
  for (const file of files) {
    try {
      results.push(await parseCandCFile(file));
    } catch {
      results.push({ fileName: file.name, ok: false, records: [], warnings: ["Gagal membaca data C&C."] });
    }
  }
  return combineCandC(results);
}

/**
 * Jalur bulanan: urutan & aturan duplikat/error sama dengan parseUplMonthly,
 * sehingga file yang tidak dihitung di dataset bulanan juga tidak dihitung di C&C.
 */
export async function parseCandCForMonthly(inputFiles: File[], fileResults: MonthlyFileResult[]): Promise<CandCResult> {
  const sorted = sortMonthlyFiles(inputFiles);
  const duplicates = findDuplicateFiles(sorted);
  const accepted = sorted.filter((_, i) => {
    const result = fileResults[i];
    return Boolean(result) && result.status !== "error" && !result.duplicate && !duplicates.has(i);
  });
  return parseCandCFiles(accepted);
}

/**
 * Pemeriksaan silang antara kategori C&C dari parser KLAND (header Day-Gros/Tax)
 * dan record C&C dari kolom B–F. Selisih berarti letak kolom pada file berbeda
 * dari mapping B–F, dan harus dicek user sebelum angka dipakai.
 */
export function candcCrossCheck(bucket: CategoryBucket | undefined, records: CandCRecord[]): string[] {
  if (!bucket) return [];
  const totals = sumCandCRecords(records);
  const issues: string[] = [];
  if (bucket.count !== totals.transactionCount) {
    issues.push(`Jumlah baris C&C pada kategori KLAND (${bucket.count}) berbeda dengan record kolom B (${totals.transactionCount}).`);
  }
  if (Math.abs(bucket.subtotalTotal - totals.subtotal) > 0.5) {
    issues.push("Total Day-Gros C&C pada kategori KLAND berbeda dengan SUM kolom C (subtotal).");
  }
  if (Math.abs(bucket.taxTotal - totals.tax) > 0.5) {
    issues.push("Total Tax C&C pada kategori KLAND berbeda dengan SUM kolom E (tax).");
  }
  return issues;
}
