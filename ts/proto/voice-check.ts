import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { recognizer, transcribe } from "./voice.ts";

const [dir, ...wavs] = process.argv.slice(2);
if (!dir || wavs.length === 0) throw new Error("voice-check MODEL_DIR WAV...");

const rssMb = () => Number(readFileSync("/proc/self/status", "utf8").match(/VmRSS:\s+(\d+)/)?.[1] ?? 0) / 1024;

const t0 = performance.now();
const r = recognizer(dir, Math.min(4, cpus().length));
console.log(`load ${((performance.now() - t0) / 1000).toFixed(2)} s, rss ${rssMb().toFixed(0)} MB`);
for (const wav of wavs) {
  const t = performance.now();
  const text = transcribe(r, wav);
  console.log(`${wav.split("/").pop()}: ${((performance.now() - t) / 1000).toFixed(2)} s, rss ${rssMb().toFixed(0)} MB: ${text}`);
}
