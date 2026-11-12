import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep as pathSep } from "node:path";
import { dataDir, now, privateDir, writePrivate } from "./paths.ts";
import type { Store } from "./store.ts";
import { clipMiddle } from "./text.ts";

/** Shorter values would hide common words in every output. */
export const MIN_LEN = 4;
/** What `run` keeps of each stream; the rest is read and dropped. */
const CAP = 1 << 20;
/** What the agent gets of the output. */
const SHOWN = 30_000;
/** The control socket waits 120 s for an answer. */
export const MAX_TIMEOUT = 110;
export const DEFAULT_TIMEOUT = 50;
export const DEFAULT_MINUTES = 15;
export const MAX_MINUTES = 24 * 60;

export interface Secret {
  name: string;
  description: string;
  value: string;
  updated: number;
}

export type AskKind = "value" | "use" | "env";

/** A card in a chat waiting for the user (kv `secret_asks`: no value in it). */
export interface Ask {
  id: string;
  chat: number;
  kind: AskKind;
  names: string[];
  reason: string;
  /** The agent that asked: "lead" or a sub-agent's name. */
  agent: string;
  /** How long the agent asked to use the keys. */
  minutes: number;
  how_to_get: string;
  /** A .env file in the chat's folder, and the variable the key goes in there. */
  env_file: string;
  env_var: string;
}

/** A chat's use of a key until `until` (kv `secret_grants`). */
export interface Grant {
  chat: number;
  name: string;
  until: number;
}

/** How long the user lets a chat use keys. */
export type Span = { kind: "minutes"; minutes: number } | { kind: "not" };

export const minutesSpan = (minutes: number): Span => ({ kind: "minutes", minutes });

export function spanLabel(span: Span, asked: number): string {
  if (span.kind === "not") return "Save only, no access";
  return span.minutes === asked ? `${minutesLabel(span.minutes)} (as asked)` : minutesLabel(span.minutes);
}

export function spans(asked: number): Span[] {
  return [asked, ...[5, 60].filter((m) => m < asked)].map(minutesSpan);
}

