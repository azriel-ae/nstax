-- ============================================================
-- PETA NAMA ITEM: jalankan setiap file baru, SEBELUM hotel/resto.
-- Menampilkan SEMUA nama di kolom E, masuk profil apa, perannya apa,
-- dan jumlah NETT-nya. Cara baca:
--   profil = HOTEL / RESTO            -> dihitung query
--   profil = TIDAK DIHITUNG           -> pembayaran / item lain (cek wajar atau tidak)
--   peran  = PERIKSA...               -> nama mirip tax/service tapi TIDAK terbaca query
-- Polanya identik dengan hotel.sql dan resto.sql.
-- ============================================================
SELECT
  E AS nama_item,
  CASE
    WHEN E REGEXP 'Restaurant|Breakfast|Food|Beverage' THEN 'RESTO'
    WHEN E REGEXP '^Room Service' THEN 'TIDAK DIHITUNG'
    WHEN E REGEXP 'Room|Laundry|Phone|Jeep|Miscellaneous' THEN 'HOTEL'
    ELSE 'TIDAK DIHITUNG'
  END AS profil,
  CASE
    WHEN E REGEXP '^(Service Room|Restaurant - Service|Restaurant Service)$' THEN 'service'
    WHEN E REGEXP '^(Tax Room|Room Tax|Restaurant - Tax|Restaurant Tax)$' THEN 'tax'
    WHEN E REGEXP 'Tax|Service|Pajak' THEN 'PERIKSA: mirip tax/service, tidak terbaca'
    WHEN E REGEXP '^Disc' THEN 'discount'
    ELSE 'item'
  END AS peran,
  COUNT(*) AS jml_baris,
  ROUND(SUM(CAST(J AS DECIMAL(15,4))), 2) AS nett
FROM d_file_data
WHERE A REGEXP '^[0-9]+$'
GROUP BY E
