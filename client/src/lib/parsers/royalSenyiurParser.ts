import { validYmd } from "../shared/parseHelpers";
// CEK UPL · ROYAL SENYIUR (kategori HOTEL dan RESTO dari SATU file CSV)
//
// Sumber : satu file CSV TANPA header (baris pertama adalah data transaksi). Kolom dibaca berdasarkan POSISI:
//   A = kode   B = tanggal transaksi   C = nomor struk   D = subtotal   E = service charge   F = tax   G = keterangan
//
// KLASIFIKASI mengikuti SQL acuan, yaitu berdasarkan NOMOR STRUK (kolom C), BUKAN kode kolom A:
//   HOTEL : C LIKE 'PC%'                                  (awalan PC, huruf besar/kecil sama seperti LIKE MySQL)
//   RESTO : C NOT LIKE 'PC%' AND C != '' AND F != ''
//   Setiap baris masuk paling banyak satu kategori (awalan PC = HOTEL, selain itu = RESTO), jadi tidak ada tumpang tindih.
//   Baris yang tidak lolos filter (C kosong; atau RESTO dengan F kosong) dilaporkan sebagai "dikecualikan filter", tidak hilang diam-diam.
//   Kolom A tidak dipakai SQL; hanya dicatat sebagai informasi (sourceCodes).
//
// HOTEL (SQL: GROUP BY C tanpa fungsi agregat):
//   id_agent = 'hotel_senyiur'   no_struk = C   date_trans = B   subtotal = D   service_charge = E   discount = 0
//   dpp = D + E   tax = F (BUKAN dihitung dari persentase)   total = (D + E) + F   keterangan = G
//   Karena SQL tidak memakai SUM()/MAX(), satu nomor struk menghasilkan SATU record. Bila sebuah struk punya >1 baris,
//   dipakai BARIS PERTAMA (urutan file lalu urutan baris) — perilaku kolom non-agregat pada GROUP BY MySQL — dan baris lain
//   TIDAK dijumlahkan. Keputusan ini eksplisit: tiap kasus dilaporkan (RoyalHotelMultiRow), termasuk apakah nilainya berbeda.
//
// RESTO (GROUP BY C — satu baris output per nomor struk):
//   id_agent = 'resto_senyiur'   no_struk = C   date_trans = MAX(B)   subtotal = SUM(D)   service_charge = SUM(E)
//   discount = 0   dpp = SUM(D + E)   tax = SUM(F)   total = SUM((D + E) + F)   keterangan = CONCAT(COUNT(*), ' struk')
//   COUNT(*) = jumlah BARIS sumber dalam grup (sesuai SQL), bukan jumlah struk unik.
//   Baris dengan isi identik TIDAK di-dedup: SQL menjumlahkan semuanya.
//
// HARIAN dan BULANAN memakai fungsi yang sama: groupRoyalLines() (HOTEL + RESTO). Harian memanggilnya atas baris satu file,
// bulanan atas baris GABUNGAN semua file valid (combineRoyalMonthly). Ringkasan harian TIDAK dijumlahkan, sehingga COUNT(*),
// MAX(B) dan pemilihan baris pertama HOTEL tetap sesuai SQL walau satu struk muncul di beberapa file. Tidak ada dedup otomatis.
//
// Akurasi: D, E, F dibaca sebagai desimal eksak (BigInt, skala 6); semua rumus dan penjumlahan memakai bilangan bulat,
// tanpa floating point dan tanpa penggabungan string. Nilai kosong/bukan angka dilaporkan sebagai masalah dan barisnya
// tidak dihitung (tidak diganti 0). Pembulatan 2 desimal hanya terjadi saat TAMPILAN.

export type RoyalCategory = "HOTEL" | "RESTO";

export const ROYAL_CATEGORIES: RoyalCategory[] = ["HOTEL", "RESTO"];

export const ROYAL_AGENT: Record<RoyalCategory, string> = {
  HOTEL: "hotel_senyiur",
  RESTO: "resto_senyiur",
};

