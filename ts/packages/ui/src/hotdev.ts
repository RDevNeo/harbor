/**
 * Dev hot reload (`harbor hot on DIR`): watches a checkout's `ts/packages` and, on a save, builds the
 * reloadable units it touches from that checkout (Bun.build, tens of ms) and swaps them into the running
 * Harbor (store/src/hot.ts). Nothing restarts: open chats, running turns and drafts stay. A build or load
 * that fails keeps the version before it and says why.
 *
 * What a fresh build is made of:
 * - the unit's own file and every file it imports by path, from the checkout;
 * - but the running app's own instance of a file registered with `share` (same code, so its state is
 *   kept) unless that file changed since hot reload started, and always of one registered with `pin`
 *   (it holds state a copy would lose: a change to it says it needs a restart);
 * - `@harbor/*` packages and `slint-ui`: the running app's, with the exports of the package's files that
 *   changed since then (and aren't pinned) taken from the checkout.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import * as slint from "slint-ui";
import * as agents from "@harbor/agents";
import * as mcp from "@harbor/mcp";
import * as net from "@harbor/net";
import * as store from "@harbor/store";
import { hot, privateDir, runDir, stateDir } from "@harbor/store";
import * as markdown from "./markdown.ts";

export interface HotHost {
  /** A short line for the user (the window's toast). */
  notice(text: string): void;
  log(line: string): void;
}

export interface Timing {
  unit: string;
  file: string;
  /** From the save (the file's mtime) to the swap, and the parts of it. */
  total: number;
  build: number;
  load: number;
}

const pinned = new Map<string, object>();
const IDENT = /^[A-Za-z_$][\w$]*$/;

/** Registers the running app's instance of a file that holds state: fresh builds always use it. */
export function pin(rel: string, ns: object): void {
  pinned.set(rel, ns);
  hot.share(rel, ns);
}

/** The running app's own instances, for fresh builds to use (see the top of this file). */
export function shareHost(): void {
  hot.share("slint-ui", slint);
  hot.share("@harbor/store", store);
  hot.share("@harbor/net", net);
  hot.share("@harbor/agents", agents);
  hot.share("@harbor/mcp", mcp);
  // The link table clicks and selections are looked up in.
  pin("packages/ui/src/markdown.ts", markdown);
  // Caches and the engine's own state.
  pin("packages/agents/src/providers.ts", agents.providers);
  pin("packages/agents/src/engine.ts", agents.engine);
  const a = agents as unknown as Record<string, object>;
  for (const f of ["detach", "oauth", "agent", "git", "procs", "worktree", "recap", "team", "movechat", "openchat", "chatpr", "wtclean", "commits", "fork", "autowork", "memory", "waiting", "patches"]) {
    const ns = a[f];
    if (ns) hot.share(`packages/agents/src/${f}.ts`, ns);
  }
}

/** The file that turns hot reload on for this PC: {"dir": checkout}. */
export function settingFile(): string {
  return join(stateDir(), "hot.json");
}

/** The checkout hot reload follows on this PC, or null: HARBOR_HOT, else `harbor hot on`'s file. */
export function hotDir(env: Record<string, string | undefined> = process.env): string | null {
  if (env.HARBOR_HOT) return env.HARBOR_HOT;
  try {
    const j = JSON.parse(readFileSync(settingFile(), "utf8")) as { dir?: unknown };
    return typeof j.dir === "string" && j.dir !== "" ? j.dir : null;
  } catch {
    return null;
  }
}

