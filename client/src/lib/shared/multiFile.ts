// Util kecil untuk pemilihan banyak file pada mode CEK UPL yang memproses satu file per sumber (JAMBULUWUK, INNA TRETES, OMAH PADHANG).
// Tidak dipakai oleh KLAND, POINTCOFFE, dan THE OMALA (mekanisme multi-file mereka sendiri tetap dipertahankan).

/** Sidik jari isi file (SHA-256). null bila crypto.subtle tidak tersedia; pemanggil lalu hanya memakai nama file. */
export async function fingerprintBuffer(buffer: ArrayBuffer): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const digest = new Uint8Array(await subtle.digest("SHA-256", buffer));
    return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

export type DuplicateProbe = { id: number; name: string; fingerprint: string | null; usable: boolean };

/**
 * File baru dianggap duplikat bila nama sama (tanpa membedakan huruf besar/kecil) atau isinya identik dengan file
 * yang SUDAH dipakai (usable). File lama yang gagal dibaca tidak menghalangi file pengganti dengan nama sama.
 */
export function findDuplicate(existing: readonly DuplicateProbe[], name: string, fingerprint: string | null): DuplicateProbe | null {
  const lower = name.toLowerCase();
  return existing.find((e) => e.usable && (e.name.toLowerCase() === lower || (fingerprint !== null && e.fingerprint === fingerprint))) ?? null;
}

export const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
