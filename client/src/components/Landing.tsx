import { useEffect, useState, type CSSProperties } from "react";
import { ArrowRight, Cloud, Copy, FileText, FileUp, Menu, X } from "lucide-react";
import { NstaxLogo } from "@/components/BrandLogo";
import { resolveLogo } from "@/lib/parserBrands";
import "./Landing.css";

/**
 * Landing page NSTAX V1 (hanya UI). Tidak menyentuh parser, rumus, endpoint, ataupun V2.
 * Navigasi memakai mekanisme yang sudah ada di Home.tsx: `onSelect(mode)`.
 */
export type LandingTarget =
  | "api-menu"
  | "upl-menu"
  | "receipt"
  | "receipt-compare"
  | "astana"
  | "fore"
  | "nsc"
  | "rotio"
  | "hokben"
  | "kai"
  | "fave"
  | "sams";

type Props = { onSelect: (mode: LandingTarget) => void };

const NAV: Array<{ mode: LandingTarget; label: string }> = [
  { mode: "api-menu", label: "Cek Transaksi API" },
  { mode: "upl-menu", label: "Cek Transaksi Upload File" },
  { mode: "receipt", label: "Cek Data Struk" },
  { mode: "receipt-compare", label: "Compare 2 File" },
];

const FEATURES: Array<{ mode: LandingTarget; title: string; text: string; icon: typeof Cloud; tone: string }> = [
  { mode: "api-menu", title: "Cek Transaksi API", text: "Untuk memproses dan memeriksa data transaksi melalui sumber API yang sudah didukung.", icon: Cloud, tone: "blue" },
  { mode: "upl-menu", title: "Cek Transaksi Upload File", text: "Untuk membaca atau memeriksa data transaksi melalui file yang diunggah sesuai format yang didukung.", icon: FileUp, tone: "indigo" },
  { mode: "receipt", title: "Cek Data Struk", text: "Untuk membantu membaca dan memeriksa data dari struk transaksi sesuai kemampuan fitur yang tersedia.", icon: FileText, tone: "green" },
  { mode: "receipt-compare", title: "Compare 2 File", text: "Untuk membandingkan dua file dan membantu menemukan perbedaan data berdasarkan mekanisme yang diterapkan.", icon: Copy, tone: "purple" },
];

/**
 * Logo melayang. `dx`/`dy` = posisi pusat logo terhadap pusat hero (px, ukuran desktop lebar);
 * `mx`/`my` = posisi di layar kecil (persen). `small` = tetap tampil di layar kecil.
 * Semua key adalah mode parser CEK DATA API yang sudah ada di Home.tsx, dan semua file logonya ada di assets/logos.
 */
type Fit = "round" | "crop";
const FLOATING: Array<{ mode: LandingTarget; label: string; asset: string; fit?: Fit; dx: number; y: number; delay: number; small?: { x: number; y: number } }> = [
  { mode: "astana", label: "ASTANA", asset: "astana", dx: -323, y: 147, delay: 0, small: { x: 14, y: 40 } },
  { mode: "fore", label: "FORE", asset: "fore", dx: -462, y: 255, delay: 1.2 },
  { mode: "nsc", label: "NSC", asset: "nsc", dx: -420, y: 399, delay: 2.4 },
  { mode: "rotio", label: "ROTIO", asset: "rotio", fit: "round", dx: -288, y: 471, delay: 0.6, small: { x: 18, y: 0 } },
  { mode: "hokben", label: "HOKBEN", asset: "hokben", fit: "round", dx: 336, y: 144, delay: 1.8, small: { x: 86, y: 40 } },
  { mode: "kai", label: "KAI", asset: "kai", dx: 481, y: 259, delay: 0.3 },
  { mode: "fave", label: "FAVE", asset: "fave", fit: "crop", dx: 424, y: 386, delay: 2.1 },
  { mode: "sams", label: "SAMS", asset: "sams", dx: 289, y: 473, delay: 1.5, small: { x: 82, y: 0 } },
];

const SOURCES: Array<{ mode: LandingTarget; label: string; asset: string; fit?: Fit }> = [
  { mode: "astana", label: "ASTANA", asset: "astana" },
  { mode: "fore", label: "FORE", asset: "fore" },
  { mode: "nsc", label: "NSC", asset: "nsc" },
  { mode: "rotio", label: "ROTIO", asset: "rotio", fit: "round" },
  { mode: "hokben", label: "HOKBEN", asset: "hokben", fit: "round" },
  { mode: "kai", label: "KAI", asset: "kai" },
  { mode: "fave", label: "FAVE", asset: "fave", fit: "crop" },
];

function Logo({ asset, label, fit }: { asset: string; label: string; fit?: Fit }) {
  const [failed, setFailed] = useState(false);
  const url = resolveLogo(asset);
  if (!url || failed) return <span className="lp-logo-fallback">{label.charAt(0)}</span>;
  return <img className={fit ? `is-${fit}` : undefined} src={url} alt="" decoding="async" draggable={false} onError={() => setFailed(true)} />;
}

