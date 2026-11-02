import { spawn } from "node:child_process";

export interface ProcOutput {
  /** null: ended by a signal. */
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

export interface ProcOptions {
  timeoutMs: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Written to stdin, then closed; absent: stdin is /dev/null. */
  input?: Uint8Array;
}

/** Runs a program to its end (git.rs `output_within`); rejects when it can't start or `timeoutMs` passes, killing it. */
export type Spawner = (program: string, args: string[], o: ProcOptions) => Promise<ProcOutput>;

export const outputWithin: Spawner = (program, args, o) =>
  new Promise((resolve, reject) => {
    const env: Record<string, string | undefined> = { ...process.env, ...o.env };
    const c = spawn(program, args, { cwd: o.cwd, env: env as NodeJS.ProcessEnv, stdio: [o.input ? "pipe" : "ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    c.stdout?.on("data", (d: Buffer) => out.push(d));
    c.stderr?.on("data", (d: Buffer) => err.push(d));
    const timer = setTimeout(() => {
      c.kill("SIGKILL");
      reject(new Error(`timed out after ${Math.round(o.timeoutMs / 1000)}s`));
    }, o.timeoutMs);
    c.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    c.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
    if (o.input && c.stdin) {
      c.stdin.on("error", () => undefined);
      c.stdin.end(o.input);
    }
  });

/** The last non-blank line of some output, or "no answer". */
export function lastLine(b: Uint8Array | string): string {
  const t = typeof b === "string" ? b : Buffer.from(b).toString("utf8");
  return (
    t
      .split(/\r?\n/)
      .reverse()
      .find((l) => l.trim() !== "")
      ?.trim() ?? "no answer"
  );
}
