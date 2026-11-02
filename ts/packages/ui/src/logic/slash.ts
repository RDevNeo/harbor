// Claude Code expands `/name` itself; other agents get the command's text in the prompt (`expand`).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { IconName } from "../icons.ts";
import { charList, cmpStr, isSpace, lines, matchIndices, takeChars, trimEndChars, trimStartChars, words } from "./text.ts";

/** Claude Code's list is asked again when the menu opens after this long. */
export const STALE_MS = 60_000;
/** A probe that hasn't answered by then is stopped. */
export const PROBE_TIMEOUT_MS = 20_000;

// Claude Code's commands that do nothing in a one-turn `claude -p` run, or that Harbor's own
// controls do (model, effort, fast mode, access; `/clear` starts a session Harbor wouldn't follow).
const HIDDEN: ReadonlySet<string> = new Set([
  "clear", "color", "config", "model", "effort", "fast", "focus", "heapdump", "mcp", "import", "rename", "output-style",
  "reload-plugins", "reload-skills", "usage-credits", "extra-usage", "agents", "auto-mode-setup", "autocompact", "advisor",
  "design", "design-consent", "design-revoke", "list-agents", "loop", "team-onboarding", "workflow-launch-exec",
]);

/** Harbor's own commands, by their name on the wire (the phone's `command`), in menu order. */
export type HarborCommand = "model" | "plan" | "default" | "effort" | "new" | "fork" | "settle" | "clear-queue";
const HARBOR_ORDER: readonly HarborCommand[] = ["model", "plan", "default", "effort", "new", "fork", "settle", "clear-queue"];

/** Where an entry comes from: its badge, and its rank among equal matches (this order). */
export type Scope = "harbor" | "project" | "personal" | "builtin" | "plugin";
const SCOPE_ORDER: readonly Scope[] = ["harbor", "project", "personal", "builtin", "plugin"];

export interface Entry {
  name: string;
  aliases: string[];
  description: string;
  /** What it takes after its name ("[low|medium|high]"). */
  hint: string;
  scope: Scope;
  /** The Harbor command, for scope "harbor"; null otherwise. */
  command: HarborCommand | null;
  /** A skill's folder (`.claude/skills/x`), not a command's file. */
  skill: boolean;
}

function harbor(command: HarborCommand, description: string): Entry {
  return { name: command, aliases: [], description, hint: "", scope: "harbor", command, skill: false };
}

function scopeRank(e: Entry): number {
  return e.command !== null ? HARBOR_ORDER.indexOf(e.command) : HARBOR_ORDER.length + SCOPE_ORDER.indexOf(e.scope);
}

export function badge(e: Entry): { icon: IconName; label: string } {
  switch (e.scope) {
    case "harbor":
      return { icon: "SLIDERS", label: "Harbor" };
    case "builtin":
      return { icon: "TERMINAL", label: "Built-in" };
    case "plugin":
      return { icon: "PLUG", label: "Plugin" };
    case "project":
      return { icon: "FOLDER", label: e.skill ? "Project skill" : "Project command" };
    case "personal":
      return { icon: "USER_ROUND", label: e.skill ? "Personal skill" : "Personal command" };
  }
}

/** The menu row's tooltip: how it's written, then what it does. */
export function entryTip(e: Entry): string {
  const usage = e.hint === "" ? `/${e.name}` : `/${e.name} ${e.hint}`;
  return `${usage}\n\n${e.description}`;
}

export function entryLine(e: Entry): string {
  return lines(e.description)[0] ?? "";
}


/** A command or skill read from a `.claude` folder. */
export interface Local {
  /** As Claude Code names it: `a:b` for `commands/a/b.md`; a skill's front matter `name`, else its folder's. */
  name: string;
  description: string;
  body: string;
  /** A skill's folder; null for a command (one `.md` file). */
  skill: string | null;
}

/** The skill's folder name when it differs from `name` (Claude Code takes both). */
export function localAlias(l: Local): string | null {
  if (l.skill === null) return null;
  const dir = basename(l.skill);
  return dir !== "" && dir !== l.name ? dir : null;
}