function Orbit() {
  // Orbit tipis di belakang konten (SVG ringan). Aksen biru hanya pada sebagian busur.
  return (
    <div className="lp-orbit" aria-hidden="true">
      <svg viewBox="-600 -600 1200 1200" focusable="false">
        <defs>
          <linearGradient id="lp-blue" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#6aa2ff" stopOpacity=".95" />
            <stop offset="1" stopColor="#6aa2ff" stopOpacity=".15" />
          </linearGradient>
        </defs>
        <circle r="336" fill="none" stroke="#e6ebf3" strokeWidth="1.2" />
        <circle r="440" fill="none" stroke="#edf0f6" strokeWidth="1.2" />
        <circle r="577" fill="none" stroke="#f1f3f8" strokeWidth="1.2" />
        <circle r="336" fill="none" stroke="url(#lp-blue)" strokeWidth="1.3" pathLength="100" strokeDasharray="22 78" transform="rotate(95)" />
        <circle r="440" fill="none" stroke="url(#lp-blue)" strokeWidth="1.2" pathLength="100" strokeDasharray="16 84" transform="rotate(-20)" />
        <circle r="577" fill="none" stroke="url(#lp-blue)" strokeWidth="1.1" pathLength="100" strokeDasharray="14 86" transform="rotate(150)" />
        <circle cx="-336" cy="-6" r="2.6" fill="#4f8df7" />
        <circle cx="338" cy="12" r="2.6" fill="#4f8df7" />
        <circle cx="-440" cy="-110" r="2.2" fill="#4f8df7" />
        <circle cx="577" cy="-62" r="2.2" fill="#4f8df7" />
        <circle cx="520" cy="250" r="2.2" fill="#4f8df7" />
        <circle cx="-262" cy="-212" r="2.2" fill="#4f8df7" />
      </svg>
    </div>
  );
}

export default function Landing({ onSelect }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const go = (mode: LandingTarget) => { setMenuOpen(false); onSelect(mode); };
  const showFeatures = () => document.getElementById("fitur")?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="lp-root">
      <div className="lp-card">
        <header className="lp-nav-wrap">
          <div className="lp-nav">
            <button type="button" className="lp-nav-logo" onClick={() => { setMenuOpen(false); window.scrollTo({ top: 0, behavior: "smooth" }); }} aria-label="NSTAX — ke atas">
              <NstaxLogo height={30} tagline={false} />
            </button>
            <nav className="lp-nav-links" aria-label="Menu utama">
              {NAV.map((item) => <button key={item.mode} type="button" onClick={() => go(item.mode)}>{item.label}</button>)}
            </nav>
            <button type="button" className="lp-nav-toggle" onClick={() => setMenuOpen((open) => !open)} aria-label={menuOpen ? "Tutup menu" : "Buka menu"} aria-expanded={menuOpen} aria-controls="lp-mobile-menu">
              {menuOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
          {menuOpen && (
            <nav id="lp-mobile-menu" className="lp-mobile-menu" aria-label="Menu utama">
              {NAV.map((item) => <button key={item.mode} type="button" onClick={() => go(item.mode)}>{item.label}<ArrowRight size={15} /></button>)}
            </nav>
          )}
        </header>

        <section className="lp-hero" aria-labelledby="lp-title">
          <Orbit />
          {FLOATING.map((item) => (
            <div
              key={item.mode}
              className={`lp-float${item.small ? " is-small" : ""}${item.small?.y === 0 ? " is-bottom" : ""}`}
              style={{ "--dx": item.dx, "--y": item.y, "--sx": item.small?.x, "--sy": item.small?.y, "--delay": `${item.delay}s` } as unknown as CSSProperties}
            >
              <button type="button" className="lp-float-btn" onClick={() => go(item.mode)} aria-label={`Buka ${item.label}`} title={item.label}>
                <Logo asset={item.asset} label={item.label} fit={item.fit} />
              </button>
            </div>
          ))}
          <div className="lp-hero-content">
            <NstaxLogo className="lp-hero-logo" height={74} tagline={false} />
            <h1 id="lp-title">Pengecekan Transaksi Lebih Cepat dan Akurat</h1>
            <p>NSTAX membantu memeriksa, membaca, dan membandingkan data transaksi dari berbagai sumber dalam satu platform yang praktis, terstruktur, dan mudah digunakan.</p>
            <div className="lp-cta">
              <button type="button" className="lp-btn lp-btn-primary" onClick={() => go("upl-menu")}>Mulai Pengecekan <ArrowRight size={15} /></button>
              <button type="button" className="lp-btn lp-btn-secondary" onClick={showFeatures}>Lihat Fitur</button>
            </div>
          </div>
        </section>

        <section className="lp-section" id="fitur" aria-labelledby="lp-fitur-title">
          <span className="lp-eyebrow">Fitur utama NSTAX</span>
          <h2 id="lp-fitur-title">Semua yang Anda Butuhkan<br className="lp-br" /> dalam Satu Platform</h2>
          <div className="lp-features">
            {FEATURES.map(({ mode, title, text, icon: Icon, tone }) => (
              <button key={mode} type="button" className="lp-feature" onClick={() => go(mode)}>
                <span className={`lp-feature-icon is-${tone}`}><Icon size={22} strokeWidth={1.7} /></span>
                <strong>{title}</strong>
                <span className="lp-feature-text">{text}</span>
                <span className="lp-feature-link">Mulai <ArrowRight size={14} /></span>
              </button>
            ))}
          </div>
        </section>

        <section className="lp-sources" aria-label="Parser dan sumber data yang didukung">
          <div className="lp-sources-label"><span>Parser &amp; sumber data yang didukung</span></div>
          <ul>
            {SOURCES.map((item) => (
              <li key={item.mode}>
                <button type="button" onClick={() => go(item.mode)} aria-label={`Buka ${item.label}`} title={item.label}><Logo asset={item.asset} label={item.label} fit={item.fit} /></button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