/**
 * Klasifikasi baris berdasarkan NOMOR STRUK (kolom C), sama seperti SQL acuan:
 *   awalan PC (LIKE 'PC%')            → HOTEL
 *   tidak diawali PC dan tidak kosong → RESTO (masih dikenai filter F != '' di parser)
 *   kosong                            → null (tidak lolos filter HOTEL maupun RESTO)
 * Satu-satunya tempat aturan ini ditulis; HARIAN dan BULANAN memakainya lewat parseRoyalSenyiurCsv.
 */
export function classifyRoyalReceipt(noStruk: string): RoyalCategory | null {
  const c = noStruk.trim();
  if (c === "") return null;
  return /^pc/i.test(c) ? "HOTEL" : "RESTO";
}

/** Jumlah kolom sumber (tanpa header). */
export const ROYAL_COLUMN_COUNT = 7;

/** Skala nilai uang (digit desimal) untuk semua bigint. */
export const ROYAL_SCALE = 6;
const SCALE_FACTOR = 10n ** BigInt(ROYAL_SCALE);

export type RoyalRow = {
  id_agent: string;
  category: RoyalCategory;
  no_struk: string;
  date_trans: string; // YYYY-MM-DD
  /** Semua nilai uang: bilangan bulat berskala 10^-ROYAL_SCALE (eksak). */
  subtotal: bigint;
  service_charge: bigint;
  discount: bigint;
  dpp: bigint;
  tax: bigint;
  total: bigint;
  keterangan: string;
  /** Nomor baris (1-based) di file CSV yang menyusun record ini. HOTEL: satu baris; RESTO: semua baris dalam grup. */
  sourceRows: number[];
  /** Kode kolom A yang muncul pada record ini. */
  sourceCodes: string[];
  /** Nama file (berurutan, unik) yang menyusun record ini. Harian: satu file; bulanan RESTO: bisa lebih dari satu. */
  sourceFiles: string[];
};

/** Satu baris sumber valid (sebelum GROUP BY C), dipakai ulang oleh HOTEL dan RESTO, harian maupun bulanan. */
export type RoyalLine = {
  fileName: string;
  line: number;
  code: string; // kolom A (informasi saja)
  noStruk: string;
  date: string; // YYYY-MM-DD
  d: bigint;
  e: bigint;
  f: bigint;
  keterangan: string; // kolom G
};
export type RoyalHotelLine = RoyalLine;
export type RoyalRestoLine = RoyalLine;

export type RoyalIssueKind = "structure" | "date" | "amount" | "receipt";
export type RoyalIssue = { row: number; kind: RoyalIssueKind; code: string; noStruk: string; value: string; message: string };
export type RoyalExcludedReason = "receipt_empty" | "tax_empty";
/** Baris yang tidak lolos filter WHERE SQL (bukan salah data): dilaporkan, tidak dihitung. */
export type RoyalExcluded = { row: number; code: string; noStruk: string; subtotal: string; tax: string; keterangan: string; reason: RoyalExcludedReason; message: string };

/** Nomor struk HOTEL dengan lebih dari satu baris sumber (SQL: GROUP BY C tanpa agregat). */
export type RoyalHotelMultiRow = {
  noStruk: string;
  used: { fileName: string; line: number }; // baris yang dipakai (pertama)
  ignored: Array<{ fileName: string; line: number; code: string; date: string; d: bigint; e: bigint; f: bigint; keterangan: string }>;
  files: string[];
  /** true bila ada baris yang tidak dipakai dengan nilai B/D/E/F/G berbeda dari baris yang dipakai (ambigu). */
  conflicting: boolean;
  /** Jumlah (D + E + F) seluruh baris yang tidak dipakai. */
  ignoredTotal: bigint;
};

export type RoyalStats = {
  sourceRecords: number; // baris data non-kosong yang dibaca (baris pertama ikut dihitung)
  blankLines: number;
  hotelSourceRows: number; // baris sumber valid yang masuk HOTEL (sebelum GROUP BY C)
  restoSourceRows: number; // baris sumber valid yang masuk RESTO (sebelum GROUP BY C)
  hotelRecords: number; // record output HOTEL (jumlah nomor struk PC unik)
  hotelIgnoredRows: number; // baris HOTEL tambahan pada struk yang sama (tidak dipakai, tidak dijumlahkan)
  restoGroups: number; // record output RESTO (jumlah nomor struk unik)
  excludedRows: number; // tidak lolos filter SQL (C kosong, atau RESTO dengan F kosong)
  issueRows: number; // baris unik bermasalah (tanggal/angka/struktur; tidak dihitung)
};

