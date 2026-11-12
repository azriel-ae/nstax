import { useEffect, useRef, useState } from "react";
import {
  AutoAnalyzer,
  yieldToPaint,
  type AnalyzeContext,
  type AutoPhase,
  type FileHandle,
} from "./autoAnalyze";

type Options = {
  /** Isi area teks saat ini. Setiap perubahan dijadwalkan untuk analisis otomatis (debounce). */
  text: string;
  /** Fungsi analisis milik halaman. Dipakai oleh jalur otomatis, upload file, dan tombol Analisis manual. */
  run: (text: string, source: string | undefined, ctx: AnalyzeContext) => void | Promise<void>;
  /** Input dikosongkan: bersihkan hasil lama (analisis tidak dijalankan). */
  onEmpty?: () => void;
  onError?: (error: unknown) => void;
  delayMs?: number;
};

export function useAutoAnalyze({ text, run, onEmpty, onError, delayMs }: Options) {
  const [phase, setPhase] = useState<AutoPhase>("idle");
  const latest = useRef({ text, run, onEmpty, onError });
  latest.current = { text, run, onEmpty, onError };

  const ref = useRef<AutoAnalyzer | null>(null);
  if (!ref.current) {
    ref.current = new AutoAnalyzer({
      run: (value, source, ctx) => latest.current.run(value, source, ctx),
      onEmpty: () => latest.current.onEmpty?.(),
      onError: (error) => latest.current.onError?.(error),
      onPhase: setPhase,
      beforeRun: yieldToPaint,
      delayMs,
    });
  }
  const analyzer = ref.current;

  useEffect(() => {
    analyzer.setActive(true);
    return () => analyzer.setActive(false);
  }, [analyzer]);

  useEffect(() => {
    analyzer.schedule(text);
  }, [analyzer, text]);

  /**
   * Satu pintu analisis. Tanpa argumen = memakai isi area teks saat ini (tombol Analisis).
   * Argumen `value` hanya dipakai bila bertipe string (aman dipakai langsung sebagai onClick).
   */
  const analyze = (value?: unknown, source?: string): Promise<void> =>
    analyzer.analyze(typeof value === "string" ? value : latest.current.text, source);

  const beginFile = (): FileHandle => analyzer.beginFile();

  return { phase, analyze, beginFile };
}
