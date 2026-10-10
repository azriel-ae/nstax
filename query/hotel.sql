-- ============================================================
-- QUERY DEFAULT HOTEL  (nilai dari kolom E = NAME, J = NETT)
-- Semua pola nama kategori ada di bagian "POLA" di bawah; kalau
-- bulan depan ada nama baru, cukup tambah di pola yang sesuai.
--   ITEM    : baris tagihan hotel (Room Charge, Disc Room, Adj Room, Laundry, ...)
--   SERVICE : Service Room   (Room Service sengaja TIDAK dihitung: itu biasanya F&B, lihat audit)
--   TAX     : Tax Room | Room Tax
-- Rumus:
--   dpp      = semua ITEM (sudah termasuk Disc/Adj)
--   subtotal = ITEM tanpa Disc
--   discount = ITEM yang berawalan Disc
--   tax      = baris TAX jika ada; jika tidak ada = (dpp + service_charge) / 10
--   total    = dpp + service_charge + tax
-- ============================================================
WITH hasil AS (
  SELECT
    A AS folio,
    filename,
    SUM(CASE WHEN E REGEXP 'Room|Laundry|Phone|Jeep|Miscellaneous'
              AND E NOT REGEXP '^(Service Room|Tax Room|Room Tax)'
             THEN CAST(J AS DECIMAL(15,4)) ELSE 0 END) AS dpp,
    SUM(CASE WHEN E REGEXP 'Room|Laundry|Phone|Jeep|Miscellaneous'
              AND E NOT REGEXP '^(Disc|Service Room|Tax Room|Room Tax)'
             THEN CAST(J AS DECIMAL(15,4)) ELSE 0 END) AS subtotal,
    SUM(CASE WHEN E REGEXP '^Disc'
              AND E REGEXP 'Room|Laundry|Phone|Jeep|Miscellaneous'
             THEN CAST(J AS DECIMAL(15,4)) ELSE 0 END) AS discount,
    SUM(CASE WHEN E REGEXP '^Service Room$'
             THEN CAST(J AS DECIMAL(15,4)) ELSE 0 END) AS service_charge,
    SUM(CASE WHEN E REGEXP '^(Tax Room|Room Tax)$'
             THEN CAST(J AS DECIMAL(15,4)) ELSE 0 END) AS tax_langsung,
    COUNT(CASE WHEN E REGEXP '^(Tax Room|Room Tax)$' THEN 1 END) AS jml_baris_tax
  FROM d_file_data
  WHERE A REGEXP '^[0-9]+$'
    AND E REGEXP 'Room|Laundry|Phone|Jeep|Miscellaneous'
    AND E NOT REGEXP 'Restaurant|Breakfast|Food|Beverage'
    AND E NOT REGEXP '^Room Service'
  GROUP BY A, filename
),
hitung AS (
  SELECT
    folio, filename, dpp, subtotal, discount, service_charge,
    CASE WHEN jml_baris_tax > 0
         THEN tax_langsung
         ELSE (dpp + service_charge) / 10
    END AS tax
  FROM hasil
)
SELECT
  'hotel_jambuluwuk' AS id_agent,
  CONCAT(folio, '-', DATE_FORMAT(STR_TO_DATE(SUBSTRING_INDEX(filename, '.', 3), '%d.%m.%Y'), '%Y-%m-%d')) AS no_struk,
  DATE_FORMAT(STR_TO_DATE(SUBSTRING_INDEX(filename, '.', 3), '%d.%m.%Y'), '%Y-%m-%d') AS date_trans,
  ROUND(dpp, 2) AS dpp,
  ROUND(subtotal, 2) AS subtotal,
  ROUND(discount, 2) AS discount,
  ROUND(service_charge, 2) AS service_charge,
  ROUND(tax, 2) AS tax,
  ROUND(dpp + service_charge + tax, 2) AS total,
  CONCAT('no folio = ', folio) AS keterangan,
  filename AS namaFile
FROM hitung