/** `dir` or its `ts/`: the folder holding `packages/`. */
export function tsRoot(dir: string): string | null {
  for (const d of [join(dir, "ts"), dir]) if (existsSync(join(d, "packages", "store", "src", "hot.ts")) || existsSync(join(d, "packages", "ui", "src", "cards.ts"))) return resolve(d);
  return null;
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** When the file was last written; null once it's gone (its deletion is a change). */
function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export class HotDev {
  readonly ts: string;
  private watcher: FSWatcher | null = null;
  /** Each watched file's modification time at its last event. */
  private seen = new Map<string, number>();
  /** Files (relative to ts/) saved since hot reload started. */
  private readonly changed = new Set<string>();
  /** Per unit: the files its last build read, and the packages it took from the app. */
  private readonly reads = new Map<string, { files: Set<string>; pkgs: Set<string> }>();
  private pending = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy: Promise<void> = Promise.resolve();
  private seq = 0;
  private readonly out: string;
  readonly timings: Timing[] = [];
  /** Called after each swap that went through. */
  onSwapped: ((t: Timing) => void) | null = null;

  constructor(
    ts: string,
    private readonly host: HotHost,
    /** Only these units (tests); every registered one when absent. */
    private readonly only?: readonly string[],
  ) {
    // Its real path: the bundler resolves imports to real paths, so a checkout reached through a link
    // (macOS's /var is /private/var) would otherwise look outside itself.
    this.ts = realOr(ts);
    this.out = privateDir(join(runDir(), "hot"));
  }

  /** Builds every unit from the checkout once (so the app runs its code), then follows saves. */
  async start(): Promise<void> {
    rmSync(this.out, { recursive: true, force: true });
    mkdirSync(this.out, { recursive: true, mode: 0o700 });
    // Files written before the first build below are built from disk, so their events (FSEvents replays them) don't count.
    let since = Number.POSITIVE_INFINITY;
    this.watcher = watch(join(this.ts, "packages"), { recursive: true }, (_ev, file) => {
      if (typeof file !== "string" || !file.endsWith(".ts") || file.endsWith(".test.ts") || file.endsWith(".d.ts") || file.includes("/test/") || file.includes("node_modules")) return;
      const rel = `packages/${file}`;
      // macOS's FSEvents also reports writes from just before the watch began, and may report one save twice:
      // only saves made since count, each once (by the file's modification time).
      const at = mtimeOf(join(this.ts, rel));
      if (at !== null && (at < since || this.seen.get(rel) === at)) return;
      if (at !== null) this.seen.set(rel, at);
      if (!this.pending.has(rel)) this.pending.set(rel, Date.now());
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), 25);
    });
    since = Date.now();
    const ok: string[] = [];
    for (const u of this.units()) if (await this.reload(u.name, null, Date.now())) ok.push(u.name);
    this.host.log(`hot: following ${this.ts} (${ok.join(", ") || "no units"})`);
  }

  private units(): readonly hot.Unit<object>[] {
    return hot.all().filter((u) => this.only === undefined || this.only.includes(u.name));
  }

  /** Resolves once the saves seen so far are built and swapped (or failed). */
  async idle(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.flush();
    }
    await this.busy;
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
  }

  private flush(): void {
    const batch = this.pending;
    this.pending = new Map();
    this.busy = this.busy.then(() => this.apply(batch));
  }

  private async apply(batch: Map<string, number>): Promise<void> {
    const stale: string[] = [];
    for (const [rel, seen] of batch) {
      let at = seen;
      try {
        at = Math.min(seen, statSync(join(this.ts, rel)).mtimeMs);
      } catch {
        // deleted: units that read it rebuild and say what's missing
      }
      this.changed.add(rel);
      batch.set(rel, at);
      if (pinned.has(rel)) stale.push(rel);
    }
    for (const rel of stale) this.host.notice(`${rel.split("/").pop()} holds state Harbor keeps: restart to use the change`);
    for (const u of this.units()) {
      const r = this.reads.get(u.name);
      const hit = [...batch.keys()].filter((rel) => !pinned.has(rel) && (r === undefined || r.files.has(rel) || r.pkgs.has(pkgOf(rel) ?? "") || rel === u.entry));
      if (hit.length === 0) continue;
      const first = hit.reduce((a, b) => ((batch.get(a) ?? 0) <= (batch.get(b) ?? 0) ? a : b));
      await this.reload(u.name, first, batch.get(first) ?? Date.now());
    }
  }

  /** Builds `name` from the checkout and swaps it in; false (and a notice) when it can't. */
  async reload(name: string, file: string | null, savedAt: number): Promise<boolean> {
    const u = hot.all().find((x) => x.name === name);
    if (!u) return false;
    const t0 = performance.now();
    const files = new Set<string>();
    const pkgs = new Set<string>();
    try {
      const r = await Bun.build({ entrypoints: [join(this.ts, u.entry)], target: "bun", format: "esm", plugins: [this.plugin(files, pkgs)] });
      if (!r.success || r.outputs.length === 0) throw new Error(r.logs.map((l) => String(l)).join("\n") || "the build failed");
      const t1 = performance.now();
      const path = join(this.out, `${name.replace(/\W/g, "_")}.${++this.seq}.mjs`);
      await Bun.write(path, r.outputs[0] as Blob);
      const mod = (await import(path)) as object;
      rmSync(path, { force: true });
      const t2 = performance.now();
      this.reads.set(name, { files, pkgs });
      hot.swap(name, { ...mod });
      const t: Timing = { unit: name, file: file ?? u.entry, total: Math.round(Date.now() - savedAt), build: Math.round(t1 - t0), load: Math.round(t2 - t1) };
      this.timings.push(t);
      if (this.timings.length > 50) this.timings.shift();
      this.host.log(`hot: ${name} v${u.version} from ${t.file}: build ${t.build} ms, load ${t.load} ms, ${t.total} ms since the save`);
      this.onSwapped?.(t);
      return true;
    } catch (e) {
      if (files.size > 0) this.reads.set(name, { files, pkgs });
      const msg = e instanceof Error ? e.message : String(e);
      this.host.log(`hot: ${name} kept its last version: ${msg}`);
      this.host.notice(`Reload of ${u.entry.split("/").pop()} failed, kept the running version: ${firstLine(msg)}`);
      return false;
    }
  }

  private plugin(files: Set<string>, pkgs: Set<string>): Bun.BunPlugin {
    const ts = this.ts;
    const changed = this.changed;
    return {
      name: "harbor-hot",
      setup(b) {
        b.onResolve({ filter: /.*/ }, (args) => {
          const spec = args.path;
          if (args.namespace === "harbor-host" && spec.startsWith("/")) return { path: spec };
          if (spec.startsWith(".") || spec.startsWith("/")) {
            const base = args.importer.startsWith("/") ? dirname(args.importer) : ts;
            let abs: string;
            try {
              abs = Bun.resolveSync(spec, base);
            } catch {
              return undefined;
            }
            const rel = relative(ts, abs);
            if (rel.startsWith("..")) return { path: abs };
            if (pinned.has(rel) || (hot.sharedOf(rel) !== undefined && !changed.has(rel))) {
              files.add(rel);
              return { path: rel, namespace: "harbor-host" };
            }
            files.add(rel);
            return { path: abs };
          }
          if (hot.sharedOf(spec) !== undefined) {
            pkgs.add(spec);
            return { path: spec, namespace: "harbor-host" };
          }
          if (spec.startsWith("@harbor/")) throw new Error(`${spec} isn't shared with reloadable code (hotdev.ts shareHost)`);
          return undefined;
        });
        b.onLoad({ filter: /.*/, namespace: "harbor-host" }, (args) => ({ contents: hostModule(ts, args.path, changed), loader: "js" }));
      },
    };
  }
}

