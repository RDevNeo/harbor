import { type ChildProcess, spawn } from "node:child_process";
import { RATE } from "./parakeet.ts";
import { WORKER_VERSION, setupScript } from "./devicespeech-scripts.ts";

/** An SSH device of this PC that can transcribe: its id, its name, and ssh's arguments with the destination last. */
export interface SpeechDevice {
  id: string;
  name: string;
  ssh: string[];
}

export interface DeviceSpeechDeps {
  /** This PC's SSH devices that may transcribe (Settings › Devices, hand-added POSIX ones). */
  devices(): SpeechDevice[];
  /** Runs `ssh <args>` (tests: a fake ssh). */
  spawn?: (args: string[]) => ChildProcess;
  /** Seconds the worker keeps the model after its last request. */
  keepSecs?: () => number;
  /** A setup step, a state change: Settings › Voice redraws. */
  changed?: () => void;
  now?: () => number;
}

/** The device's command: the worker, kept `keep` seconds. Plain single quotes without backslashes read the same in sh, bash, zsh and fish. */
export const serveCommand = (keep: number): string => `sh -c 'exec "$HOME/.harbor-voice/serve" ${Math.max(0, Math.round(keep))}'`;
/** `sh -s` reads the setup script from stdin, whatever the login shell. */
export const SETUP_COMMAND = "sh -s";

/** The worker's connection gives up sooner than other ssh calls (8 s): on a LAN it takes well under a second, and the person waits. ssh takes an option's first value. */
export const SPEECH_SSH = ["-o", "ConnectTimeout=4"];
/** The worker's hello: after the connection and Python's start (a name that doesn't resolve isn't covered by ConnectTimeout). */
const HELLO_MS = 8000;
/** A device that failed isn't asked again for this long: the next dictation goes straight to the fallback. */
const DOWN_MS = 30_000;
const SETUP_MS = 45 * 60_000;
/** A failed setup is tried again after this long (a dictation or the Voice page asks). */
const SETUP_RETRY_MS = 10 * 60_000;
/** The answer's time: the model's load when it isn't loaded, then about 0.3 s per 10 s of audio on a busy Apple Silicon laptop. */
export function answerBudgetMs(audioSecs: number, warm: boolean): number {
  return (warm ? 6000 : 30_000) + Math.ceil(audioSecs * 400);
}

interface Answer {
  ok?: boolean;
  text?: string;
  model?: string;
  error?: string;
  cold?: boolean;
  hello?: number;
  version?: string;
  engine?: string;
}

class NotSetUp extends Error {}

const field = (o: unknown, k: string): unknown => (typeof o === "object" && o !== null ? (o as Record<string, unknown>)[k] : undefined);

/** One `serve` on a device, over its own ssh: JSON lines in order, one answer per request. */
class Worker {
  hello: { version: string; engine: string } | null = null;
  /** The model was loaded by an earlier request (the next answer is quick). */
  warm = false;
  dead = false;
  private out = "";
  private err = "";
  private queue: { resolve: (a: Answer) => void; reject: (e: Error) => void }[] = [];
  private greeted: Promise<void>;

  constructor(
    readonly child: ChildProcess,
    readonly name: string,
  ) {
    let greet!: () => void;
    let fail!: (e: Error) => void;
    this.greeted = new Promise<void>((resolve, reject) => {
      greet = resolve;
      fail = reject;
    });
    this.greeted.catch(() => undefined);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (s: string) => {
      this.out += s;
      for (let i = this.out.indexOf("\n"); i >= 0; i = this.out.indexOf("\n")) {
        const line = this.out.slice(0, i);
        this.out = this.out.slice(i + 1);
        let a: Answer;
        try {
          a = JSON.parse(line) as Answer;
        } catch {
          continue;
        }
        if (this.hello === null && a.hello !== undefined) {
          this.hello = { version: String(field(a, "version") ?? ""), engine: String(field(a, "engine") ?? "") };
          greet();
          continue;
        }
        this.queue.shift()?.resolve(a);
      }
    });
    child.stderr?.on("data", (s: string) => {
      this.err = (this.err + s).slice(-2000);
    });
    child.stdin?.on("error", () => undefined);
    const ended = (code: number | null) => {
      if (this.dead) return;
      this.dead = true;
      const why = this.why(code);
      fail(why);
      for (const q of this.queue.splice(0)) q.reject(why);
    };
    child.on("error", (e) => {
      this.err = e.message;
      ended(null);
    });
    child.on("close", (code) => ended(code));
  }

  private why(code: number | null): Error {
    const said = this.err.trim().split("\n").filter((l) => l.trim() !== "").at(-1) ?? "";
    // sh's "not found" for a missing ~/.harbor-voice/serve.
    if (code === 127 || /harbor-voice\/serve.*(not found|No such file)/.test(this.err)) return new NotSetUp(`${this.name} isn't set up to transcribe`);
    if (code === 255) return new Error(said !== "" ? said.replace(/^ssh: /, "") : `${this.name} can't be reached`);
    return new Error(said !== "" ? said : `the speech worker on ${this.name} stopped${code === null ? "" : ` (exit ${code})`}`);
  }

  ready(ms: number): Promise<void> {
    return within(this.greeted, ms, () => new Error(`${this.name} didn't answer in ${Math.round(ms / 1000)} s`));
  }

  ask(req: Record<string, unknown>, body: Uint8Array | null, ms: number): Promise<Answer> {
    if (this.dead) return Promise.reject(new Error(`the speech worker on ${this.name} stopped`));
    const p = new Promise<Answer>((resolve, reject) => this.queue.push({ resolve, reject }));
    this.child.stdin?.write(`${JSON.stringify(req)}\n`);
    if (body !== null) this.child.stdin?.write(body);
    return within(p, ms, () => new Error(`${this.name} didn't answer in ${Math.round(ms / 1000)} s`));
  }

  stop(): void {
    this.dead = true;
    try {
      this.child.stdin?.end();
      this.child.kill();
    } catch {
      // already gone
    }
  }
}

