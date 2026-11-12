# NSTAX

NSTAX aplikasi untuk mengecek data transaksi

## Menjalankan

```bash
npm ci --legacy-peer-deps   # install (sesuai package-lock.json)
npm run dev                 # dev server (Vite)
npm run check               # TypeScript
npm test                    # vitest
npm run build               # build client (dist/public) + server (dist/index.js)
npm start                   # jalankan hasil build
```

## Deploy dengan Docker

Prasyarat server: Docker. Aplikasi 100% statis di sisi browser (parsing berjalan di browser), tanpa database dan tanpa environment variable wajib.

```bash
docker build -t nstax:latest .                                   # build image
docker run -d --name nstax --restart unless-stopped -p 3000:3000 nstax:latest   # jalankan (http://SERVER:3000)
docker logs -f nstax                                             # lihat log
docker stop nstax && docker start nstax                          # hentikan / jalankan ulang
```

- Port container: **3000** (env `PORT`, default 3000). Ganti port host: `-p 8080:3000`.
- Update setelah source berubah: `docker build -t nstax:latest . && docker rm -f nstax && docker run -d --name nstax --restart unless-stopped -p 3000:3000 nstax:latest`.
- Reverse proxy cukup meneruskan semua path ke port 3000 (server sudah fallback SPA ke `index.html`).
- Font Inter dimuat dari Google Fonts oleh browser pengguna; bila tidak ada internet, tampilan memakai font sistem.
- Detail dan verifikasi: lihat `docs/DOCKER.md`.

## Struktur

```
client/                   aplikasi web (React + Vite)
  index.html
  public/                 aset statis (favicon, logo, diakses lewat URL)
  src/
    main.tsx, App.tsx     entry dan router (wouter)
    index.css             style global
    pages/                satu halaman per checker (Home = menu utama)
    components/           komponen bersama (Landing = halaman utama); ui/ = shadcn yang dipakai
    contexts/             ThemeContext
    assets/logos/         logo parser (lihat README di folder itu)
    lib/
      parsers/            parser per sumber data (Astana, Fore, ...)
      upl/                CEK UPL: parser, kategori, C&C, resto, bulanan
      compare/            perbandingan dua file dan perbandingan struk
      shared/             helper lintas parser (monthlyCommon, multiFile, parseHelpers)
      parserBrands.tsx, nstaxLogoPaths.ts, utils.ts
server/index.ts           server Express statis untuk produksi (port 3000)
docker/                   skrip build/verifikasi Docker (strip-v2, assert-no-v2, verify.sh)
docs/DOCKER.md            dokumentasi Docker lengkap
Dockerfile, .dockerignore konfigurasi image `nstax`
```
