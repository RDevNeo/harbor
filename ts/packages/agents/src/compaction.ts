// Long Claude sessions stay cheap: every local turn is a fresh `claude --resume`, which reloads the
// session file from its last compact boundary. Past COMPACT_OVER bytes of that, the turn's runner
// first runs Claude Code's own `/compact` on the session (same command line, same account), so
// this turn and the ones after it load a summary instead of the whole conversation. The chat keeps
// every message: only what Claude reloads is summarized.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { at, compact, optStr, parse, str } from "./json.ts";

/** Bytes after the last compact boundary past which a turn compacts the session first. */
export const COMPACT_OVER = 15_000_000;

/** COMPACT_OVER, or HARBOR_COMPACT_OVER's bytes (tests and rigs; the runner reads it too). */
export function threshold(): number {
  const v = Number(process.env.HARBOR_COMPACT_OVER ?? "");
  return Number.isFinite(v) && v > 0 ? v : COMPACT_OVER;
}

/** A compaction that takes longer is given up on, and the turn goes on uncompacted. */
export const COMPACT_TIMEOUT_MS = 10 * 60_000;

/** The `out` line type the runner writes about a compaction (start, then done). */
export const COMPACT_LINE = "harbor_compact";

/** Claude Code's marker line (JSON.stringify, so never with spaces). */
const NEEDLE = Buffer.from('"subtype":"compact_boundary"');
const CHUNK = 1 << 20;

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Harbor's side, at the turn's start: worth a look by the runner (only a stat: the scan is the runner's). */
export function mayNeed(path: string, over: number = threshold()): boolean {
  return sizeOf(path) > over;
}

/** Where the last compact boundary line of a Claude session file starts; 0 if it has none. Reads backwards from the end. */
export function lastBoundary(path: string): number {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return 0;
  }
  try {
    const size = fstatSync(fd).size;
    // Chunks overlap by the needle's length, so one split across two is still found.
    const buf = Buffer.alloc(CHUNK + NEEDLE.length);
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - CHUNK);
      const len = Math.min(end + NEEDLE.length, size) - start;
      const n = readSync(fd, buf, 0, len, start);
      const view = buf.subarray(0, n);
      let i = view.lastIndexOf(NEEDLE);
      while (i >= 0) {
        const line = lineAt(fd, start + i, size);
        if (line !== null) return line;
        i = i === 0 ? -1 : view.lastIndexOf(NEEDLE, i - 1);
      }
      end = start;
    }
    return 0;
  } finally {
    closeSync(fd);
  }
}

/** The start of the line holding `pos` when that line is a real compact boundary entry (not text quoting one). */
function lineAt(fd: number, pos: number, size: number): number | null {
  const back = Buffer.alloc(64 * 1024);
  const from = Math.max(0, pos - back.length);
  const n = readSync(fd, back, 0, pos - from, from);
  const nl = back.subarray(0, n).lastIndexOf(10);
  if (nl < 0 && from > 0) return null;
  const startAt = nl < 0 ? from : from + nl + 1;
  const fwd = Buffer.alloc(Math.min(256 * 1024, size - startAt));
  const m = readSync(fd, fwd, 0, fwd.length, startAt);
  const end = fwd.subarray(0, m).indexOf(10);
  const v = parse(fwd.subarray(0, end < 0 ? m : end).toString("utf8"));
  return str(at(v, "type")) === "system" && str(at(v, "subtype")) === "compact_boundary" ? startAt : null;
}

/** What `claude --resume` reloads of a session: the bytes from its last compact boundary on. */
export function liveBytes(path: string): number {
  const size = sizeOf(path);
  return size === 0 ? 0 : size - lastBoundary(path);
}

export interface Compacted {
  before: number;
  after: number;
  ok: boolean;
  error: string;
}

/** The `out` lines: `start` before the compaction, `done` after it. */
export function startLine(before: number): string {
  return `${compact({ type: COMPACT_LINE, state: "start", before })}\n`;
}

export function doneLine(c: Compacted): string {
  return `${compact({ type: COMPACT_LINE, state: "done", before: c.before, after: c.after, ok: c.ok, error: c.error })}\n`;
}

/** The stream-json message that makes Claude Code compact the session it resumed. */
export const COMPACT_MESSAGE = `${compact({ type: "user", message: { role: "user", content: [{ type: "text", text: "/compact" }] } })}\n`;

