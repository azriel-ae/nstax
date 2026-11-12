// Dijalankan setelah `npm run build` di dalam image: pastikan hasil build adalah V1 dan tidak memuat V2.
import fs from "node:fs";
import path from "node:path";

const dist = path.join(process.cwd(), "dist");
const fail = (m) => { console.error(`assert-no-v2: GAGAL — ${m}`); process.exit(1); };
for (const f of ["index.js", "public/index.html"]) if (!fs.existsSync(path.join(dist, f))) fail(`dist/${f} tidak ada`);

// Penanda khas V2: kelas CSS/komponen yang hanya didefinisikan di client/src/v2 (string tetap ada walau JS di-minify).
const MARKERS = ["v2-btn", "v2-banner", "v2-embed", "v2-root", "v2-navy", "V2App", "LegacyEmbed"];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const hits = [];
let scanned = 0;
for (const f of walk(dist)) {
  if (/\.(png|jpe?g|webp|ico|svg|woff2?|ttf|map)$/i.test(f)) continue;
  const t = fs.readFileSync(f, "utf8");
  scanned++;
  for (const m of MARKERS) if (t.includes(m)) hits.push(`${path.relative(dist, f)} memuat "${m}"`);
}
if (hits.length) fail(hits.join("; "));
console.log(`assert-no-v2: OK — ${scanned} berkas dist diperiksa, tidak ada penanda V2.`);
