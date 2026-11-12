import type { TableData } from "./compareTable";
import {
  autoDetectConfig, classifyAmount, DATE_NAMES, inferLocale, isRowIndexColumn, keySet, KEY_NAMES, norm, normalizeDateText, parseNumber,
  type KeyRule,
} from "./compareFilesEngine";

// Deteksi identitas transaksi otomatis: memindai SEMUA kolom kedua file × aturan normalisasi yang AMAN, memilih irisan terbesar.
// Aturan yang dicoba hanya "alnum" (standar) dan "strict": nomor struk selalu dibandingkan UTUH. Tidak ada pencocokan awalan, digit terakhir,
// hanya-digit, atau nol di depan dibuang — itu dapat menyamakan struk yang sebenarnya berbeda.
// Bila tidak ada kolom yang cocok, coba identitas alternatif (tanggal[+jam] + total) lewat kolom virtual — selalu diberi label jelas.

export type AutoIdentity = {
  kind: "column" | "composite" | "none";
  a: number; b: number; rule: KeyRule;
  matched: number; uniqueA: number; uniqueB: number; ratio: number;
  confidence: "high" | "medium" | "low";
  explain: string;
  /** contoh nilai identitas (asli) dari tiap file, untuk diperiksa pengguna */
  sampleA: string[]; sampleB: string[];
  /** hanya untuk kind = composite: tabel dengan kolom virtual di paling kanan */
  tableA?: TableData; tableB?: TableData;
};

const RULE_TEXT: Record<KeyRule, string> = {
  strict: "persis sama", alnum: "mengabaikan spasi, koma, dan tanda baca (nomor tetap dibandingkan utuh)",
};
const STRICTNESS: KeyRule[] = ["alnum", "strict"];

type ColStat = { col: number; fill: number; unique: number; named: boolean; header: string };
function eligibleColumns(t: TableData): ColStat[] {
  const out: ColStat[] = [];
  const n = t.rows.length || 1;
  for (let c = 0; c < t.headers.length; c++) {
    const name = norm(t.headers[c]);
    const named = KEY_NAMES.includes(name);
    if (!named && (classifyAmount(t.headers[c]) !== "other" || DATE_NAMES.includes(name))) continue;
    if (isRowIndexColumn(t, c)) continue; // penomoran baris bukan identitas transaksi (akan mencocokkan berdasarkan posisi)
    const { set, filled } = keySet(t, c);
    const fill = filled / n, unique = filled ? set.size / filled : 0;
    // Kolom bernama kunci boleh berulang (mis. satu struk punya banyak baris item): duplikat dilaporkan oleh mesin, bukan alasan membuang kolomnya.
    // Hanya "id" generik yang tetap harus hampir unik (sama dengan rankKeyColumns).
    if (fill < 0.9 || unique < (named ? (name === "id" ? 0.9 : 0) : 0.9)) continue;
    out.push({ col: c, fill, unique, named, header: t.headers[c] });
  }
  return out;
}
const sample = (t: TableData, col: number): string[] => { const o: string[] = []; for (let r = 0; r < t.rows.length && o.length < 3; r++) { const v = (t.rows[r][col] ?? "").trim(); if (v) o.push(v); } return o; };

function bestColumnPair(ta: TableData, tb: TableData): AutoIdentity | null {
  const ca = eligibleColumns(ta), cb = eligibleColumns(tb);
  if (!ca.length || !cb.length) return null;
  const cache = new Map<string, Set<string>>();
  const get = (side: string, t: TableData, col: number, rule: KeyRule) => { const id = `${side}|${col}|${rule}`; let v = cache.get(id); if (!v) { v = keySet(t, col, rule, false).set; cache.set(id, v); } return v; };
  let best: { x: ColStat; y: ColStat; rule: KeyRule; matched: number; ua: number; ub: number; ratio: number; pts: number } | null = null;
  for (const x of ca) for (const y of cb) {
    for (const rule of STRICTNESS) {
      const sa = get("a", ta, x.col, rule), sb = get("b", tb, y.col, rule);
      if (!sa.size || !sb.size) continue;
      const [small, big] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
      let matched = 0; small.forEach((k) => { if (big.has(k)) matched++; });
      if (!matched) continue;
      const ratio = matched / small.size;
      // kolom bernama kunci & aturan lebih ketat diutamakan saat irisan hampir sama
      const pts = ratio * 1000 + (x.named ? 15 : 0) + (y.named ? 15 : 0) - STRICTNESS.indexOf(rule) * 3 + Math.min(matched, 5000) / 5000;
      if (!best || pts > best.pts) best = { x, y, rule, matched, ua: sa.size, ub: sb.size, ratio, pts };
    }
  }
  if (!best) return null;
  const b = best;
  const confidence = b.ratio >= 0.8 ? "high" : b.ratio >= 0.4 ? "medium" : "low";
  return {
    kind: "column", a: b.x.col, b: b.y.col, rule: b.rule, matched: b.matched, uniqueA: b.ua, uniqueB: b.ub, ratio: b.ratio, confidence,
    explain: `Kolom “${ta.headers[b.x.col]}” (File A) ↔ “${tb.headers[b.y.col]}” (File B), dicocokkan ${RULE_TEXT[b.rule]}.`,
    sampleA: sample(ta, b.x.col), sampleB: sample(tb, b.y.col),
  };
}

