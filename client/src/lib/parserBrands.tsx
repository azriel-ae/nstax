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
  Mountain,
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
 * - Key = ID mode parser yang sudah ada di Home.tsx (mis. "fore", "upl", "innatretes").
 * - `asset` = nama file logo di src/assets/logos (tanpa ekstensi). Dideteksi saat build,
 *   jadi tidak ada request 404 kalau filenya belum ada.
 * - Kalau logo tidak ada / gagal dimuat -> `icon`, atau `monogram` bila tidak ada ikon.
 */
export type BrandSpec = { name: string; asset?: string; icon?: LucideIcon; monogram?: string };

const logoFiles = import.meta.glob<string>("../assets/logos/*.{svg,png,webp,jpg,jpeg}", {
  eager: true,
  query: "?url",
  import: "default",
});

const logoIndex: Record<string, string> = {};
for (const [path, url] of Object.entries(logoFiles)) {
  const base = (path.split("/").pop() ?? "").replace(/\.[^.]+$/, "").toLowerCase();
  if (base) logoIndex[base] = url;
}

export function resolveLogo(asset?: string): string | undefined {
  return asset ? logoIndex[asset.toLowerCase()] : undefined;
}

export const PARSER_BRANDS: Record<string, BrandSpec> = {
  // CEK DATA API
  astana: { name: "ASTANA", asset: "astana", icon: Building2 },
  fore: { name: "FORE", asset: "fore", icon: Coffee },
  nsc: { name: "NSC", asset: "nsc", icon: Clapperboard }, // fallback bioskop sampai logo NSC terverifikasi
  nasgor69: { name: "NASGOR 69", asset: "nasgor69", icon: UtensilsCrossed },
  rotio: { name: "ROTIO", asset: "rotio", icon: Croissant },
  kai: { name: "KAI", asset: "kai", icon: Train },
  hokben: { name: "HOKBEN", asset: "hokben", icon: Soup },
  kopken: { name: "KOPKEN", asset: "kopken", icon: CupSoda },
  fave: { name: "FAVE", asset: "fave", icon: Store },
  sams: { name: "SAMS", asset: "sams", icon: Film }, // identitas SAMS Studio
  // CEK UPL
  upl: { name: "KLAND", asset: "kland", monogram: "K" }, // multi-kategori: identitas KLAND, bukan ikon hotel/resto
  pointcoffe: { name: "POINTCOFFE", asset: "pointcoffee", icon: Coffee },
  "omala-menu": { name: "THE OMALA", asset: "omala", monogram: "O" },
  omahpadhang: { name: "OMAH PADHANG", asset: "omahpadhang", icon: Coffee }, // kafe, bukan hotel
  jambuluwuk: { name: "JAMBULUWUK", asset: "jambuluwuk", monogram: "J" },
  innatretes: { name: "INNA TRETES", asset: "innatretes", icon: Mountain },
};

/** Ikon kategori (KLAND, Jambuluwuk, Inna Tretes, Omala). Key = label kategori persis (uppercase). */
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
