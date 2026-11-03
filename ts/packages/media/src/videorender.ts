import { type Mpv, Native } from "./libmpv.ts";
// Its source, not its path: a compiled executable or a bundle has no videoworker.ts beside it.
import * as workerText from "./videoworker.ts" with { type: "text" };

/** RGBA, straight alpha, `width` x `height`: what a Slint image takes. Valid until the next frame. */
export interface Frame {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface RenderStats {
  frames: number;
  avg: number;
  max: number;
}

/** Two: one being drawn while the window copies the other. */
export const BUFFERS = 2;
const START_MS = 5000;
const QUIT_MS = 3000;

type Out = { t: "ready" } | { t: "failed"; why: string } | { t: "using"; gen: number } | { t: "frame"; gen: number; i: number } | ({ t: "freed" } & RenderStats);

interface Gen {
  width: number;
  height: number;
  bufs: Native[];
  views: Uint8ClampedArray[];
}

/** The worker didn't answer: it may still be inside libmpv. */
export class RenderStartTimeout extends Error {}

let source: string | null = null;

function workerUrl(): string {
  source ??= URL.createObjectURL(new Blob([(workerText as unknown as { default: string }).default], { type: "application/typescript" }));
  return source;
}

/**
 * libmpv's software renderer on a thread of its own (videoworker.ts): the window's thread only gets finished frames,
 * at the size `resize` asks for. The buffers are allocated here once per size and given back by the worker before
 * they are freed, so no frame allocates anything.
 */
export class RenderWorker {
  private readonly gens = new Map<number, Gen>();
  private gen = -1;
  private quitting: ((s: RenderStats | null) => void) | null = null;
  private dead = false;

  private constructor(
    private readonly worker: Worker,
    private readonly onFrame: (f: Frame) => void,
  ) {}

  /** The render context, made on the worker's thread for `mpv`'s core; rejects when mpv can't draw. */
  static start(libPath: string, mpv: Mpv, onFrame: (f: Frame) => void): Promise<RenderWorker> {
    return new Promise((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(workerUrl());
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      worker.unref();
      const r = new RenderWorker(worker, onFrame);
      const timer = setTimeout(() => fail(new RenderStartTimeout(`no answer in ${START_MS} ms`)), START_MS);
      const fail = (e: Error) => {
        clearTimeout(timer);
        worker.terminate();
        reject(e);
      };
      worker.onerror = (e) => fail(new Error(e.message));
      worker.onmessage = (e: MessageEvent<Out>) => {
        const m = e.data;
        if (m.t === "ready") {
          clearTimeout(timer);
          worker.onmessage = (ev: MessageEvent<Out>) => r.message(ev.data);
          worker.onerror = () => r.lost();
          resolve(r);
        } else if (m.t === "failed") {
          fail(new Error(m.why));
        }
      };
      worker.postMessage({ t: "init", lib: libPath, mpv: Number(mpv.handle) });
    });
  }

  get width(): number {
    return this.gens.get(this.gen)?.width ?? 0;
  }

  get height(): number {
    return this.gens.get(this.gen)?.height ?? 0;
  }

  /** Frames from now on are `width` x `height`; the current one is drawn again at that size. */
  resize(width: number, height: number): void {
    if (this.dead || (width === this.width && height === this.height)) return;
    const bufs = Array.from({ length: BUFFERS }, () => Native.alloc(width * height * 4));
    const views = bufs.map((b) => new Uint8ClampedArray(b.bytes.buffer, 0, width * height * 4));
    this.gen += 1;
    this.gens.set(this.gen, { width, height, bufs, views });
    this.worker.postMessage({ t: "target", gen: this.gen, width, height, bufs: bufs.map((b) => Number(b.addr)) });
  }

  /** Draws the current frame again (after a seek or a restart there may be no new one for a while). */
  force(): void {
    if (!this.dead) this.worker.postMessage({ t: "force" });
  }

  private message(m: Out): void {
    switch (m.t) {
      case "using":
        // The worker no longer holds any older buffer.
        for (const [g, gen] of this.gens) {
          if (g >= m.gen) continue;
          for (const b of gen.bufs) b.free();
          this.gens.delete(g);
        }
        break;
      case "frame": {
        const g = this.gens.get(m.gen);
        if (!g) break;
        this.onFrame({ width: g.width, height: g.height, data: g.views[m.i]! });
        // The window copied it: the buffer is the worker's again.
        if (m.gen === this.gen) this.worker.postMessage({ t: "free", gen: m.gen, i: m.i });
        break;
      }
      case "freed":
        this.end({ frames: m.frames, avg: m.avg, max: m.max });
        break;
      default:
        break;
    }
  }

  private lost(): void {
    this.end(null);
  }

  private end(stats: RenderStats | null): void {
    if (this.dead) return;
    this.dead = true;
    this.worker.terminate();
    // Only a worker that said it let go of the buffers may have them freed under it.
    if (stats !== null) {
      for (const g of this.gens.values()) for (const b of g.bufs) b.free();
      this.gens.clear();
    }
    this.quitting?.(stats);
    this.quitting = null;
  }

  /**
   * Frees the render context (on the worker's thread, as libmpv wants), then the buffers. Null when the worker didn't
   * answer: then it may still be inside libmpv, so the core must not be destroyed either.
   */
  stop(): Promise<RenderStats | null> {
    if (this.dead) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.end(null), QUIT_MS);
      this.quitting = (s) => {
        clearTimeout(timer);
        resolve(s);
      };
      this.worker.postMessage({ t: "quit" });
    });
  }
}
