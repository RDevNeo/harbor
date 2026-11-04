import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as dictate from "../src/dictate.ts";
import * as parakeet from "../src/parakeet.ts";
import * as voice from "../src/voice.ts";

const FILES = ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt", "silero_vad.onnx"];

export interface ModelSource {
  dir: string;
  wavs: string;
}

/** A folder holding the Parakeet files and test_wavs/{en,de,es}.wav already on this PC, or null. */
export function findModel(): ModelSource | null {
  const candidates = [process.env.HARBOR_TEST_PARAKEET_DIR, join(homedir(), ".cache/hts/tmp/parakeet")];
  for (const c of candidates) {
    if (c && FILES.every((f) => existsSync(join(c, f))) && existsSync(join(c, "test_wavs/en.wav"))) return { dir: c, wavs: join(c, "test_wavs") };
  }
  return null;
}

export function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `hmedia-${prefix}-`));
}

export interface Sandbox {
  data: string;
  /** Back to the default settings, fetcher and worker command, keeping the data folder. */
  reset(): void;
  restore(): Promise<void>;
}

const offline: voice.Fetcher = async () => {
  throw new Error("no network in tests");
};

const ENV = ["XDG_DATA_HOME", "PATH", "HARBOR_WHISPER", "HARBOR_TEST_MEMAVAIL_MB", "HARBOR_SPEECH_THREADS"] as const;

/** An empty data folder as XDG_DATA_HOME, and a way back to the environment and the module state. */
export function sandbox(): Sandbox {
  const saved = ENV.map((k) => [k, process.env[k]] as const);
  const root = tmp("data");
  process.env.XDG_DATA_HOME = root;
  voice.setFetcher(offline);
  return {
    data: root,
    reset() {
      voice.setFetcher(offline);
      voice.setConfig("", "");
      dictate.set({ engine: "", cleanup: false, keepMin: 5 });
      dictate.setHost("");
      dictate.setWords({ commands: true, dict: [] });
      dictate.setAccount(null);
      parakeet.setWorkerCommand(null);
    },
    async restore() {
      this.reset();
      await voice.downloadSettled();
      voice.takeDownloadError();
      voice.downloading();
      voice.setFetcher(null);
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Links the Parakeet files into the sandbox's data folder, where Harbor looks for them. */
export function installModel(src: ModelSource): void {
  mkdirSync(parakeet.dir(), { recursive: true });
  for (const f of FILES) symlinkSync(join(src.dir, f), join(parakeet.dir(), f));
}

export function wavFile(src: ModelSource, name: string): Int16Array {
  return voice.wavSamples(readFileSync(join(src.wavs, `${name}.wav`)));
}

/** A recorder stand-in on PATH: prints `bytes` bytes of the file, then waits like pw-record does. */
export function fakeRecorder(bin: string, source: string, bytes: number): void {
  mkdirSync(bin, { recursive: true });
  const script = join(bin, "pw-record");
  writeFileSync(script, `#!/bin/sh\nhead -c ${bytes} '${source}'\nexec sleep 60\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}
