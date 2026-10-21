// NSTAX V2 — deteksi format CEK DATA API.
// Modul MURNI: tidak menghitung apa pun, hanya mengklasifikasi struktur JSON
// berdasarkan field yang dipakai parser asli. Parser asli tetap yang menghitung.
//
// Tiga hasil (sesuai spesifikasi):
//   confident   -> semua record cocok dengan signature tepat satu parser
//   uncertain   -> bukti kurang / ambigu -> pengguna memilih parser manual
//   mixed       -> beberapa format dalam satu file -> tidak diproses otomatis
//   unsupported -> bukan JSON valid / struktur tidak dikenali

import { looksLikeManyarNoBill } from "../../lib/parsers/manyarParser";

export type ApiKind = "astana" | "fore" | "nsc" | "rotio" | "hokben" | "kopken" | "kai" | "fave" | "sams" | "manyar";

export const API_KINDS: readonly ApiKind[] = ["astana", "fore", "nsc", "rotio", "hokben", "kopken", "kai", "fave", "sams", "manyar"];

export const API_KIND_LABELS: Record<ApiKind, string> = {
  astana: "ASTANA", fore: "FORE", nsc: "NSC", rotio: "ROTI O", hokben: "HOKBEN",
  kopken: "KOPKEN", kai: "KAI", fave: "FAVE", sams: "SAMS", manyar: "MANYAR",
};

export type Candidate = { kind: ApiKind; matched: number; total: number; evidence: string[] };

export type DetectionResult =
  | { status: "confident"; kind: ApiKind; recordCount: number; evidence: string[] }
  | { status: "uncertain"; reason: string; recordCount: number; candidates: Candidate[] }
  | { status: "mixed"; reason: string; recordCount: number; counts: Partial<Record<ApiKind, number>>; unclassified: number }
  | { status: "unsupported"; reason: string };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (r: Rec, ...keys: string[]) => keys.every((k) => Object.prototype.hasOwnProperty.call(r, k));

// Field persis yang dipakai parser asli (lihat astanaParser, foreParser, transactionParser, vendorParser).
const ASTANA_FIELDS = ["Date", "Product", "Gross", "Service", "Tax", "Nett"] as const;
const FORE_FIELDS = ["tgl", "counter_id", "counter_name", "billing_id", "total", "pajak"] as const;
// MANYAR = field ASTANA + NoBill. NoBill berpola FL/SL + digit-lah yang membedakannya dari ASTANA.
const MANYAR_FIELDS = ["Date", "Product", "NoBill", "Gross", "Service", "Tax", "Nett"] as const;
const NSC_FIELDS = ["transaction_no", "movie_title", "date", "show_time", "show_studio_id", "total_orders", "selected_orders", "total", "total_seat"] as const;

type Shape = "array" | "data" | "result" | "Data" | "nested";

function extract(root: unknown): { shape: Shape; items: unknown[] } | null {
  if (Array.isArray(root)) return { shape: "array", items: root };
  if (!isRec(root)) return null;
  // Wrapper dibaca persis seperti vendorParser: data / result / Data.
  if (Array.isArray(root.result)) return { shape: "result", items: root.result };
  if (Array.isArray(root.Data)) return { shape: "Data", items: root.Data };
  if (Array.isArray(root.data)) return { shape: "data", items: root.data };
  // FORE & NSC asli mengumpulkan object bersarang yang memuat field khas.
  const found: Rec[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!isRec(v)) return;
    if (has(v, "billing_id") || has(v, "counter_id") || has(v, "pajak") || has(v, "transaction_no") || has(v, "movie_title")) found.push(v);
    else Object.values(v).forEach(walk);
  };
  walk(root);
  return found.length ? { shape: "nested", items: found } : null;
}

// `overrides`: jika record cocok dengan probe ini, hit dari parser yang disebut dibuang (record itu milik probe ini).
type Probe = { kind: ApiKind; shapes: Shape[]; strong: boolean; test: (r: Rec) => boolean; evidence: string; overrides?: ApiKind[] };

const PROBES: Probe[] = [
  { kind: "astana", shapes: ["array"], strong: true, test: (r) => has(r, ...ASTANA_FIELDS), evidence: "field Date, Product, Gross, Service, Tax, Nett" },
  {
    kind: "manyar", shapes: ["array"], strong: true, overrides: ["astana"],
    test: (r) => has(r, ...MANYAR_FIELDS) && looksLikeManyarNoBill(r.NoBill),
    evidence: "field Date, Product, NoBill, Gross, Service, Tax, Nett + NoBill berawalan FL/SL",
  },
  { kind: "kai", shapes: ["array"], strong: true, test: (r) => has(r, "biayatotal"), evidence: "field biayatotal pada array root" },
  {
    kind: "rotio", shapes: ["array"], strong: true,
    test: (r) => { const inner = Object.values(r).filter(isRec); return inner.length > 0 && inner.every((x) => has(x, "4")); },
    evidence: "array of object dengan kunci bersarang yang memuat indeks \"4\"",
  },
  { kind: "kopken", shapes: ["result"], strong: true, test: (r) => has(r, "dpp", "pajak", "total"), evidence: "wrapper result + field dpp, pajak, total" },
  { kind: "fave", shapes: ["Data"], strong: true, test: (r) => has(r, "base_amount", "tax_amount", "grand_total"), evidence: "wrapper Data + field base_amount, tax_amount, grand_total" },
  { kind: "fore", shapes: ["array", "data", "nested"], strong: true, test: (r) => has(r, ...FORE_FIELDS), evidence: "field tgl, counter_id, counter_name, billing_id, total, pajak" },
  { kind: "nsc", shapes: ["array", "data", "nested"], strong: true, test: (r) => has(r, ...NSC_FIELDS), evidence: "field transaction_no, movie_title, show_studio_id, total_seat, dst." },
  // Lemah: signature hanya berasal dari kode parser (belum ada sampel asli). Tidak pernah "confident".
  { kind: "sams", shapes: ["data"], strong: false, test: (r) => has(r, "dpp", "tax", "total"), evidence: "wrapper data + field dpp, tax, total" },
  { kind: "hokben", shapes: ["data"], strong: false, test: (r) => has(r, "tax"), evidence: "wrapper data + field tax" },
];

