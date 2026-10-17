# Logo parser NSTAX

Nama file harus sama dengan `asset` di `src/lib/parserBrands.tsx`.
Format: svg, png, webp, jpg. Tidak perlu mengubah kode.

Terpasang: astana, fore, nsc, rotio, kai, hokben, kopken, fave, sams, kland, nasgor 69,
pointcoffee, omala, omahpadhang, jambuluwuk, innatretes, hotel plataran, family mart, manyar

Jika file tidak ada / gagal dimuat, kartu otomatis menampilkan ikon fallback.

## Versi optimized (non-destruktif)

`optimized/` berisi versi turunan logo yang margin kosongnya dipangkas dan latarnya dinormalkan
(astana, fore, kai, kopken, nsc, sams, pointcoffee, kland, innatretes, jambuluwuk, omahpadhang).
File asli di folder ini tidak diubah. Jika ada file dengan nama dasar yang sama di `optimized/`,
itulah yang dipakai (lihat `resolveLogo` di `src/lib/parserBrands.tsx`).

Kotak logo kartu parser: tinggi 64px (56px di mobile), lebar 1.8x tinggi (`spec.ratio` untuk override).