function localEntry(l: Local, scope: Scope): Entry {
  const alias = localAlias(l);
  return { name: l.name, aliases: alias === null ? [] : [alias], description: l.description, hint: "", scope, command: null, skill: l.skill !== null };
}

/** Front matter's `name:` and `description:` (block scalars folded into one line), and the text after it. */
export function front(raw: string): { name: string; description: string; body: string } {
  const text = raw.replaceAll("\r\n", "\n");
  const rest = text.startsWith("---\n") ? text.slice(4) : null;
  const cut = rest === null ? -1 : rest.indexOf("\n---");
  if (rest === null || cut < 0) return { name: "", description: "", body: text };
  const head = lines(rest.slice(0, cut));
  const body = rest.slice(cut + 4);
  const field = (key: string): string => {
    const i = head.findIndex((l) => l.startsWith(key) && l.charAt(key.length) === ":");
    const line = head[i];
    if (line === undefined) return "";
    const v = line.slice(key.length + 1).trim();
    if (v.startsWith(">") || v.startsWith("|")) {
      const more: string[] = [];
      for (const l of head.slice(i + 1)) {
        if (!(l.startsWith(" ") || l.startsWith("\t") || l.trim() === "")) break;
        if (l.trim() !== "") more.push(l.trim());
      }
      return more.join(" ");
    }
    const quoted = v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")));
    return quoted ? v.slice(1, -1) : v;
  };
  return { name: field("name"), description: field("description"), body: trimStartChars(body, "-\n") };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function read(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function mdFiles(dir: string, out: string[]): void {
  for (const name of list(dir)) {
    const p = join(dir, name);
    if (isDir(p)) mdFiles(p, out);
    else if (name.endsWith(".md") && name !== ".md") out.push(p);
  }
}

// Paths compare by their components, as Rust's `PathBuf` does.
function cmpPath(a: string, b: string): number {
  const x = a.split(sep);
  const y = b.split(sep);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const c = cmpStr(x[i] ?? "", y[i] ?? "");
    if (c !== 0) return c;
  }
  return x.length - y.length;
}

/** The commands (`commands/**\/*.md`) and skills (`skills/*\/SKILL.md`) of a `.claude` folder, commands first, each sorted by path. */
export function scan(base: string): Local[] {
  const v: Local[] = [];
  const cdir = join(base, "commands");
  const files: string[] = [];
  mdFiles(cdir, files);
  files.sort(cmpPath);
  for (const f of files) {
    const text = read(f);
    if (text === null) continue;
    const name = relative(cdir, f).slice(0, -".md".length).split(sep).join(":");
    const fm = front(text);
    const first = lines(fm.body).map((l) => trimStartChars(l, "#").trim()).find((l) => l !== "") ?? "";
    v.push({ name, description: fm.description === "" ? takeChars(first, 120) : fm.description, body: fm.body, skill: null });
  }
  const sdir = join(base, "skills");
  const skills = list(sdir).map((n) => join(sdir, n)).filter((d) => isFile(join(d, "SKILL.md")));
  skills.sort(cmpPath);
  for (const d of skills) {
    const text = read(join(d, "SKILL.md"));
    if (text === null) continue;
    const fm = front(text);
    v.push({ name: fm.name === "" ? basename(d) : fm.name, description: fm.description, body: fm.body, skill: d });
  }
  return v;
}

/** A command's text for `args`: in place of `$ARGUMENTS`, or after it. */
export function withArgs(body: string, args: string): string {
  if (body.includes("$ARGUMENTS")) return body.replaceAll("$ARGUMENTS", args);
  return args === "" ? body : `${body}\n\nArguments: ${args}`;
}

/** The prompt for an agent that doesn't expand these itself: a leading `/command args` becomes the command's text, and every `/skill` named gets its instructions before the message. */
export function expand(text: string, locals: readonly Local[]): string {
  const find = (name: string): Local | undefined => locals.find((l) => l.name === name || localAlias(l) === name);
  if (text.startsWith("/")) {
    const rest = text.slice(1);
    const ws = rest.search(/\s/u);
    const name = ws < 0 ? rest : rest.slice(0, ws);
    const args = ws < 0 ? "" : rest.slice(ws + 1);
    const c = find(name);
    if (c !== undefined && c.skill === null) return withArgs(c.body, args.trim());
  }
  const blocks: string[] = [];
  const seen: string[] = [];
  for (const raw of words(text)) {
    const word = trimEndChars(raw, ",.;:!?)");
    const s = word.startsWith("/") ? find(word.slice(1)) : undefined;
    if (s === undefined || seen.includes(s.name) || s.skill === null) continue;
    seen.push(s.name);
    blocks.push(`[skill /${s.name}: follow it for this message. Its other files are in ${s.skill}]\n\n${s.body.trim()}`);
  }
  if (blocks.length === 0) return text;
  return `${blocks.join("\n\n---\n\n")}\n\n---\n\n${text}`;
}


function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The commands in Claude Code's answer to `initialize`; null for other lines. */
export function parseInitialize(line: string): Entry[] | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  const top = obj(v);
  if (top.type !== "control_response") return null;
  const list = obj(obj(top.response).response).commands;
  if (!Array.isArray(list)) return null;
  return list
    .map(obj)
    .filter((c) => typeof c.name === "string")
    .map((c): Entry => {
      const desc = str(c.description);
      const suffix = [" (project)", " (user)"].find((s) => desc.endsWith(s));
      return {
        name: str(c.name),
        aliases: Array.isArray(c.aliases) ? c.aliases.filter((x): x is string => typeof x === "string") : [],
        description: suffix === undefined ? desc : desc.slice(0, -suffix.length),
        hint: str(c.argumentHint),
        scope: c.builtin === true ? "builtin" : "plugin",
        command: null,
        skill: false,
      };
    });
}

