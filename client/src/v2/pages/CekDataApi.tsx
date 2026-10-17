import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { API_KINDS, API_KIND_LABELS, detectApiFormat, type ApiKind, type DetectionResult } from "../detect/apiDetector";
import { runApiParser, type RunView } from "../detect/apiRunner";

const MAX_BYTES = 10 * 1024 * 1024;
const PAGE = 200;

export default function CekDataApi() {
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const [kind, setKind] = useState<ApiKind | null>(null);
  const [manual, setManual] = useState(false);
  const [view, setView] = useState<RunView | null>(null);
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [cat, setCat] = useState("ALL");
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => { setDetection(null); setKind(null); setManual(false); setView(null); setQuery(""); setShown(PAGE); setCat("ALL"); setError(""); };

  const analyze = (value: string) => {
    reset();
    const d = detectApiFormat(value);
    setDetection(d);
    if (d.status === "confident") { setKind(d.kind); setView(runApiParser(d.kind, value)); }
  };
  const runManual = (k: ApiKind) => { setManual(true); setKind(k); setQuery(""); setShown(PAGE); setCat("ALL"); setView(runApiParser(k, text)); };

  const onFile = async (file?: File) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".json")) { reset(); setError("Hanya file .json yang didukung parser BACA DATA API."); return; }
    if (file.size > MAX_BYTES) { reset(); setError("Ukuran file melebihi 10 MB."); return; }
    try { const t = await file.text(); setText(t); setSource(file.name); analyze(t); } catch { reset(); setError("File tidak dapat dibaca."); }
  };

  // Parser dengan filter kategori (MANYAR) menghitung ulang dari data sumber yang sama; parser lain memakai view apa adanya.
  const current = useMemo(() => (view?.select ? view.select(cat) : null), [view, cat]);
  const metrics = current?.metrics ?? view?.metrics ?? [];
  const allRows = current?.rows ?? view?.rows ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? allRows.filter((r) => r.some((c) => c.toLowerCase().includes(q))) : allRows;
  }, [allRows, query]);

  const download = () => {
    if (!view || !kind) return;
    const url = URL.createObjectURL(new Blob([(current?.csv ?? view.csv)()], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `nstax-v2-${view.fileSlug}${view.filters ? `-${cat.toLowerCase()}` : ""}.csv`; a.click(); URL.revokeObjectURL(url);
  };

  return (
    <>
      <h1 className="v2-h1">BACA DATA API</h1>
      <p className="v2-sub">Unggah JSON. Format dikenali dari struktur datanya, lalu dihitung oleh parser asli masing-masing. Jika buktinya belum cukup, Anda memilih parser sendiri.</p>

      <section className="v2-panel">
        <h2>1 · Input data</h2>
        <div className="v2-row" style={{ marginBottom: 10 }}>
          <button className="v2-btn" type="button" onClick={() => fileRef.current?.click()}>Pilih file JSON</button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
          <span style={{ color: "var(--v2-muted)", fontSize: 13 }}>{source || "atau tempel JSON di bawah"} · maks 10 MB · diproses lokal di browser</span>
        </div>
        <textarea className="v2-text" value={text} spellCheck={false} placeholder="Tempel JSON di sini…" onChange={(e) => { setText(e.target.value); reset(); }} />
        <div className="v2-row" style={{ marginTop: 10 }}>
          <button className="v2-btn primary" type="button" onClick={() => analyze(text)} disabled={!text.trim()}>Deteksi &amp; analisis</button>
          <button className="v2-btn" type="button" onClick={() => { setText(""); setSource(""); reset(); }}>Bersihkan</button>
        </div>
      </section>

      {error && <div className="v2-banner bad">{error}</div>}

      {detection?.status === "confident" && !manual && (
        <div className="v2-banner ok">Terdeteksi: <strong>{API_KIND_LABELS[detection.kind]}</strong> · {detection.evidence.join(" · ")}</div>
      )}
      {detection?.status === "unsupported" && <div className="v2-banner bad"><strong>Format tidak didukung / tidak valid.</strong> {detection.reason}</div>}
      {detection?.status === "mixed" && (
        <div className="v2-banner bad"><strong>File campuran — tidak diproses otomatis.</strong> {detection.reason} Rincian: {Object.entries(detection.counts).map(([k, c]) => `${API_KIND_LABELS[k as ApiKind]} ${c}`).join(", ")}{detection.unclassified ? `, tidak dikenali ${detection.unclassified}` : ""}.</div>
      )}
      {detection?.status === "uncertain" && (
        <section className="v2-panel">
          <div className="v2-banner warn" style={{ marginBottom: 12 }}><strong>Format belum dapat dipastikan.</strong> {detection.reason}</div>
          <h2>Pilih parser secara manual</h2>
          <div className="v2-row">
            {API_KINDS.map((k) => {
              const c = detection.candidates.find((x) => x.kind === k);
              return <button key={k} type="button" className={`v2-btn${kind === k && manual ? " primary" : ""}`} onClick={() => runManual(k)} title={c ? `${c.matched}/${c.total} record cocok sebagian` : "Tidak ada kecocokan struktur"}>{API_KIND_LABELS[k]}{c ? ` · ${c.matched}/${c.total}` : ""}</button>;
            })}
          </div>
          <p style={{ fontSize: 12.5, color: "var(--v2-muted)", marginBottom: 0 }}>Memilih manual tetap memakai aturan parser tersebut apa adanya; baris yang tidak cocok dilaporkan oleh parser, bukan disembunyikan.</p>
        </section>
      )}

      {view && !view.ok && <div className="v2-banner bad">{view.error}</div>}
      {view?.ok && kind && (
        <section className="v2-panel">
          <h2>2 · Hasil {API_KIND_LABELS[kind]}{manual ? " (dipilih manual)" : ""}</h2>
          {view.notices.map((m, i) => <div key={i} className={`v2-banner ${i === 0 ? "ok" : "warn"}`}>{m}</div>)}
          {view.filters && (
            <div className="v2-row" style={{ marginBottom: 10 }} role="group" aria-label="Filter kategori">
              {view.filters.map((f) => <button key={f.key} type="button" className={`v2-btn${cat === f.key ? " primary" : ""}`} aria-pressed={cat === f.key} onClick={() => { setCat(f.key); setShown(PAGE); }}>{f.label}</button>)}
            </div>
          )}
          <div className="v2-metrics">{metrics.map((m) => <div key={m.label} className="v2-metric"><span>{m.label}</span><strong>{m.value}</strong></div>)}</div>
          <div className="v2-row" style={{ marginBottom: 10 }}>
            <input className="v2-input" placeholder="Cari di tabel…" value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE); }} />
            <button className="v2-btn" type="button" onClick={download}>{view.filters ? "Export CSV (kategori terpilih)" : "Export CSV (semua baris parser)"}</button>
            <span style={{ color: "var(--v2-muted)", fontSize: 13 }}>{filtered.length.toLocaleString("id-ID")} dari {allRows.length.toLocaleString("id-ID")} baris</span>
          </div>
          <div className="v2-table-wrap">
            <table className="v2-table">
              <thead><tr><th>No</th>{view.columns.map((c) => <th key={c.label} className={c.numeric ? "num" : ""}>{c.label}</th>)}</tr></thead>
              <tbody>{filtered.slice(0, shown).map((r, i) => <tr key={i}><td>{i + 1}</td>{r.map((c, j) => <td key={j} className={view.columns[j]?.numeric ? "num" : ""}>{c}</td>)}</tr>)}</tbody>
            </table>
          </div>
          {shown < filtered.length && <div style={{ marginTop: 10 }}><button className="v2-btn" type="button" onClick={() => setShown((s) => s + PAGE)}>Tampilkan {PAGE} baris lagi</button></div>}
        </section>
      )}
    </>
  );
}