function within<T>(p: Promise<T>, ms: number, late: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(late()), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

interface Setup {
  running: boolean;
  step: string;
  error: string;
  at: number;
}

/** Dictation on SSH devices: a worker per device, started on demand over ssh, set up there by itself when it's missing. */
export class DeviceSpeech {
  private workers = new Map<string, Worker>();
  private setups = new Map<string, Setup>();
  private down = new Map<string, { until: number; why: string }>();

  constructor(private readonly d: DeviceSpeechDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private run(args: string[]): ChildProcess {
    return (this.d.spawn ?? ((a) => spawn("ssh", a, { stdio: ["pipe", "pipe", "pipe"] })))(args);
  }

  list(): { id: string; name: string }[] {
    return this.d.devices().map(({ id, name }) => ({ id, name }));
  }

  private device(id: string): SpeechDevice {
    const dev = this.d.devices().find((x) => x.id === id);
    if (!dev) throw new Error("that SSH device isn't in Settings › Devices anymore");
    return dev;
  }

  private worker(dev: SpeechDevice): Worker {
    const cur = this.workers.get(dev.id);
    if (cur && !cur.dead) return cur;
    const w = new Worker(this.run([...SPEECH_SSH, ...dev.ssh, serveCommand(this.d.keepSecs?.() ?? 300)]), dev.name);
    this.workers.set(dev.id, w);
    w.child.on("close", () => {
      if (this.workers.get(dev.id) === w) this.workers.delete(dev.id);
      this.d.changed?.();
    });
    return w;
  }

  /** A worker that said hello; one missing on the device starts its setup. */
  private async ready(dev: SpeechDevice): Promise<Worker> {
    const live = this.workers.get(dev.id);
    if (live && !live.dead && live.hello !== null) return live;
    const setup = this.setups.get(dev.id);
    if (setup?.running) throw new Error(`${dev.name} is being set up to transcribe (${setup.step})`);
    const down = this.down.get(dev.id);
    if (down && this.now() < down.until) throw new Error(down.why);
    const w = this.worker(dev);
    try {
      await w.ready(HELLO_MS);
    } catch (e) {
      w.stop();
      if (e instanceof NotSetUp) {
        this.setUp(dev.id, false);
        const s = this.setups.get(dev.id);
        if (s && !s.running && s.error !== "") throw new Error(`${dev.name} couldn't be set up to transcribe: ${s.error}`);
        throw new Error(`${dev.name} is being set up to transcribe (once, a few minutes)`);
      }
      const why = e instanceof Error ? e.message : String(e);
      this.down.set(dev.id, { until: this.now() + DOWN_MS, why });
      this.d.changed?.();
      throw e;
    }
    this.down.delete(dev.id);
    // An older worker answers while the new one is put in place.
    if (w.hello?.version !== WORKER_VERSION) this.setUp(dev.id, false);
    return w;
  }

  /** Loads the model on the device while the person speaks (and sets the device up when it needs it). */
  warm(id: string): void {
    let dev: SpeechDevice;
    try {
      dev = this.device(id);
    } catch {
      return;
    }
    void this.ready(dev)
      .then(async (w) => {
        if (w.warm) return;
        const a = await w.ask({ op: "warm" }, null, answerBudgetMs(0, false));
        if (a.ok === true) w.warm = true;
        this.d.changed?.();
      })
      .catch(() => undefined);
  }

  async transcribe(id: string, samples: Int16Array, lang: string): Promise<{ text: string; model: string }> {
    const dev = this.device(id);
    const w = await this.ready(dev);
    const pcm = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    const warm = w.warm;
    let a: Answer;
    try {
      a = await w.ask({ op: "transcribe", bytes: pcm.byteLength, lang }, pcm, answerBudgetMs(samples.length / RATE, warm));
    } catch (e) {
      // No answer: the device sleeps or left the network. The next try connects again.
      w.stop();
      this.down.set(dev.id, { until: this.now() + DOWN_MS, why: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    if (a.ok !== true) throw new Error(typeof a.error === "string" && a.error !== "" ? a.error : "the speech worker failed");
    w.warm = true;
    const model = typeof a.model === "string" && a.model !== "" ? a.model : (w.hello?.engine ?? "");
    return { text: typeof a.text === "string" ? a.text : "", model: `${model} ${a.cold === true || !warm ? "cold" : "warm"}` };
  }

  /** Puts the worker on the device (again): in the background, one at a time. `force`: even after a recent failure. */
  setUp(id: string, force: boolean): void {
    let dev: SpeechDevice;
    try {
      dev = this.device(id);
    } catch {
      return;
    }
    const cur = this.setups.get(dev.id);
    if (cur?.running || (!force && cur && cur.error !== "" && this.now() - cur.at < SETUP_RETRY_MS)) return;
    const s: Setup = { running: true, step: "connecting", error: "", at: this.now() };
    this.setups.set(dev.id, s);
    this.d.changed?.();
    console.error(`harbor: setting up ${dev.name} to transcribe dictation`);
    const child = this.run([...dev.ssh, SETUP_COMMAND]);
    let out = "";
    let err = "";
    let done = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (t: string) => {
      out += t;
      for (let i = out.indexOf("\n"); i >= 0; i = out.indexOf("\n")) {
        const line = out.slice(0, i).trim();
        out = out.slice(i + 1);
        if (line.startsWith("step: ")) s.step = line.slice(6);
        else if (line.startsWith("error: ")) s.error = line.slice(7);
        else if (line.startsWith("done")) done = true;
        this.d.changed?.();
      }
    });
    child.stderr?.on("data", (t: string) => {
      err = (err + t).slice(-2000);
    });
    child.stdin?.on("error", () => undefined);
    const timer = setTimeout(() => child.kill(), SETUP_MS);
    const finish = (code: number | null) => {
      if (!s.running) return;
      clearTimeout(timer);
      s.running = false;
      s.at = this.now();
      if (done && code === 0) {
        s.error = "";
        s.step = "";
        this.down.delete(dev.id);
        // The next request starts the new worker.
        this.workers.get(dev.id)?.stop();
        this.workers.delete(dev.id);
        console.error(`harbor: ${dev.name} is set up to transcribe dictation`);
      } else {
        if (s.error === "") s.error = err.trim().split("\n").at(-1)?.replace(/^ssh: /, "") || `setup stopped (exit ${code ?? "killed"})`;
        console.error(`harbor: setting up ${dev.name} to transcribe failed: ${s.error}`);
      }
      this.d.changed?.();
    };
    child.on("error", (e) => {
      s.error = e.message;
      finish(null);
    });
    child.on("close", (code) => finish(code));
    child.stdin?.end(setupScript());
  }

  /** Settings › Voice picked the device: set it up again after a failure, else connect and load the model. */
  prepare(id: string): void {
    const s = this.setups.get(id);
    if (s && !s.running && s.error !== "") this.setUp(id, true);
    else this.warm(id);
  }

  /** A line for Settings › Voice: setting up, failed, unreachable, ready, or "" (not asked yet this run). */
  state(id: string): string {
    const s = this.setups.get(id);
    if (s?.running) return `Setting up: ${s.step}…`;
    if (s && s.error !== "") return `Couldn't set it up: ${s.error}`;
    const down = this.down.get(id);
    if (down && this.now() < down.until) return `Not reachable: ${down.why}`;
    const w = this.workers.get(id);
    if (w?.hello) return w.warm ? `Ready, model loaded (${w.hello.engine})` : `Ready (${w.hello.engine})`;
    return "";
  }

  stop(): void {
    for (const w of this.workers.values()) w.stop();
    this.workers.clear();
  }
}