type SpawnOpts = Parameters<typeof Bun.spawn>[1];

/**
 * The runner's step before the turn: when `session` holds more than `over` bytes past its last
 * boundary, runs the turn's own Claude command line with `/compact` as its only message.
 * `emit` gets the `out` lines. Never throws: a failed compaction leaves the turn to run as before.
 */
export async function compactFirst(
  dir: string,
  session: string,
  run: { program: string; argv: string[]; cwd: string; env: Record<string, string | undefined> },
  emit: (line: string) => void,
  over: number = threshold(),
  timeoutMs: number = COMPACT_TIMEOUT_MS,
): Promise<Compacted | null> {
  const before = liveBytes(session);
  if (before <= over || existsSync(join(dir, "stopped"))) return null;
  emit(startLine(before));
  const outPath = join(dir, "compact.out");
  const errPath = join(dir, "compact.err");
  let error = "";
  try {
    const outFd = openSync(outPath, "a", 0o600);
    const errFd = openSync(errPath, "a", 0o600);
    try {
      const child = Bun.spawn([run.program, ...run.argv], { cwd: run.cwd, env: run.env, stdin: "pipe", stdout: outFd, stderr: errFd } as SpawnOpts);
      const stdin = child.stdin as { write(s: string): void; end(): unknown } | undefined;
      stdin?.write(COMPACT_MESSAGE);
      await stdin?.end();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3000).unref?.();
      }, timeoutMs);
      await child.exited;
      clearTimeout(timer);
      if (timedOut) error = `it took longer than ${Math.round(timeoutMs / 60_000)} minutes`;
      else error = resultError(outPath) ?? (child.exitCode === 0 ? "" : tail(errPath) || `claude exited with ${child.exitCode}`);
    } finally {
      closeSync(outFd);
      closeSync(errFd);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const after = liveBytes(session);
  const ok = error === "" && after < before;
  if (error === "" && !ok) error = "the session didn't get shorter";
  const c: Compacted = { before, after, ok, error };
  emit(doneLine(c));
  return c;
}

/** The error a `result` line of the compaction reported, if any. */
function resultError(path: string): string | null {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n").reverse()) {
    const v = parse(line);
    if (str(at(v, "type")) !== "result") continue;
    if (at(v, "is_error") !== true && at(v, "subtype") === "success") return null;
    return clip(optStr(at(v, "result")) ?? str(at(v, "subtype")));
  }
  return null;
}

function tail(path: string): string {
  try {
    const lines = readFileSync(path, "utf8").trim().split("\n");
    return clip(lines[lines.length - 1] ?? "");
  } catch {
    return "";
  }
}

const clip = (s: string): string => (s.length > 200 ? `${s.slice(0, 199)}…` : s);

/** "52 MB", "4.2 MB", "310 KB": sizes in the chat's notices. */
export function mb(n: number): string {
  if (n >= 10e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

/** The chat's notice while the session compacts, and once it has. */
export function compactingText(before: number): string {
  return `Compacting the session (${mb(before)}) before this turn`;
}

export function compactedText(c: Compacted): string {
  return c.ok ? `Session compacted (${mb(c.before)} → ${mb(c.after)})` : `Couldn't compact the session (${mb(c.before)}): ${c.error}`;
}

/** Claude Code's own compaction (`/compact` typed in the chat, or its automatic one), in tokens. */
export function claudeCompactedText(before: number, after: number): string {
  const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  return before > 0 ? `Claude Code compacted the conversation (${k(before)} → ${k(after)} tokens)` : "Claude Code compacted the conversation";
}

/** Whether a notice is one of these, and of which side: Harbor's (`harbor`) or Claude Code's (`claude`). */
export function compactNotice(text: string): "harbor" | "claude" | null {
  if (text.startsWith("Compacting the session") || text.startsWith("Session compacted") || text.startsWith("Couldn't compact the session")) return "harbor";
  if (text.startsWith("Claude Code compacted the conversation")) return "claude";
  return null;
}

export const COMPACT_DETAIL =
  "Claude Code reloads the whole session at every turn, so a long one costs memory and time each message. Harbor ran /compact: Claude now continues from a summary of the earlier conversation. This chat still shows every message.";
