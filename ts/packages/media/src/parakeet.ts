import { rmSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { dataDir } from "@harbor/store";
import type { Part } from "./voice.ts";
import { sys } from "@harbor/os";

export const RATE = 16_000;

const DIR = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
const HF = "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main";

/** (file, URL, size, SHA-256 or "" where the repository gives none). */
const FILES: readonly (readonly [string, string, number, string])[] = [
  ["encoder.int8.onnx", "encoder.int8.onnx", 652_184_281, "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247"],
  ["decoder.int8.onnx", "decoder.int8.onnx", 11_845_275, "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e"],
  ["joiner.int8.onnx", "joiner.int8.onnx", 6_355_277, "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3"],
  ["tokens.txt", "tokens.txt", 93_939, ""],
  ["silero_vad.onnx", "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx", 643_854, "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6"],
];

/** The languages it knows (ISO 639-1), for choosing Whisper for the others. */
export const LANGS: readonly string[] = ["bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it", "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk"];

const SPLIT_ABOVE_S = 30;
const CALL_TIMEOUT_MS = 600_000;
/** Parakeet isn't loaded with less free memory than this (MB): Whisper or another PC instead. */
const MIN_FREE_MB = 1200;
export const MAX_WORKER_SAMPLES = RATE * 1200;

export function dir(): string {
  return join(dataDir(), "parakeet", DIR);
}

export function parts(): Part[] {
  return FILES.map(([name, url, size, sha256]) => ({
    url: url.startsWith("https://") ? url : `${HF}/${url}`,
    dst: join(dir(), name),
    size,
    sha256,
  }));
}

export function size(): number {
  return FILES.reduce((n, f) => n + f[2], 0);
}

/** Its size in MB, as the mesh counts it for a PC that has it loaded. */
export function modelMb(): number {
  return Math.floor(size() / 1_000_000);
}

export function installed(): boolean {
  return FILES.every(([name, , want]) => {
    try {
      return statSync(join(dir(), name)).size === want;
    } catch {
      return false;
    }
  });
}

/** Free memory in MB (`MemAvailable`; `HARBOR_TEST_MEMAVAIL_MB` for test rigs). */
export const memAvailableMb = (): number => sys.memAvailableMb() ?? 0;

function threads(): number {
  const forced = process.env.HARBOR_SPEECH_THREADS;
  if (forced !== undefined && /^\d+$/.test(forced) && Number(forced) > 0) return Number(forced);
  return Math.min(Math.max(availableParallelism(), 1), 4);
}

type Head =
  | { op: "load"; dir: string }
  | { op: "parakeet"; dir: string }
  | { op: "whisper"; dir: string; name: string; lang: string };

type Sherpa = typeof import("sherpa-onnx-node").default;
type Recognizer = InstanceType<Sherpa["OfflineRecognizer"]>;

let sherpaMod: Sherpa | null = null;
let rec: { dir: string; r: Recognizer } | null = null;

async function sherpa(): Promise<Sherpa> {
  sherpaMod ??= (await import("sherpa-onnx-node")).default;
  return sherpaMod;
}

function floats(samples: Int16Array): Float32Array {
  const pcm = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) pcm[i] = (samples[i] as number) / 32768;
  return pcm;
}

async function recognizer(d: string): Promise<Recognizer> {
  if (rec && rec.dir === d) return rec.r;
  for (const [name, , want] of FILES.slice(0, 4)) {
    let got = -1;
    try {
      got = statSync(join(d, name)).size;
    } catch {
      // a missing file counts as the wrong size below
    }
    if (got !== want) throw new Error("The Parakeet model isn't downloaded.");
  }
  const s = await sherpa();
  let r: Recognizer;
  try {
    r = new s.OfflineRecognizer({
      featConfig: { sampleRate: RATE, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: join(d, "encoder.int8.onnx"), decoder: join(d, "decoder.int8.onnx"), joiner: join(d, "joiner.int8.onnx") },
        tokens: join(d, "tokens.txt"),
        numThreads: threads(),
        provider: "cpu",
        debug: 0,
        modelType: "nemo_transducer",
      },
      decodingMethod: "greedy_search",
    });
  } catch {
    throw new Error("Couldn't load the Parakeet model. Remove it in Settings › Voice and download it again.");
  }
  rec = { dir: d, r };
  return r;
}

