import { describe, expect, it } from "vitest";
import { AutoAnalyzer, type AnalyzeContext, type AutoPhase } from "./autoAnalyze";
import { parseForeJson } from "../parsers/foreParser";
import { parseManyar } from "../parsers/manyarParser";

// Jam palsu: debounce diuji tanpa menunggu waktu sungguhan dan tanpa bergantung pada fake timer framework.
function makeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (handle: unknown) => void timers.delete(handle as number),
    pending: () => timers.size,
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const DELAY = 600;

function setup(run?: (text: string, source: string | undefined, ctx: AnalyzeContext) => void | Promise<void>) {
  const clock = makeClock();
  const calls: Array<{ text: string; source?: string }> = [];
  const phases: AutoPhase[] = [];
  let emptied = 0;
  const errors: unknown[] = [];
  const analyzer = new AutoAnalyzer({
    run: async (text, source, ctx) => {
      calls.push({ text, source });
      await run?.(text, source, ctx);
    },
    delayMs: DELAY,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onPhase: (p) => phases.push(p),
    onEmpty: () => void emptied++,
    onError: (e) => void errors.push(e),
  });
  return { analyzer, clock, calls, phases, errors, emptied: () => emptied };
}

describe("analisis otomatis dari teks", () => {
  it("1. menempelkan teks baru menjalankan analisis otomatis setelah jeda (tanpa tombol)", async () => {
    const { analyzer, clock, calls } = setup();
    analyzer.schedule('[{"a":1}]');
    expect(calls).toHaveLength(0);
    await clock.advance(DELAY - 1);
    expect(calls).toHaveLength(0);
    await clock.advance(1);
    expect(calls).toEqual([{ text: '[{"a":1}]', source: undefined }]);
    expect(analyzer.phase).toBe("done");
  });

  it("debounce: banyak perubahan cepat hanya memproses teks terakhir satu kali", async () => {
    const { analyzer, clock, calls } = setup();
    for (const text of ["[", "[{", '[{"a"', '[{"a":1}', '[{"a":1}]']) {
      analyzer.schedule(text);
      await clock.advance(100);
    }
    expect(calls).toHaveLength(0);
    await clock.advance(DELAY);
    expect(calls.map((c) => c.text)).toEqual(['[{"a":1}]']);
  });

  it("2. mengubah teks memperbarui hasil; selama menunggu, status bukan 'selesai' (hasil lama tidak tampak sebagai terbaru)", async () => {
    const { analyzer, clock, calls } = setup();
    analyzer.schedule("A");
    await clock.advance(DELAY);
    expect(analyzer.phase).toBe("done");
    analyzer.schedule("B");
    expect(analyzer.phase).toBe("waiting");
    await clock.advance(DELAY);
    expect(calls.map((c) => c.text)).toEqual(["A", "B"]);
    expect(analyzer.phase).toBe("done");
  });

  it("mengembalikan teks ke versi yang sudah dianalisis tidak memicu analisis ulang", async () => {
    const { analyzer, clock, calls } = setup();
    analyzer.schedule("A");
    await clock.advance(DELAY);
    analyzer.schedule("AB");
    expect(analyzer.phase).toBe("waiting");
    analyzer.schedule("A");
    expect(analyzer.phase).toBe("done");
    await clock.advance(DELAY * 2);
    expect(calls).toHaveLength(1);
  });
});

