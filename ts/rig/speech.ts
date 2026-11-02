import { readFileSync } from "node:fs";
const [exe, dir, wav] = process.argv.slice(2) as [string, string, string];
const b = readFileSync(wav);
const pcm = b.subarray(44);
const n = pcm.length / 2;
const p = Bun.spawn([exe, "--speech-worker"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
p.stdin.write(`${JSON.stringify({ op: "parakeet", dir, n })}\n`);
p.stdin.write(pcm);
await p.stdin.flush();
const r = p.stdout.getReader();
let text = "";
while (!text.includes("\n")) { const { value, done } = await r.read(); if (done) break; text += new TextDecoder().decode(value); }
console.log(text.trim());
p.stdin.end(); await p.exited;
