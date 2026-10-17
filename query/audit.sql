-- ============================================================
-- AUDIT: nama item yang TIDAK ditangkap query HOTEL maupun RESTO.
-- Jalankan tiap bulan. Hasil yang wajar hanya pembayaran (mis. FO City Ledger).
-- Kalau muncul nama baru bertipe Room/Tax/Service/Food, tambahkan ke pola query.
-- ============================================================
SELECT
  E AS nama_item,
  COUNT(*) AS jml_baris,
  ROUND(SUM(CAST(J AS DECIMAL(15,4))), 2) AS nett
FROM d_file_data
WHERE A REGEXP '^[0-9]+$'
  AND NOT (E REGEXP 'Room|Laundry|Phone|Jeep|Miscellaneous'
           AND E NOT REGEXP 'Restaurant|Breakfast|Food|Beverage'
           AND E NOT REGEXP '^Room Service')
  AND E NOT REGEXP 'Restaurant|Breakfast|Food|Beverage'
GROUP BY E