export type RoyalSource = {
  ok: boolean;
  error?: string;
  fileName: string;
  rows: RoyalRow[];
  excluded: RoyalExcluded[];
  issues: RoyalIssue[];
  stats: RoyalStats;
  /** Baris sumber valid milik file ini (bahan agregasi gabungan bulanan). */
  hotelLines: RoyalHotelLine[];
  restoLines: RoyalRestoLine[];
  hotelMulti: RoyalHotelMultiRow[];
};

const emptyStats = (): RoyalStats => ({
  sourceRecords: 0, blankLines: 0, hotelSourceRows: 0, restoSourceRows: 0, hotelRecords: 0, hotelIgnoredRows: 0, restoGroups: 0,
  excludedRows: 0, issueRows: 0,
});

/** Hasil untuk file yang gagal dibaca/divalidasi: tidak membawa record apa pun. */
export const failRoyalSource = (fileName: string, error: string): RoyalSource => ({
  ok: false, error, fileName, rows: [], excluded: [], issues: [], stats: emptyStats(), hotelLines: [], restoLines: [], hotelMulti: [],
});
const failSource = failRoyalSource;

// ---------- CSV (RFC 4180 sederhana: koma, tanda kutip ganda, CRLF/LF/CR, BOM) ----------

export type CsvRecord = { line: number; fields: string[] };

/** Memecah teks CSV menjadi record. TIDAK ada baris header: semua baris non-kosong adalah record. */
export function parseCsvRecords(input: string): { records: CsvRecord[]; blankLines: number } {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: CsvRecord[] = [];
  let blankLines = 0;
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let startLine = 1;
  let sawContent = false; // ada karakter apa pun (termasuk koma) pada record berjalan

  const endRecord = () => {
    fields.push(field);
    const isBlank = fields.length === 1 && fields[0].trim() === "" && !sawContent;
    if (isBlank) blankLines++;
    else records.push({ line: startLine, fields });
    fields = [];
    field = "";
    sawContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") { inQuotes = true; sawContent = true; continue; }
    if (ch === ",") { fields.push(field); field = ""; sawContent = true; continue; }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      startLine = line;
      continue;
    }
    if (field === "" && fields.length === 0 && !sawContent) startLine = line;
    field += ch;
    if (ch.trim() !== "") sawContent = true;
  }
  if (field !== "" || fields.length > 0 || sawContent) endRecord();
  return { records, blankLines };
}

/** Desimal polos → bigint berskala ROYAL_SCALE (setengah menjauhi nol). null = bukan angka valid. */
export function parseRoyalDecimal(text: string): bigint | null {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
  if (!m) return null;
  const intPart = m[2] ?? "";
  const fracPart = m[3] ?? "";
  if (intPart === "" && fracPart === "") return null;
  const kept = (fracPart + "0".repeat(ROYAL_SCALE)).slice(0, ROYAL_SCALE);
  let scaled = BigInt(intPart === "" ? "0" : intPart) * SCALE_FACTOR + BigInt(kept);
  if (fracPart.charAt(ROYAL_SCALE) !== "" && fracPart.charAt(ROYAL_SCALE) >= "5") scaled += 1n;
  return m[1] === "-" ? -scaled : scaled;
}

/** Rumus per baris/grup dari D, E, F (bigint berskala ROYAL_SCALE). Dipakai HOTEL (satu baris) dan RESTO (sudah dijumlah). */
export function computeRoyalAmounts(d: bigint, e: bigint, f: bigint) {
  return {
    subtotal: d, // D
    service_charge: e, // E
    discount: 0n, // 0
    dpp: d + e, // D + E
    tax: f, // F
    total: d + e + f, // (D + E) + F
  };
}