const PROBE_ARGS = [
  "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--strict-mcp-config", "--no-session-persistence", "--settings", '{"disableAllHooks":true}',
];
const ASK = '{"type":"control_request","request_id":"harbor-slash","request":{"subtype":"initialize"}}';

/** Asks Claude Code (`bin`, run in `cwd`) for its commands: a short run with no hooks, no MCP servers and no session. */
export async function probe(bin: string, cwd: string, env: Readonly<Record<string, string | null>>, timeoutMs = PROBE_TIMEOUT_MS): Promise<Entry[] | null> {
  const full: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) full[k] = v;
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete full[k];
    else full[k] = v;
  }
  const spawn = () => {
    try {
      return Bun.spawn([bin, ...PROBE_ARGS], { cwd, env: full, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    } catch {
      return null;
    }
  };
  const child = spawn();
  if (child === null) return null;
  // Stdin stays open (it would end the run) until the answer, or the timeout.
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    child.stdin.write(`${ASK}\n`);
    await child.stdin.flush();
    const reader = child.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      buf += done ? dec.decode() : dec.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0 || (done && buf !== "")) {
        const line = nl >= 0 ? buf.slice(0, nl) : buf;
        buf = nl >= 0 ? buf.slice(nl + 1) : "";
        const found = parseInitialize(line.endsWith("\r") ? line.slice(0, -1) : line);
        if (found !== null) return found;
        nl = buf.indexOf("\n");
      }
      if (done) return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}


/** What an agent offers that the menu depends on: its effort levels and access levels (ids, first is the default). */
export interface AgentModes {
  efforts: readonly string[];
  access: readonly string[];
}

/** What the menu knows of an existing chat (the draft has none). */
export interface SlashChat {
  /** Its last reply can be forked. */
  forkable: boolean;
  settled: boolean;
  /** Messages wait for its running turn. */
  queued: boolean;
}

