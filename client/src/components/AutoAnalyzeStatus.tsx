import { Loader2, Zap, Check, AlertTriangle } from "lucide-react";
import type { AutoPhase } from "@/lib/shared/autoAnalyze";

const COPY: Record<AutoPhase, string> = {
  idle: "Otomatis: data dianalisis setelah ditempel atau diunggah. Tombol Analisis untuk pemeriksaan manual.",
  waiting: "Input berubah — hasil di bawah masih dari data sebelumnya, segera dianalisis…",
  running: "Menganalisis data…",
  done: "Selesai dianalisis. Ubah input atau tekan Analisis untuk memperbarui.",
  error: "Analisis tidak selesai. Input Anda tidak diubah; periksa pesan di bawah.",
};

/** Satu baris status kecil untuk analisis otomatis; tidak mengubah tata letak halaman. */
export default function AutoAnalyzeStatus({ phase }: { phase: AutoPhase }) {
  const Icon = phase === "running" || phase === "waiting" ? Loader2 : phase === "done" ? Check : phase === "error" ? AlertTriangle : Zap;
  return (
    <div className={`auto-status is-${phase}`} role="status" aria-live="polite">
      <Icon size={13} className={phase === "running" || phase === "waiting" ? "auto-status-spin" : undefined} />
      <span>{COPY[phase]}</span>
    </div>
  );
}