/** Bigint skala ROYAL_SCALE → "Rp1.234,56" (2 desimal hanya untuk tampilan, setengah menjauhi nol). */
export function formatRoyalMoney(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const unit = 10n ** BigInt(ROYAL_SCALE - 2);
  let cents = abs / unit;
  if (abs % unit >= unit / 2n) cents += 1n;
  const intText = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const frac = (cents % 100n).toString().padStart(2, "0");
  return `Rp${negative && cents !== 0n ? "-" : ""}${intText},${frac}`;
}

/** Representasi desimal penuh (untuk audit/pengujian), tanpa nol di belakang. */
export function royalToPlain(value: bigint): string {
  const negative = value < 0n;
  const abs = (negative ? -value : value).toString().padStart(ROYAL_SCALE + 1, "0");
  const int = abs.slice(0, abs.length - ROYAL_SCALE);
  const frac = abs.slice(abs.length - ROYAL_SCALE).replace(/0+$/, "");
  return `${negative ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

/** Kolom B → YYYY-MM-DD. Mendukung yyyy-mm-dd, yyyy/mm/dd (boleh diikuti jam) dan dd-mm-yyyy, dd/mm/yyyy, dd.mm.yyyy. null = tidak valid; tidak pernah memakai tanggal hari ini. */
export function parseRoyalDate(value: string): string | null {
  const text = value.trim();
  if (text === "") return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(text);
  if (m) return validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T].*)?$/.exec(text);
  if (m) return validYmd(Number(m[3]), Number(m[2]), Number(m[1]));
  return null;
}

const NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

type RestoGroup = {
  noStruk: string;
  maxDate: string;
  d: bigint;
  e: bigint;
  f: bigint;
  dpp: bigint; // SUM(D + E) per baris
  total: bigint; // SUM((D + E) + F) per baris
  count: number;
  lines: number[];
  codes: Set<string>;
  files: Set<string>;
};

/** RESTO: GROUP BY C atas baris sumber valid. Satu-satunya implementasi (harian dan bulanan). Urutan = kemunculan pertama nomor struk. */
export function groupRestoLines(lines: readonly RoyalRestoLine[]): RoyalRow[] {
  const groups = new Map<string, RestoGroup>();
  for (const l of lines) {
    const lineDpp = l.d + l.e;
    const lineTotal = l.d + l.e + l.f;
    const hit = groups.get(l.noStruk);
    if (hit) {
      if (l.date > hit.maxDate) hit.maxDate = l.date; // MAX(B)
      hit.d += l.d; hit.e += l.e; hit.f += l.f; hit.dpp += lineDpp; hit.total += lineTotal;
      hit.count++; hit.lines.push(l.line); hit.codes.add(l.code); hit.files.add(l.fileName);
    } else {
      groups.set(l.noStruk, { noStruk: l.noStruk, maxDate: l.date, d: l.d, e: l.e, f: l.f, dpp: lineDpp, total: lineTotal, count: 1, lines: [l.line], codes: new Set([l.code]), files: new Set([l.fileName]) });
    }
  }
  return [...groups.values()].map((g) => ({
    id_agent: ROYAL_AGENT.RESTO,
    category: "RESTO" as const,
    no_struk: g.noStruk,
    date_trans: g.maxDate,
    subtotal: g.d, // SUM(D)
    service_charge: g.e, // SUM(E)
    discount: 0n,
    dpp: g.dpp, // SUM(D + E)
    tax: g.f, // SUM(F)
    total: g.total, // SUM((D + E) + F)
    keterangan: `${g.count} struk`, // CONCAT(COUNT(*), ' struk')
    sourceRows: g.lines,
    sourceCodes: [...g.codes],
    sourceFiles: [...g.files],
  }));
}

/**
 * HOTEL: GROUP BY C tanpa fungsi agregat. Satu record per nomor struk; nilai diambil dari BARIS PERTAMA grup
 * (urutan masukan = urutan file lalu urutan baris). Baris berikutnya pada struk yang sama TIDAK dijumlahkan dan dilaporkan di `multi`.
 */
export function groupHotelLines(lines: readonly RoyalHotelLine[]): { rows: RoyalRow[]; multi: RoyalHotelMultiRow[] } {
  const groups = new Map<string, RoyalHotelLine[]>();
  for (const l of lines) {
    const hit = groups.get(l.noStruk);
    if (hit) hit.push(l); else groups.set(l.noStruk, [l]);
  }
  const rows: RoyalRow[] = [];
  const multi: RoyalHotelMultiRow[] = [];
  for (const [noStruk, ls] of groups) {
    const first = ls[0];
    rows.push({
      id_agent: ROYAL_AGENT.HOTEL,
      category: "HOTEL",
      no_struk: noStruk,
      date_trans: first.date, // B
      ...computeRoyalAmounts(first.d, first.e, first.f), // D, E, F → dpp = D + E, total = D + E + F
      keterangan: first.keterangan, // G
      sourceRows: [first.line],
      sourceCodes: [first.code],
      sourceFiles: [first.fileName],
    });
    if (ls.length > 1) {
      const rest = ls.slice(1);
      multi.push({
        noStruk,
        used: { fileName: first.fileName, line: first.line },
        ignored: rest.map((l) => ({ fileName: l.fileName, line: l.line, code: l.code, date: l.date, d: l.d, e: l.e, f: l.f, keterangan: l.keterangan })),
        files: [...new Set(ls.map((l) => l.fileName))],
        conflicting: rest.some((l) => l.date !== first.date || l.d !== first.d || l.e !== first.e || l.f !== first.f || l.keterangan !== first.keterangan),
        ignoredTotal: rest.reduce((n, l) => n + l.d + l.e + l.f, 0n),
      });
    }
  }
  return { rows, multi };
}

/** Satu-satunya jalur pengelompokan HOTEL + RESTO. Dipakai mode HARIAN (satu file) dan BULANAN (gabungan semua file). */
export function groupRoyalLines(hotelLines: readonly RoyalHotelLine[], restoLines: readonly RoyalRestoLine[]) {
  const hotel = groupHotelLines(hotelLines);
  const resto = groupRestoLines(restoLines);
  return { rows: [...hotel.rows, ...resto], hotelRows: hotel.rows, restoRows: resto, hotelMulti: hotel.multi };
}

/** Membaca teks CSV ROYAL SENYIUR dan menghasilkan record HOTEL + RESTO sesuai SQL acuan. */
export function parseRoyalSenyiurCsv(text: string, fileName: string): RoyalSource {
  const { records, blankLines } = parseCsvRecords(text);
  if (records.length === 0) return failSource(fileName, "File kosong: tidak ada baris data.");

  const stats = emptyStats();
  stats.blankLines = blankLines;
  const excluded: RoyalExcluded[] = [];
  const issues: RoyalIssue[] = [];
  const hotelLines: RoyalHotelLine[] = [];
  const restoLines: RoyalRestoLine[] = [];

  for (const rec of records) {
    stats.sourceRecords++;
    const line = rec.line;
    let fields = rec.fields;
    // Koma di ujung baris (kolom kosong setelah G) ditoleransi; kolom berisi di luar 7 tidak.
    while (fields.length > ROYAL_COLUMN_COUNT && fields[fields.length - 1].trim() === "") fields = fields.slice(0, -1);
    const code = (fields[0] ?? "").trim();
    const noStrukPreview = (fields[2] ?? "").trim();

    if (fields.length !== ROYAL_COLUMN_COUNT) {
      stats.issueRows++;
      issues.push({ row: line, kind: "structure", code, noStruk: noStrukPreview, value: String(fields.length), message: `Jumlah kolom ${fields.length}, seharusnya ${ROYAL_COLUMN_COUNT} — baris tidak dihitung.` });
      continue;
    }

    const [, bRaw, cRaw, dRaw, eRaw, fRaw, gRaw] = fields;
    const noStruk = cRaw.trim();
    const category = classifyRoyalReceipt(noStruk);
    const exclude = (reason: RoyalExcludedReason, message: string) => {
      stats.excludedRows++;
      excluded.push({ row: line, code, noStruk, subtotal: dRaw.trim(), tax: fRaw.trim(), keterangan: gRaw.trim(), reason, message });
    };

    // Filter WHERE SQL. HOTEL: C LIKE 'PC%'. RESTO: C NOT LIKE 'PC%' AND C != '' AND F != ''.
    if (category === null) { exclude("receipt_empty", "Nomor struk (kolom C) kosong — tidak lolos filter HOTEL (C LIKE 'PC%') maupun RESTO (C != '')."); continue; }
    if (category === "RESTO" && fRaw.trim() === "") { exclude("tax_empty", "Tax (kolom F) kosong — tidak lolos filter RESTO (F != '')."); continue; }

    const rowIssues: RoyalIssue[] = [];
    const date = parseRoyalDate(bRaw);
    if (date === null) {
      rowIssues.push({ row: line, kind: "date", code, noStruk, value: bRaw.trim(), message: bRaw.trim() === "" ? "Tanggal (kolom B) kosong — baris tidak dihitung." : `Tanggal (kolom B) "${bRaw.trim()}" tidak dapat dibaca — baris tidak dihitung.` });
    }
    const amounts: Array<[string, string, bigint | null]> = [["D", "subtotal", null], ["E", "service charge", null], ["F", "tax", null]];
    [dRaw, eRaw, fRaw].forEach((raw, idx) => {
      const value = raw.trim();
      if (value === "" || !NUMBER_RE.test(value)) {
        rowIssues.push({ row: line, kind: "amount", code, noStruk, value, message: value === "" ? `Nilai ${amounts[idx][1]} (kolom ${amounts[idx][0]}) kosong — baris tidak dihitung.` : `Nilai ${amounts[idx][1]} (kolom ${amounts[idx][0]}) "${value}" bukan angka valid — baris tidak dihitung.` });
      } else {
        amounts[idx][2] = parseRoyalDecimal(value);
      }
    });
    if (rowIssues.length) {
      stats.issueRows++;
      issues.push(...rowIssues);
      continue;
    }

    const l: RoyalLine = { fileName, line, code, noStruk, date: date as string, d: amounts[0][2] as bigint, e: amounts[1][2] as bigint, f: amounts[2][2] as bigint, keterangan: gRaw.trim() };
    if (category === "HOTEL") { stats.hotelSourceRows++; hotelLines.push(l); }
    else { stats.restoSourceRows++; restoLines.push(l); }
  }

  const grouped = groupRoyalLines(hotelLines, restoLines);
  stats.hotelRecords = grouped.hotelRows.length;
  stats.hotelIgnoredRows = stats.hotelSourceRows - stats.hotelRecords;
  stats.restoGroups = grouped.restoRows.length;
  return { ok: true, fileName, rows: grouped.rows, excluded, issues, stats, hotelLines, restoLines, hotelMulti: grouped.hotelMulti };
}

export function filterRoyalRows(rows: readonly RoyalRow[], category: RoyalCategory): RoyalRow[] {
  return rows.filter((row) => row.category === category);
}

export function countRoyalByCategory(rows: readonly RoyalRow[]): Record<RoyalCategory, number> {
  const counts: Record<RoyalCategory, number> = { HOTEL: 0, RESTO: 0 };
  for (const row of rows) counts[row.category]++;
  return counts;
}

export type RoyalSummary = {
  count: number; // jumlah record output
  sourceRows: number; // jumlah baris sumber di balik record tersebut
  subtotal: bigint;
  dpp: bigint;
  discount: bigint;
  service_charge: bigint;
  tax: bigint;
  total: bigint;
};

/** Ringkasan dari SELURUH record yang diberikan (bukan halaman preview). */
export function summarizeRoyalRows(rows: readonly RoyalRow[]): RoyalSummary {
  const s: RoyalSummary = { count: 0, sourceRows: 0, subtotal: 0n, dpp: 0n, discount: 0n, service_charge: 0n, tax: 0n, total: 0n };
  for (const row of rows) {
    s.count++;
    s.sourceRows += row.sourceRows.length;
    s.subtotal += row.subtotal;
    s.dpp += row.dpp;
    s.discount += row.discount;
    s.service_charge += row.service_charge;
    s.tax += row.tax;
    s.total += row.total;
  }
  return s;
}

export type RoyalMonthlyIssue = RoyalIssue & { fileName: string };
export type RoyalMonthlyExcluded = RoyalExcluded & { fileName: string };

export type RoyalFileStatus = {
  fileName: string;
  ok: boolean;
  error?: string;
  stats: RoyalStats;
  issueCount: number;
};

export type RoyalMonthly = {
  rows: RoyalRow[]; // HOTEL (GROUP BY C atas gabungan seluruh file) + RESTO (GROUP BY C atas gabungan seluruh file)
  excluded: RoyalMonthlyExcluded[];
  issues: RoyalMonthlyIssue[];
  files: RoyalFileStatus[];
  okFiles: number;
  failedFiles: number;
  /** false bila ada file yang gagal: periode tidak boleh dinyatakan lengkap. */
  complete: boolean;
  dateMin: string | null;
  dateMax: string | null;
  /** Jumlah nomor struk RESTO yang barisnya tersebar di lebih dari satu file (dikelompokkan sesuai SQL, tidak dibuang). */
  restoReceiptsAcrossFiles: number;
  /** Jumlah nomor struk HOTEL yang muncul di lebih dari satu file (dikelompokkan sesuai SQL: satu record). */
  hotelReceiptsAcrossFiles: number;
  /** Struk HOTEL dengan >1 baris (di satu file maupun lintas file). */
  hotelMulti: RoyalHotelMultiRow[];
  /** Statistik gabungan; hotelRecords dan restoGroups dihitung dari pengelompokan ulang, bukan dijumlahkan per file. */
  stats: RoyalStats;
};

/** Urutan deterministik (Ctrl + A tidak menjamin urutan): nama file, angka diurutkan secara numerik. */
export const compareRoyalFileNames = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

/** Menggabungkan hasil parse per file. File gagal dilaporkan dan tidak membawa record; file valid lain tetap masuk. */
export function combineRoyalMonthly(sources: readonly RoyalSource[]): RoyalMonthly {
  const ordered = [...sources].sort((x, y) => compareRoyalFileNames(x.fileName, y.fileName));
  const stats = emptyStats();
  const hotelLines: RoyalHotelLine[] = [];
  const restoLines: RoyalRestoLine[] = [];
  const excluded: RoyalMonthlyExcluded[] = [];
  const issues: RoyalMonthlyIssue[] = [];
  const files: RoyalFileStatus[] = [];
  let dateMin: string | null = null;
  let dateMax: string | null = null;

  for (const src of ordered) {
    files.push({ fileName: src.fileName, ok: src.ok, error: src.error, stats: src.stats, issueCount: src.issues.length });
    if (!src.ok) continue;
    const st = src.stats;
    stats.sourceRecords += st.sourceRecords; stats.blankLines += st.blankLines;
    stats.hotelSourceRows += st.hotelSourceRows; stats.restoSourceRows += st.restoSourceRows;
    stats.excludedRows += st.excludedRows; stats.issueRows += st.issueRows;
    hotelLines.push(...src.hotelLines);
    restoLines.push(...src.restoLines);
    excluded.push(...src.excluded.map((u) => ({ ...u, fileName: src.fileName })));
    issues.push(...src.issues.map((i) => ({ ...i, fileName: src.fileName })));
  }

  // Tanggal hanya dari baris valid.
  const consider = (d: string) => {
    if (dateMin === null || d < dateMin) dateMin = d;
    if (dateMax === null || d > dateMax) dateMax = d;
  };
  hotelLines.forEach((l) => consider(l.date));
  restoLines.forEach((l) => consider(l.date));

  // Fungsi pengelompokan yang SAMA dengan mode harian, atas baris gabungan seluruh file valid.
  const grouped = groupRoyalLines(hotelLines, restoLines);
  stats.hotelRecords = grouped.hotelRows.length;
  stats.hotelIgnoredRows = stats.hotelSourceRows - stats.hotelRecords;
  stats.restoGroups = grouped.restoRows.length;
  const okFiles = files.filter((f) => f.ok).length;
  const failedFiles = files.length - okFiles;
  return {
    rows: grouped.rows,
    excluded, issues, files, okFiles, failedFiles,
    complete: failedFiles === 0 && files.length > 0,
    dateMin, dateMax,
    restoReceiptsAcrossFiles: grouped.restoRows.filter((r) => r.sourceFiles.length > 1).length,
    hotelReceiptsAcrossFiles: grouped.hotelMulti.filter((m) => m.files.length > 1).length,
    hotelMulti: grouped.hotelMulti,
    stats,
  };
}