/** What the menu offers. */
export function entries(
  agent: AgentModes,
  remote: boolean,
  access: string,
  chat: SlashChat | null,
  cli: readonly Entry[] | null,
  project: readonly Local[],
  personal: readonly Local[],
): Entry[] {
  const out: Entry[] = [harbor("model", "Switch the model for this chat")];
  if (agent.efforts.length > 0) out.push(harbor("effort", "Change how hard the agent thinks"));
  if (access === "plan") out.push(harbor("default", "Switch this chat back from read only"));
  else if (agent.access.includes("plan")) out.push(harbor("plan", "Switch this chat to read only: it reads and plans, changes nothing"));
  if (chat !== null) {
    out.push(harbor("new", "Start a new chat in this project"));
    if (chat.forkable) out.push(harbor("fork", "Fork this chat after its last reply into a new chat"));
    if (!chat.settled) out.push(harbor("settle", "Mark this chat settled: done, out of the way in the sidebar"));
    if (chat.queued) out.push(harbor("clear-queue", "Drop the messages waiting for the running turn"));
  }
  const files: [Local, Scope][] = [...project.map((l): [Local, Scope] => [l, "project"]), ...personal.map((l): [Local, Scope] => [l, "personal"])];
  for (const e of cli ?? []) {
    const hidden = HIDDEN.has(e.name) || e.name.startsWith("__") || e.description.startsWith("(removed)") || e.description.startsWith("Renamed to");
    if ((e.scope === "builtin" && hidden) || (remote && e.scope !== "builtin")) continue;
    const copy: Entry = { ...e, aliases: [...e.aliases] };
    // Claude Code doesn't say which are the user's skills; the files do.
    const f = files.find(([l]) => l.name === e.name);
    if (f !== undefined) {
      copy.scope = f[1];
      copy.command = null;
      copy.skill = f[0].skill !== null;
    }
    out.push(copy);
  }
  // Files Claude Code didn't list: new since it was asked, or all of them for other agents and other devices.
  for (const [l, scope] of files) {
    if (!out.some((e) => e.name === l.name || e.aliases.includes(l.name))) out.push(localEntry(l, scope));
  }
  return out;
}

/** The `/word` being typed: the chars from its slash to the end of the word (positions in chars). */
export interface Word {
  start: number;
  end: number;
  query: string;
  /** It begins the message: commands only run there, skills anywhere. */
  first: boolean;
}

/** The `/word` at char `cursor` of `text`, if the cursor is in one. */
export function word(text: string, cursor: number): Word | null {
  const cs = charList(text);
  const cur = Math.min(cursor, cs.length);
  let start = 0;
  for (let i = cur - 1; i >= 0; i--) {
    if (isSpace(cs[i])) {
      start = i + 1;
      break;
    }
  }
  if (cs[start] !== "/" || start === cur) return null;
  let end = cs.length;
  for (let i = cur; i < cs.length; i++) {
    if (isSpace(cs[i])) {
      end = i;
      break;
    }
  }
  return { start, end, query: cs.slice(start + 1, cur).join(""), first: cs.slice(0, start).every((c) => isSpace(c)) };
}

/** `text` with the word replaced by `withText` and a space after it (none for an empty `withText`, which also takes the space after the word); the cursor after it, in chars. */
export function replace(text: string, w: { start: number; end: number }, withText: string): { text: string; cursor: number } {
  const cs = charList(text);
  const before = cs.slice(0, w.start).join("");
  let after = cs.slice(Math.min(w.end, cs.length));
  if (after[0] === " ") after = after.slice(1);
  const put = withText === "" ? "" : `${withText} `;
  return { text: before + put + after.join(""), cursor: w.start + charList(put).length };
}

// Its letters in order, fewer skipped first; null when they aren't all there.
function gapsInOrder(hay: string, q: string): number | null {
  const rest = charList(hay);
  let at = 0;
  let gaps = 0;
  for (const c of q) {
    for (;;) {
      const x = rest[at++];
      if (x === undefined) return null;
      if (x === c) break;
      gaps++;
    }
  }
  return gaps;
}

