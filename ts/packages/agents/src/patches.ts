/**
 * User patches: small TypeScript files that add buttons over the composer (run a command, send a
 * message, open a page) and side panels (a web page, a list) to a project's chats. The format is in
 * patches.md, which Harbor also puts in ~/.harbor/patches/README.md for agents to read.
 *
 * A patch is code that runs in Harbor, so it runs only once the user has trusted that exact content
 * (its SHA-256): an edit asks again. It can import nothing but Node's and Bun's own modules, so the
 * hash covers all of it.
 */
import { paths as osPaths } from "@harbor/os";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import doc from "./patches.md" with { type: "text" };

export const PATCH_DOC = doc;
export const TRUST_KEY = "patch_trust";
const EXT = /\.(ts|js|mjs)$/;
const MAX_BYTES = 256 * 1024;
const LIVE_MS = 10_000;

export type ActionKind = "run" | "prompt" | "url";

export interface PatchAction {
  /** Stable across loads: the patch's file and the action's title. */
  id: string;
  title: string;
  kind: ActionKind;
  /** The command, the message or the URL. */
  value: string;
  icon: string;
  patch: string;
}

export interface PanelItem {
  title: string;
  detail?: string;
  section?: string;
  trailing?: string;
  /** Opened in the browser when the row is clicked. */
  url?: string;
}

export interface ItemsCtx {
  /** The chat's folder. */
  cwd: string;
  /** The folder holding the patch's `.harbor/` (home for ~/.harbor). */
  root: string;
  /** Runs `command` in `root` through bash -lc; resolves with what it printed, rejects on a non-zero exit. */
  sh(command: string): Promise<string>;
}

export interface PatchPanel {
  id: string;
  title: string;
  icon: string;
  url?: string;
  note?: string;
  items?: (ctx: ItemsCtx) => PanelItem[] | Promise<PanelItem[]>;
  patch: string;
}

export type PatchState = "trusted" | "untrusted" | "blocked" | "error";

export interface PatchFile {
  path: string;
  name: string;
  /** The folder holding its `.harbor/`. */
  root: string;
  hash: string;
  state: PatchState;
  /** Why it's blocked or failed. */
  error: string;
  actions: PatchAction[];
  panels: PatchPanel[];
}

export interface TrustStore {
  get(key: string): string | null | undefined;
  set(key: string, value: string): void;
}

/** The patch folders a chat in `cwd` gets: `.harbor/patches` in it and each folder above it up to (not including) home, the project's, then ~/.harbor/patches. */
export function patchDirs(cwd: string, project: string | null, home: string): string[] {
  const out: string[] = [];
  const add = (d: string) => {
    const p = join(d, ".harbor", "patches");
    if (!out.includes(p)) out.push(p);
  };
  const walk = (from: string) => {
    let d = resolve(from);
    const h = resolve(home);
    while (osPaths.under(d, h) !== "" && d !== dirname(d)) {
      add(d);
      d = dirname(d);
    }
  };
  if (cwd !== "") walk(cwd);
  if (project) walk(project);
  add(resolve(home));
  return out;
}