function decode(r: Recognizer, piece: Float32Array): string {
  const stream = r.createStream();
  stream.acceptWaveform({ samples: piece, sampleRate: RATE });
  r.decode(stream);
  return r.getResult(stream).text;
}

async function parakeetOp(d: string, samples: Int16Array): Promise<string> {
  const r = await recognizer(d);
  const pcm = floats(samples);
  const pieces = pcm.length > SPLIT_ABOVE_S * RATE ? await split(d, pcm) : [pcm];
  const out: string[] = [];
  for (const piece of pieces) {
    if (piece.length === 0) continue;
    const t = decode(r, piece).trim();
    if (t !== "") out.push(t);
  }
  return out.join(" ");
}

/** Whisper's pieces are returned one per line; voice.ts cleans them. */
async function whisperOp(d: string, name: string, samples: Int16Array, lang: string): Promise<string> {
  const s = await sherpa();
  let r: Recognizer;
  try {
    r = new s.OfflineRecognizer({
      modelConfig: {
        whisper: {
          encoder: join(d, `${name}-encoder.int8.onnx`),
          decoder: join(d, `${name}-decoder.int8.onnx`),
          language: lang === "auto" ? "" : lang,
          task: "transcribe",
          tailPaddings: -1,
        },
        tokens: join(d, `${name}-tokens.txt`),
        numThreads: threads(),
        provider: "cpu",
        debug: 0,
      },
      decodingMethod: "greedy_search",
    });
  } catch {
    throw new Error("Couldn't load the Whisper model. Remove it in Settings › Voice and download it again.");
  }
  const pcm = floats(samples);
  // Whisper reads 30 s at most. Detecting the language it picks one per piece and translates the
  // rest into it, so then each phrase (cut at pauses) is a piece and the speaker can switch.
  const pieces = lang === "auto" || pcm.length > 25 * RATE ? await split(dir(), pcm) : [pcm];
  const out: string[] = [];
  for (const piece of pieces) {
    if (piece.length > 0) out.push(decode(r, piece));
  }
  return out.join("\n");
}

/** A long recording cut at its pauses (Silero VAD), pieces of at most ~20 s; fixed 20 s pieces if the VAD can't start. */
async function split(modelDir: string, pcm: Float32Array): Promise<Float32Array[]> {
  const fixed = (): Float32Array[] => {
    const out: Float32Array[] = [];
    for (let i = 0; i < pcm.length; i += 20 * RATE) out.push(pcm.slice(i, i + 20 * RATE));
    return out;
  };
  const s = await sherpa();
  let vad: InstanceType<Sherpa["Vad"]>;
  try {
    vad = new s.Vad(
      {
        sileroVad: { model: join(modelDir, "silero_vad.onnx"), threshold: 0.5, minSilenceDuration: 0.8, minSpeechDuration: 0.25, windowSize: 512, maxSpeechDuration: 20 },
        sampleRate: RATE,
        numThreads: 1,
        provider: "cpu",
        debug: 0,
      },
      Math.floor(pcm.length / RATE) + 2,
    );
  } catch {
    return fixed();
  }
  const out: Float32Array[] = [];
  const take = () => {
    while (!vad.isEmpty()) {
      out.push(vad.front(false).samples.slice());
      vad.pop();
    }
  };
  for (let i = 0; i < pcm.length; i += 512) {
    vad.acceptWaveform(pcm.slice(i, i + 512));
    take();
  }
  vad.flush();
  take();
  return out.length === 0 ? fixed() : out;
}