/** How well `query` matches (lower is better), as T3 Code ranks: the name exactly, then as a prefix, at a word boundary, anywhere, in order; then the description. */
export function score(e: Entry, query: string): number | null {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const name = (raw: string): number | null => {
    const n = raw.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 2;
    if (matchIndices(n, q).some((i) => i > 0 && "-_:/".includes(n.charAt(i - 1)))) return 4;
    if (n.includes(q)) return 6;
    const g = gapsInOrder(n, q);
    return g === null ? null : 100 + g;
  };
  const desc = e.description.toLowerCase();
  const inDesc = desc.startsWith(q) ? 22 : desc.includes(q) ? 26 : null;
  const all = [name(e.name), ...e.aliases.map((x) => {
    const s = name(x);
    return s === null ? null : s + 1;
  }), inDesc].filter((s): s is number => s !== null);
  return all.length === 0 ? null : Math.min(...all);
}

/** The entries for `w`, best first. */
export function search(all: readonly Entry[], w: Word): Entry[] {
  const v: [number, Entry][] = [];
  for (const e of all) {
    if (!(w.first || e.skill || e.scope === "harbor" || e.scope === "plugin")) continue;
    const s = score(e, w.query);
    if (s !== null) v.push([s, e]);
  }
  v.sort(([sa, a], [sb, b]) => sa - sb || scopeRank(a) - scopeRank(b) || cmpStr(a.name, b.name));
  return v.map((x) => x[1]);
}

/** Whether Harbor puts the commands' and skills' text in for an agent: not for Claude Code on this PC (`device` empty), which expands them itself. */
export function expands(kind: string | null, device: string): boolean {
  return !(kind === "claude" && device === "");
}

/** The access /plan or /default leaves a chat with; `before` is what it had before /plan. */
export function accessAfter(h: HarborCommand, agent: AgentModes, before: string | null): string {
  if (h === "plan") return "plan";
  return before !== null && before !== "plan" ? before : (agent.access[0] ?? "full");
}

/** The user's own `.claude` folder for an account: a Claude account's config dir, else ~/.claude. */
export function personalDir(account: { kind: string; configDir: string | null } | null, home: string): string {
  return account !== null && account.kind === "claude" && account.configDir !== null ? account.configDir : join(home, ".claude");
}

/** An entry as the phone API sends it (android/PROTOCOL.md, `GET /v1/chats/{id}/slash`). */
export function entryJson(e: Entry): {
  name: string;
  aliases: string[];
  description: string;
  hint: string;
  source: Scope;
  skill: boolean;
  badge: string;
  command: HarborCommand | null;
} {
  return { name: e.name, aliases: e.aliases, description: e.description, hint: e.hint, source: e.scope, skill: e.skill, badge: badge(e).label, command: e.command };
}

/** `POST /v1/chats/{id}/slash`'s `command`: one that acts on the PC, or the error to answer. */
export function apiCommand(command: unknown): { command: "plan" | "default" | "fork" | "settle" | "clear-queue" } | { status: number; error: string } {
  switch (command) {
    case "plan":
    case "default":
    case "fork":
    case "settle":
    case "clear-queue":
      return { command };
    case "model":
    case "effort":
    case "new":
      return { status: 400, error: `/${command} is picked on the phone: update Harbor there` };
    default:
      return { status: 400, error: "command is plan, default, fork, settle or clear-queue" };
  }
}

/** An entry picked for `w` in `draft`: the new text and cursor, the token written (for the composer's picked list), and the Harbor command to run (its word is taken out). */
export function accept(draft: string, w: Word, e: Entry): { text: string; cursor: number; token: string; command: HarborCommand | null } {
  const token = e.command !== null ? "" : `/${e.name}`;
  return { ...replace(draft, w, token), token, command: e.command };
}

/** The text a chat's agent gets for the user's `text`, `tags` after it: as is for Claude Code here, which expands slash commands itself; with the commands and skills of the project's `.claude` folder (in `cwd`) and the `personal` one put in for other agents. */
export function slashPrompt(text: string, tags: string, expandIt: boolean, cwd: string, personal: string): string {
  if (!expandIt || !text.includes("/")) return text + tags;
  return expand(text, [...scan(join(cwd, ".claude")), ...scan(personal)]) + tags;
}
