import { useState } from "react";
import { categoryBrand, resolveLogo, type BrandSpec } from "@/lib/parserBrands";

/** Logo resmi bila ada, otherwise ikon/monogram. Tidak pernah menampilkan gambar rusak. */
export function BrandLogo({ spec, size = 44 }: { spec: BrandSpec; size?: number }) {
  const [failed, setFailed] = useState(false);
  const url = resolveLogo(spec.asset);
  const Icon = spec.icon;
  return (
    <span className="brand-logo" style={{ width: size, height: size }} aria-hidden="true">
      {url && !failed ? (
        <img src={url} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} />
      ) : Icon ? (
        <Icon size={Math.round(size * 0.5)} strokeWidth={1.8} />
      ) : (
        <span className="brand-monogram" style={{ fontSize: size * 0.44 }}>{spec.monogram ?? spec.name.charAt(0)}</span>
      )}
    </span>
  );
}

/** Dipakai di halaman kategori: <CategoryIcon label="HOTEL" /> */
export function CategoryIcon({ label, size = 28 }: { label: string; size?: number }) {
  return <BrandLogo spec={categoryBrand(label)} size={size} />;
}

export function NstaxMark({ size = 34 }: { size?: number }) {
  return (
    <svg className="nx-mark" width={size} height={size} viewBox="0 0 40 40" role="img" aria-label="NSTAX">
      <rect x="3" y="3" width="34" height="34" rx="9" fill="#fff" stroke="#e2581a" strokeWidth="2.4" />
      <circle cx="18.5" cy="21" r="5.5" fill="none" stroke="#e2581a" strokeWidth="3" />
      <path d="M24 15v13" fill="none" stroke="#e2581a" strokeWidth="3" strokeLinecap="round" />
      <rect x="31" y="31" width="6" height="6" rx="1.4" fill="#e2581a" />
    </svg>
  );
}
