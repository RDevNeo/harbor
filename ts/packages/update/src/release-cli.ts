import { readFileSync, writeFileSync } from "node:fs";
import { buildManifest, lane, type Lane } from "./lane.ts";
import { parseManifest, type Manifest } from "./manifest.ts";

export interface ReleaseDeps {
  git: (args: string[]) => Promise<string>;
  readFile: (path: string) => string | null;
  writeFile: (path: string, data: string) => void;
  out: (line: string) => void;
  err: (line: string) => void;
}

export const nodeDeps = (): ReleaseDeps => ({
  git: async (args) => {
    const p = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
    return out;
  },
  readFile: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  writeFile: (p, d) => writeFileSync(p, d),
  out: (l) => console.log(l),
  err: (l) => console.error(l),
});

function opts(argv: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith("--")) m.set(a.slice(2), argv[i + 1]?.startsWith("--") === false ? (argv[++i] ?? "") : "true");
  }
  return m;
}

const isLane = (v: string | undefined): v is Lane => v === "bundle" || v === "runtime";

export async function releaseCli(argv: string[], d: ReleaseDeps = nodeDeps()): Promise<number> {
  const [cmd, ...rest] = argv;
  const o = opts(rest);
  if (cmd === "lane") {
    const forced = o.get("force");
    if (o.has("first")) {
      d.out("lane=runtime");
      d.err("the first TypeScript release carries the runtime");
      return 0;
    }
    const base = o.get("base");
    if (base === undefined) {
      d.err("lane needs --base <ref>");
      return 2;
    }
    const changed = (await d.git(["diff", "--name-only", `${base}...HEAD`])).split("\n").filter((l) => l !== "");
    const before = await d.git(["show", `${base}:ts/package.json`]).catch(() => null);
    const decided = lane({ changed, packageJson: { before, after: d.readFile("ts/package.json") } });
    const chosen = isLane(forced) ? forced : decided.lane;
    d.out(`lane=${chosen}`);
    for (const r of decided.reasons) d.err(r);
    if (isLane(forced) && forced !== decided.lane) d.err(`lane forced to ${forced}`);
    return 0;
  }
  if (cmd === "manifest") {
    const version = o.get("version");
    const chosen = o.get("lane");
    const out = o.get("out");
    if (version === undefined || !isLane(chosen) || out === undefined) {
      d.err("manifest needs --version, --lane bundle|runtime and --out");
      return 2;
    }
    const prevText = o.get("previous") === undefined ? null : d.readFile(o.get("previous") ?? "");
    let previous: Manifest | null = null;
    if (prevText !== null) previous = parseManifest(prevText);
    const code = o.get("apk-code");
    const manifest = buildManifest({
      version,
      lane: chosen,
      previous,
      ...(o.has("browser-id") ? { browser: { id: o.get("browser-id") ?? "" } } : {}),
      ...(o.has("video-id") ? { video: { id: o.get("video-id") ?? "" } } : {}),
      ...(code === undefined ? {} : { apk: { code: Number(code) } }),
    });
    d.writeFile(out, JSON.stringify(manifest));
    return 0;
  }
  d.err("usage: release.ts lane --base REF [--force LANE] [--first] | manifest --version V --lane LANE --out FILE [--previous FILE] [--browser-id ID] [--video-id ID] [--apk-code N]");
  return 2;
}