export function minutesLabel(m: number): string {
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} min`;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

export function askedMinutes(v: unknown): number {
  if (typeof v !== "number") return DEFAULT_MINUTES;
  return Math.min(MAX_MINUTES, Math.max(1, Math.round(v)));
}

export function grant(grants: Grant[], chat: number, names: readonly string[], span: Span, at: number): void {
  if (span.kind !== "minutes") return;
  const until = at + span.minutes * 60;
  for (let i = grants.length - 1; i >= 0; i--) {
    const g = grants[i];
    if (g && g.chat === chat && names.includes(g.name)) grants.splice(i, 1);
  }
  for (const name of names) grants.push({ chat, name, until });
}

export function ungranted(grants: readonly Grant[], chat: number, names: readonly string[], at: number): string[] {
  return names.filter((n) => !grants.some((g) => g.chat === chat && g.name === n && g.until > at));
}

export function expire(grants: Grant[], at: number): Grant[] {
  const gone = grants.filter((g) => g.until <= at);
  const kept = grants.filter((g) => g.until > at);
  grants.splice(0, grants.length, ...kept);
  return gone;
}

function jsonList(raw: string | null): unknown[] {
  if (raw === null) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function loadGrants(store: Store): Grant[] {
  const out: Grant[] = [];
  for (const g of jsonList(store.get("secret_grants"))) {
    if (!isRec(g)) return [];
    const chat = g.chat === undefined ? 0 : g.chat;
    const name = g.name === undefined ? "" : g.name;
    const until = g.until === undefined ? 0 : g.until;
    if (typeof chat !== "number" || typeof name !== "string" || typeof until !== "number") return [];
    out.push({ chat, name, until });
  }
  return out;
}

export function saveGrants(store: Store, grants: readonly Grant[]): void {
  store.set("secret_grants", JSON.stringify(grants.map((g) => ({ chat: g.chat, name: g.name, until: g.until }))));
}

export function loadAsks(store: Store): Ask[] {
  const out: Ask[] = [];
  for (const a of jsonList(store.get("secret_asks"))) {
    if (!isRec(a)) return [];
    const str = (k: string): string | null => (a[k] === undefined ? "" : typeof a[k] === "string" ? (a[k] as string) : null);
    const num = (k: string): number | null => (a[k] === undefined ? 0 : typeof a[k] === "number" ? (a[k] as number) : null);
    const kind = a.kind === undefined ? "value" : a.kind;
    const names = a.names === undefined ? [] : a.names;
    const [id, reason, agent, how, file, envVar] = [str("id"), str("reason"), str("agent"), str("how_to_get"), str("env_file"), str("env_var")];
    const [chat, minutes] = [num("chat"), num("minutes")];
    if (kind !== "value" && kind !== "use" && kind !== "env") return [];
    if (!Array.isArray(names) || !names.every((n): n is string => typeof n === "string")) return [];
    if (id === null || reason === null || agent === null || how === null || file === null || envVar === null || chat === null || minutes === null) return [];
    out.push({ id, chat, kind, names, reason, agent, minutes, how_to_get: how, env_file: file, env_var: envVar });
  }
  return out;
}

export function saveAsks(store: Store, asks: readonly Ask[]): void {
  store.set(
    "secret_asks",
    JSON.stringify(
      asks.map((a) => ({
        id: a.id,
        chat: a.chat,
        kind: a.kind,
        names: a.names,
        reason: a.reason,
        agent: a.agent,
        minutes: a.minutes,
        how_to_get: a.how_to_get,
        env_file: a.env_file,
        env_var: a.env_var,
      })),
    ),
  );
}

/** Known key formats: a prefix and the name such a key usually goes by. */
const KNOWN: readonly (readonly [string, string])[] = [
  ["sk-ant-", "ANTHROPIC_API_KEY"],
  ["sk-", "OPENAI_API_KEY"],
  ["github_pat_", "GITHUB_TOKEN"],
  ["ghp_", "GITHUB_TOKEN"],
  ["gho_", "GITHUB_TOKEN"],
  ["glpat-", "GITLAB_TOKEN"],
  ["boat_", "BOAT_API_KEY"],
  ["xoxb-", "SLACK_BOT_TOKEN"],
  ["sk_live_", "STRIPE_SECRET_KEY"],
  ["AKIA", "AWS_ACCESS_KEY_ID"],
  ["AIza", "GOOGLE_API_KEY"],
];

/** A word of `text` that looks like a known kind of key, and the name it would be saved as. */
export function pastedKey(text: string): [string, string] | null {
  for (const w of text.split(/[\s"'`=:,;()<>[\]{}]/)) {
    const hit = KNOWN.find(([p]) => w.startsWith(p));
    if (!hit) continue;
    const rest = w.slice(hit[0].length);
    const shaped = Buffer.byteLength(w) >= 20 && /^[A-Za-z0-9_-]*$/.test(rest) && /[0-9]/.test(rest);
    if (shaped) return [w, hit[1]];
  }
  return null;
}

export function secretsPath(dir: string = dataDir()): string {
  return join(privateDir(dir), "secrets.json");
}

function read(p: string): Secret[] {
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: Secret[] = [];
  for (const s of v) {
    if (!isRec(s) || typeof s.name !== "string" || typeof s.value !== "string") return [];
    const description = s.description === undefined ? "" : s.description;
    const updated = s.updated === undefined ? 0 : s.updated;
    if (typeof description !== "string" || typeof updated !== "number") return [];
    out.push({ name: s.name, description, value: s.value, updated });
  }
  return out;
}

