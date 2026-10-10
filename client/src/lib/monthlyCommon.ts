/**
 * Util bersama untuk fitur UPLOAD BULANAN (CEK KLAND & CEK POINTCOFFE).
 *
 * File ini TIDAK dipakai oleh jalur upload 1 file / harian.
 */

export type MonthlyFileStatus = "success" | "warning" | "error";

export type MonthlyFileInfo = {
  name: string;
  size: number;
  lastModified: number;
};

export type MonthlyFileResult = MonthlyFileInfo & {
  index: number;
  status: MonthlyFileStatus;
  /** Pesan error (status "error") atau ringkasan warning (status "warning"). */
  message?: string;
  warnings: string[];
  /** Jumlah row valid yang MASUK ke dataset bulanan dari file ini. */
  rowCount: number;
  /** true jika file diabaikan karena identik dengan file lain (name+size+lastModified). */
  duplicate: boolean;
  duplicateOf?: string;
  /** Total per file (hanya untuk tampilan/validasi, bukan sumber summary bulanan). */
  qty?: number;
  gross?: number;
  tax?: number;
  total?: number;
};

export type MonthlyProgress = { done: number; total: number; fileName: string };

export const fileSignature = (file: MonthlyFileInfo) => `${file.name}|${file.size}|${file.lastModified}`;

/** Urutkan berdasarkan nama (numerik-aware: 2 < 10). Hanya mengatur urutan; tidak memengaruhi hasil hitung. */
export function sortMonthlyFiles<T extends { name: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => a.name.localeCompare(b.name, "id", { numeric: true, sensitivity: "base" }));
}

/** Pemeriksaan duplikat berdasarkan name + size + lastModified. */
export function findDuplicateFiles(files: MonthlyFileInfo[]): Map<number, number> {
  const seen = new Map<string, number>();
  const duplicates = new Map<number, number>(); // index duplikat -> index file asli
  files.forEach((file, index) => {
    const key = fileSignature(file);
    const original = seen.get(key);
    if (original === undefined) seen.set(key, index);
    else duplicates.set(index, original);
  });
  return duplicates;
}

export const DUPLICATE_WARNING = "File kemungkinan duplikat.";

/** Memberi kesempatan UI untuk repaint di antara file (progress bar). */
export const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
