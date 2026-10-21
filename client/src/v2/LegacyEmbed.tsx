// Membungkus halaman checker LAMA tanpa mengubahnya, supaya logika/rumus identik dengan versi produksi.
// Dimuat lazy: kode ini hanya diunduh saat pengguna membuka /v2.
import { lazy, Suspense, type ComponentType } from "react";

type Back = { onBack: () => void };
const L = <P,>(loader: () => Promise<{ default: ComponentType<P> }>) => lazy(loader);

export const LegacyPages = {
  nasgor69: L<Back>(() => import("@/pages/Nasgor69Checker")),
  pointcoffeHm: L<Back>(() => import("@/pages/PointCoffeeHmChecker")),
  familyMart: L<Back>(() => import("@/pages/FamilyMartChecker")),
  receipt: L<Back>(() => import("@/pages/ReceiptChecker")),
  compare: L<Back>(() => import("@/pages/ReceiptCompareChecker")),
  kland: L<Back>(() => import("@/pages/UplChecker")),
  omalaHotel: L<Back>(() => import("@/pages/OmalaChecker").then((m) => ({ default: ({ onBack }: Back) => <m.default category="HOTEL" onBack={onBack} /> }))),
  omalaResto: L<Back>(() => import("@/pages/OmalaChecker").then((m) => ({ default: ({ onBack }: Back) => <m.default category="RESTO" onBack={onBack} /> }))),
  omahPadhang: L<Back>(() => import("@/pages/OmahPadhangChecker")),
  jambuluwuk: L<Back>(() => import("@/pages/JambuluwukChecker")),
  innaTretes: L<Back>(() => import("@/pages/InnaTretesChecker")),
  royalSenyiur: L<Back>(() => import("@/pages/RoyalSenyiurChecker")),
  hotelPlataran: L<Back>(() => import("@/pages/HotelPlataranChecker")),
} as const;

export function Embed({ page, onBack }: { page: keyof typeof LegacyPages; onBack: () => void }) {
  const Page = LegacyPages[page];
  return (
    <div className="v2-embed">
      <Suspense fallback={<p>Memuat…</p>}>
        {/* key: state setiap mode terpisah, tidak bocor antar mode */}
        <Page key={page} onBack={onBack} />
      </Suspense>
    </div>
  );
}
