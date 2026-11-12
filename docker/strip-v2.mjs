// Dijalankan DI DALAM tahap build Docker (bukan di working tree Anda): membuang semua jejak NSTAX V2 dari salinan source di image.
// Penjaga utamanya adalah pemindaian akhir: bila setelah pembersihan MASIH ada referensi kode V2 di source (mis. bentuk App.tsx
// berubah sehingga pola tidak cocok), skrip GAGAL dan build berhenti — lebih baik build gagal daripada image diam-diam memuat V2.
// Pada paket yang sudah V1-only (tanpa pola V2) skrip tidak mengubah apa pun dan tetap lulus.
import fs from "node:fs";
import path from "node:path";

const src = path.join(process.cwd(), "client", "src");
const fail = (m) => { console.error(`strip-v2: GAGAL — ${m}`); process.exit(1); };

// 1) direktori V2 (biasanya sudah tidak ada karena .dockerignore)
fs.rmSync(path.join(src, "v2"), { recursive: true, force: true });

// 2) App.tsx: hapus import lazy V2 dan dua route /v2
const appPath = path.join(src, "App.tsx");
let app = fs.readFileSync(appPath, "utf8");
const cuts = [
  [/^import \{ lazy, Suspense \} from "react";\r?\n/m, "import lazy/Suspense"],
  [/^\/\/ NSTAX V2 dimuat lazy.*\r?\n/m, "komentar V2"],
  [/^const V2App = lazy\(.*\r?\n/m, "const V2App"],
  [/^const V2 = \(\) => .*\r?\n/m, "const V2"],
  [/^[ \t]*<Route path=\{"\/v2"\} component=\{V2\} \/>\r?\n/m, "route /v2"],
  [/^[ \t]*<Route path=\{"\/v2\/\*\?"\} component=\{V2\} \/>\r?\n/m, "route /v2/*?"],
];
let removed = 0;
for (const [re] of cuts) if (re.test(app)) { app = app.replace(re, ""); removed++; }
fs.writeFileSync(appPath, app);

// 3) index.css: hapus blok pewarisan khusus V2 (.v2-root)
const cssPath = path.join(src, "index.css");
let css = fs.readFileSync(cssPath, "utf8");
const block = /\r?\n\/\* =+\r?\n   NSTAX V2 — nilai LAMA dibekukan\.[\s\S]*?body:has\(\.v2-root\)[^\n]*\r?\n/;
if (block.test(css)) { css = css.replace(block, "\n"); removed++; }
fs.writeFileSync(cssPath, css);

// 4) pemeriksaan akhir: tidak ada import/route/kelas V2 yang tersisa di source (komentar boleh)
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const bad = [];
for (const f of walk(src)) {
  if (!/\.(tsx?|css)$/.test(f)) continue;
  const t = fs.readFileSync(f, "utf8");
  if (/from\s+["'][^"']*\/v2(\/|["'])|import\(\s*["'][^"']*\/v2\/|["']\/v2["/]|\.v2-root|v2-embed|V2App/.test(t)) bad.push(path.relative(src, f));
}
if (bad.length) fail(`masih ada referensi kode V2 di: ${bad.join(", ")}`);
console.log(removed ? `strip-v2: OK — V2 dikeluarkan (${removed} bagian dibuang: route /v2, import lazy, CSS .v2-root).` : "strip-v2: OK — source sudah V1-only, tidak ada yang perlu dibuang.");
