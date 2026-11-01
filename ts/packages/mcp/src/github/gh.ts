import { spawn } from "node:child_process";
import type { Dest } from "../ghapi.ts";
import { agentEnv } from "../mcp.ts";
import { childPath, which } from "../sys.ts";

export const GH_TIMEOUT = 90_000;

export interface GhOut {
  code: number;
  stdout: string;
  stderr: string;
}

export type GhRun = (args: string[]) => Promise<GhOut>;

export type MeshHttp = (dest: Dest, method: string, path: string, body: unknown, waitMs: number) => Promise<[status: number, body: unknown]>;

export class GhSpawnError extends Error {
  constructor(
    readonly kind: "missing" | "timeout" | "other",
    message: string,
  ) {
    super(message);
  }
}

async function ghEnv(): Promise<Record<string, string>> {
  const env: Record<string, string | undefined> = { ...process.env, PATH: childPath() };
  for (const [k, v] of await agentEnv()) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

/** Runs `gh` as Harbor's agents see it; the child is killed after `timeoutMs`. */
export function realGh(timeoutMs: number = GH_TIMEOUT): GhRun {
  return async (args) => {
    const bin = which("gh");
    if (bin === undefined) throw new GhSpawnError("missing", "No such file or directory (os error 2)");
    const env = await ghEnv();
    return new Promise<GhOut>((resolve, reject) => {
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let over = false;
      const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        over = true;
        child.kill("SIGKILL");
        reject(new GhSpawnError("timeout", `timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.stderr.on("data", (d: Buffer) => err.push(d));
      child.once("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(new GhSpawnError(e.code === "ENOENT" ? "missing" : "other", e.message));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (over) return;
        resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
      });
    });
  };
}

export const ghRun: GhRun = (args) => realGh()(args);

export function spawnText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function gh(args: string[], run: GhRun = ghRun): Promise<string> {
  let out: GhOut;
  try {
    out = await run(args);
  } catch (e) {
    throw new Error(`gh: ${spawnText(e)}`);
  }
  if (out.code !== 0) {
    const e = out.stderr.trim();
    throw new Error(e === "" ? "gh failed" : e);
  }
  return out.stdout;
}
