// Recording the microphone for dictation. Linux records with PipeWire's or PulseAudio's own tools
// (media/src/voice.ts finds them); where Harbor records itself (macOS: CoreAudio; Windows: waveIn), it runs
// `harbor record-mic`, which writes 16 kHz mono signed 16-bit samples to stdout until it's stopped.
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