function write(p: string, all: readonly Secret[]): void {
  const json = JSON.stringify(
    all.map((s) => ({ name: s.name, description: s.description, value: s.value, updated: s.updated })),
    null,
    2,
  );
  try {
    writePrivate(p, json);
  } catch (e) {
    throw new Error(`can't save ${p}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function load(path: string = secretsPath()): Secret[] {
  return read(path);
}

export function names(path: string = secretsPath()): Secret[] {
  return load(path).map((s) => ({ ...s, value: "" }));
}

/** An environment variable name: letters, digits and `_`, upper case, not starting with a digit ("boat-api-key" is BOAT_API_KEY). */
export function envName(s: string): string | null {
  const n = [...s.trim()].map((c) => (c === "-" || c === " " ? "_" : c.replace(/[a-z]/, (x) => x.toUpperCase()))).join("");
  const bytes = Buffer.byteLength(n);
  const ok = bytes >= 1 && bytes <= 64 && /^[A-Za-z0-9_]*$/.test(n) && !/^[0-9]/.test(n);
  return ok ? n : null;
}

/** Adds or replaces `name`; an empty `description` keeps the one it had. Returns the stored name. */
export function save(name: string, value: string, description: string, path: string = secretsPath()): string {
  const env = envName(name);
  if (env === null) throw new Error("A name has letters, digits and _ only, like BOAT_API_KEY.");
  const v = value.trim();
  if ([...v].length < MIN_LEN) throw new Error(`The value needs at least ${MIN_LEN} characters.`);
  const all = read(path);
  const d = description.trim();
  const found = all.find((s) => s.name === env);
  if (found) {
    found.value = v;
    if (d !== "") found.description = d;
    found.updated = now();
  } else {
    all.push({ name: env, description: d, value: v, updated: now() });
  }
  all.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  write(path, all);
  return env;
}

/** The account vault's copy of one key, as it is (its `updated` too), or its removal: what another PC of the account saved. */
export function put(name: string, secret: Secret | null, path: string = secretsPath()): void {
  const all = read(path).filter((s) => s.name !== name);
  if (secret !== null) all.push({ name, description: secret.description, value: secret.value, updated: secret.updated });
  all.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  write(path, all);
}

export function remove(name: string, path: string = secretsPath()): void {
  write(
    path,
    read(path).filter((s) => s.name !== name),
  );
}

/** A variable name as a .env file has it (case kept): letters, digits and `_`. */
export function envVarName(s: string): string | null {
  const n = s.trim();
  const bytes = Buffer.byteLength(n);
  const ok = bytes >= 1 && bytes <= 64 && /^[A-Za-z0-9_]*$/.test(n) && !/^[0-9]/.test(n);
  return ok ? n : null;
}

/** Where Harbor may write a key for `file`: a file named `.env` or `.env.*`, in a folder that exists inside `root` (symlinks resolved), and not itself a symlink. */
/** Whether `path` is `dir` or under it (Windows' separators and drive letters too). */
function within(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${pathSep}`) && !isAbsolute(rel));
}

