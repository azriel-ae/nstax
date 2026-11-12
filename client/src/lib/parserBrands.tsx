/// <reference types="vite/client" />
import {
  Building2,
  Car,
  Clapperboard,
  Coffee,
  Croissant,
  CupSoda,
  Drumstick,
  Film,
  Gamepad2,
  Hotel,
  Layers,
  Soup,
  Store,
  Tent,
  Ticket,
  Train,
  Utensils,
  UtensilsCrossed,
  Waves,
  type LucideIcon,
} from "lucide-react";

/**
 * Sistem logo/ikon terpusat NSTAX (hanya UI, tidak menyentuh logika parser).
 *
 * - Key = ID mode parser yang sudah ada di Home.tsx (mis. "fore", "upl").
 * - `asset` = nama file logo di src/assets/logos (tanpa ekstensi). Dideteksi saat build,
 *   jadi tidak ada request 404 kalau filenya belum ada.
 * - Kalau logo tidak ada / gagal dimuat -> `icon`, atau `monogram` bila tidak ada ikon.
 */
export type BrandSpec = {
  name: string;
  asset?: string;
  icon?: LucideIcon;
  monogram?: string;
  round?: boolean;
  /** Rasio lebar/tinggi kotak logo di kartu parser. Default 1.8 (seragam, supaya nama parser sejajar antar kartu; logo panjang tetap besar). */
  ratio?: number;
};

const logoFiles = import.meta.glob<string>("../assets/logos/*.{svg,png,webp,jpg,jpeg}", {
  eager: true,
  query: "?url",
  import: "default",
});

// Versi turunan (margin kosong dipangkas, latar dinormalkan) di assets/logos/optimized.
// File asli tidak diubah; kalau ada versi optimized dengan nama sama, itu yang dipakai.
const optimizedFiles = import.meta.glob<string>("../assets/logos/optimized/*.{svg,png,webp,jpg,jpeg}", {
  eager: true,
  query: "?url",
  import: "default",
});

function indexFiles(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, url] of Object.entries(files)) {
    const base = (path.split("/").pop() ?? "").replace(/\.[^.]+$/, "").toLowerCase();
    if (base) out[base] = url;
  }
  return out;
}

const logoIndex = indexFiles(logoFiles);
const optimizedIndex = indexFiles(optimizedFiles);

export function resolveLogo(asset?: string): string | undefined {
  if (!asset) return undefined;
  const key = asset.toLowerCase();
  return optimizedIndex[key] ?? logoIndex[key];
}

export const PARSER_BRANDS: Record<string, BrandSpec> = {
  // CEK DATA API
  astana: { name: "ASTANA", asset: "astana", icon: Building2 },
  fore: { name: "FORE", asset: "fore", icon: Coffee },
  nsc: { name: "NSC", asset: "nsc", icon: Clapperboard },
  nasgor69: { name: "NASGOR 69", asset: "nasgor69", icon: UtensilsCrossed, round: true }, // logo resmi: assets/logos/nasgor69.webp
  rotio: { name: "ROTIO", asset: "rotio", icon: Croissant, round: true },
  kai: { name: "KAI", asset: "kai", icon: Train },
  hokben: { name: "HOKBEN", asset: "hokben", icon: Soup, round: true },
  kopken: { name: "KOPKEN", asset: "kopken", icon: CupSoda },
  fave: { name: "FAVE", asset: "fave", icon: Store },
  sams: { name: "SAMS", asset: "sams", icon: Film }, // identitas SAMS Studio
  "pointcoffe-hm": { name: "POINTCOFFE HM", asset: "pointcoffee", icon: Coffee },
  manyar: { name: "MANYAR", asset: "manyar", icon: Hotel }, // logo opsional: assets/logos/manyar.png (ikon hotel bila tidak ada)
  "hangry-sda": { name: "HANGRY SDA", asset: "hangry", icon: Utensils },
  familymart: { name: "FAMILY MART", asset: "familymart", icon: Store }, // logo opsional: assets/logos/familymart.png (ikon toko bila tidak ada)
  // CEK DATA KLAND
  upl: { name: "KLAND", asset: "kland", monogram: "K" }, // multi-kategori: identitas KLAND, bukan ikon hotel/resto
};

/** Ikon kategori (KLAND). Key = label kategori persis (uppercase). */
export const CATEGORY_BRANDS: Record<string, BrandSpec> = {
  HOTEL: { name: "HOTEL", asset: "cat-hotel", icon: Hotel },
  RESTO: { name: "RESTO", asset: "cat-resto", icon: Utensils },
  "RESTO PREGO": { name: "RESTO PREGO", asset: "cat-prego", icon: Utensils },
  KFOOD: { name: "KFOOD", asset: "cat-kfood", icon: Drumstick },
  "C&C": { name: "C&C", asset: "cat-cc", icon: CupSoda },
  PARKIR: { name: "PARKIR", asset: "cat-parkir", icon: Car },
  "MESIN CAPIT": { name: "MESIN CAPIT", asset: "cat-capit", icon: Gamepad2 },
  "KLAND HIBURAN": { name: "KLAND HIBURAN", asset: "cat-hiburan", icon: Ticket },
  HIBURAN: { name: "HIBURAN", asset: "cat-hiburan", icon: Ticket },
  "WATER SLIDE": { name: "WATER SLIDE", asset: "cat-waterslide", icon: Waves },
  GLAMPING: { name: "GLAMPING", asset: "cat-glamping", icon: Tent },
};

/** Pencocokan persis (bukan "contains") supaya kategori tidak salah ikon. */
export function categoryBrand(label: string): BrandSpec {
  return CATEGORY_BRANDS[label.trim().toUpperCase()] ?? { name: label, icon: Layers };
}
