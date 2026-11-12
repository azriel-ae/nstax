// Pengendali analisis otomatis + manual untuk halaman CEK TRANSAKSI API.
//
// Satu-satunya jalur analisis: `AutoAnalyzer.analyze()` -> `run()` (fungsi analisis milik halaman).
// Teks yang ditempel (schedule, dengan debounce), upload file, dan tombol Analisis manual
// semuanya berakhir di `run()` yang sama, sehingga hasilnya identik.
//
// Tidak ada logika parsing/perhitungan di sini; file ini hanya mengatur KAPAN analisis dijalankan.

export type AutoPhase = "idle" | "waiting" | "running" | "done" | "error";

export type AnalyzeContext = {
  /** Nomor permintaan analisis ini. */
  token: number;
  /** false bila sudah ada input/analisis yang lebih baru; hasil permintaan ini tidak boleh ditampilkan. */
  isCurrent: () => boolean;
};

export type FileHandle = {
  /** true selama belum ada input/file/analisis yang lebih baru. */
  isLatest: () => boolean;
  /** Tandai pembacaan file gagal (hanya berpengaruh bila masih yang terbaru). */
  fail: () => void;
};

export type AutoAnalyzerOptions = {
  run: (text: string, source: string | undefined, ctx: AnalyzeContext) => void | Promise<void>;
  delayMs?: number;
  onPhase?: (phase: AutoPhase) => void;
  /** Dipanggil saat input dikosongkan setelah sebelumnya ada hasil/proses. Analisis TIDAK dijalankan. */
  onEmpty?: () => void;
  /** Dipanggil bila run() melempar error tak terduga. Teks input pengguna tidak disentuh. */
  onError?: (error: unknown) => void;
  isEmpty?: (text: string) => boolean;
  /** Memberi kesempatan indikator "Menganalisis..." tampil sebelum parsing berat. */
  beforeRun?: () => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export const DEFAULT_AUTO_DELAY_MS = 600;

export const yieldToPaint = () =>
  new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        resolve();
      }
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(finish, 0));
    // Tab di latar belakang tidak memanggil rAF; jangan sampai analisis tertahan.
    setTimeout(finish, 80);
  });

export class AutoAnalyzer {
  private opts: AutoAnalyzerOptions;
  private token = 0;
  private timer: unknown = null;
  private inFlight: string | null = null;
  private lastAnalyzed: string | null = null;
  private active = true;
  private current: AutoPhase = "idle";

  constructor(opts: AutoAnalyzerOptions) {
    this.opts = opts;
  }

  setOptions(opts: Partial<AutoAnalyzerOptions>) {
    this.opts = { ...this.opts, ...opts };
  }

  get phase(): AutoPhase {
    return this.current;
  }

  /** Aktif/nonaktifkan (mis. saat komponen unmount). Nonaktif membatalkan timer dan menolak hasil yang sedang berjalan. */
  setActive(active: boolean) {
    this.active = active;
    if (!active) {
      this.cancelTimer();
      this.token++;
      this.inFlight = null;
    }
  }

  /** Dipanggil setiap isi area teks berubah. Menjalankan analisis otomatis setelah jeda (debounce). */
  schedule(text: string) {
    if (!this.active) return;
    this.cancelTimer();
    const isEmpty = this.opts.isEmpty ?? ((value: string) => value.trim() === "");

    if (isEmpty(text)) {
      this.token++; // batalkan analisis yang sedang berjalan
      const hadState = this.current !== "idle" || this.lastAnalyzed !== null;
      this.inFlight = null;
      this.lastAnalyzed = null;
      this.setPhase("idle");
      if (hadState) this.opts.onEmpty?.();
      return;
    }

    // Input yang sama persis dengan yang sedang/telah dianalisis (mis. teks dari upload file): jangan analisis ganda.
    if (text === this.inFlight || (this.inFlight === null && text === this.lastAnalyzed)) {
      if (this.current === "waiting") this.setPhase(this.inFlight === null ? "done" : "running");
      return;
    }

    this.token++; // hasil analisis lama tidak boleh menimpa input terbaru
    this.inFlight = null;
    this.setPhase("waiting");
    const setTimer = this.opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    this.timer = setTimer(() => {
      this.timer = null;
      void this.execute(text, undefined);
    }, this.opts.delayMs ?? DEFAULT_AUTO_DELAY_MS);
  }

  /** Jalur manual (tombol Analisis) dan jalur file: langsung jalan, membatalkan debounce yang tertunda. */
  analyze(text: string, source?: string): Promise<void> {
    this.cancelTimer();
    return this.execute(text, source);
  }

  /** Dipanggil sebelum membaca file (async). Input/file yang lebih baru membuat hasil pembacaan ini dibuang. */
  beginFile(): FileHandle {
    this.cancelTimer();
    const token = ++this.token;
    this.inFlight = null;
    this.setPhase("running");
    return {
      isLatest: () => this.active && token === this.token,
      fail: () => {
        if (this.active && token === this.token) this.setPhase("error");
      },
    };
  }

  private async execute(text: string, source: string | undefined): Promise<void> {
    if (!this.active) return;
    const token = ++this.token;
    this.inFlight = text;
    this.setPhase("running");
    const isCurrent = () => this.active && token === this.token;
    try {
      await this.opts.beforeRun?.();
      if (!isCurrent()) return;
      await this.opts.run(text, source, { token, isCurrent });
      if (!isCurrent()) return;
      this.inFlight = null;
      this.lastAnalyzed = text;
      this.setPhase("done");
    } catch (error) {
      if (!isCurrent()) return;
      this.inFlight = null;
      this.lastAnalyzed = null;
      this.setPhase("error");
      this.opts.onError?.(error);
    }
  }

  private cancelTimer() {
    if (this.timer !== null) {
      (this.opts.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.timer);
      this.timer = null;
    }
  }

  private setPhase(phase: AutoPhase) {
    if (this.current === phase) return;
    this.current = phase;
    this.opts.onPhase?.(phase);
  }
}
