import { type ChildProcess, spawn, type StdioOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomHex } from "@harbor/store";
import { agentEnv } from "./mcp.ts";
import { childPath } from "./sys.ts";

export const OUTPUT_MAX = 40_000;

export function hostname(): string {
  try {
    const s = readFileSync("/etc/hostname", "utf8").trim();
    if (s !== "") return s;
  } catch {
    // no /etc/hostname
  }
  return "this PC";
}

export function quote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

export function token(): string {
  return randomHex(18);
}

const ERRNO: Record<string, [number, string]> = {
  ENOENT: [2, "No such file or directory"],
  EACCES: [13, "Permission denied"],
  EEXIST: [17, "File exists"],
  ENOTDIR: [20, "Not a directory"],
  EISDIR: [21, "Is a directory"],
  ENOSPC: [28, "No space left on device"],
  EROFS: [30, "Read-only file system"],
  ENAMETOOLONG: [36, "File name too long"],
  EPERM: [1, "Operation not permitted"],
};

/** An error as Rust's io::Error prints it: "No such file or directory (os error 2)". */
export function osError(e: unknown): string {
  const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
  const known = ERRNO[code];
  if (known) return `${known[1]} (os error ${known[0]})`;
  return e instanceof Error ? e.message : String(e);
}

export async function agentProcessEnv(): Promise<Record<string, string>> {
  const env: Record<string, string | undefined> = { ...process.env, PATH: childPath() };
  for (const [k, v] of await agentEnv()) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

/** `bash -lc script` in `cwd` in a process group of its own (stopped as a whole). */
export async function shellCommand(script: string, cwd: string, stdio: StdioOptions): Promise<ChildProcess> {
  return spawn("bash", ["-lc", script], { cwd, env: await agentProcessEnv(), detached: true, stdio });
}

export function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // the group is gone already
  }
}

export class Tail {
  private chunks: Buffer[] = [];
  private size = 0;
  private cut = 0;

  push(b: Buffer): void {
    this.chunks.push(b);
    this.size += b.length;
    if (this.size > 2 * OUTPUT_MAX) {
      const all = Buffer.concat(this.chunks);
      const drop = all.length - OUTPUT_MAX;
      this.chunks = [all.subarray(drop)];
      this.size = OUTPUT_MAX;
      this.cut += drop;
    }
  }

  text(max: number): string {
    const all = Buffer.concat(this.chunks);
    let start = Math.max(0, all.length - max);
    while (start < all.length && ((all[start] ?? 0) & 0xc0) === 0x80) start++;
    const cut = this.cut + start;
    const text = all.subarray(start).toString("utf8");
    return cut === 0 ? text : `[… ${cut} bytes cut]\n${text}`;
  }
}

export type ShellResult = { kind: "exit"; code: number; text: string } | { kind: "stopped"; text: string } | { kind: "failed"; why: string; text: string };

const sleep = (ms: number): Promise<"late"> => new Promise((r) => setTimeout(() => r("late"), ms));

/** The output is only its end past OUTPUT_MAX; background children still holding the pipe are killed, or the call would never return. */
export async function shell(script: string, cwd: string, limitMs: number): Promise<ShellResult> {
  const child = await shellCommand(script, cwd, ["ignore", "pipe", "ignore"]);
  const out = child.stdout;
  const tail = new Tail();
  const outDone = new Promise<"done">((resolve) => {
    out?.on("data", (b: Buffer) => tail.push(b));
    out?.on("end", () => resolve("done"));
    out?.on("close", () => resolve("done"));
    out?.on("error", () => resolve("done"));
  });
  type Ended = { error: Error } | { code: number | null };
  const ended = new Promise<Ended>((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code) => resolve({ code }));
  });
  let stopped = false;
  const timer = setTimeout(() => {
    stopped = true;
    killGroup(child.pid);
  }, limitMs);
  const end = await ended;
  clearTimeout(timer);
  if ("error" in end) return { kind: "failed", why: `cannot run it in ${cwd}: ${osError(end.error)}`, text: "" };
  let note = "";
  if ((await Promise.race([outDone, sleep(500)])) === "late") {
    killGroup(child.pid);
    note = "\n[stopped the background processes still holding the output; redirect the output of ones that should keep running]";
    await Promise.race([outDone, sleep(2000)]);
  }
  out?.destroy();
  const text = tail.text(OUTPUT_MAX) + note;
  if (stopped) return { kind: "stopped", text };
  return { kind: "exit", code: end.code ?? -1, text };
}

export interface Captured {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

export function capture(program: string, args: string[], env: Record<string, string>): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const so: Buffer[] = [];
    const se: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => so.push(b));
    child.stderr.on("data", (b: Buffer) => se.push(b));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout: Buffer.concat(so), stderr: Buffer.concat(se) }));
  });
}
