// The phone gets the same rows as the strip (`status.agents`).
import type { Item } from "./item.ts";
import { charCount, takeChars, trim, trimEnd, trimEndChars, trimStartChars } from "./text.ts";

/** A provider (providers.rs `Kind`). */
export type Provider = "claude" | "codex";

export const PROVIDERS: readonly Provider[] = ["claude", "codex"];

/** From this many running agents on, the strip starts folded into "3 agents working". */
export const FOLD_AT = 3;
/** The longest "doing" text and report line. */
const DOING_MAX = 48;
export const REPORT_MAX = 110;
/** The working dot's beat, in seconds. */
export const PULSE_SECS = 1.6;
/** How long a row's "Stop api?" waits once the pointer has left it, in seconds. */
export const CONFIRM_AWAY = 1.5;

/** One running subagent as the strip shows it. */
export interface Row {
  id: number;
  name: string;
  kind: Provider | null;
  /** The account badge ("AB") when there are several accounts of a kind. */
  badge: string;
  model: string;
  task: string;
  doing: string;
  secs: number;
  /** Its tokens and cost so far ("12.4k tok · $0.18"), "" before its first turn ends. */
  usage: string;
}

/** "3 agents working", "1 agent working  ·  2 queued". */
export function title(n: number, queued: number): string {
  const t = n === 1 ? "1 agent working" : `${n} agents working`;
  return queued > 0 ? `${t}  ·  ${queued} queued` : t;
}

/** How long an agent has run, short: "40s", "2m", "1h 5m". */
export function shortElapsed(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

/** The logo file (assets/logos) of a provider, and whether it is a mask tinted with the text colour. */
export function logo(kind: Provider): [string, boolean] {
  switch (kind) {
    case "claude":
      return ["p-claude-color.rgba", false];
    case "codex":
      return ["p-openai.a8", true];
  }
}

function clip(s: string, max: number): string {
  const t = trim(s);
  if (charCount(t) <= max) return t;
  return `${trimEnd(takeChars(t, max - 1))}…`;
}

/** A path as short as it reads well: relative to the project, else its last two parts. */
function shortPath(path: string, root: string): string {
  const p = trimEndChars(trimStartChars(trim(path), ['"', "'"]), ['"', "'"]);
  const r = trimEndChars(root, ["/"]);
  const inside = r !== "" && p.startsWith(`${r}/`) ? p.slice(r.length + 1) : "";
  const rel = inside !== "" ? inside : trimEndChars(p, ["/"]).split("/").slice(-2).join("/");
  if (charCount(rel) > 36) return clip(`…/${rel.slice(rel.lastIndexOf("/") + 1)}`, 36);
  return rel;
}

/** A shell command as an activity: "running tests", "building", "running npm install". */
function shellDoing(cmd: string): string {
  // The command that matters: past `cd … &&` and leading VAR=value assignments.
  const last = cmd
    .split("&&")
    .map(trim)
    .find((p) => !p.startsWith("cd ") && p !== "") ?? trim(cmd);
  const all = last.split(/\s+/).filter((w) => w !== "");
  const skip = all.findIndex((w) => !(w.includes("=") && !w.startsWith("-")));
  const words = skip < 0 ? [] : all.slice(skip);
  const line = words.join(" ");
  const parts = line.split(/[^\p{Alphabetic}\p{N}_-]/u);
  const has = (k: string) => parts.includes(k);
  const w0 = words[0] ?? "";
  const first = w0.slice(w0.lastIndexOf("/") + 1);
  const second = words[1] ?? "";
  if (has("test") || has("tests") || has("pytest") || has("jest") || has("vitest")) return "running tests";
  if ((first === "build.sh" || ["cargo", "npm", "pnpm", "make", "gradle", "tsc"].some(has)) && (has("check") || has("build") || first === "make" || first === "tsc" || first === "build.sh")) return "building";
  if (first === "git") {
    if (second === "commit") return "committing";
    if (second === "push") return "pushing";
    if (["pull", "fetch", "rebase", "merge"].includes(second)) return "syncing with git";
    if (["diff", "status", "log", "show"].includes(second)) return "reviewing changes";
  }
  if (first === "gh") return "using GitHub";
  if (["rg", "grep", "find", "fd", "ls"].includes(first)) return "searching files";
  if (["cat", "head", "tail", "less", "sed", "wc"].includes(first)) return "reading files";
  if (first === "sleep") return "waiting";
  if (first === "curl" || first === "wget") return "fetching a URL";
  if (first === "") return "running a command";
  const sub = second !== "" && /^[a-z-]+$/.test(second) ? ` ${second}` : "";
  return clip(`running ${first}${sub}`, DOING_MAX);
}

const SHELL = ["Bash", "Shell", "shell", "run_shell_command", "exec_command", "bash"];
const EDIT = ["Edit", "MultiEdit", "str_replace", "replace", "edit_file", "edit", "apply_patch", "NotebookEdit"];
const WRITE = ["Write", "write_file", "create_file", "write"];
const READ = ["Read", "read_file", "read_many_files", "view", "read"];
const SEARCH = ["Grep", "Glob", "LS", "grep", "glob", "search_file_content", "list_directory", "codebase_search", "find"];
const WEB_SEARCH = ["WebSearch", "web_search", "google_web_search"];
const WEB_FETCH = ["WebFetch", "web_fetch", "fetch"];

function splitOnce(s: string, sep: string): [string, string] | null {
  const i = s.indexOf(sep);
  return i < 0 ? null : [s.slice(0, i), s.slice(i + sep.length)];
}

function jsonString(input: string, key: string): string {
  try {
    const v: unknown = JSON.parse(input);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const x: unknown = (v as Record<string, unknown>)[key];
      if (typeof x === "string") return x;
    }
  } catch {
    // Not JSON: no argument.
  }
  return "";
}

