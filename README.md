# NSTAX

NSTAX aplikasi untuk mengecek data transaksi

## Menjalankan

```bash
npm ci --legacy-peer-deps   # install (sama dengan yang dipakai Vercel)
npm run dev                 # dev server (Vite)
npm run check               # TypeScript
npm test                    # vitest
npm run build               # build client (dist/public) + server (dist/index.js)
npm start                   # jalankan hasil build
```

Deploy Vercel memakai `vercel.json` (`npm run build:vercel`, output `dist/public`).

## Struktur

```
client/
  index.html
  public/                 aset statis (favicon, logo, diakses lewat URL)
  src/
    main.tsx, App.tsx     entry dan router (wouter)
    index.css             style global
    pages/                satu halaman per checker (Home menjadi menu utama)
    components/           komponen bersama (Landing = halaman utama V1); ui/ = shadcn yang benar-benar dipakai
    contexts/             ThemeContext
    assets/logos/         logo parser (lihat README di folder itu)
    lib/
      parsers/            parser per sumber data (Astana, Fore, Plataran, Inna Tretes, ...)
      upl/                CEK UPL: parser, kategori, C&C, resto, bulanan
      jambuluwuk/         parser workbook, mesin SQL, query default
      compare/            perbandingan dua file dan perbandingan struk
      shared/             helper lintas parser (monthlyCommon, multiFile, parseHelpers)
      fixtures/           file contoh untuk test
      parserBrands.tsx, nstaxLogoPaths.ts, utils.ts
server/index.ts           server Express statis untuk produksi
```