export function envPath(root: string, file: string): string {
  const f = file.trim();
  const name = basename(f);
  if (name !== ".env" && !(name.startsWith(".env.") && name.length > 5)) throw new Error(`'${f}' isn't a .env file: only files named .env or .env.something`);
  if (f.split(/[\\/]/).includes("..")) throw new Error(`'${f}' goes outside the project`);
  let real: string;
  try {
    real = realpathSync(root);
  } catch (e) {
    throw new Error(`can't open the project folder ${root}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const full = isAbsolute(f) ? f : join(real, f);
  const parent = dirname(full);
  let dir: string;
  try {
    dir = realpathSync(parent);
  } catch {
    throw new Error(`the folder of '${f}' doesn't exist`);
  }
  if (!within(real, dir)) throw new Error(`'${f}' is outside the project (${real})`);
  const target = join(dir, name);
  let m: ReturnType<typeof lstatSync> | undefined;
  try {
    m = lstatSync(target);
  } catch {
    m = undefined;
  }
  if (m?.isSymbolicLink()) throw new Error(`'${f}' is a symlink; Harbor writes only plain files`);
  if (m && !m.isFile()) throw new Error(`'${f}' isn't a file`);
  return target;
}

/** `VAR=value`, quoted when the value needs it: single quotes keep everything as is, double quotes (with `\\`, `\"` and `\n`) when it holds a single quote or a line break. */
export function envLine(v: string, value: string): string {
  const plain = value !== "" && /^[A-Za-z0-9_\-./:+@,~%]*$/.test(value);
  if (plain) return `${v}=${value}`;
  if (!/['\n\r]/.test(value)) return `${v}='${value}'`;
  const q = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\r", "").replaceAll("\n", "\\n");
  return `${v}="${q}"`;
}

/** `text` (a .env file) with `v` set to `value`: its line replaced where it was (an `export ` before it kept), later copies dropped, or a line added at the end. */
export function setEnvVar(text: string, v: string, value: string): string {
  const line = envLine(v, value);
  const out: string[] = [];
  let done = false;
  // Rust's `str::lines`: splits on \n, drops a final empty piece and a \r before the \n.
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const raw of lines) {
    const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const t = l.trimStart();
    const exported = t.startsWith("export ");
    const rest = (exported ? t.slice(7) : t).trimStart();
    const isVar = rest.startsWith(v) && rest.slice(v.length).trimStart().startsWith("=");
    if (!isVar) out.push(l);
    else if (!done) {
      out.push(exported ? `export ${line}` : line);
      done = true;
    }
  }
  if (!done) out.push(line);
  return `${out.join("\n")}\n`;
}

/** Sets `v` in the .env file at `path` (from `envPath`); a new file is owner-only. */
export function writeEnv(path: string, v: string, value: string): void {
  let old = "";
  if (existsSync(path)) {
    try {
      old = readFileSync(path, "utf8");
    } catch (e) {
      throw new Error(`can't read ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  try {
    const fresh = !existsSync(path);
    writeFileSync(path, setEnvVar(old, v, value), { mode: 0o600 });
    if (fresh) chmodSync(path, 0o600);
  } catch (e) {
    throw new Error(`can't write ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function git(root: string, args: string[]): { ok: boolean; out: string } | null {
  const r = spawnSync("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  return r.error ? null : { ok: r.status === 0, out: r.stdout };
}

/** Whether git keeps `path` out of commits: null outside a git project; a tracked file is not ignored, whatever .gitignore says. */
export function gitIgnored(root: string, path: string): boolean | null {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (!top?.ok) return null;
  const dir = top.out.trim();
  if (git(dir, ["ls-files", "--error-unmatch", "--", path])?.ok) return false;
  return git(dir, ["check-ignore", "-q", "--no-index", "--", path])?.ok ?? false;
}

/** Adds `path` to the .gitignore at the top of its git project. */
export function addToGitignore(root: string, path: string): void {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (!top?.ok) throw new Error("not a git project");
  const dir = realpathSync(top.out.trim());
  if (!within(dir, path) || relative(dir, path) === "") throw new Error("the file is outside the git project");
  // .gitignore takes "/" whatever the system's separator.
  const rel = relative(dir, path).split(pathSep).join("/");
  const file = join(dir, ".gitignore");
  const old = existsSync(file) ? readFileSync(file, "utf8") : "";
  const sep = old === "" || old.endsWith("\n") ? "" : "\n";
  try {
    writeFileSync(file, `${old}${sep}/${rel}\n`);
  } catch (e) {
    throw new Error(`can't write ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64(b: Uint8Array): string {
  return Buffer.from(b).toString("base64");
}

/** The base64 characters that `value` alone decides, when it starts `skip` bytes into the encoded data: what shows inside a longer base64 text ("user:key" in a Basic header). */
export function b64Core(value: Uint8Array, skip: number): string {
  const data = new Uint8Array(skip + value.length);
  data.set(value, skip);
  const bits = data.length * 8;
  const first = Math.ceil((skip * 8) / 6);
  const end = Math.floor(bits / 6);
  let out = "";
  for (let i = first; i < end; i++) {
    let n = 0;
    for (let b = i * 6; b < i * 6 + 6; b++) n = (n << 1) | (((data[Math.floor(b / 8)] ?? 0) >> (7 - (b % 8))) & 1);
    out += B64[n];
  }
  return out;
}

const bytes = (s: string): Buffer => Buffer.from(s, "utf8");
const bcmp = (a: string, b: string): number => Buffer.compare(bytes(a), bytes(b));

/** `%2F` as `%2f`: some encoders write lower-case escapes. */
function lowerEscapes(url: string): string {
  let out = "";
  let left = 0;
  for (const c of url) {
    if (c === "%") {
      left = 2;
      out += c;
    } else if (left > 0) {
      left--;
      out += c.toLowerCase();
    } else out += c;
  }
  return out;
}

/** Every form `value` may take in output. */
export function forms(value: string): string[] {
  const b = bytes(value);
  const v = [value];
  const json = JSON.stringify(value);
  v.push(json.slice(1, -1));
  let url = "";
  for (const c of b) url += /[A-Za-z0-9\-._~]/.test(String.fromCharCode(c)) && c < 128 ? String.fromCharCode(c) : `%${c.toString(16).toUpperCase().padStart(2, "0")}`;
  v.push(lowerEscapes(url));
  v.push(url);
  const hex = [...b].map((c) => c.toString(16).padStart(2, "0")).join("");
  v.push(hex.toUpperCase());
  v.push(hex);
  for (let skip = 0; skip < 3; skip++) {
    const core = b64Core(b, skip);
    v.push(core.replaceAll("+", "-").replaceAll("/", "_"));
    v.push(core);
  }
  const kept = v.filter((f) => [...f].length >= MIN_LEN).sort(bcmp);
  return kept.filter((f, i) => i === 0 || f !== kept[i - 1]);
}

/** `text` with every form of each (name, value) replaced by `[hidden: NAME]`. Not a boundary: a command can re-encode a value, and agents run as the user, who can read the file. */
export function scrub(text: string, secrets: readonly (readonly [string, string])[]): string {
  const all = secrets.flatMap(([n, v]) => forms(v).map((f) => [f, n] as const));
  // Longest first: a value that holds another one goes whole.
  all.sort((a, b) => Buffer.byteLength(b[0]) - Buffer.byteLength(a[0]));
  let out = text;
  for (const [f, n] of all) if (out.includes(f)) out = out.split(f).join(`[hidden: ${n}]`);
  return out;
}

/** Output cut short (the cap, a timeout) may end partway through a value: that start goes too. */
export function dropPartial(text: string, secrets: readonly (readonly [string, string])[]): string {
  let out = bytes(text);
  for (const f of secrets.flatMap(([, v]) => forms(v))) {
    const fb = bytes(f);
    for (let n = fb.length - 1; n >= MIN_LEN - 1; n--) {
      if (n < fb.length && ((fb[n] ?? 0) & 0xc0) === 0x80) continue;
      if (out.length >= n && out.subarray(out.length - n).equals(fb.subarray(0, n))) {
        out = Buffer.concat([out.subarray(0, out.length - n), bytes("[hidden]")]);
        break;
      }
    }
  }
  return out.toString("utf8");
}

export interface RunOptions {
  /** The agent's environment: names set to a value, or removed when undefined. */
  env?: Record<string, string | undefined>;
  /** PATH for the command (default: this process's). */
  path?: string;
}

interface Drain {
  buf: Buffer[];
  size: number;
  over: boolean;
  closed: boolean;
  done: Promise<void>;
}

function drain(stream: ReadableStream<Uint8Array>): Drain {
  const d: Drain = { buf: [], size: 0, over: false, closed: false, done: Promise.resolve() };
  d.done = (async () => {
    try {
      for await (const chunk of stream) {
        const room = Math.min(Math.max(CAP - d.size, 0), chunk.length);
        if (room > 0) d.buf.push(Buffer.from(chunk.subarray(0, room)));
        d.size += room;
        if (room < chunk.length) d.over = true;
      }
    } finally {
      d.closed = true;
    }
  })();
  return d;
}

/** Runs `cmd` in `cwd` with `secrets` as environment variables; the output comes back scrubbed. Rejects when it couldn't start or ran out of time (the message holds what came). */
export async function run(
  cmd: string,
  cwd: string,
  secrets: readonly (readonly [string, string])[],
  timeoutMs: number,
  opts: RunOptions = {},
): Promise<string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  if (opts.path !== undefined) env.PATH = opts.path;
  for (const [k, v] of secrets) env[k] = v;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    // Its own session and group: a timeout ends whatever it started too.
    proc = Bun.spawn(["bash", "-lc", cmd], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  } catch (e) {
    throw new Error(`can't run bash: ${e instanceof Error ? e.message : String(e)}`);
  }
  const out = drain(proc.stdout as ReadableStream<Uint8Array>);
  const err = drain(proc.stderr as ReadableStream<Uint8Array>);
  const t0 = performance.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    spawnSync("kill", ["-KILL", "--", `-${proc.pid}`], { stdio: "ignore" });
    proc.kill("SIGKILL");
  }, timeoutMs);
  await proc.exited;
  clearTimeout(timer);
  // Something it started outside its group may hold the pipes open: what came so far.
  await Promise.race([Promise.all([out.done, err.done]), new Promise((r) => setTimeout(r, 2000))]);
  const finished = !timedOut;
  const text = (d: Drain): string => {
    const raw = Buffer.concat(d.buf).toString("utf8");
    const cut = !finished || d.over || !d.closed;
    const clean = scrub(raw, secrets);
    return cut ? dropPartial(clean, secrets) : clean;
  };
  const [stdout, stderr] = [text(out), text(err)];
  let body = stdout.trimEnd();
  if (stderr.trim() !== "") body += `\n--- stderr ---\n${stderr.trimEnd()}`;
  body = clipMiddle(body, SHOWN);
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  if (finished) {
    const code = proc.exitCode;
    return `${code === null ? "killed by a signal" : `exit code ${code}`} (${secs}s)\n${body}`;
  }
  throw new Error(`timed out after ${Math.floor(timeoutMs / 1000)}s and was stopped\n${body}`);
}