/** One tool call as an activity. */
function toolDoing(name: string, summary: string, input: string, root: string): string {
  // "mcp__harbor__send_message" and Codex's "harbor.send_message" alike.
  const [server, tool] = name.startsWith("mcp__") ? (splitOnce(name.slice(5), "__") ?? ["", name.slice(5)]) : (splitOnce(name, ".") ?? ["", name]);
  const arg = (k: string) => jsonString(input, k);
  // Codex's file changes read "update src/x.rs".
  const path = () => {
    const s = trim(summary);
    const kv = splitOnce(s, " ");
    return shortPath(kv && ["add", "update", "delete", "modify"].includes(kv[0]) ? kv[1] : s, root);
  };
  return clip(toolText(server, tool, summary, arg, path), DOING_MAX);
}

function toolText(server: string, tool: string, summary: string, arg: (k: string) => string, path: () => string): string {
  if (server === "harbor") {
    switch (tool) {
      case "send_message":
        return `messaging ${arg("to")}`;
      case "start_process":
        return `starting ${arg("name")}`;
      case "read_messages":
        return "reading messages";
      case "list_agents":
        return "checking the team";
      case "process_logs":
      case "list_processes":
        return "checking processes";
      default:
        return tool.replaceAll("_", " ");
    }
  }
  if (server !== "") return `${server} · ${tool}`;
  if (SHELL.includes(tool)) return shellDoing(summary);
  if (EDIT.includes(tool)) return trim(summary) === "" ? "editing files" : `editing ${path()}`;
  if (WRITE.includes(tool)) return `writing ${path()}`;
  if (READ.includes(tool)) return `reading ${path()}`;
  if (SEARCH.includes(tool)) return "searching code";
  if (WEB_SEARCH.includes(tool)) return "searching the web";
  if (WEB_FETCH.includes(tool)) {
    const after = summary.split("://")[1];
    const host = after === undefined ? "" : (after.split("/")[0] ?? "");
    return host === "" ? "reading a web page" : `reading ${host}`;
  }
  if (tool === "Task" || tool === "Agent") return "delegating";
  if (tool === "TodoWrite" || tool === "update_plan" || tool === "todo_write") return "planning";
  return tool.replace(/[A-Z]/g, (c) => c.toLowerCase()).replaceAll("_", " ");
}

/** What a running agent is doing now, from its transcript: its latest tool call, thinking, or writing. */
export function doing(items: readonly Item[], root: string): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it) continue;
    if (it.kind === "tool") return toolDoing(it.name, it.summary, it.input, root);
    if (it.kind === "thinking") return "thinking";
    if (it.kind === "text" && trim(it.text) !== "") return "writing";
    if (it.kind === "user" || it.kind === "result") break;
  }
  return "starting";
}

/** The line a finished subagent leaves in its lead's chat: its report's first sentence ("api finished: Added tests for X"); an error report says so. */
export function reportLine(name: string, report: string): string {
  const sentence = headline(report);
  if (sentence === "") return `${name} finished`;
  return sentence.startsWith("Error: ") ? `${name} failed: ${sentence.slice(7)}` : `${name} finished: ${sentence}`;
}