describe("analisis otomatis dari file", () => {
  it("3. upload file langsung dianalisis dan perubahan teks dari upload tidak memicu analisis ganda", async () => {
    const { analyzer, clock, calls } = setup();
    const handle = analyzer.beginFile();
    expect(handle.isLatest()).toBe(true);
    // Halaman memanggil setText(isiFile) lalu analyze(isiFile, nama) pada tick yang sama.
    const done = analyzer.analyze("FILE-1", "a.json");
    analyzer.schedule("FILE-1"); // efek React setelah setText
    await done;
    await clock.advance(DELAY * 3);
    expect(calls).toEqual([{ text: "FILE-1", source: "a.json" }]);
    expect(analyzer.phase).toBe("done");
  });

  it("4. mengganti file memproses file terbaru; membaca file yang lambat tidak menimpa file yang lebih baru", async () => {
    const { analyzer, calls } = setup();
    const first = analyzer.beginFile(); // file 1 mulai dibaca (lambat)
    const second = analyzer.beginFile(); // file 2 dipilih sebelum file 1 selesai
    expect(first.isLatest()).toBe(false);
    expect(second.isLatest()).toBe(true);
    if (second.isLatest()) await analyzer.analyze("FILE-2", "b.json");
    // file 1 selesai terbaca belakangan: halaman memeriksa isLatest() lalu membuang hasilnya
    if (first.isLatest()) await analyzer.analyze("FILE-1", "a.json");
    expect(calls).toEqual([{ text: "FILE-2", source: "b.json" }]);
  });

  it("mengetik saat file masih dibaca membuang hasil pembacaan file itu", async () => {
    const { analyzer, clock, calls } = setup();
    const handle = analyzer.beginFile();
    analyzer.schedule("ketikan baru");
    expect(handle.isLatest()).toBe(false);
    await clock.advance(DELAY);
    expect(calls.map((c) => c.text)).toEqual(["ketikan baru"]);
  });

  it("8b. file gagal dibaca: status 'error' dan input tidak disentuh", async () => {
    const { analyzer, calls } = setup();
    const handle = analyzer.beginFile();
    handle.fail();
    expect(analyzer.phase).toBe("error");
    expect(calls).toHaveLength(0);
  });
});

describe("tombol Analisis manual", () => {
  it("5. tetap menjalankan analisis, walau teks yang sama sudah dianalisis otomatis", async () => {
    const { analyzer, clock, calls } = setup();
    analyzer.schedule("A");
    await clock.advance(DELAY);
    await analyzer.analyze("A");
    expect(calls).toHaveLength(2);
  });

  it("menekan Analisis saat debounce tertunda membatalkan timer (tidak ada analisis ganda)", async () => {
    const { analyzer, clock, calls } = setup();
    analyzer.schedule("A");
    expect(clock.pending()).toBe(1);
    await analyzer.analyze("A");
    expect(clock.pending()).toBe(0);
    await clock.advance(DELAY * 3);
    expect(calls).toHaveLength(1);
  });

  it("6. otomatis dan manual memberi hasil identik (parser FORE yang sama)", async () => {
    const fore = { tgl: "2026-08-01T03:42:04.000Z", counter_id: 480, counter_name: "X", billing_id: "260824800017", total: 29000, pajak: 2636 };
    const input = JSON.stringify([fore, { ...fore, billing_id: "260814800012", total: 49600, pajak: 4509 }]);
    let autoResult: unknown;
    const auto = setup((text) => void (autoResult = parseForeJson(text)));
    auto.analyzer.schedule(input);
    await auto.clock.advance(DELAY);
    let manualResult: unknown;
    const manual = setup((text) => void (manualResult = parseForeJson(text)));
    await manual.analyzer.analyze(input);
    expect(autoResult).toEqual(manualResult);
    expect((autoResult as { validTransactions: unknown[] }).validTransactions).toHaveLength(2);
  });

  it("6b. otomatis dan manual memberi hasil identik (parser MANYAR dengan ribuan baris)", async () => {
    const records = Array.from({ length: 3000 }, (_, i) => ({
      Date: "2026-08-02",
      Product: i % 2 ? "MANYAR RESTO" : "MANYAR HOTEL",
      NoBill: `${i % 2 ? "SL" : "FL"}-26${String(i).padStart(7, "0")}`,
      Gross: "114000.00",
      Service: "9421.46",
      Tax: "10363.69",
      Nett: "94214.85",
    }));
    const input = JSON.stringify(records);
    let a: unknown;
    let m: unknown;
    const auto = setup((text) => void (a = parseManyar(text)));
    auto.analyzer.schedule(input);
    await auto.clock.advance(DELAY);
    const manual = setup((text) => void (m = parseManyar(text)));
    await manual.analyzer.analyze(input);
    expect(a).toEqual(m);
  });
});

