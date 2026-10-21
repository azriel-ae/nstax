// NSTAX V2 — auto-detect perusahaan untuk BACA DATA APITRANS.
// Modul MURNI: tidak menghitung apa pun. Hanya menentukan perusahaan dari IDENTITAS yang ada
// di JSON (id_agent, nama_usaha); parser milik perusahaan itu yang kemudian menghitung.
//
// Keempat perusahaan memakai struktur JSON yang sama ({status,count,data[]} dengan no_struk, dpp,
// tax, total, ...), jadi struktur TIDAK dipakai untuk membedakan. Hanya identitas.
//
// Identitas terverifikasi dari sampel data:
//   NASGOR69      id_agent "nasgor69"    nama_usaha "Nasgor69"          (sampel asli dari pemilik data)
//   POINTCOFFE HM id_agent "point_pas"   nama_usaha "Point Coffee"      (sampel di pointcoffeHmParser.test.ts)
//   HANGRY SDA    id_agent "hangry_sda"  nama_usaha "Hangry Sidoarjo"   (sampel asli dari pemilik data)
//   FAMILY MART   id_agent "familymart_sda" nama_usaha "Family Mart Sidoarjo" (sampel asli dari pemilik data)

import { normalizeIdentity } from "../../lib/parsers/hangrySdaParser";

export type ApiTransKind = "nasgor69" | "pointcoffeHm" | "familyMart" | "hangrySda";

export const API_TRANS_LABELS: Record<ApiTransKind, string> = {
  nasgor69: "NASGOR69",
  pointcoffeHm: "POINTCOFFE HM",
  familyMart: "FAMILY MART",
  hangrySda: "HANGRY SDA",
};

// Pencocokan PERSIS (setelah trim, huruf kecil, spasi berulang jadi satu). Bukan "mengandung".
const AGENT_IDS: Record<string, ApiTransKind> = {
  nasgor69: "nasgor69",
  point_pas: "pointcoffeHm",
  hangry_sda: "hangrySda",
  familymart_sda: "familyMart",
};
const USAHA_NAMES: Record<string, ApiTransKind> = {
  nasgor69: "nasgor69",
  "point coffee": "pointcoffeHm",
  "hangry sidoarjo": "hangrySda",
  "family mart sidoarjo": "familyMart",
};

export type ApiTransDetection =
  | { ok: true; kind: ApiTransKind; label: string; recordCount: number; evidence: string[] }
  | { ok: false; reason: string };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const present = (v: unknown) => typeof v === "string" ? v.trim() !== "" : v !== null && v !== undefined;
const show = (v: unknown) => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "-" : String(v));

const fail = (reason: string): ApiTransDetection => ({ ok: false, reason });

function kindFromAgent(value: unknown): ApiTransKind | null {
  const key = normalizeIdentity(value);
  return Object.prototype.hasOwnProperty.call(AGENT_IDS, key) ? AGENT_IDS[key] : null;
}
function kindFromUsaha(value: unknown): ApiTransKind | null {
  const key = normalizeIdentity(value);
  return Object.prototype.hasOwnProperty.call(USAHA_NAMES, key) ? USAHA_NAMES[key] : null;
}

export function detectApiTrans(text: string): ApiTransDetection {
  if (!text.trim()) return fail("Input kosong. Tempel JSON atau pilih file .json terlebih dahulu.");

  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    return fail(`JSON tidak valid: ${error instanceof Error ? error.message : String(error)}. Periksa kembali isi file.`);
  }

  // Struktur dasar: array langsung, atau object { status, count, data: [...] }.
  let items: unknown[];
  if (Array.isArray(root)) items = root;
  else if (isRec(root) && Array.isArray(root.data)) {
    // status diperiksa sebelum data diproses.
    if (typeof root.status === "string" && root.status.trim().toLowerCase() !== "ok") {
      return fail(`Status respons API bukan "ok" (status: "${root.status}"). Periksa kembali respons API.`);
    }
    items = root.data;
  } else return fail("Struktur JSON tidak dikenali. Dibutuhkan array transaksi atau object dengan properti data berupa array.");

  if (items.length === 0) return fail("Data kosong. Tidak ada transaksi yang bisa dibaca.");

  const counts = new Map<ApiTransKind, number>();
  const seenValues = new Map<ApiTransKind, Set<string>>();
  const unidentified: number[] = [];

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!isRec(item)) return fail(`Elemen data ke-${i + 1} bukan object transaksi. Setiap elemen harus berupa object.`);
    const byAgent = kindFromAgent(item.id_agent);
    const byUsaha = kindFromUsaha(item.nama_usaha);
    if (byAgent && byUsaha && byAgent !== byUsaha) {
      return fail(`Identitas format tidak konsisten pada transaksi ke-${i + 1}: id_agent "${show(item.id_agent)}" milik ${API_TRANS_LABELS[byAgent]}, tetapi nama_usaha "${show(item.nama_usaha)}" milik ${API_TRANS_LABELS[byUsaha]}. Proses dihentikan.`);
    }
    const kind = byAgent ?? byUsaha;
    if (!kind) {
      unidentified.push(i + 1);
      continue;
    }
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    const set = seenValues.get(kind) ?? new Set<string>();
    if (present(item.id_agent)) set.add(`id_agent=${show(item.id_agent)}`);
    if (present(item.nama_usaha)) set.add(`nama_usaha=${show(item.nama_usaha)}`);
    seenValues.set(kind, set);
  }

  if (counts.size > 1) {
    const detail = Array.from(counts.entries()).map(([k, c]) => `${API_TRANS_LABELS[k]} ${c.toLocaleString("id-ID")}`).join(", ");
    return fail(`Identitas format tidak konsisten: file memuat transaksi dari lebih dari satu perusahaan (${detail}). Pisahkan file per perusahaan, lalu coba lagi.`);
  }
  if (counts.size === 0) {
    return fail("Format tidak dikenali: id_agent/nama_usaha tidak cocok dengan NASGOR69, POINTCOFFE HM, FAMILY MART, maupun HANGRY SDA, atau field identitas tidak ada. Masukkan JSON yang benar.");
  }
  if (unidentified.length > 0) {
    const sample = unidentified.slice(0, 5).join(", ");
    return fail(`Identitas tidak cukup kuat: ${unidentified.length.toLocaleString("id-ID")} dari ${items.length.toLocaleString("id-ID")} transaksi tidak punya id_agent/nama_usaha yang dikenali (transaksi ke-${sample}${unidentified.length > 5 ? ", ..." : ""}). Parser tidak dipilih agar tidak ada transaksi yang salah proses.`);
  }

  const [kind] = Array.from(counts.keys());
  return {
    ok: true,
    kind,
    label: API_TRANS_LABELS[kind],
    recordCount: items.length,
    evidence: [...(seenValues.get(kind) ?? [])].sort().concat(`${items.length.toLocaleString("id-ID")} dari ${items.length.toLocaleString("id-ID")} transaksi beridentitas sama`),
  };
}