export function detectApiFormat(text: string): DetectionResult {
  if (!text.trim()) return { status: "unsupported", reason: "Input kosong." };
  let root: unknown;
  try { root = JSON.parse(text); } catch { return { status: "unsupported", reason: "Bukan JSON yang valid." }; }
  const ex = extract(root);
  if (!ex) return { status: "unsupported", reason: "Struktur JSON tidak dikenali (bukan array, wrapper data/result/Data, maupun object transaksi)." };
  const { shape, items } = ex;
  if (!items.length) return { status: "unsupported", reason: "Data kosong: tidak ada record untuk dibaca." };

  const probes = PROBES.filter((p) => p.shapes.includes(shape));
  const counts: Partial<Record<ApiKind, number>> = {};
  const perKind = new Map<ApiKind, number>(); // record yang cocok per parser (satu record bisa cocok >1 parser)
  let unclassified = 0;
  let ambiguousRecords = 0;
  items.forEach((item) => {
    if (!isRec(item)) { unclassified++; return; }
    const rawHits = probes.filter((p) => p.test(item));
    const overridden = new Set(rawHits.flatMap((p) => p.overrides ?? []));
    const hits = overridden.size ? rawHits.filter((p) => !overridden.has(p.kind)) : rawHits;
    hits.forEach((p) => perKind.set(p.kind, (perKind.get(p.kind) ?? 0) + 1));
    const strongHits = hits.filter((p) => p.strong);
    if (strongHits.length === 1 && !hits.some((p) => !p.strong)) counts[strongHits[0].kind] = (counts[strongHits[0].kind] ?? 0) + 1;
    else if (hits.length === 0) unclassified++;
    else ambiguousRecords++;
  });

  const candidates: Candidate[] = probes
    .filter((p) => perKind.has(p.kind))
    .map((p) => ({ kind: p.kind, matched: perKind.get(p.kind) ?? 0, total: items.length, evidence: [p.evidence] }))
    .sort((a, b) => b.matched - a.matched);

  const total = items.length;
  const distinct = (Object.keys(counts) as ApiKind[]).filter((k) => (counts[k] ?? 0) > 0);

  // MANYAR + ASTANA: record ASTANA di sini adalah record ber-field sama yang NoBill-nya bukan FL/SL.
  // Jangan ditolak sebagai "campuran" (pengguna tidak bisa lanjut) dan jangan diproses otomatis: serahkan ke pilihan manual.
  if (distinct.length === 2 && distinct.includes("manyar") && distinct.includes("astana")) {
    return { status: "uncertain", recordCount: total, candidates, reason: `${(counts.manyar ?? 0).toLocaleString("id-ID")} record ber-NoBill FL/SL (pola MANYAR) bercampur dengan ${(counts.astana ?? 0).toLocaleString("id-ID")} record ber-field sama yang NoBill-nya kosong/bukan FL/SL. Tidak diproses otomatis; pilih MANYAR (record tidak dikenal akan dilaporkan) atau ASTANA secara manual.` };
  }
  if (distinct.length > 1) {
    return { status: "mixed", recordCount: total, counts, unclassified, reason: "File memuat record dari lebih dari satu format. Pisahkan file per format sebelum diproses." };
  }
  if (distinct.length === 1 && unclassified === 0 && ambiguousRecords === 0 && counts[distinct[0]] === total) {
    const probe = probes.find((p) => p.kind === distinct[0])!;
    return { status: "confident", kind: distinct[0], recordCount: total, evidence: [probe.evidence, `${total.toLocaleString("id-ID")} dari ${total.toLocaleString("id-ID")} record cocok`] };
  }
  if (distinct.length === 1) {
    const k = distinct[0];
    const bad = total - (counts[k] ?? 0);
    return { status: "uncertain", recordCount: total, candidates, reason: `Hanya ${(counts[k] ?? 0).toLocaleString("id-ID")} dari ${total.toLocaleString("id-ID")} record yang cocok penuh dengan ${API_KIND_LABELS[k]}; ${bad.toLocaleString("id-ID")} record tidak cocok atau ambigu. Tidak diproses otomatis agar tidak ada baris yang terbuang diam-diam.` };
  }
  if (candidates.length) {
    const weakOnly = candidates.every((c) => !PROBES.find((p) => p.kind === c.kind)!.strong);
    const apitransLike = items.some((r) => isRec(r) && (has(r, "no_struk") || has(r, "id_agent") || has(r, "date_trans")));
    const base = weakOnly
      ? `Struktur cocok dengan lebih dari satu format yang buktinya belum cukup membedakan (${candidates.map((c) => API_KIND_LABELS[c.kind]).join(", ")}). Pilih parser secara manual.`
      : `Bukti format belum cukup meyakinkan (${candidates.map((c) => API_KIND_LABELS[c.kind]).join(", ")}). Pilih parser secara manual.`;
    return { status: "uncertain", recordCount: total, candidates, reason: base + (apitransLike ? " Ditemukan field no_struk/id_agent/date_trans yang lazim di BACA DATA APITRANS." : "") };
  }
  return { status: "unsupported", reason: "Tidak ada signature parser yang cocok dengan struktur file ini." };
}