describe("input kosong dan error", () => {
  it("7. input kosong/spasi tidak menjalankan analisis dan tidak error", async () => {
    const { analyzer, clock, calls, emptied } = setup();
    expect(() => analyzer.schedule("")).not.toThrow();
    analyzer.schedule("   \n ");
    await clock.advance(DELAY * 2);
    expect(calls).toHaveLength(0);
    expect(emptied()).toBe(0); // belum ada hasil yang perlu dibersihkan
    expect(analyzer.phase).toBe("idle");
  });

  it("mengosongkan teks setelah ada hasil membersihkan hasil lama dan membatalkan analisis tertunda", async () => {
    const { analyzer, clock, calls, emptied } = setup();
    analyzer.schedule("A");
    await clock.advance(DELAY);
    analyzer.schedule("AB"); // menunggu
    analyzer.schedule(""); // dikosongkan sebelum sempat jalan
    await clock.advance(DELAY * 2);
    expect(calls.map((c) => c.text)).toEqual(["A"]);
    expect(emptied()).toBe(1);
    expect(analyzer.phase).toBe("idle");
  });

  it("8. input tidak valid: parser melaporkan error lewat hasilnya, analisis tidak melempar", async () => {
    let shown: { ok: boolean; error?: string } | null = null;
    const { analyzer, clock, errors } = setup((text) => void (shown = parseForeJson(text) as { ok: boolean; error?: string }));
    analyzer.schedule("{ bukan json");
    await clock.advance(DELAY);
    expect(shown!.ok).toBe(false);
    expect(typeof shown!.error).toBe("string");
    expect(errors).toHaveLength(0);
    expect(analyzer.phase).toBe("done");
  });

  it("error tak terduga: status 'error', onError dipanggil, dan teks yang sama boleh dicoba lagi", async () => {
    let fail = true;
    const { analyzer, clock, calls, errors } = setup(() => {
      if (fail) throw new Error("boom");
    });
    analyzer.schedule("A");
    await clock.advance(DELAY);
    expect(analyzer.phase).toBe("error");
    expect(errors).toHaveLength(1);
    fail = false;
    analyzer.schedule("A"); // tidak dianggap sudah sukses dianalisis
    await clock.advance(DELAY);
    expect(calls).toHaveLength(2);
    expect(analyzer.phase).toBe("done");
  });
});

describe("sinkronisasi dan perubahan input cepat", () => {
  it("9. hasil analisis lama (async) tidak menimpa hasil terbaru", async () => {
    const gates: Record<string, () => void> = {};
    let shown = "";
    const { analyzer, clock } = setup(
      (text, _s, ctx) =>
        new Promise<void>((resolve) => {
          gates[text] = () => {
            if (ctx.isCurrent()) shown = text; // sama seperti halaman: hanya yang terbaru boleh tampil
            resolve();
          };
        }),
    );
    analyzer.schedule("A");
    await clock.advance(DELAY); // A mulai dan tertahan
    analyzer.schedule("B");
    await clock.advance(DELAY); // B mulai
    gates["B"]();
    await flush();
    gates["A"](); // A selesai paling akhir
    await flush();
    expect(shown).toBe("B");
    expect(analyzer.phase).toBe("done");
  });

  it("10. manual yang masih berjalan lalu diganti ketikan baru: hanya hasil terbaru yang tampil, tanpa analisis ganda", async () => {
    let shown = "";
    const gates: Record<string, () => void> = {};
    const { analyzer, clock, calls } = setup(
      (text, _s, ctx) =>
        new Promise<void>((resolve) => {
          gates[text] = () => {
            if (ctx.isCurrent()) shown = text;
            resolve();
          };
        }),
    );
    void analyzer.analyze("A");
    await flush();
    analyzer.schedule("B");
    await clock.advance(DELAY);
    gates["B"]();
    await flush();
    gates["A"]();
    await flush();
    expect(shown).toBe("B");
    expect(calls.map((c) => c.text)).toEqual(["A", "B"]);
  });

  it("tidak ada analisis saat komponen sudah tidak aktif (unmount)", async () => {
    const { analyzer, clock, calls } = setup();
    analyzer.schedule("A");
    analyzer.setActive(false);
    await clock.advance(DELAY * 2);
    expect(calls).toHaveLength(0);
    analyzer.setActive(true);
    analyzer.schedule("A");
    await clock.advance(DELAY);
    expect(calls).toHaveLength(1);
  });

  it("status berurutan: waiting -> running -> done", async () => {
    const { analyzer, clock, phases } = setup();
    analyzer.schedule("A");
    await clock.advance(DELAY);
    expect(phases).toEqual(["waiting", "running", "done"]);
  });
});
