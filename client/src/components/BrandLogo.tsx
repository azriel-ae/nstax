import { useState, type CSSProperties } from "react";
import { resolveLogo, type BrandSpec } from "@/lib/parserBrands";
import { NSTAX_LOGO_H, NSTAX_LOGO_VIEWBOX, NSTAX_LOGO_W, NSTAX_SYMBOL_N_PATH, NSTAX_WORD_PATH } from "@/lib/nstaxLogoPaths";

/** Logo resmi bila ada, otherwise ikon/monogram. Tidak pernah menampilkan gambar rusak. */
export function BrandLogo({ spec, size = 44, wide, parser }: { spec: BrandSpec; size?: number; wide?: boolean; /** Kartu parser: ukuran diatur CSS (64px desktop, 56px mobile), lebar mengikuti spec.ratio. */ parser?: boolean }) {
  const [failed, setFailed] = useState(false);
  const url = resolveLogo(spec.asset);
  const Icon = spec.icon;
  const cls = `brand-logo${spec.round ? " is-round" : ""}${parser ? " is-parser" : ""}`;
  const style = (parser
    ? { "--logo-r": spec.ratio ?? 1.8 }
    : { width: wide ? Math.round(size * 1.3) : size, height: size, "--logo-h": `${size}px` }) as unknown as CSSProperties;
  return (
    <span className={cls} style={style} aria-hidden="true">
      {url && !failed ? (
        <img src={url} alt="" decoding="async" draggable={false} onError={() => setFailed(true)} />
      ) : Icon ? (
        <Icon size={parser ? 30 : Math.round(size * 0.5)} strokeWidth={1.8} />
      ) : (
        <span className="brand-monogram" style={{ fontSize: parser ? 28 : size * 0.44 }}>{spec.monogram ?? spec.name.charAt(0)}</span>
      )}
    </span>
  );
}

const NX_BLUE = "var(--nx-logo-blue, #2563EB)";

function LogoSymbol() {
  return (
    <>
      <rect width="96" height="96" rx="24" fill={NX_BLUE} />
      <path fill="#fff" d={NSTAX_SYMBOL_N_PATH} />
    </>
  );
}

/** Simbol NSTAX saja (favicon / area kecil): kotak biru + huruf N putih. */
export function NstaxMark({ size = 34, className }: { size?: number; className?: string }) {
  return (
    <svg className={`nx-mark${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 96 96" role="img" aria-label="NSTAX">
      <LogoSymbol />
    </svg>
  );
}

/** Logo horizontal NSTAX: simbol + wordmark. `height` dalam px. Prop `tagline` dipertahankan agar pemanggil lama tetap valid (logo baru tanpa tagline). */
export function NstaxLogo({ height = 40, className }: { height?: number; tagline?: boolean; className?: string }) {
  const ink = "var(--nx-logo-ink, #0F172A)";
  return (
    <svg className={`nx-logo${className ? ` ${className}` : ""}`} height={height} viewBox={NSTAX_LOGO_VIEWBOX} role="img" aria-label="NSTAX" style={{ width: "auto", aspectRatio: `${NSTAX_LOGO_W} / ${NSTAX_LOGO_H}` }}>
      <LogoSymbol />
      <path transform="translate(120 80)" fill={ink} d={NSTAX_WORD_PATH} />
    </svg>
  );
}

/** Branding sidebar halaman parser: logo penuh saat lebar, ikon saja saat sidebar ciut (diatur CSS). */
export function SidebarBrand() {
  return (
    <div className="brand-lockup">
      <NstaxLogo className="brand-full" height={36} />
      <NstaxMark className="brand-icon" size={34} />
    </div>
  );
}