export function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Why a patch's source can't be trusted (the hash wouldn't cover what it runs); null when it can. */
export function blockedWhy(src: string): string | null {
  const t = new Bun.Transpiler({ loader: "ts" });
  let imports: { path: string }[];
  try {
    imports = t.scanImports(src);
  } catch (e) {
    return `it doesn't parse: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`;
  }
  const other = imports.find((i) => !/^(node:|bun$|bun:)/.test(i.path));
  if (other) return `it imports ${other.path}: a patch can import only node: and bun modules, so keep it in this one file`;
  if (/\b(import|require)\s*\(/.test(t.transformSync(src))) return "it loads code by a name worked out as it runs (import() or require()), which trusting the file can't cover";
  return null;
}

function trusted(store: TrustStore): Record<string, number> {
  try {
    const v: unknown = JSON.parse(store.get(TRUST_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function isTrusted(store: TrustStore, hash: string): boolean {
  return hash in trusted(store);
}

export function trust(store: TrustStore, hash: string): void {
  const t = trusted(store);
  t[hash] = Date.now();
  store.set(TRUST_KEY, JSON.stringify(t));
}

export function untrust(store: TrustStore, hash: string): void {
  const t = trusted(store);
  delete t[hash];
  store.set(TRUST_KEY, JSON.stringify(t));
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** A loaded patch module's actions and panels; throws with what's wrong. */
export function shape(mod: unknown, path: string): { actions: PatchAction[]; panels: PatchPanel[] } {
  const def = (mod as { default?: unknown } | null)?.default;
  if (!def || typeof def !== "object") throw new Error("it has no default export: export default { actions: [...], panels: [...] }");
  const d = def as Record<string, unknown>;
  const icon = str(d.icon);
  const actions: PatchAction[] = [];
  const list = (k: string): Record<string, unknown>[] => {
    const v = d[k];
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`${k} isn't a list`);
    return v.map((x, i) => {
      if (!x || typeof x !== "object") throw new Error(`${k}[${i}] isn't an object`);
      return x as Record<string, unknown>;
    });
  };
  for (const [i, a] of list("actions").entries()) {
    const title = str(a.title);
    if (title === "") throw new Error(`actions[${i}] has no title`);
    const kinds = (["run", "prompt", "url"] as const).filter((k) => str(a[k]) !== "");
    if (kinds.length !== 1) throw new Error(`"${title}" needs exactly one of run, prompt or url`);
    const kind = kinds[0] as ActionKind;
    const value = str(a[kind]);
    if (kind === "url" && !/^https?:\/\//i.test(value)) throw new Error(`"${title}": url must start with http:// or https://`);
    actions.push({ id: `${path}#${title}`, title: title.slice(0, 60), kind, value, icon: str(a.icon) || icon, patch: path });
  }
  const panels: PatchPanel[] = [];
  for (const [i, p] of list("panels").entries()) {
    const title = str(p.title);
    if (title === "") throw new Error(`panels[${i}] has no title`);
    const url = str(p.url);
    const items = typeof p.items === "function" ? (p.items as PatchPanel["items"]) : undefined;
    if ((url === "") === (items === undefined)) throw new Error(`panel "${title}" needs a url or an items function`);
    const panel: PatchPanel = { id: `${path}#panel:${title}`, title: title.slice(0, 60), icon: str(p.icon) || icon, patch: path };
    if (url !== "") panel.url = /^[a-z]+:\/\//i.test(url) ? url : `http://${url}`;
    if (items) panel.items = items;
    if (str(p.note) !== "") panel.note = str(p.note);
    panels.push(panel);
  }
  return { actions, panels };
}

/** Runs a list panel's command in `root`: what it printed; rejects on a non-zero exit or after 10 s. */
export async function sh(root: string, command: string): Promise<string> {
  const p = Bun.spawn(["bash", "-lc", command], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => p.kill(), LIVE_MS);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${command} exited ${code}: ${(err || out).trim().slice(-400)}`);
  return out;
}

/** A list panel's rows, at most 500; throws with why there are none. */
export async function panelItems(panel: PatchPanel, cwd: string, root: string): Promise<PanelItem[]> {
  if (!panel.items) return [];
  const work = Promise.resolve(panel.items({ cwd, root, sh: (c) => sh(root, c) }));
  const rows = await Promise.race([work, Bun.sleep(LIVE_MS).then(() => Promise.reject(new Error("it took longer than 10 s")))]);
  if (!Array.isArray(rows)) throw new Error("items didn't return a list");
  return rows.slice(0, 500).map((r) => {
    const o = (r ?? {}) as unknown as Record<string, unknown>;
    const row: PanelItem = { title: str(o.title) || String(r) };
    for (const k of ["detail", "section", "trailing", "url"] as const) if (str(o[k]) !== "") row[k] = str(o[k]);
    return row;
  });
}

interface Seen {
  mtime: number;
  size: number;
  file: PatchFile;
}

/**
 * Patch files as they are on disk, loaded once trusted. `scan` is cheap enough to call every second
 * or two: it reads a file again only when its size or mtime changed, and imports it only when its
 * content is trusted and new.
 */
export class Patches {
  private readonly seen = new Map<string, Seen>();
  private readonly loaded = new Map<string, { actions: PatchAction[]; panels: PatchPanel[] } | Error>();
  private readonly loading = new Map<string, Promise<void>>();
  /** Per file, its last version that loaded: kept on screen while a newer one fails. */
  private readonly good = new Map<string, { actions: PatchAction[]; panels: PatchPanel[] }>();
  /** A patch finished loading (or failing): scan again to see it. */
  onLoaded: ((f: PatchFile) => void) | null = null;

  constructor(private readonly store: TrustStore) {}

  scan(dirs: readonly string[]): PatchFile[] {
    const out: PatchFile[] = [];
    for (const dir of dirs) {
      let names: string[];
      try {
        names = readdirSync(dir).filter((n) => EXT.test(n) && !n.startsWith(".") && !n.endsWith(".d.ts")).sort();
      } catch {
        continue;
      }
      for (const n of names) {
        const f = this.file(join(dir, n));
        if (f) out.push(f);
      }
    }
    return out;
  }

  private file(path: string): PatchFile | null {
    let st: { mtimeMs: number; size: number; isFile(): boolean };
    try {
      st = statSync(path);
    } catch {
      this.seen.delete(path);
      return null;
    }
    if (!st.isFile()) return null;
    let s = this.seen.get(path);
    if (!s || s.mtime !== st.mtimeMs || s.size !== st.size) {
      const root = dirname(dirname(dirname(path)));
      const base: PatchFile = { path, name: basename(path).replace(EXT, ""), root, hash: "", state: "untrusted", error: "", actions: [], panels: [] };
      if (st.size > MAX_BYTES) base.state = "blocked";
      if (st.size > MAX_BYTES) base.error = "it's over 256 KB";
      else {
        const src = readFileSync(path, "utf8");
        base.hash = hashOf(src);
        const why = blockedWhy(src);
        if (why !== null) {
          base.state = "blocked";
          base.error = why;
        }
      }
      s = { mtime: st.mtimeMs, size: st.size, file: base };
      this.seen.set(path, s);
    }
    const f = s.file;
    if (f.state === "blocked") return f;
    if (!isTrusted(this.store, f.hash)) return { ...f, state: "untrusted", actions: [], panels: [] };
    const key = `${path}?${f.hash}`;
    const got = this.loaded.get(key);
    if (got === undefined) {
      this.load(key, f);
      return { ...f, state: "trusted" };
    }
    if (got instanceof Error) {
      const last = this.good.get(path);
      return { ...f, state: "error", error: got.message, actions: last?.actions ?? [], panels: last?.panels ?? [] };
    }
    this.good.set(path, got);
    return { ...f, state: "trusted", actions: got.actions, panels: got.panels };
  }

  private load(key: string, f: PatchFile): void {
    if (this.loading.has(key)) return;
    const job = (async () => {
      try {
        // The query makes each content a module of its own: Bun keeps the old one, which isn't used again.
        const mod: unknown = await import(`${f.path}?h=${f.hash.slice(0, 16)}`);
        this.loaded.set(key, shape(mod, f.path));
      } catch (e) {
        this.loaded.set(key, e instanceof Error ? e : new Error(String(e)));
      } finally {
        this.loading.delete(key);
        this.onLoaded?.(f);
      }
    })();
    this.loading.set(key, job);
  }

  /** Waits for every load in flight (tests). */
  async settled(): Promise<void> {
    while (this.loading.size > 0) await Promise.all([...this.loading.values()]);
  }

  trust(f: PatchFile): void {
    trust(this.store, f.hash);
  }
}

/** Puts the format's doc where agents read it: ~/.harbor/patches/README.md (only when it differs). */
export function writeDoc(home: string): string {
  const dir = join(home, ".harbor", "patches");
  const p = join(dir, "README.md");
  try {
    if (existsSync(p) && readFileSync(p, "utf8") === doc) return p;
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, doc);
  } catch {
    // a read-only home: agents still get the format from the prompt's pointer to Harbor's docs
  }
  return p;
}
