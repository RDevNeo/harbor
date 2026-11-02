// The licence texts of the npm packages a release carries (release build, .github/boat/build.sh):
// every package bun installed for ts/, apart from the compiler and type packages, with its
// version, its declared licence and its LICENSE/NOTICE files. Usage: notices.ts OUTFILE
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const out = process.argv[2];
if (out === undefined) {
  console.error("usage: notices.ts OUTFILE");
  process.exit(2);
}

const store = new URL("../node_modules/.bun/", import.meta.url).pathname;
const devOnly = (name: string): boolean => name === "typescript" || name.startsWith("@types/") || name.startsWith("@typescript/") || name === "bun-types" || name === "undici-types";

const seen = new Map<string, string>();
for (const entry of readdirSync(store)) {
  const nm = join(store, entry, "node_modules");
  let names: string[];
  try {
    names = readdirSync(nm).flatMap((n) => (n.startsWith("@") ? readdirSync(join(nm, n)).map((m) => `${n}/${m}`) : [n]));
  } catch {
    continue;
  }
  for (const name of names) {
    if (devOnly(name)) continue;
    const dir = join(nm, name);
    let pkg: { name?: string; version?: string; license?: unknown };
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as typeof pkg;
    } catch {
      continue;
    }
    const id = `${pkg.name ?? name}@${pkg.version ?? "?"}`;
    if (seen.has(id)) continue;
    const texts = readdirSync(dir)
      .filter((f) => /^(licen[cs]e|copying|notice)/i.test(f) && statSync(join(dir, f)).isFile())
      .sort()
      .map((f) => readFileSync(join(dir, f), "utf8").trim());
    const licence = typeof pkg.license === "string" ? pkg.license : "see the text below";
    seen.set(id, `${id} (${licence})\n\n${texts.join("\n\n") || "(no licence file in the package)"}`);
  }
}

const sections = [...seen.keys()].sort().map((k) => seen.get(k));
const rule = `\n\n${"-".repeat(72)}\n\n`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `Harbor uses these npm packages (${sections.length}). Their licences follow.${rule}${sections.join(rule)}\n`);
console.log(`${sections.length} packages in ${out}`);