const TIME = /(\d{1,2}):(\d{2})/;
function compositeTables(ta: TableData, tb: TableData): AutoIdentity | null {
  const cfg = autoDetectConfig(ta, tb);
  const da = cfg.a.date, db = cfg.b.date;
  const total = cfg.amounts.find((p) => classifyAmount(ta.headers[p.a]) === "total" || classifyAmount(tb.headers[p.b]) === "total");
  if (da < 0 || db < 0 || !total) return null;
  const withTime = (t: TableData, c: number) => t.rows.filter((r) => TIME.test(r[c] ?? "")).length / (t.rows.length || 1) >= 0.8;
  const useTime = withTime(ta, da) && withTime(tb, db);
  const locA = inferLocale(ta.rows.map((r) => r[total.a] ?? "")), locB = inferLocale(tb.rows.map((r) => r[total.b] ?? ""));
  const mk = (t: TableData, dc: number, ac: number, loc: "id" | "en" | "unknown"): TableData => {
    const rows = t.rows.map((r) => {
      const d = normalizeDateText(r[dc] ?? ""); const n = parseNumber(r[ac] ?? "", loc);
      const tm = useTime ? TIME.exec(r[dc] ?? "") : null;
      const key = d && n.state === "ok" ? `${d}${tm ? ` ${tm[1].padStart(2, "0")}:${tm[2]}` : ""} | ${n.canon}` : "";
      return [...r, key];
    });
    return { ...t, headers: [...t.headers, "Identitas gabungan (tanggal+total)"], rows };
  };
  const A = mk(ta, da, total.a, locA), B = mk(tb, db, total.b, locB);
  const ka = A.headers.length - 1, kb = B.headers.length - 1;
  const sa = keySet(A, ka, "strict"), sb = keySet(B, kb, "strict"); // kunci virtual berisi "tanggal | angka": tanda baca bermakna, jangan dibuang
  if (sa.set.size < 0.9 * sa.filled || sb.set.size < 0.9 * sb.filled) return null; // terlalu banyak kombinasi kembar → tidak dapat diandalkan
  const [small, big] = sa.set.size <= sb.set.size ? [sa.set, sb.set] : [sb.set, sa.set];
  let matched = 0; small.forEach((k) => { if (big.has(k)) matched++; });
  const ratio = small.size ? matched / small.size : 0;
  if (ratio < 0.3) return null;
  return {
    kind: "composite", a: ka, b: kb, rule: "strict", matched, uniqueA: sa.set.size, uniqueB: sb.set.size, ratio, confidence: ratio >= 0.8 ? "medium" : "low",
    explain: `Nomor struk tidak ada yang sama di kolom mana pun, jadi dipakai identitas alternatif: ${useTime ? "tanggal + jam" : "tanggal"} + total (${ta.headers[total.a]} ↔ ${tb.headers[total.b]}). Cara ini tidak dapat mendeteksi “nominal berbeda” (karena nominal ikut menjadi identitas) dan kurang pasti dibanding nomor struk.`,
    sampleA: sample(A, ka), sampleB: sample(B, kb), tableA: A, tableB: B,
  };
}

/** Pilih identitas terbaik secara otomatis. Selalu mengembalikan hasil (kind "none" bila tidak ada yang meyakinkan). */
export function autoIdentity(ta: TableData, tb: TableData): AutoIdentity {
  const col = bestColumnPair(ta, tb);
  if (col && col.ratio >= 0.3) return col;
  const comp = compositeTables(ta, tb);
  if (comp) return comp;
  if (col) return col; // irisan sangat rendah tetapi ada: tetap ditawarkan dengan keyakinan rendah
  return { kind: "none", a: -1, b: -1, rule: "strict", matched: 0, uniqueA: 0, uniqueB: 0, ratio: 0, confidence: "low", explain: "Tidak ditemukan kolom identitas yang sama di kedua file. Pilih kolom secara manual.", sampleA: [], sampleB: [] };
}
