import type { QueryResult } from "./jambuluwukSql";

// Status eksekusi query CEK UPL · JAMBULUWUK. Visibilitas hasil TIDAK ditentukan oleh "array kosong atau tidak",
// melainkan oleh status eksekusi + identitas input (profil, teks query, versi file) yang menghasilkan hasil itu.

export type Failure = { message: string; pos: number | null; length: number; row: number | null; sql: string };
export type RunInputs = { profile: string; sql: string; sourceVersion: number | null };

export type RunPhase =
  | { kind: "idle" }
  | { kind: "running"; runId: number; inputs: RunInputs }
  | { kind: "success"; runId: number; inputs: RunInputs; result: QueryResult; fileName: string }
  | { kind: "error"; runId: number; inputs: RunInputs; failure: Failure };

export type StaleReason = "file" | "profil" | "query";

export type ResultView =
  | { kind: "none" } // belum pernah dijalankan / direset: sembunyikan semua komponen hasil
  | { kind: "running" }
  | { kind: "stale"; reason: StaleReason; previousProfile: string } // hasil lama kedaluwarsa: disembunyikan
  | { kind: "error"; failure: Failure }
  | { kind: "empty"; result: QueryResult; fileName: string } // query berhasil, 0 baris
  | { kind: "ready"; result: QueryResult; fileName: string }; // ringkasan + tabel boleh tampil

export const IDLE: RunPhase = { kind: "idle" };

const staleReason = (prev: RunInputs, cur: RunInputs): StaleReason | null => {
  if (prev.sourceVersion !== cur.sourceVersion) return "file";
  if (prev.profile !== cur.profile) return "profil";
  if (prev.sql !== cur.sql) return "query";
  return null;
};

/** Menentukan apa yang boleh ditampilkan untuk input saat ini. Hasil lama tidak pernah tampil sebagai hasil terbaru. */
export function deriveView(phase: RunPhase, current: RunInputs): ResultView {
  switch (phase.kind) {
    case "idle":
      return { kind: "none" };
    case "running":
      return phase.inputs.profile === current.profile && phase.inputs.sourceVersion === current.sourceVersion ? { kind: "running" } : { kind: "none" };
    case "error": {
      // pesan error tetap terlihat selama profil/file sama agar pengguna bisa memperbaiki query tanpa kehilangan konteks
      const r = staleReason(phase.inputs, current);
      return r === "file" || r === "profil" ? { kind: "none" } : { kind: "error", failure: phase.failure };
    }
    case "success": {
      const r = staleReason(phase.inputs, current);
      if (r) return { kind: "stale", reason: r, previousProfile: phase.inputs.profile };
      return phase.result.rows.length === 0
        ? { kind: "empty", result: phase.result, fileName: phase.fileName }
        : { kind: "ready", result: phase.result, fileName: phase.fileName };
    }
  }
}

/** Transisi: mulai eksekusi. Hasil sebelumnya langsung dibuang (tidak dicampur dengan hasil baru). */
export const startRun = (runId: number, inputs: RunInputs): RunPhase => ({ kind: "running", runId, inputs });

/** Transisi: eksekusi selesai. Diabaikan bila bukan eksekusi terbaru (mis. file diganti / hasil direset saat berjalan). */
export function finishRun(phase: RunPhase, runId: number, next: Exclude<RunPhase, { kind: "idle" | "running" }>): RunPhase {
  return phase.kind === "running" && phase.runId === runId ? next : phase;
}
