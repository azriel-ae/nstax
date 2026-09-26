export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

// Tarif pajak tiket bioskop (PBJT Jasa Kesenian dan Hiburan). Nilai "total" pada
// JSON sumber dianggap sebagai subtotal SEBELUM pajak — sistem menghitung sendiri
// nominal pajaknya, bukan mengambil dari field manapun di data mentah.
export const TAX_RATE_PERCENT = 10;

/**
 * Menghitung pajak dari sebuah nominal (dalam minor unit / sen) memakai BigInt
 * agar tidak ada pembulatan floating-point yang bisa membuat total pajak meleset
 * saat dijumlahkan lintas ratusan/ribuan transaksi. Pembulatan: round-half-up per baris.
 */
function calcTaxMinor(subtotalMinor: bigint, ratePercent: number = TAX_RATE_PERCENT): bigint {
  const rateBasisPoints = BigInt(Math.round(ratePercent * 100)); // dukung 1 desimal, mis. 10.5% -> 1050
  const sign = subtotalMinor < BigInt(0) ? -BigInt(1) : BigInt(1);
  const absolute = subtotalMinor < BigInt(0) ? -subtotalMinor : subtotalMinor;
  const numerator = absolute * rateBasisPoints;
  const denominator = BigInt(10000);
  const rounded = (numerator + denominator / BigInt(2)) / denominator;
  return rounded * sign;
}

export const EXPECTED_FIELDS = [
  "transaction_no",
  "movie_title",
  "date",
  "show_time",
  "show_studio_id",
  "total_orders",
  "selected_orders",
  "total",
  "total_seat",
] as const;

type RawRecord = Record<string, unknown>;

type NumericResult =
  | { ok: true; value: number; text: string }
  | { ok: false; reason: string };

export type TransactionIssue = {
  index: number;
  transactionNo?: string;
  field: string;
  message: string;
};

export type ParsedTransaction = {
  id: string;
  sourceIndex: number;
  raw: RawRecord;
  transactionNo: string;
  movieTitle: string;
  date: string;
  showTime: string;
  studio: string;
  totalOrders: bigint;
  selectedOrders: bigint;
  totalSeat: bigint;
  totalMinor: bigint;
  taxMinor: bigint;
  grandTotalMinor: bigint;
  isDuplicate: boolean;
  warnings: string[];
};

export type ParseResult = {
  ok: boolean;
  error?: string;
  warning?: string;
  detectedShape: "object" | "array" | "nested" | "unknown";
  candidateCount: number;
  validTransactions: ParsedTransaction[];
  issues: TransactionIssue[];
  duplicateCount: number;
};

const hasOwn = (value: RawRecord, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function normalizeNumericText(value: unknown): { ok: true; text: string } | { ok: false; reason: string } {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { ok: false, reason: "bukan angka finite" };
    const text = String(value);
    if (/e/i.test(text)) return { ok: false, reason: "format eksponensial tidak didukung" };
    return /^-?\d+(\.\d+)?$/.test(text) ? { ok: true, text } : { ok: false, reason: "format angka tidak dikenali" };
  }

  if (typeof value !== "string") return { ok: false, reason: "tipe harus number atau string angka" };
  const text = value.trim();
  if (!text) return { ok: false, reason: "nilainya kosong" };
  return /^-?\d+(\.\d+)?$/.test(text)
    ? { ok: true, text }
    : { ok: false, reason: "gunakan angka tanpa simbol mata uang atau pemisah ribuan" };
}

function parseNumeric(value: unknown, field: string, integer = false): NumericResult {
  const normalized = normalizeNumericText(value);
  if (!normalized.ok) return { ok: false, reason: `${field} ${normalized.reason}` };
  const numeric = Number(normalized.text);
  if (!Number.isFinite(numeric)) return { ok: false, reason: `${field} terlalu besar untuk diproses dengan aman` };
  if (integer && (!Number.isInteger(numeric) || numeric < 0)) {
    return { ok: false, reason: `${field} harus berupa bilangan bulat nol atau lebih` };
  }
  return { ok: true, value: numeric, text: normalized.text };
}

