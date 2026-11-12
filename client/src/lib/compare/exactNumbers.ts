import JSZip from "jszip";

// Nomor struk adalah IDENTIFIER, bukan angka hitungan. Angka bulat > 2^53 (mis. 641126010100002641, 18 digit) tidak dapat disimpan
// utuh sebagai Number JavaScript: 641126010100002641, ...642, dan ...643 semuanya menjadi nilai double yang SAMA. Karena itu angka
// panjang harus dibaca sebagai TEKS langsung dari sumbernya (XML Excel / teks JSON), sebelum sempat menjadi Number.

/** Angka bulat dengan ≥ 16 digit sudah melewati batas presisi aman double (15 digit). */
export const LONG_INT_DIGITS = 16;
const LONG_INT = new RegExp(`^-?\\d{${LONG_INT_DIGITS},}$`);

/**
 * JSON: bungkus angka bulat panjang yang TIDAK bertanda kutip dengan tanda kutip sebelum JSON.parse, supaya digitnya tidak hilang.
 * Memindai karakter demi karakter (tahu mana string, mana angka), sehingga isi string yang kebetulan berupa digit tidak disentuh.
 * Angka desimal / berpangkat tidak diubah. Mengembalikan teks baru dan jumlah angka yang dibungkus.
 */
export function quoteLongJsonIntegers(text: string): { text: string; quoted: number } {
  let out = "", quoted = 0, i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i + (ch === "-" ? 1 : 0);
      const digitsStart = j;
      while (j < n && text[j] >= "0" && text[j] <= "9") j++;
      const isInteger = !(text[j] === "." || text[j] === "e" || text[j] === "E");
      const token = text.slice(i, j);
      if (isInteger && j - digitsStart >= LONG_INT_DIGITS) { out += `"${token}"`; quoted++; }
      else {
        // angka biasa / desimal / berpangkat: salin utuh sampai akhir token angka
        let k = j;
        while (k < n && /[0-9.eE+\-]/.test(text[k])) k++;
        out += isInteger ? token : text.slice(i, k);
        j = isInteger ? j : k;
      }
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, quoted };
}

const decodeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : undefined;
};

type SheetCells = Record<string, { t?: string; v?: unknown; w?: string } | undefined>;
export type MinimalWorkbook = { SheetNames: string[]; Sheets: Record<string, unknown> };
export type XlsxRecovery = { longNumbers: number; inlineStrings: number };

const decodeNumeric = (s: string) => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
const cellTextFromInline = (inner: string): string => {
  const is = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)?.[1];
  if (is === undefined) return "";
  const noPhonetic = is.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of noPhonetic.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += m[1];
  return decodeXml(decodeNumeric(out));
};

/**
 * Excel (.xlsx): pembaca SheetJS punya dua kelemahan yang merusak nomor struk, dan keduanya dipulihkan di sini langsung dari XML lembar kerja:
 *  1. Sel ANGKA bulat ≥ 16 digit dibaca sebagai Number sehingga digit ke-16 dst. hilang → diganti sel TEKS berisi digit lengkap.
 *  2. Sel teks sebaris (t="inlineStr") yang ditulis dengan bentuk tag tak lazim (mis. <is xmlns="…"> dari beberapa eksportir) dapat terbaca KOSONG
 *     → seluruh nomor struk satu file hilang. Sel yang kosong/tidak terbaca diisi dari teks XML aslinya.
 * Sel yang sudah terbaca dengan benar tidak diubah (selain angka panjang). Mengembalikan jumlah sel yang dipulihkan per jenis.
 */
export async function recoverCellsFromXlsx(buffer: ArrayBuffer, workbook: MinimalWorkbook): Promise<XlsxRecovery> {
  const result: XlsxRecovery = { longNumbers: 0, inlineStrings: 0 };
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(buffer); } catch { return result; }
  const wbXml = await zip.file("xl/workbook.xml")?.async("string");
  const relXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!wbXml || !relXml) return result;

  const targets = new Map<string, string>(); // rId → path
  for (const m of relXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id"), target = attr(m[0], "Target");
    if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
  }
  const hasLong = new RegExp(`<v>\\s*-?\\d{${LONG_INT_DIGITS},}\\s*</v>`);
  for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], "name"), rid = attr(m[0], "r:id") ?? attr(m[0], "id");
    const path = rid ? targets.get(rid) : undefined;
    const ws = name ? (workbook.Sheets[name] as SheetCells | undefined) : undefined;
    if (!name || !path || !ws) continue;
    const xml = await zip.file(path)?.async("string");
    if (!xml || !(hasLong.test(xml) || /t="inlineStr"/.test(xml))) continue; // cepat: tidak ada yang perlu dipulihkan
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const addr = attr(c[1], "r");
      if (!addr || !c[2]) continue;
      const t = attr(c[1], "t");
      const cell = ws[addr];
      if (t === "inlineStr") {
        const text = cellTextFromInline(c[2]);
        const read = cell && cell.v !== undefined && cell.v !== null ? String(cell.v) : "";
        if (text !== "" && read === "") { ws[addr] = { ...(cell ?? {}), t: "s", v: text, w: text }; result.inlineStrings++; }
        continue;
      }
      if (t && t !== "n") continue; // hanya sel numerik
      const v = /<v>\s*([^<]*?)\s*<\/v>/.exec(c[2])?.[1];
      if (!v || !LONG_INT.test(v) || !cell) continue;
      ws[addr] = { ...cell, t: "s", v, w: v };
      result.longNumbers++;
    }
  }
  return result;
}

/** Sel numerik bulat yang melewati batas presisi dan TIDAK dapat dipulihkan (mis. file .xls atau Excel yang menyimpan 15 digit): digit sebenarnya sudah hilang di file. */
export function countUnsafeIntegerCells(ws: unknown): number {
  let n = 0;
  const cells = ws as Record<string, { t?: string; v?: unknown } | undefined>;
  for (const addr of Object.keys(cells)) {
    if (addr.charCodeAt(0) === 33) continue;
    const c = cells[addr];
    if (c && c.t === "n" && typeof c.v === "number" && Number.isInteger(c.v) && Math.abs(c.v) > Number.MAX_SAFE_INTEGER) n++;
  }
  return n;
}