/** "@harbor/net" for a file of packages/net/src. */
function pkgOf(rel: string): string | null {
  const m = /^packages\/([^/]+)\/src\//.exec(rel);
  return m ? `@harbor/${m[1]}` : null;
}

/** A module that is the app's own instance of `key`, with a package's changed files' exports from the checkout. */
export function hostModule(ts: string, key: string, changed: ReadonlySet<string>): string {
  const ns = hot.sharedOf(key) ?? {};
  const lines = [`const H = globalThis.__harborHot.shared(${JSON.stringify(key)});`];
  const fresh = new Set<string>();
  const m = /^@harbor\/(.+)$/.exec(key);
  if (m) {
    const t = new Bun.Transpiler({ loader: "ts" });
    for (const rel of changed) {
      if (pkgOf(rel) !== key || pinned.has(rel)) continue;
      const abs = join(ts, rel);
      let names: string[];
      try {
        names = t.scan(readFileSync(abs, "utf8")).exports.filter((n) => IDENT.test(n) && n !== "default" && n in ns && !fresh.has(n));
      } catch {
        continue;
      }
      if (names.length === 0) continue;
      for (const n of names) fresh.add(n);
      lines.push(`export { ${names.join(", ")} } from ${JSON.stringify(abs)};`);
    }
  }
  for (const k of Object.keys(ns)) if (k !== "default" && IDENT.test(k) && !fresh.has(k)) lines.push(`export const ${k} = H.${k};`);
  if ("default" in ns) lines.push("export default H.default;");
  return lines.join("\n");
}

function firstLine(s: string): string {
  const l = s.split("\n").find((x) => x.trim() !== "") ?? s;
  return l.length > 160 ? `${l.slice(0, 160)}…` : l;
}
