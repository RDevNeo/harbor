// Hub's WhatsApp engine (whatsapp/engine.mjs, Baileys) as a child process for one Persons WhatsApp
// connection, the way Hub's own WhatsApp host runs it (mcp/src/whatsapphost.ts ChildEngine): the
// engine fetched and installed once by whatsappsetup.ensureEngine, run by Hub's runtime as Bun
// (whatsappsetup.bunCommand), commands as JSON lines on stdin, answers and events on stdout, its log
// (stderr) in <connection folder>/engine.log. Only the auth folder differs: each connection has its own.
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});

/** The engine as the connection sees it (a test's stand-in implements it too). */
export interface WaEngine {
  /** Spawns it and sends "start"; events go to `onEvent`, an exit (expected or not) to `onExit`. */
  start(onEvent: (ev: string, data: unknown) => void, onExit: () => void): Promise<void>;
  request(op: string, args?: Json, waitMs?: number): Promise<Json>;
  stop(): Promise<void>;
  running(): boolean;
}

export type WaEngineFactory = (o: { authDir: string; logFile: string; say: (s: string) => void }) => WaEngine;

export class ChildWaEngine implements WaEngine {
  private child: ChildProcess | undefined;
  private next = 1;
  private readonly waiting = new Map<number, { ok: (r: Json) => void; no: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly o: { authDir: string; logFile: string; say: (s: string) => void }) {}

  running(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  async start(onEvent: (ev: string, data: unknown) => void, onExit: () => void): Promise<void> {
    const { whatsappsetup } = await import("@harbor/mcp");
    const dir = await whatsappsetup.ensureEngine(this.o.say);
    const bun = whatsappsetup.bunCommand();
    mkdirSync(this.o.authDir, { recursive: true, mode: 0o700 });
    const log = openSync(this.o.logFile, "a", 0o600);
    const env: Record<string, string> = { ...bun.env };
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && (["HOME", "PATH", "LANG", "TZ", "SSL_CERT_FILE"].includes(k) || k.startsWith("XDG_"))) env[k] = v;
    const child = spawn(bun.exe, [join(dir, "engine.mjs"), this.o.authDir], { cwd: dir, env, stdio: ["pipe", "pipe", log] });
    closeSync(log);
    this.child = child;
    child.on("error", (e) => this.o.say(`engine: ${e.message}`));
    child.on("exit", () => {
      if (this.child === child) this.child = undefined;
      for (const [, w] of this.waiting) {
        clearTimeout(w.timer);
        w.no(new Error("WhatsApp's engine stopped."));
      }
      this.waiting.clear();
      onExit();
    });
    const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    lines.on("line", (l) => {
      let v: Json;
      try {
        v = obj(JSON.parse(l));
      } catch {
        return;
      }
      if (typeof v.id === "number") {
        const w = this.waiting.get(v.id);
        if (w === undefined) return;
        this.waiting.delete(v.id);
        clearTimeout(w.timer);
        if (v.ok === true) w.ok(obj(v.result));
        else w.no(new Error(typeof v.error === "string" && v.error ? v.error : "WhatsApp failed."));
      } else if (typeof v.ev === "string") onEvent(v.ev, v.data);
    });
    await this.request("start", {});
  }

  request(op: string, args: Json = {}, waitMs = 120_000): Promise<Json> {
    const child = this.child;
    if (child === undefined || child.stdin === null) return Promise.reject(new Error("WhatsApp isn’t started"));
    const id = this.next++;
    return new Promise((ok, no) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        no(new Error("WhatsApp didn’t answer"));
      }, waitMs);
      this.waiting.set(id, { ok, no, timer });
      child.stdin?.write(`${JSON.stringify({ ...args, id, op })}\n`);
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    await this.request("stop", {}, 3000).catch(() => {});
    await new Promise<void>((r) => {
      if (child.exitCode !== null) return r();
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        r();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(t);
        r();
      });
    });
  }
}

export const childEngine: WaEngineFactory = (o) => new ChildWaEngine(o);