export async function handle(head: Head, samples: Int16Array): Promise<string> {
  switch (head.op) {
    case "load":
      await recognizer(head.dir);
      return "";
    case "parakeet":
      return parakeetOp(head.dir, samples);
    case "whisper": {
      // Only codes Harbor offers: a stray byte can't reach the C side.
      const lang = head.lang.length <= 8 && /^[A-Za-z]+$/.test(head.lang) ? head.lang : "auto";
      return whisperOp(head.dir, head.name, samples, lang);
    }
  }
}

export function parseHead(v: unknown): Head | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  switch (o.op) {
    case "load":
    case "parakeet":
      return { op: o.op, dir: str("dir") };
    case "whisper":
      return { op: "whisper", dir: str("dir"), name: str("name"), lang: str("lang") };
    default:
      return null;
  }
}


interface Worker {
  proc: Bun.Subprocess<"pipe", "pipe", "ignore">;
  lines: Lines;
  last: number;
}

class Lines {
  private queue: string[] = [];
  private waiter: { resolve: (s: string) => void; reject: (e: Error) => void } | null = null;
  private closed = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    void this.pump(stream);
  }

  private async pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of stream) {
        buf += dec.decode(chunk, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          this.push(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
        }
      }
    } catch {
      // a killed worker ends its pipe
    }
    this.closed = true;
    this.waiter?.reject(new Error("the worker ended"));
    this.waiter = null;
  }

  private push(line: string): void {
    // sherpa's C++ side may print to stdout: only JSON lines are answers.
    if (!line.startsWith("{")) return;
    if (this.waiter) {
      this.waiter.resolve(line);
      this.waiter = null;
    } else {
      this.queue.push(line);
    }
  }

  next(timeoutMs: number): Promise<string> {
    const q = this.queue.shift();
    if (q !== undefined) return Promise.resolve(q);
    if (this.closed) return Promise.reject(new Error("the worker ended"));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiter = null;
        reject(new Error("the worker timed out"));
      }, timeoutMs);
      this.waiter = {
        resolve: (s) => {
          clearTimeout(t);
          resolve(s);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      };
    });
  }
}

let worker: Worker | null = null;
let isLoaded = false;
let reaper: ReturnType<typeof setInterval> | null = null;
let active = 0;
let chain: Promise<unknown> = Promise.resolve();
let keepMinutes = 5;
/** Loads asked for (a preload, or a transcription that has to load first) and not answered yet. */
let loading = 0;
let workerCmd: string[] | null = null;
let callTimeoutMs = CALL_TIMEOUT_MS;

/** Minutes the model stays loaded after its last use (0: freed right after each use). */
export function setKeepMin(m: number): void {
  keepMinutes = m;
}

export function keepMin(): number {
  return keepMinutes;
}

export function loaded(): boolean {
  return isLoaded;
}

/** How ready the model is for the next recording: in memory, on its way in (a preload under way), or still to load. */
export function warmth(): "warm" | "loading" | "cold" {
  return isLoaded ? "warm" : loading > 0 ? "loading" : "cold";
}

/** The command that starts a speech worker (default: this runtime on speech-worker.ts); for a compiled build. */
export function setWorkerCommand(cmd: string[] | null): void {
  workerCmd = cmd;
}

export const compiled = (): boolean => Bun.main.startsWith("/$bunfs/");

export function useOwnBinaryForWorker(): void {
  if (compiled()) setWorkerCommand([process.execPath, "--speech-worker"]);
}

export function setCallTimeout(ms: number): void {
  callTimeoutMs = ms;
}

export function workerPid(): number | null {
  return worker?.proc.pid ?? null;
}

/** Loads the model ahead of a transcription (while the person speaks); false when it is loaded, loading, missing or memory is short. */
export function preload(): boolean {
  if (!installed() || loaded() || loading > 0 || memAvailableMb() < MIN_FREE_MB) return false;
  void call({ op: "load", dir: dir() }, new Int16Array(0)).catch(() => undefined);
  return true;
}

