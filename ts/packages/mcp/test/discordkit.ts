import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { Electron, Host, Policy, listen, type Running } from "../src/discordhost.ts";
import type { Mode } from "../src/discordhost.ts";
import { serve } from "../src/discord.ts";
import type { Obj } from "../src/discordjson.ts";
import * as setup from "../src/discordsetup.ts";
import { Vencords } from "../src/discordsetup.ts";
import { now } from "@harbor/store";

const KEYS = ["XDG_DATA_HOME", "XDG_RUNTIME_DIR", "HOME"];

/** A private data folder for one test file, with every HARBOR_DISCORD_* variable cleared. */
export function sandbox(): { dir: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "hdtest-"));
  const saved = new Map<string, string | undefined>();
  for (const k of [...KEYS, ...Object.keys(process.env).filter((k) => k.startsWith("HARBOR_DISCORD_"))]) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  process.env.XDG_DATA_HOME = join(dir, "data");
  process.env.XDG_RUNTIME_DIR = join(dir, "run");
  process.env.HOME = join(dir, "home");
  return {
    dir,
    restore() {
      for (const k of [...Object.keys(process.env).filter((k) => k.startsWith("HARBOR_DISCORD_")), ...KEYS]) delete process.env[k];
      for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface ZipEntry {
  name: string;
  data: Uint8Array | string;
  mode?: number;
  deflate?: boolean;
}

/** A zip written by hand: stored or deflated entries with Unix modes. */
export function zip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const u16 = (n: number): Buffer => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    return b;
  };
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0);
    return b;
  };
  for (const e of entries) {
    const raw = Buffer.from(e.data);
    const body = e.deflate === true ? deflateRawSync(raw) : raw;
    const method = e.deflate === true ? 8 : 0;
    const name = Buffer.from(e.name);
    const local = Buffer.concat([Buffer.from("PK\x03\x04\x14\0\0\0", "latin1"), u16(method), u32(0), u32(0), u32(body.length), u32(raw.length), u16(name.length), u16(0), name, body]);
    const mode = e.mode ?? (e.name.endsWith("/") ? 0o040755 : 0o100644);
    central.push(Buffer.concat([Buffer.from("PK\x01\x02\x14\x03\x14\0\0\0", "latin1"), u16(method), u32(0), u32(0), u32(body.length), u32(raw.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(mode * 65536), u32(offset), name]));
    parts.push(local);
    offset += local.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.concat([Buffer.from("PK\x05\x06\0\0\0\0", "latin1"), u16(entries.length), u16(entries.length), u32(dir.length), u32(offset), u16(0)]);
  return Buffer.concat([...parts, dir, end]);
}


export const repoDiscord = join(import.meta.dir, "../../../../discord");

/** An executable that stands in for Electron: test/fakeelectron.ts under Bun. */
export function fakeElectron(dir: string): string {
  const bin = join(dir, "fake-electron");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fakeelectron.ts")}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** What the fake Electron is told to do, and what it was asked. */
export function plan(root: string, p: Record<string, unknown>): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "fake.json"), JSON.stringify(p));
}

export function fakeLog(root: string): Record<string, unknown>[] {
  const f = join(root, "fake.log");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
}

export async function until(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}


/** A sandbox with the fake Electron, the real shell folder, a Vencord on disk and, optionally, a signed-in account. */
export function rig(signedIn = true): { box: ReturnType<typeof sandbox>; root: string } {
  const box = sandbox();
  process.env.HARBOR_DISCORD_NO_CGROUP = "1";
  process.env.HARBOR_DISCORD_ELECTRON = fakeElectron(box.dir);
  process.env.HARBOR_DISCORD_SHELL = repoDiscord;
  const root = setup.root();
  mkdirSync(setup.vencordDir("abc"), { recursive: true });
  const v = new Vencords();
  v.current = "abc";
  v.checked = now();
  v.save();
  if (signedIn) writeFileSync(setup.accountPath(), JSON.stringify({ id: "1", username: "ana", name: "Ana", at: 1 }));
  return { box, root };
}

export interface Started {
  host: Host;
  running: Running;
  events: [Mode, Obj][];
  swap: { on: boolean };
}

export async function startHost(policy = new Policy(0, 20, 0, 8)): Promise<Started> {
  const events: [Mode, Obj][] = [];
  const swap = { on: true };
  let host: Host | undefined;
  const sink = (mode: Mode, m: Obj): void => {
    events.push([mode, m]);
    host?.event(mode, m);
  };
  host = new Host({ engine: new Electron(setup.profile(), sink), scratch: new Electron(join(setup.root(), "scratch"), sink), policy, swap: () => swap.on });
  host.chatDelay = 50;
  host.signalsRest = true;
  const running = await listen(host, 3_600_000);
  if (running === undefined) throw new Error("the host's lock is taken");
  return { host, running, events, swap };
}

/** An MCP client on `harbor app discord`'s stdio, in this process. */
export function mcpClient(): { rpc: (method: string, params?: unknown) => Promise<Record<string, unknown>>; close: () => void } {
  const input = new PassThrough();
  const output = new PassThrough();
  void serve(input, output);
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();
  let buf = "";
  output.setEncoding("utf8");
  output.on("data", (d: string) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
      buf = buf.slice(i + 1);
      waiting.get(m.id as number)?.(m);
    }
  });
  let id = 0;
  return {
    rpc: (method, params) =>
      new Promise((resolve) => {
        const n = ++id;
        waiting.set(n, resolve);
        input.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
      }),
    close: () => input.end(),
  };
}

export function toolText(r: Record<string, unknown>): string {
  const result = r.result as { content: { type: string; text?: string }[] };
  return result.content.map((c) => c.text ?? `[${c.type}]`).join("\n");
}
