import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { dataDir, newUuid } from "@harbor/store";
import * as parakeet from "./parakeet.ts";

export const RATE = parakeet.RATE;
const MAX_SECS = 600;
const TRANSCRIBE_TIMEOUT_MS = 300_000;

/** (code whisper takes, label). "auto" detects it per phrase, so languages can be mixed. */
export const LANGS: readonly (readonly [string, string])[] = [
  ["auto", "Detect automatically"],
  ["en", "English"],
  ["pt", "Portuguese"],
];

/** (name, what it's like, download size in bytes): Whisper's multilingual models (int8). */
export const MODELS: readonly (readonly [string, string, number])[] = [
  ["tiny", "Fastest, rougher", 103_609_903],
  ["base", "Fast, good for dictation", 160_609_290],
  ["small", "Slower, most accurate", 375_485_327],
];

export const DEFAULT_MODEL = "base";

/** Each Whisper model's files (sherpa-onnx's int8 export of OpenAI's Whisper): (file, size, SHA-256 or ""). */
export function modelFiles(name: string): [string, number, string][] {
  const sizes: Record<string, [[number, string], [number, string]]> = {
    tiny: [
      [12_937_772, "d24fb083ae3b1041fc24e97971d60e280c9342201fbb67b0ab428a8b4a51a434"],
      [89_855_401, "d2fece8dd42771f1df975c6c0445770d0c292bf7547c2cae04a6c0cc57540925"],
    ],
    base: [
      [29_120_534, "0b8fb1304b6109976038efff5ace81720e00386f3ff6b54ee8c75291ca0a1e11"],
      [130_672_026, "9759d217388a01b3a4c7c15533201067b48ae819c4daafc8624e64b9409dc02d"],
    ],
    small: [
      [112_442_483, "4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9"],
      [262_226_114, "acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee"],
    ],
  };
  const m = Object.hasOwn(sizes, name) ? sizes[name] : undefined;
  if (!m) return [];
  return [
    [`${name}-encoder.int8.onnx`, m[0][0], m[0][1]],
    [`${name}-decoder.int8.onnx`, m[1][0], m[1][1]],
    [`${name}-tokens.txt`, 816_730, ""],
  ];
}

let cfgLang = "";
let cfgModel = "";

export function setConfig(lang: string, model: string): void {
  cfgLang = "auto";
  cfgModel = model;
}

/** The language whisper is told ("auto", "en", "pt") and the model used. */
export function config(): [string, string] {
  return [cfgLang === "" ? "auto" : cfgLang, cfgModel];
}

export function modelsDir(): string {
  return join(dataDir(), "whisper-onnx");
}

export function modelDir(name: string): string {
  return join(modelsDir(), name);
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

export function installed(name: string): boolean {
  const files = modelFiles(name);
  return files.length > 0 && files.every(([f, size]) => sizeOf(join(modelDir(name), f)) === size);
}

/** The model to use: the one picked if it's there, else the smallest one there. */
export function currentModel(): string | null {
  const [, m] = config();
  if (m !== "" && installed(m)) return m;
  return MODELS.map((x) => x[0]).find((n) => installed(n)) ?? null;
}

function ggmlModel(name: string): string | null {
  const d = join(dataDir(), "whisper");
  for (const n of [name, ...MODELS.map((m) => m[0])]) {
    const p = join(d, `ggml-${n}.bin`);
    if (sizeOf(p) > 1_000_000) return p;
  }
  return null;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function onPath(names: readonly string[]): string | null {
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    if (d === "") continue;
    for (const n of names) {
      const p = join(d, n);
      if (isFile(p)) return p;
    }
  }
  return null;
}

export type Engine = { kind: "builtin" } | { kind: "cli"; bin: string };

export function engine(): Engine {
  const p = process.env.HARBOR_WHISPER;
  if (p && isFile(p)) return { kind: "cli", bin: p };
  return { kind: "builtin" };
}

export interface InputDevice { id: string; label: string }
let inputDevice = "";
export function setInputDevice(id: string): void { inputDevice = id; }
export function currentInputDevice(): string { return inputDevice; }

/** Pulse source names also identify PipeWire nodes when pipewire-pulse is used. */
export function pulseInputs(value: unknown): InputDevice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    if (!v || typeof v !== "object") return [];
    const p = v as Record<string, unknown>;
    // A sink's monitor (what the speakers play) is no microphone: pactl names it *.monitor and gives it
    // monitor_source (its sink) or monitor_of_sink, depending on the version ("n/a" / 4294967295: none).
    const ofSink = p.monitor_of_sink;
    const monitor = (typeof p.monitor_source === "string" && p.monitor_source !== "") || (typeof ofSink === "number" && ofSink !== 4294967295) || (typeof ofSink === "string" && ofSink !== "" && ofSink !== "n/a");
    if (typeof p.name !== "string" || p.name.endsWith(".monitor") || monitor) return [];
    return [{ id: p.name, label: typeof p.description === "string" ? p.description : p.name }];
  });
}

