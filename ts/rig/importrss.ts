// RSS after importing modules the way an entry does: bun rig/importrss.ts MODULE... (paths from ts/).
import { readFileSync } from "node:fs";
import { join } from "node:path";

const rss = () => Number(readFileSync("/proc/self/status", "utf8").match(/VmRSS:\s+(\d+)/)?.[1]) / 1024;
const before = rss();
for (const m of process.argv.slice(2)) await import(join(import.meta.dirname, "..", m));
Bun.gc(true);
console.log(JSON.stringify({ modules: process.argv.slice(2), before_mb: +before.toFixed(1), after_mb: +rss().toFixed(1) }));