function toMinorUnits(value: unknown): { ok: true; value: bigint } | { ok: false; reason: string } {
  const normalized = normalizeNumericText(value);
  if (!normalized.ok) return normalized;
  const [wholePart, fractionPart = ""] = normalized.text.split(".");
  const sign = wholePart.startsWith("-") ? -BigInt(1) : BigInt(1);
  const absoluteWhole = wholePart.replace("-", "");
  const fraction = fractionPart.padEnd(2, "0");
  const cents = fraction.slice(0, 2);
  let minor = BigInt(absoluteWhole) * BigInt(100) + BigInt(cents || "0");
  if (fractionPart.length > 2 && Number(fractionPart[2]) >= 5) minor += BigInt(1);
  return { ok: true, value: minor * sign };
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeTransaction(value: unknown): value is RawRecord {
  if (!isRecord(value)) return false;
  const transactionNo = value.transaction_no;
  const hasIdentity = typeof transactionNo === "string" && transactionNo.trim().length > 0;
  const signalCount = EXPECTED_FIELDS.filter((field) => hasOwn(value, field)).length;
  return hasIdentity && signalCount >= 2;
}

function collectCandidates(value: unknown, path: string[], found: RawRecord[]): void {
  if (looksLikeTransaction(value)) {
    found.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectCandidates(item, [...path, String(index)], found));
    return;
  }
  if (isRecord(value)) {
    Object.entries(value).forEach(([key, child]) => collectCandidates(child, [...path, key], found));
  }
}

function displayString(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value);
}

function makeIssue(index: number, record: RawRecord, field: string, message: string): TransactionIssue {
  const transactionNo = displayString(record.transaction_no);
  return { index, transactionNo: transactionNo || undefined, field, message };
}

export function parseTransactionJson(text: string): ParseResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: "JSON kosong. Tempelkan data JSON atau upload file .json terlebih dahulu.",
      detectedShape: "unknown",
      candidateCount: 0,
      validTransactions: [],
      issues: [],
      duplicateCount: 0,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      ok: false,
      error: "JSON tidak valid. Periksa kembali tanda kurung, koma, tanda kutip, atau struktur JSON.",
      detectedShape: "unknown",
      candidateCount: 0,
      validTransactions: [],
      issues: [],
      duplicateCount: 0,
    };
  }

  const detectedShape: ParseResult["detectedShape"] = Array.isArray(parsed)
    ? "array"
    : isRecord(parsed) && Object.values(parsed).some((value) => Array.isArray(value) || isRecord(value))
      ? "nested"
      : isRecord(parsed)
        ? "object"
        : "unknown";

  if (!Array.isArray(parsed) && !isRecord(parsed)) {
    return {
      ok: false,
      error: "JSON valid, tetapi root harus berupa object, array, atau struktur object yang memuat transaksi.",
      detectedShape,
      candidateCount: 0,
      validTransactions: [],
      issues: [],
      duplicateCount: 0,
    };
  }

  const candidates: RawRecord[] = [];
  collectCandidates(parsed, [], candidates);
  const issues: TransactionIssue[] = [];
  const validTransactions: ParsedTransaction[] = [];

  candidates.forEach((record, candidateIndex) => {
    const transactionNo = displayString(record.transaction_no);
    let invalid = false;

    if (!transactionNo) {
      issues.push(makeIssue(candidateIndex, record, "transaction_no", "Transaction number wajib diisi."));
      invalid = true;
    }

    if (!hasOwn(record, "total")) {
      issues.push(makeIssue(candidateIndex, record, "total", "Field total wajib ada agar transaksi dapat dihitung."));
      invalid = true;
    }

    const total = parseNumeric(record.total, "total");
    if (!total.ok) {
      issues.push(makeIssue(candidateIndex, record, "total", total.reason));
      invalid = true;
    }

    const numericFields = [
      ["total_orders", true],
      ["selected_orders", true],
      ["total_seat", true],
    ] as const;
    const numericValues: Record<string, bigint> = {};
    const warnings: string[] = [];

    numericFields.forEach(([field, integer]) => {
      if (!hasOwn(record, field)) {
        warnings.push(`${field} tidak tersedia`);
        numericValues[field] = BigInt(0);
        return;
      }
      const result = parseNumeric(record[field], field, integer);
      if (!result.ok) {
        issues.push(makeIssue(candidateIndex, record, field, result.reason));
        invalid = true;
        return;
      }
      numericValues[field] = BigInt(Math.trunc(result.value));
    });

    if (invalid || !total.ok) return;
    const totalMinor = toMinorUnits(total.text);
    if (!totalMinor.ok) {
      issues.push(makeIssue(candidateIndex, record, "total", totalMinor.reason));
      return;
    }

    const taxMinor = calcTaxMinor(totalMinor.value);

    validTransactions.push({
      id: `${transactionNo}-${candidateIndex}`,
      sourceIndex: candidateIndex,
      raw: record,
      transactionNo,
      movieTitle: displayString(record.movie_title) || "—",
      date: displayString(record.date) || "—",
      showTime: displayString(record.show_time) || "—",
      studio: displayString(record.show_studio_id) || "—",
      totalOrders: numericValues.total_orders ?? BigInt(0),
      selectedOrders: numericValues.selected_orders ?? BigInt(0),
      totalSeat: numericValues.total_seat ?? BigInt(0),
      totalMinor: totalMinor.value,
      taxMinor,
      grandTotalMinor: totalMinor.value + taxMinor,
      isDuplicate: false,
      warnings,
    });
  });

  const occurrences = new Map<string, number>();
  validTransactions.forEach((transaction) => {
    occurrences.set(transaction.transactionNo, (occurrences.get(transaction.transactionNo) ?? 0) + 1);
  });
  let duplicateCount = 0;
  validTransactions.forEach((transaction) => {
    if ((occurrences.get(transaction.transactionNo) ?? 0) > 1) {
      transaction.isDuplicate = true;
      duplicateCount += 1;
    }
  });

  return {
    ok: true,
    warning:
      validTransactions.length === 0
        ? "JSON berhasil dibaca, tetapi tidak ditemukan data transaksi valid."
        : issues.length > 0
          ? `${issues.length} masalah ditemukan dan tidak ikut dimasukkan ke perhitungan.`
          : undefined,
    detectedShape,
    candidateCount: candidates.length,
    validTransactions,
    issues,
    duplicateCount,
  };
}

