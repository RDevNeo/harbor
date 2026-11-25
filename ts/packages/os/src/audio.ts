// Recording the microphone for dictation. Linux records with PipeWire's or PulseAudio's own tools
// (media/src/voice.ts finds them); where Harbor records itself (macOS: CoreAudio; Windows: waveIn), it runs
// `harbor record-mic`, which writes 16 kHz mono signed 16-bit samples to stdout until it's stopped. It also plays
// audio files natively (play, decode: Persons' voice messages).
import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { unlinkSync } from "node:fs";
import { platform } from "./platform.ts";

/** Whether Harbor records the microphone itself here (`record-mic`). */
export function available(): boolean {
  const p = platform();
  return p === "darwin" || p === "win32";
}

/** The command that records: Harbor itself (`self`, as spawn.selfArgv gives it) with `record-mic`. */
export function recorder(self: readonly string[]): { bin: string; args: string[] } | null {
  const [bin, ...rest] = self;
  return available() && bin !== undefined ? { bin, args: [...rest, "record-mic"] } : null;
}

/** `harbor record-mic`: records to stdout until the process is stopped; 1 when the microphone can't be used. */
export async function recordToStdout(): Promise<number> {
  if (!available()) {
    console.error("harbor record-mic: not on this system");
    return 2;
  }
  const mic: { record: (sink: (s: Uint8Array) => void) => () => void } =
    platform() === "win32" ? (require("./win32/mic.ts") as typeof import("./win32/mic.ts")) : (require("./darwin-mic.ts") as typeof import("./darwin-mic.ts"));
  let stop: () => void;
  try {
    stop = mic.record((samples) => process.stdout.write(samples));
  } catch (e) {
    console.error(`harbor record-mic: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  await new Promise<void>((resolve) => {
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => resolve());
    process.stdout.on("error", () => resolve());
  });
  stop();
  return 0;
}

// ---------- playing audio files (Persons' voice messages) ----------
// Native, no browser: ffmpeg decodes the file (from a position, at a speed) and the sound server plays the samples:
// PipeWire's pw-cat, PulseAudio's paplay or ALSA's aplay on Linux. Without those (macOS, Windows, a PC with no
// ffmpeg) a player that does both: mpv, else ffplay; macOS also afplay after ffmpeg wrote a WAV.


const RATE_OUT = 48_000;

export interface Playing {
  /** Stops it at once (no `onEnd`). */
  stop(): void;
}

const which = (name: string): string | null => Bun.which(name) as string | null;

/** How this PC plays a file ("ffmpeg+pw-cat", "mpv"…), or null when nothing here can. */
export function player(): string | null {
  const ff = which("ffmpeg");
  if (platform() === "linux" && ff) for (const s of ["pw-cat", "paplay", "aplay"]) if (which(s)) return `ffmpeg+${s}`;
  for (const p of ["mpv", "ffplay"]) if (which(p)) return p;
  if (platform() === "darwin" && ff && which("afplay")) return "ffmpeg+afplay";
  return null;
}

/** ffmpeg's tempo filter for a speed (0.5–2 in one atempo). */
const tempo = (speed: number): string => `atempo=${Math.min(2, Math.max(0.5, speed)).toFixed(2)}`;

/** The sink command reading raw s16le stereo at 48 kHz on stdin. */
function sinkArgs(sink: string): string[] {
  if (sink === "pw-cat") return ["pw-cat", "--playback", "--raw", "--format", "s16", "--rate", String(RATE_OUT), "--channels", "2", "--media-role", "Communication", "-"];
  if (sink === "paplay") return ["paplay", "--raw", "--format=s16le", `--rate=${RATE_OUT}`, "--channels=2"];
  return ["aplay", "-q", "-t", "raw", "-f", "S16_LE", "-r", String(RATE_OUT), "-c", "2"];
}

/**
 * Plays `file` from `at` seconds at `speed` (1, 1.5, 2…). `onEnd` runs once when it finishes or fails by itself
 * (`error` set when it couldn't play), never after `stop()`. Null when this PC has no way to play it.
 */
export function play(file: string, at: number, speed: number, onEnd: (error?: string) => void): Playing | null {
  const how = player();
  if (!how) return null;
  const start = Math.max(0, at).toFixed(2);
  const kids: ChildProcess[] = [];
  let over = false;
  let tmp: string | null = null;
  const finish = (error?: string): void => {
    if (over) return;
    over = true;
    for (const k of kids) if (k.exitCode === null) k.kill("SIGKILL");
    if (tmp) try { unlinkSync(tmp); } catch { /* gone */ }
    onEnd(error);
  };
  const quiet = { stdio: ["ignore", "ignore", "pipe"] as ("ignore" | "pipe")[] };
  const errText = (k: ChildProcess): (() => string) => {
    let e = "";
    k.stderr?.on("data", (b: Buffer) => { if (e.length < 2000) e += b.toString(); });
    return () => e.trim().split("\n").pop() ?? "";
  };
  if (how.startsWith("ffmpeg+") && how !== "ffmpeg+afplay") {
    const dec = spawnChild("ffmpeg", ["-nostdin", "-v", "error", "-ss", start, "-i", file, "-af", tempo(speed), "-f", "s16le", "-ac", "2", "-ar", String(RATE_OUT), "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
    const [bin, ...args] = sinkArgs(how.slice(7));
    const out = spawnChild(bin!, args, { stdio: ["pipe", "ignore", "pipe"] });
    kids.push(dec, out);
    const decErr = errText(dec), outErr = errText(out);
    dec.stdout?.pipe(out.stdin!);
    out.stdin?.on("error", () => {});
    dec.on("error", (e) => finish(e.message));
    out.on("error", (e) => finish(e.message));
    dec.on("exit", (code) => { if (code !== 0 && code !== null && !over) finish(decErr() || `ffmpeg exited ${code}`); });
    out.on("exit", (code) => finish(code === 0 || code === null ? undefined : outErr() || `${bin} exited ${code}`));
  } else if (how === "mpv" || how === "ffplay") {
    const args = how === "mpv"
      ? ["--no-video", "--really-quiet", "--no-terminal", `--start=${start}`, `--speed=${speed}`, file]
      : ["-nodisp", "-autoexit", "-loglevel", "error", "-ss", start, "-af", tempo(speed), file];
    const k = spawnChild(how, args, quiet);
    kids.push(k);
    const e = errText(k);
    k.on("error", (x) => finish(x.message));
    k.on("exit", (code) => finish(code === 0 || code === null ? undefined : e() || `${how} exited ${code}`));
  } else {
    // macOS without mpv / ffplay: a WAV from that position, then afplay at the speed
    tmp = joinPath(tmpdir(), `hub-audio-${process.pid}-${Date.now()}.wav`);
    const wav = tmp;
    const dec = spawnChild("ffmpeg", ["-nostdin", "-v", "error", "-y", "-ss", start, "-i", file, wav], quiet);
    kids.push(dec);
    dec.on("error", (x) => finish(x.message));
    dec.on("exit", (code) => {
      if (over) return;
      if (code !== 0) return finish(`ffmpeg exited ${code}`);
      const k = spawnChild("afplay", ["-r", String(speed), wav], quiet);
      kids.push(k);
      k.on("error", (x) => finish(x.message));
      k.on("exit", (c) => finish(c === 0 || c === null ? undefined : `afplay exited ${c}`));
    });
  }
  return {
    stop() {
      over = true;
      for (const k of kids) if (k.exitCode === null) k.kill("SIGKILL");
      if (tmp) try { unlinkSync(tmp); } catch { /* gone */ }
    },
  };
}

/**
 * A file decoded to mono signed 16-bit samples at `rate` (ffmpeg), at most `maxSecs`; null without ffmpeg. `low`:
 * background work, ffmpeg at the lowest CPU priority (nice 19 where there is `nice`).
 */
export async function decode(file: string, rate: number, maxSecs = 1200, low = false): Promise<Int16Array | null> {
  if (!which("ffmpeg")) return null;
  const nice = low && platform() !== "win32" ? which("nice") : null;
  return new Promise((resolve, reject) => {
    const args = ["-nostdin", "-v", "error", "-i", file, "-t", String(maxSecs), "-f", "s16le", "-ac", "1", "-ar", String(rate), "pipe:1"];
    const k = spawnChild(nice ?? "ffmpeg", nice ? ["-n", "19", "ffmpeg", ...args] : args, { stdio: ["ignore", "pipe", "pipe"] });
    const parts: Buffer[] = [];
    let err = "";
    k.stdout?.on("data", (b: Buffer) => parts.push(b));
    k.stderr?.on("data", (b: Buffer) => { if (err.length < 2000) err += b.toString(); });
    k.on("error", reject);
    k.on("exit", (code) => {
      if (code !== 0) return reject(new Error(err.trim().split("\n").pop() || `ffmpeg exited ${code}`));
      const b = Buffer.concat(parts);
      const out = new Int16Array(Math.floor(b.length / 2));
      for (let i = 0; i < out.length; i++) out[i] = b.readInt16LE(i * 2);
      resolve(out);
    });
  });
}