export async function transcribe(samples: Int16Array): Promise<string> {
  if (!installed()) throw new Error("The Parakeet model isn't downloaded.");
  const free = memAvailableMb();
  if (!loaded() && free < MIN_FREE_MB) throw new Error(`Not enough free memory for Parakeet (${free} MB free).`);
  return call({ op: "parakeet", dir: dir() }, samples);
}

export function whisper(d: string, name: string, samples: Int16Array, lang: string): Promise<string> {
  return call({ op: "whisper", dir: d, name, lang }, samples);
}

export async function unload(): Promise<void> {
  if (active > 0) return;
  const w = worker;
  worker = null;
  if (w) await stop(w);
}

export async function remove(): Promise<void> {
  await unload();
  rmSync(dir(), { recursive: true, force: true });
}

async function stop(w: Worker): Promise<void> {
  isLoaded = false;
  if (worker === w) worker = null;
  w.proc.kill();
  await w.proc.exited;
}

function spawnWorker(): Worker {
  const cmd = workerCmd ?? [process.execPath, join(import.meta.dir, "speech-worker.ts")];
  const proc = Bun.spawn(cmd, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, HARBOR_SPEECH_THREADS: String(threads()) },
  });
  return { proc, lines: new Lines(proc.stdout), last: Date.now() };
}

function exclusive<T>(f: () => Promise<T>): Promise<T> {
  const r = chain.then(f, f);
  chain = r.catch(() => undefined);
  return r;
}

function call(head: Head, samples: Int16Array): Promise<string> {
  active += 1;
  const loads = !isLoaded && (head.op === "load" || head.op === "parakeet");
  if (loads) loading += 1;
  return exclusive(() => callWorker(head, samples)).finally(() => {
    active -= 1;
    if (loads) loading -= 1;
  });
}

async function callWorker(head: Head, samples: Int16Array): Promise<string> {
  if (worker && (worker.proc.exitCode !== null || worker.proc.signalCode !== null)) {
    isLoaded = false;
    worker = null;
  }
  if (!worker) {
    try {
      worker = spawnWorker();
    } catch (e) {
      throw new Error(`Couldn't start the speech engine: ${e instanceof Error ? e.message : String(e)}`);
    }
    reaper ??= setInterval(() => void reap(), 5000);
    reaper.unref();
  }
  const w = worker;
  const body = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  let line: string;
  try {
    w.proc.stdin.write(Buffer.concat([Buffer.from(`${JSON.stringify({ ...head, n: samples.length })}\n`), body]));
    await w.proc.stdin.flush();
    line = await w.lines.next(callTimeoutMs);
  } catch {
    // It died (an abort, out of memory) or hangs: gone, and the next try starts anew.
    await stop(w);
    throw new Error("The speech engine stopped (out of memory?); try again.");
  }
  w.last = Date.now();
  let v: { text?: unknown; error?: unknown } = {};
  try {
    v = JSON.parse(line) as typeof v;
  } catch {
    // an unreadable answer is "no answer"
  }
  if (head.op === "parakeet" || head.op === "load") isLoaded = typeof v.text === "string";
  if (keepMin() === 0 && head.op !== "load") await stop(w);
  if (typeof v.text === "string") return v.text;
  throw new Error(typeof v.error === "string" ? v.error : "The speech engine gave no answer.");
}

/** Ends the worker once it's been idle long enough (at least two minutes: a model loaded while you speak waits for the recording to end). */
export async function reap(now: number = Date.now()): Promise<boolean> {
  if (active > 0) return false;
  const w = worker;
  if (!w) {
    if (reaper) clearInterval(reaper);
    reaper = null;
    return false;
  }
  if (now - w.last < Math.max(keepMin() * 60, 120) * 1000) return false;
  await stop(w);
  return true;
}
