// phone.sh's report: where the TypeScript hub's answers differ from the Rust hub's, revisions aside.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "";
const read = (f: string): unknown => {
  const t = readFileSync(join(dir, f), "utf8");
  return t === "" ? null : (JSON.parse(t) as unknown);
};
const raw = (f: string) => readFileSync(join(dir, f), "utf8");

function walk(a: unknown, b: unknown, at: string, out: string[]): void {
  if (/\.(rev|updated_ms)$/.test(at)) return;
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) {
    out.push(`${at}: rust ${JSON.stringify(a)?.slice(0, 120)} | ts ${JSON.stringify(b)?.slice(0, 120)}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${at}: rust ${a.length} entries | ts ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) walk(a[i], b[i], `${at}[${i}]`, out);
    return;
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const x = a as Record<string, unknown>;
    const y = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (!(k in y)) out.push(`${at}.${k}: only in rust (${JSON.stringify(x[k])?.slice(0, 80)})`);
      else if (!(k in x)) out.push(`${at}.${k}: only in ts (${JSON.stringify(y[k])?.slice(0, 80)})`);
      else walk(x[k], y[k], `${at}.${k}`, out);
    }
    return;
  }
  if (a !== b) out.push(`${at}: rust ${JSON.stringify(a)} | ts ${JSON.stringify(b)}`);
}

for (const c of ["1", "2"]) {
  const out: string[] = [];
  walk(read(`rust-${c}.json`), read(`ts-${c}.json`), `chat${c}`, out);
  const norm = (s: string) => s.replace(/"rev":\d+/g, '"rev":0');
  const same = norm(raw(`rust-${c}.json`)) === norm(raw(`ts-${c}.json`));
  console.log(`== chat ${c} items: ${out.length} differences; bytes ${same ? "identical" : "differ"} (revisions aside)`);
  for (const l of out) console.log(`  ${l}`);
}
const out: string[] = [];
walk(read("rust-state.json"), read("ts-state.json"), "state", out);
console.log(`== /v1/state: ${out.length} differences`);
for (const l of out.slice(0, 60)) console.log(`  ${l}`);