export function formatRupiahMinor(minor: bigint): string {
  const sign = minor < BigInt(0) ? "-" : "";
  const absolute = minor < BigInt(0) ? -minor : minor;
  const whole = absolute / BigInt(100);
  const fraction = absolute % BigInt(100);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `Rp${sign}${grouped}${fraction === BigInt(0) ? "" : `,${fraction.toString().padStart(2, "0")}`}`;
}

export function formatAverageMinor(totalMinor: bigint, count: number): string {
  if (count === 0) return "Rp0";
  const divisor = BigInt(count);
  const rounded = (totalMinor + divisor / BigInt(2)) / divisor;
  return formatRupiahMinor(rounded);
}

export function formatInteger(value: bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

export function calculateSummary(transactions: ParsedTransaction[]) {
  const totalMinor = transactions.reduce((sum, transaction) => sum + transaction.totalMinor, BigInt(0));
  const taxMinor = transactions.reduce((sum, transaction) => sum + transaction.taxMinor, BigInt(0));
  const grandTotalMinor = totalMinor + taxMinor;
  return {
    count: transactions.length,
    totalMinor,
    taxMinor,
    grandTotalMinor,
    totalOrders: transactions.reduce((sum, transaction) => sum + transaction.totalOrders, BigInt(0)),
    selectedOrders: transactions.reduce((sum, transaction) => sum + transaction.selectedOrders, BigInt(0)),
    totalSeat: transactions.reduce((sum, transaction) => sum + transaction.totalSeat, BigInt(0)),
    averageMinor: transactions.length ? (totalMinor + BigInt(transactions.length) / BigInt(2)) / BigInt(transactions.length) : BigInt(0),
  };
}

export function toCsv(transactions: ParsedTransaction[]): string {
  const headers = ["No", "Transaction No", "Movie", "Date", "Show Time", "Studio", "Orders", "Selected", "Seat", "Subtotal", `Pajak (${TAX_RATE_PERCENT}%)`, "Grand Total"];
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const rows = transactions.map((transaction, index) => [
    String(index + 1),
    transaction.transactionNo,
    transaction.movieTitle,
    transaction.date,
    transaction.showTime,
    transaction.studio,
    transaction.totalOrders.toString(),
    transaction.selectedOrders.toString(),
    transaction.totalSeat.toString(),
    formatRupiahMinor(transaction.totalMinor),
    formatRupiahMinor(transaction.taxMinor),
    formatRupiahMinor(transaction.grandTotalMinor),
  ]);
  return [headers, ...rows].map((row) => row.map(escape).join(",")).join("\n");
}