/** A report's first sentence as one plain line: its first line that isn't a heading or a code fence, without list marks, bold or code ticks, clipped. */
function headline(text: string): string {
  const first =
    text
      .split(/\r?\n/)
      .map(trim)
      .filter((l) => !l.startsWith("#") && !l.startsWith("```"))
      .map((l) => trim(trimStartChars(l, [">", "-", "*", " "])))
      .find((l) => l !== "" && l !== "(no text reply)") ?? "";
  const plain = first.replaceAll("**", "").replaceAll("`", "");
  const cut = plain.indexOf(". ");
  const piece = cut < 0 ? plain : plain.slice(0, cut + 2);
  return clip(trim(trimEndChars(trim(piece), ["."])), REPORT_MAX);
}

/** The strip's shape: its title, whether it folds, has a title row, shows its rows, and how many lines it takes. `stored` is the user's last fold or unfold (null: none). */
export function stripView(rows: number, queued: number, stored: boolean | null): { title: string; folded: boolean; header: boolean; open: boolean; lines: number } {
  const folded = rows >= FOLD_AT;
  const header = folded || queued > 0;
  const open = (stored ?? rows < FOLD_AT) || !folded;
  return { title: title(rows, queued), folded, header, open, lines: (open ? rows : 0) + (header ? 1 : 0) };
}

/** What a click on the strip's title row does: fold or unfold it, or open the Agents panel. */
export function headerClick(folded: boolean): "toggle" | "team" {
  return folded ? "toggle" : "team";
}

/** A row's tooltip lines: [text, style]. */
export function rowTip(row: Row): [string, string][] {
  const out: [string, string][] = [
    [row.name, "strong-14"],
    [row.model, "label-12-mono"],
  ];
  if (row.task !== "") out.push([row.task, "label-12"]);
  out.push([`Working for ${shortElapsed(row.secs)}`, "label-12"]);
  out.push(["Click to open the agent", "label-12"]);
  return out;
}

/** `status.agents` for the phone: null without running subagents. */
export function stripJson(
  rows: readonly Row[],
  queued: number,
  nowMs: number,
): {
  title: string;
  folded: boolean;
  header: boolean;
  rows: { id: number; name: string; doing: string; task: string; model: string; logo: string; badge: string; since_ms: number; usage: string }[];
} | null {
  if (rows.length === 0) return null;
  return {
    title: title(rows.length, queued),
    folded: rows.length >= FOLD_AT,
    header: rows.length >= FOLD_AT || queued > 0,
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      doing: r.doing,
      task: r.task,
      model: r.model,
      logo: r.kind === null ? "" : logo(r.kind)[0],
      badge: r.badge,
      since_ms: nowMs - r.secs * 1000,
      usage: r.usage,
    })),
  };
}

/** What changes the strip as the phone sees it. */
export function stripKey(rows: readonly Row[]): [number, string][] {
  return rows.map((r) => [r.id, r.doing]);
}

/** The open "Stop api?" of a row: one at a time. */
export interface Confirm {
  id: number;
  /** Since when (seconds) the pointer is off the row. */
  away: number | null;
  /** Opened from the keyboard: Cancel takes the focus. */
  focus: boolean;
}

/** What an open "Stop api?" becomes this frame; null closes it. Off the row and off the keyboard it goes after `CONFIRM_AWAY`. */
export function nextConfirm(c: Confirm, e: { cancel: boolean; stop: boolean; hovered: boolean; focused: boolean; now: number }): Confirm | null {
  if (e.cancel || e.stop) return null;
  if (c.focus) return { ...c, focus: false };
  if (e.hovered || e.focused) return { ...c, away: null };
  if (c.away === null) return { ...c, away: e.now };
  return e.now - c.away > CONFIRM_AWAY ? null : c;
}

/** Where row `nth`'s working dot is in its beat (0..1) at `time` seconds, out of step with its neighbours. */
export function pulsePhase(time: number, nth: number): number {
  const x = time / PULSE_SECS + nth * 0.37;
  return x - Math.floor(x);
}

/** The working dot at `phase`: a blue-900 dot of radius 3 and a ring that swells and fades. */
export function workingDot(phase: number): { ring: number; ringAlpha: number; dot: number; color: "blue-900" } {
  const ease = 1 - (1 - phase) ** 3;
  return { ring: 6 * (0.6 + 1.4 * ease), ringAlpha: 0.5 * (1 - ease), dot: 3, color: "blue-900" };
}
