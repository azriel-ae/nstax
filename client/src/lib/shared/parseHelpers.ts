// Helper murni yang dipakai bersama oleh beberapa parser (isi identik dengan salinan lokal sebelumnya).

export const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function stringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

/** Tanggal kalender valid (1900–2200) → "YYYY-MM-DD", selain itu null. */
export const validYmd = (y: number, m: number, d: number): string | null => {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || y < 1900 || y > 2200) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

/** Angka → string desimal biasa tanpa notasi eksponen; null bila bukan angka hingga. */
export const numberToPlain = (value: number): string | null => {
  if (!Number.isFinite(value)) return null;
  const plain = String(value);
  return /e/i.test(plain) ? value.toFixed(20).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") : plain;
};
