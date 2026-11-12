# NSTAX V1 — Docker

Image: **`nstax`** (tag lokal `nstax:latest`). Hanya NSTAX V1; kode V2 tidak masuk image.

## Build & jalankan

```bash
docker build -t nstax:latest .
docker run --rm -p 3000:3000 nstax:latest        # buka http://localhost:3000
```

- Port aplikasi **3000** (dibaca dari `server/index.ts`: `process.env.PORT || 3000`).
- Ganti port di host: `-p 8080:3000`. Ganti port di dalam container: `-e PORT=8080 -p 8080:8080`.
- Server mendengarkan di semua antarmuka (bukan hanya `localhost`), jadi dapat diakses dari host.
- Tidak ada environment variable wajib dan tidak ada layanan eksternal: semua parsing berjalan di browser.
- Container berjalan sebagai user non-root (`node`) dan punya `HEALTHCHECK` (GET `/`).

Build membutuhkan **akses internet** (mengunduh image `node:22-bookworm-slim` dan paket npm sesuai `package-lock.json`).

## Tes & verifikasi

```bash
docker build --target test .     # menjalankan vitest pada kode V1 (tidak mengubah image final)
bash docker/verify.sh            # (jalankan dari root proyek; butuh bash: Linux/macOS/WSL/Git Bash)   build, tes, jalankan container, cek route/aset, cek tidak ada V2/.env
```

## Cara V2 dikeluarkan

1. `.dockerignore` mengeluarkan `client/src/v2` dari build context.
2. `docker/strip-v2.mjs` (di dalam tahap build) membuang import lazy + route `/v2` dari `App.tsx` dan blok CSS `.v2-root`
   pada **salinan di image**; source di repo Anda tidak diubah. Bila masih ada referensi V2 yang tersisa, build **gagal**.
3. `docker/assert-no-v2.mjs` memindai hasil build (`dist/`) mencari penanda V2; bila ada, build **gagal**.
4. `docker/verify.sh` memeriksa lagi isi image yang sudah jadi.

Di image, `/v2` tidak ada: server mengembalikan `index.html` V1 dan router V1 menampilkan halaman 404.
File V1 bersama yang punya parameter/komentar untuk V2 (mis. `initialJson` pada beberapa checker, helper `looksLikeManyarNoBill`)
tetap ada karena merupakan bagian kode V1; tidak ada halaman, komponen, rute, atau aset V2.

## Deploy

```bash
docker tag nstax:latest registry.contoh.com/nstax:latest && docker push registry.contoh.com/nstax:latest
```

Reverse proxy (Nginx/Caddy/Traefik) cukup meneruskan semua path ke port 3000; server sudah melakukan fallback SPA ke `index.html`.
Proyek ini tidak lagi memakai Vercel: `vercel.json` dan skrip `build:vercel` / `vercel-build` sudah dihapus. Fallback SPA (`/(.*)` → `index.html`) ditangani `server/index.ts`.

## Catatan: Compare 2 File

Lihat `client/src/lib/compare/` — `compareFilesEngine.ts`, `identityDetect.ts`, `compareTable.ts`, dan tes baru `compareConsistency.test.ts`.
