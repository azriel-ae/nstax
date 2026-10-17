import { useState } from "react";
import { useLocation } from "wouter";
import "./v2.css";
import { Embed, LegacyPages } from "./LegacyEmbed";
import CekDataApi from "./pages/CekDataApi";

type Item = { key: keyof typeof LegacyPages; label: string; note: string };
const APITRANS: Item[] = [
  { key: "nasgor69", label: "NASGOR69", note: "Parser NASGOR 69 (JSON API)" },
  { key: "pointcoffeHm", label: "POINTCOFFE HM", note: "Nilai sumber dipertahankan, tidak dihitung ulang" },
  { key: "familyMart", label: "FAMILY MART", note: "Filter prefix no_struk" },
];
const UPL: Item[] = [
  { key: "kland", label: "KLAND", note: "Multi-kategori, harian & bulanan" },
  { key: "omalaHotel", label: "THE OMALA · HOTEL", note: "" },
  { key: "omalaResto", label: "THE OMALA · RESTO", note: "" },
  { key: "omahPadhang", label: "OMAH PADHANG", note: "Harian & bulanan" },
  { key: "jambuluwuk", label: "JAMBULUWUK", note: "Query editor HOTEL & RESTO" },
  { key: "innaTretes", label: "INNA TRETES", note: "Harian & bulanan" },
  { key: "royalSenyiur", label: "ROYAL SENYIUR", note: "CSV HOTEL & RESTO" },
  { key: "hotelPlataran", label: "HOTEL PLATARAN", note: "Excel BODY EMAIL, 4 kategori" },
];

const NAV = [
  { path: "/v2", label: "Dashboard" },
  { path: "/v2/cek-data-api", label: "BACA DATA API" },
  { path: "/v2/apitrans", label: "BACA DATA APITRANS" },
  { path: "/v2/baca-struk", label: "BACA DATA STRUK" },
  { path: "/v2/compare", label: "COMPARE 2 FILE" },
  { path: "/v2/upl", label: "CEK UPL" },
];

function Picker({ title, sub, items, base, go }: { title: string; sub: string; items: Item[]; base: string; go: (p: string) => void }) {
  return (
    <>
      <h1 className="v2-h1">{title}</h1>
      <p className="v2-sub">{sub}</p>
      <div className="v2-grid">
        {items.map((i) => (
          <button key={i.key} type="button" className="v2-card" onClick={() => go(`${base}/${i.key}`)}><strong>{i.label}</strong>{i.note && <span>{i.note}</span>}</button>
        ))}
      </div>
    </>
  );
}

export default function V2App() {
  const [loc, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const path = loc.replace(/\/+$/, "") || "/v2";
  const go = (p: string) => { navigate(p); setOpen(false); window.scrollTo(0, 0); };
  const seg = path.split("/"); // ["", "v2", section, mode]
  const section = seg[2] ?? "";
  const mode = seg[3] ?? "";

  let body;
  if (section === "cek-data-api") body = <CekDataApi />;
  else if (section === "apitrans") {
    const item = APITRANS.find((i) => i.key === mode);
    body = item ? <Embed page={item.key} onBack={() => go("/v2/apitrans")} /> : <Picker title="BACA DATA APITRANS" sub="Pilih sumber. Setiap mode memakai parser dan pemetaan datanya sendiri." items={APITRANS} base="/v2/apitrans" go={go} />;
  } else if (section === "baca-struk") body = <Embed page="receipt" onBack={() => go("/v2")} />;
  else if (section === "compare") body = <Embed page="compare" onBack={() => go("/v2")} />;
  else if (section === "upl") {
    const item = UPL.find((i) => i.key === mode);
    body = item ? <Embed page={item.key} onBack={() => go("/v2/upl")} /> : <Picker title="CEK UPL" sub="Parser, rumus, dan filter sama persis dengan versi sebelumnya." items={UPL} base="/v2/upl" go={go} />;
  } else if (section === "") {
    body = (
      <>
        <h1 className="v2-h1">NSTAX V2</h1>
        <p className="v2-sub">Akses cepat ke fitur. Aplikasi lama tetap tersedia di halaman utama.</p>
        <div className="v2-grid">
          {NAV.slice(1).map((n) => <button key={n.path} type="button" className="v2-card" onClick={() => go(n.path)}><strong>{n.label}</strong></button>)}
          <a className="v2-card" href="/"><strong>NSTAX versi lama</strong><span>Buka halaman utama</span></a>
        </div>
      </>
    );
  } else body = <><h1 className="v2-h1">Halaman tidak ditemukan</h1><button className="v2-btn" type="button" onClick={() => go("/v2")}>Ke Dashboard V2</button></>;

  return (
    <div className="v2-root">
      <header className="v2-top"><button type="button" onClick={() => setOpen((o) => !o)} aria-label="Menu">☰</button><strong>NSTAX V2</strong></header>
      <aside className={`v2-side${open ? " open" : ""}`}>
        <div className="v2-brand">NSTAX<small>V2 · LIGHT ENTERPRISE</small></div>
        <div className="v2-nav-label">Menu</div>
        <nav className="v2-nav">
          {NAV.map((n) => {
            const active = n.path === "/v2" ? section === "" : path === n.path || path.startsWith(n.path + "/");
            return <a key={n.path} className={active ? "is-active" : ""} onClick={() => go(n.path)} role="link" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && go(n.path)}>{n.label}</a>;
          })}
        </nav>
        <div className="v2-side-foot">Data diproses lokal di browser.<br /><a href="/" style={{ color: "#cfe0f7" }}>← NSTAX versi lama</a></div>
      </aside>
      <main className="v2-main"><div className="v2-content">{body}</div></main>
    </div>
  );
}
