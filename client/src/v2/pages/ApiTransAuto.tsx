// BACA DATA APITRANS (V2): satu alur dengan deteksi perusahaan otomatis.
// Perusahaan ditentukan dari id_agent/nama_usaha (lihat detect/apiTransDetector), lalu hasilnya
// ditampilkan oleh halaman parser lama milik perusahaan itu. Rumus, filter, dan kategori tidak diubah.
import { lazy, Suspense, useRef, useState, type ChangeEvent, type ComponentType } from "react";
import { detectApiTrans, type ApiTransDetection, type ApiTransKind } from "../detect/apiTransDetector";

type ResultProps = { onBack: () => void; initialJson?: string; initialSourceName?: string };
const lz = (loader: () => Promise<{ default: ComponentType<ResultProps> }>) => lazy(loader);

const RESULT_PAGES: Record<ApiTransKind, ReturnType<typeof lz>> = {
  nasgor69: lz(() => import("@/pages/Nasgor69Checker")),
  pointcoffeHm: lz(() => import("@/pages/PointCoffeeHmChecker")),
  familyMart: lz(() => import("@/pages/FamilyMartChecker")),
  hangrySda: lz(() => import("@/pages/HangrySdaChecker")),
};

const MAX_BYTES = 50 * 1024 * 1024;

export default function ApiTransAuto() {
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [detection, setDetection] = useState<ApiTransDetection | null>(null);
  // `run` menyimpan JSON yang sedang diproses; `runId` memaksa halaman hasil dibuat ulang untuk input baru.
  const [run, setRun] = useState<{ json: string; name: string; id: number } | null>(null);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => { setDetection(null); setRun(null); setError(""); };

  const analyze = (value: string, name: string) => {
    setError("");
    const d = detectApiTrans(value);
    setDetection(d);
    setRun(d.ok ? { json: value, name, id: Date.now() } : null);
  };

  const onFile = async (file?: File) => {
    if (!file) return;
    reset();
    if (!file.name.toLowerCase().endsWith(".json")) { setError("Hanya file .json yang didukung."); return; }
    if (file.size > MAX_BYTES) { setError("Ukuran file terlalu besar. Batas maksimal adalah 50 MB."); return; }
    try {
      const t = await file.text();
      setText(t);
      setSource(file.name);
      analyze(t, file.name);
    } catch {
      setError("File tidak dapat dibaca. Coba pilih file JSON lain.");
    }
  };

  const Result = detection?.ok ? RESULT_PAGES[detection.kind] : null;

  return (
    <>
      <h1 className="v2-h1">BACA DATA APITRANS</h1>
      <p className="v2-sub">Unggah atau tempel JSON. Perusahaan dikenali otomatis dari id_agent / nama_usaha, lalu dihitung oleh parser milik perusahaan itu (NASGOR69, POINTCOFFE HM, FAMILY MART, atau HANGRY SDA). Aturan tiap perusahaan tidak digabung.</p>

      <section className="v2-panel">
        <h2>1 · Input data</h2>
        <div className="v2-row" style={{ marginBottom: 10 }}>
          <button className="v2-btn" type="button" onClick={() => fileRef.current?.click()}>Pilih file JSON</button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e: ChangeEvent<HTMLInputElement>) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
          <span style={{ color: "var(--v2-muted)", fontSize: 13 }}>{source || "atau tempel JSON di bawah"} · maks 50 MB · diproses lokal di browser</span>
        </div>
        <textarea className="v2-text" value={text} spellCheck={false} placeholder="Tempel JSON di sini…" onChange={(e) => { setText(e.target.value); reset(); }} />
        <div className="v2-row" style={{ marginTop: 10 }}>
          <button className="v2-btn primary" type="button" onClick={() => analyze(text, source)} disabled={!text.trim()}>Deteksi &amp; analisis</button>
          <button className="v2-btn" type="button" onClick={() => { setText(""); setSource(""); reset(); }}>Bersihkan</button>
        </div>
      </section>

      {error && <div className="v2-banner bad">{error}</div>}
      {detection && !detection.ok && <div className="v2-banner bad"><strong>Tidak dapat diproses.</strong> {detection.reason}</div>}
      {detection?.ok && (
        <div className="v2-banner ok">
          Format terdeteksi: <strong>{detection.label}</strong> · {detection.recordCount.toLocaleString("id-ID")} transaksi · dasar deteksi: {detection.evidence.join(" · ")}
        </div>
      )}

      {Result && run && (
        <div className="v2-embed">
          <Suspense fallback={<p>Memuat…</p>}>
            <Result key={run.id} onBack={reset} initialJson={run.json} initialSourceName={run.name} />
          </Suspense>
        </div>
      )}
    </>
  );
}