export function pipewireInputs(value: unknown): InputDevice[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    const p = v?.info?.props;
    return p?.["media.class"] === "Audio/Source" && typeof p["node.name"] === "string"
      ? [{ id: p["node.name"], label: p["node.description"] || p["node.nick"] || p["node.name"] }] : [];
  });
}

/** Enumerates on opening Voice; no audio server or permission is needed to use system default. */
export async function inputDevices(): Promise<InputDevice[]> {
  const defaults = [{ id: "", label: "System default" }];
  for (const [bin, args, parse] of [["pactl", ["--format=json", "list", "sources"], pulseInputs], ["pw-dump", [], pipewireInputs]] as const) {
    const path = onPath([bin]);
    if (!path) continue;
    try {
      const child = Bun.spawn([path, ...args], { stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => child.kill(), 2000);
      try {
        const text = await new Response(child.stdout).text();
        if (await child.exited === 0) { const devices = parse(JSON.parse(text)); if (devices.length) return [...defaults, ...devices]; }
      } finally { clearTimeout(timer); }
    } catch { /* Try the other audio server; default remains usable. */ }
  }
  return defaults;
}

export function recorder(device = inputDevice): { bin: string; args: string[] } | null {
  const pw = onPath(["pw-record"]);
  if (pw) return { bin: pw, args: [...(device ? ["--target", device] : []), "--raw", "--rate", "16000", "--channels", "1", "--format", "s16", "--media-category", "Capture", "--media-role", "Communication", "-"] };
  const pa = onPath(["parecord"]);
  return pa ? { bin: pa, args: [...(device ? [`--device=${device}`] : []), "--raw", "--rate=16000", "--channels=1", "--format=s16le", "--latency-msec=100"] } : null;
}

export function cantRecord(): string | null {
  return recorder() === null ? "Can't record: neither pw-record (PipeWire) nor parecord (PulseAudio) is on this PC." : null;
}

/** Why a transcription didn't happen. `wait`: a model is downloading, try again when it's done. */
export class Fail extends Error {
  constructor(
    readonly kind: "wait" | "err",
    message: string,
  ) {
    super(message);
    this.name = "Fail";
  }

  get text(): string {
    return this.message;
  }
}

/** `name` is needed and not there: starts its download (unless one runs) and says how far along it is, or why the last try failed. */
export function waitFor(name: string): Fail {
  const failed = takeDownloadError();
  if (failed) return new Fail("err", `Couldn't download the ${label(failed[0])} speech model: ${failed[1]}`);
  if (downloading() === null) startDownload(name);
  const [n, done, total] = downloading() ?? [name, 0, 0];
  return new Fail("wait", `Getting the ${label(n)} speech model (${megabytes(done)} of ${megabytes(total)}); try again when it's done.`);
}

export function capital(s: string): string {
  const [f, ...rest] = Array.from(s);
  return f === undefined ? "" : f.toUpperCase() + rest.join("");
}

export function label(name: string): string {
  return capital(name);
}

export function megabytes(b: number): string {
  return `${Math.floor(b / 1_000_000)} MB`;
}

export class Recording {
  readonly started = Date.now();
  private chunks: Int16Array[] = [];
  private count = 0;
  private lvl = 0;
  private odd: number | null = null;
  private done: Promise<void>;

  private constructor(
    private child: ChildProcess,
    wake: () => void,
  ) {
    this.done = new Promise((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    child.stdout?.on("data", (buf: Buffer) => {
      let bytes: Buffer = this.odd === null ? buf : Buffer.concat([Buffer.from([this.odd]), buf]);
      this.odd = null;
      if (bytes.length % 2 === 1) {
        this.odd = bytes[bytes.length - 1] as number;
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      const chunk = new Int16Array(bytes.length / 2);
      for (let i = 0; i < chunk.length; i++) chunk[i] = bytes.readInt16LE(i * 2);
      this.lvl = rms(chunk);
      if (this.count < RATE * MAX_SECS) {
        this.chunks.push(chunk);
        this.count += chunk.length;
      }
      wake();
    });
  }

  /** Starts recording; `wake` is called as sound comes in (to redraw the meter). */
  static start(wake: () => void): Recording {
    const r = recorder();
    if (!r) throw new Error("no recorder (pw-record or parecord)");
    const child = spawn(r.bin, r.args, { stdio: ["ignore", "pipe", "ignore"] });
    return new Recording(child, wake);
  }

  length(): number {
    return this.count;
  }

  level(): number {
    return this.lvl;
  }

  tooLong(): boolean {
    return Date.now() - this.started >= MAX_SECS * 1000;
  }

  async stop(): Promise<Int16Array> {
    this.child.kill("SIGKILL");
    await this.done;
    const out = new Int16Array(this.count);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    this.chunks = [];
    this.count = 0;
    return out;
  }

  cancel(): void {
    this.child.kill("SIGKILL");
  }
}

/** Loudness of a chunk, 0..1 (RMS, scaled so speech fills most of the meter). */
export function rms(s: Int16Array): number {
  if (s.length === 0) return 0;
  let sum = 0;
  for (const x of s) sum += (x / 32768) ** 2;
  return Math.min(Math.sqrt(sum / s.length) * 6, 1);
}

export function wav(samples: Int16Array, rate: number): Uint8Array {
  const data = samples.length * 2;
  const out = new Uint8Array(44 + data);
  const v = new DataView(out.buffer);
  out.set(Buffer.from("RIFF"), 0);
  v.setUint32(4, 36 + data, true);
  out.set(Buffer.from("WAVEfmt "), 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  out.set(Buffer.from("data"), 36);
  v.setUint32(40, data, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, samples[i] as number, true);
  return out;
}

function tag(b: Uint8Array, at: number): string {
  return Buffer.from(b.subarray(at, at + 4)).toString("latin1");
}

/** The samples of a 16-bit PCM WAV, as 16 kHz mono (other rates and stereo are converted). */
export function wavSamples(b: Uint8Array): Int16Array {
  const bad = () => new Error("The recording isn't a 16-bit PCM WAV file.");
  if (b.length < 12 || tag(b, 0) !== "RIFF" || tag(b, 8) !== "WAVE") throw bad();
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let channels = 0;
  let rate = 0;
  let i = 12;
  while (i + 8 <= b.length) {
    const len = v.getUint32(i + 4, true);
    const bodyAt = i + 8;
    const bodyEnd = Math.min(bodyAt + len, b.length);
    const id = tag(b, i);
    if (id === "fmt " && bodyEnd - bodyAt >= 16) {
      const format = v.getUint16(bodyAt, true);
      channels = v.getUint16(bodyAt + 2, true);
      rate = v.getUint32(bodyAt + 4, true);
      const bits = v.getUint16(bodyAt + 14, true);
      if (!(format === 1 || format === 0xfffe) || bits !== 16 || channels === 0 || rate === 0) throw bad();
    } else if (id === "data" && channels > 0) {
      const frames = Math.floor((bodyEnd - bodyAt) / (2 * channels));
      const mono = new Int16Array(frames);
      for (let f = 0; f < frames; f++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += v.getInt16(bodyAt + (f * channels + c) * 2, true);
        mono[f] = Math.trunc(sum / channels);
      }
      return resample(mono, rate, RATE);
    }
    i += 8 + len + (len & 1);
  }
  throw bad();
}

function resample(s: Int16Array, from: number, to: number): Int16Array {
  if (from === to || s.length === 0) return s;
  const n = Math.floor((s.length * to) / from);
  const out = new Int16Array(n);
  const last = s.length - 1;
  for (let i = 0; i < n; i++) {
    const x = (i * from) / to;
    const j = Math.floor(x);
    const f = x - j;
    const a = s[Math.min(j, last)] as number;
    const b = s[Math.min(j + 1, last)] as number;
    out[i] = Math.trunc(a + (b - a) * f);
  }
  return out;
}

/** whisper's text as one paragraph, without its non-speech marks ("[BLANK_AUDIO]", "(music)"). */
export function clean(s: string): string {
  const out: string[] = [];
  for (const raw of s.split(/\r?\n/)) {
    let l = raw.trim();
    // Timestamps, if a build prints them anyway.
    if (l.startsWith("[") && l.includes("-->")) {
      const at = l.indexOf("]");
      if (at >= 0) l = l.slice(at + 1).trim();
    }
    const wholeMark = (l.startsWith("[") && l.endsWith("]")) || (l.startsWith("(") && l.endsWith(")"));
    if (l === "" || wholeMark) continue;
    out.push(l);
  }
  return out.join(" ");
}

function threads(): number {
  return Math.min(Math.max(availableParallelism(), 1), 4);
}

export interface Output {
  code: number | null;
  stdout: string;
  stderr: string;
}

export async function outputWithin(bin: string, args: readonly string[], limitMs: number): Promise<Output> {
  const proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, limitMs);
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    if (timedOut) throw new Error(`timed out after ${Math.floor(limitMs / 1000)}s`);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function transcribeCli(bin: string, model: string, wavPath: string, lang: string, terms: readonly string[]): Promise<string> {
  const args = ["-m", model, "-f", wavPath, "-l", lang, "-t", String(threads()), "-nt", "-np"];
  // The dictionary's terms as the initial prompt: Whisper leans towards their spellings.
  const top = terms.slice(0, 40);
  if (top.length > 0) args.push("--prompt", `${top.join(", ")}.`);
  let out: Output;
  try {
    out = await outputWithin(bin, args, TRANSCRIBE_TIMEOUT_MS);
  } catch (e) {
    throw new Error(`${bin}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (out.code !== 0) {
    const last = out.stderr.split("\n").reverse().find((l) => l.trim() !== "");
    throw new Error(`${bin} failed: ${last?.trim() ?? "no output"}`);
  }
  return clean(out.stdout);
}

/** Without a model the default one starts downloading (`Fail("wait")`). `terms` go into the external program's prompt. */
export async function whisper(samples: Int16Array, lang: string, terms: readonly string[] = []): Promise<string> {
  const code = LANGS.some((l) => l[0] === lang) ? lang : "auto";
  const e = engine();
  if (e.kind === "builtin") {
    const name = currentModel();
    if (name === null) throw waitFor(DEFAULT_MODEL);
    try {
      return clean(await parakeet.whisper(modelDir(name), name, samples, code));
    } catch (err) {
      throw new Fail("err", err instanceof Error ? err.message : String(err));
    }
  }
  const [, picked] = config();
  const model = ggmlModel(picked);
  if (model === null) throw new Fail("err", `HARBOR_WHISPER is set: put a whisper.cpp ggml model (ggml-base.bin) in ${join(dataDir(), "whisper")}.`);
  const path = join(tmpdir(), `harbor-voice-${process.pid}-${newUuid()}.wav`);
  try {
    writeFileSync(path, wav(samples, RATE), { mode: 0o600 });
    return await transcribeCli(e.bin, model, path, code, terms);
  } catch (err) {
    throw new Fail("err", err instanceof Error ? err.message : String(err));
  } finally {
    rmSync(path, { force: true });
  }
}

export interface Part {
  url: string;
  dst: string;
  size: number;
  sha256: string;
}

export type Fetcher = (url: string, signal: AbortSignal) => Promise<Response>;

let fetcher: Fetcher = (url, signal) => fetch(url, { signal });

export function setFetcher(f: Fetcher | null): void {
  fetcher = f ?? ((url, signal) => fetch(url, { signal }));
}

interface Download {
  name: string;
  total: number;
  done: number;
  result: { error: string | null } | null;
  /** Started by keepParakeet, not by someone waiting: its failure isn't told (it's tried again later). */
  quiet: boolean;
}

let current: Download | null = null;
let running: Promise<void> = Promise.resolve();

export function whisperParts(name: string): Part[] {
  return modelFiles(name).map(([f, size, sha256]) => ({
    url: `https://huggingface.co/csukuangfj/sherpa-onnx-whisper-${name}/resolve/main/${f}`,
    dst: join(modelDir(name), f),
    size,
    sha256,
  }));
}

/** Starts downloading model `name` ("parakeet", or a Whisper model), unless a download is already under way. `parts` replaces the model's own files. */
export function startDownload(name: string, parts?: Part[], quiet = false): void {
  if (current && current.result === null) {
    // Someone is waiting for it now: a failure of the download under way is told after all.
    if (!quiet) current.quiet = false;
    return;
  }
  const all = parts ?? (name === "parakeet" ? parakeet.parts() : whisperParts(name));
  const d: Download = { name, total: all.reduce((n, p) => n + p.size, 0), done: 0, result: null, quiet };
  current = d;
  running = (async () => {
    try {
      let base = 0;
      for (const part of all) {
        if (sizeOf(part.dst) !== part.size) {
          await fetchPart(part, (n) => {
            d.done = base + n;
          });
        }
        base += part.size;
        d.done = base;
      }
      d.result = { error: null };
    } catch (e) {
      d.result = { error: e instanceof Error ? e.message : String(e) };
    }
  })();
}

export function downloadSettled(): Promise<void> {
  return running;
}

/** The download under way: (model, bytes so far, total bytes). */
export function downloading(): [string, number, number] | null {
  const d = current;
  if (!d) return null;
  if (d.result === null) return [d.name, d.done, d.total];
  if (d.result.error === null) current = null;
  return null;
}

/** A download that failed: (model, why), once. */
export function takeDownloadError(): [string, string] | null {
  const d = current;
  if (!d?.result?.error) return null;
  current = null;
  return d.quiet ? null : [d.name, d.result.error];
}

const MIN_FREE_BYTES = 2 * 1024 ** 3;

function freeBytes(path: string): number {
  try {
    mkdirSync(path, { recursive: true });
    const s = statfsSync(path);
    return s.bavail * s.bsize;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Gets the Parakeet model in the background when this PC lacks it, so dictation works the first time: a first try
 * `firstMs` after the start, then again after each failure (2, 4, 8… minutes, at most an hour), and an hourly look
 * once it's there (its files may be deleted). Never with less than 2 GB free. Returns the stop function. */
export function keepParakeet(o: { firstMs?: number; free?: (path: string) => number } = {}): () => void {
  let stopped = false;
  let fails = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const free = o.free ?? freeBytes;
  const later = (ms: number) => {
    if (!stopped) timer = setTimeout(() => void round(), ms);
  };
  const round = async (): Promise<void> => {
    if (stopped) return;
    if (parakeet.installed()) return later(3600_000);
    if (free(dataDir()) < MIN_FREE_BYTES) return later(3600_000);
    if (downloading() === null) startDownload("parakeet", undefined, true);
    await downloadSettled();
    if (parakeet.installed()) {
      fails = 0;
      return later(3600_000);
    }
    // A failed quiet try leaves nothing to tell; someone else's (Whisper's) download was in the way: look again soon.
    if (current?.result?.error && current.quiet) current = null;
    fails++;
    later(Math.min(60_000 * 2 ** Math.min(fails, 6), 3600_000));
  };
  later(o.firstMs ?? 30_000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function partName(dst: string): string {
  return `${dst.replace(/\.[^./]*$/, "")}.part`;
}

class Transient extends Error {}

async function fetchPart(part: Part, progress: (n: number) => void): Promise<void> {
  const tmp = partName(part.dst);
  mkdirSync(dirname(part.dst), { recursive: true });
  let last: Error = new Error("the download stopped");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fetchOnce(part, tmp, progress);
      return;
    } catch (e) {
      rmSync(tmp, { force: true });
      last = e instanceof Error ? e : new Error(String(e));
      if (!(last instanceof Transient)) break;
    }
  }
  throw new Error(last.message === "" ? "the download stopped" : last.message);
}

async function fetchOnce(part: Part, tmp: string, progress: (n: number) => void): Promise<void> {
  const ctl = new AbortController();
  const connect = setTimeout(() => ctl.abort(), 20_000);
  let res: Response;
  try {
    res = await fetcher(part.url, ctl.signal);
  } catch (e) {
    throw new Transient(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(connect);
  }
  if (!res.ok || !res.body) {
    const msg = `The requested URL returned error: ${res.status}`;
    throw res.status >= 500 ? new Transient(msg) : new Error(msg);
  }
  const hash = createHash("sha256");
  const sink = Bun.file(tmp).writer();
  let len = 0;
  try {
    for await (const chunk of res.body) {
      sink.write(chunk);
      hash.update(chunk);
      len += chunk.length;
      progress(len);
    }
  } catch (e) {
    await sink.end();
    throw new Transient(e instanceof Error ? e.message : String(e));
  }
  await sink.end();
  if (part.size > 0 && len !== part.size) throw new Error(`download incomplete (${len} of ${part.size} bytes)`);
  if (part.sha256 !== "" && hash.digest("hex") !== part.sha256) throw new Error("the download was damaged (checksum mismatch); try again");
  renameSync(tmp, part.dst);
}

export function modelProgress(): string | null {
  const d = downloading();
  return d ? `${d[2] > 0 ? Math.floor((d[1] * 100) / d[2]) : 0}%` : null;
}

/** `text` inserted into `s` at char `at`, spaced from the words around it: the new string and the cursor after the insert. */
export function insertSpaced(s: string, at: number, text: string): [string, number] {
  const chars = Array.from(s);
  const pos = Math.min(at, chars.length);
  const t = text.trim();
  const isWs = (c: string | undefined) => c !== undefined && /^\s$/u.test(c);
  const before = pos > 0 && !isWs(chars[pos - 1]);
  const after = pos < chars.length && !isWs(chars[pos]);
  const ins = `${before ? " " : ""}${t}${after ? " " : ""}`;
  const cursor = pos + Array.from(ins).length - (after ? 1 : 0);
  return [chars.slice(0, pos).join("") + ins + chars.slice(pos).join(""), cursor];
}
