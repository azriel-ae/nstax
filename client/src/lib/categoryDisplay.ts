import type { MainCategory } from "./kategoriMapper";

/**
 * Urutan & label TAMPILAN kategori untuk dropdown CEK UPL KLAND.
 * Hanya presentasi: `value` tetap kategori internal (MainCategory) yang dipakai
 * parser, mapping, filter, dan perhitungan.
 */
export const CATEGORY_DROPDOWN_OPTIONS: { value: MainCategory; label: string }[] = [
  { value: "C&C", label: "KLAND Caffe AND Croisant/C&C" },
  { value: "HIBURAN — KLAND HIBURAN", label: "KLAND HIBURAN" },
  { value: "HIBURAN — MESIN CAPIT", label: "KLAND HIBURAN MESIN CAPIT" },
  { value: "HIBURAN — WATER SLIDE", label: "KLAND HIBURAN WATERSLIDE" },
  { value: "HOTEL — K GALLERY", label: "KLAND HOTEL" },
  { value: "PARKIR", label: "KLAND PARKIR" },
  { value: "RESTO PREGO", label: "KLAND RESTO (PREGO)" },
  { value: "K FOOD", label: "KLAND RESTO / KFOOD" },
  { value: "HOTEL — GLAMPING", label: "PT. TAMAN KLAND INDONESIA (GLAMPING)" },
];

const LABELS = new Map<string, string>(CATEGORY_DROPDOWN_OPTIONS.map((o) => [o.value, o.label]));

/** Label tampilan untuk kategori internal; kategori lain (mis. Tidak Terpetakan) apa adanya. */
export const categoryDisplayLabel = (category: string): string => LABELS.get(category) ?? category;
