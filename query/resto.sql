-- ============================================================
-- QUERY DEFAULT RESTO  (nilai dari kolom E = NAME, J = NETT)
--   ITEM    : Restaurant - Food/Beverage, Breakfast Package, Disc ...
--   SERVICE : Restaurant - Service | Restaurant Service
--   TAX     : Restaurant - Tax | Restaurant Tax
-- Rumus sama dengan HOTEL:
--   tax = baris TAX jika ada; jika tidak ada = (dpp + service_charge) / 10
-- ============================================================
WITH hasil AS (
  SELECT
    A AS folio,
    filename,
    SUM(CASE WHEN E REGEXP 'Restaurant|Breakfast|Food|Beverage'
              AND E NOT REGEXP '^(Restaurant - Service|Restaurant Service|Restaurant - Tax|Restaurant Tax)'
             THEN CAST(J AS DECIMAL(15,4)) ELSE 0 END) AS dpp,
    SUM(CASE WHEN E REGEXP 'Restaurant|Breakfast|Food|Beverage'
              AND E NOT REGEXP '^(Disc|Restaurant - Service|Restaurant Service|Restaurant - Tax|Restaurant Tax)'
             THEN CAST(J AS DECIMAL(15,4)) ELSE 0 END) AS subtotal,
    SUM(CASE WHEN E REGEXP '^Disc'
              AND E REGEXP 'Restaurant|Breakfast|Food|Beverage'
             THEN CAST(J AS DECIMAL(15,4)) ELSE 0 END) AS discount,
    SUM(CASE WHEN E REGEXP '^(Restaurant - Service|Restaurant Service)$'
             THEN CAST(J AS DECIMAL(15,4)) ELSE 0 END) AS service_charge,
    SUM(CASE WHEN E REGEXP '^(Restaurant - Tax|Restaurant Tax)$'
             THEN CAST(J AS DECIMAL(15,4)) ELSE 0 END) AS tax_langsung,
    COUNT(CASE WHEN E REGEXP '^(Restaurant - Tax|Restaurant Tax)$' THEN 1 END) AS jml_baris_tax
  FROM d_file_data
  WHERE A REGEXP '^[0-9]+$'
    AND E REGEXP 'Restaurant|Breakfast|Food|Beverage'
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
  'resto_jambuluwuk' AS id_agent,
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
