// Claude Code's recap and prompt suggestion (2.1.303). Harbor can't fork the CLI's prompt cache, so
// it asks Haiku with Claude Code's own prompts and filters over a condensed transcript.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Item } from "@harbor/store";
import { at, optStr, parse } from "./json.ts";
import { dataDir } from "./paths.ts";

/** Claude Code's recap prompt, verbatim. */
export const RECAP_PROMPT =
  "The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. Lead with the overall goal and current task, then the one next action. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.";

/** Claude Code's suggestion prompt, verbatim. */
export const SUGGEST_PROMPT = `[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]

FIRST: Look at the user's recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.

THE TEST: Would they think "I was just about to type that"?

EXAMPLES:
User asked "fix the bug and run tests", bug is fixed → "run the tests"
After code written → "try it out"
Claude offers options → suggest the one the user would likely pick, based on conversation
Claude asks to continue → "yes" or "go ahead"
Task complete, obvious follow-up → "commit this" or "push it"
After error or misunderstanding → silence (let them assess/correct)

Be specific: "run the tests" beats "continue".

NEVER SUGGEST:
- Evaluative ("looks good", "thanks")
- Questions ("what about...?")
- Claude-voice ("Let me...", "I'll...", "Here's...")
- New ideas they didn't ask about
- Multiple sentences

Stay silent if the next step isn't obvious from what the user said.

Stay silent if a suggestion could be unsafe or inappropriate — including any sensitive topic (security incidents, credentials, harm, private data). Even when the user is doing legitimate security or cybersecurity work, do not predict potentially unsafe actions.

Format: 2-12 words, match the user's style. Or nothing.

Reply with ONLY the suggestion, no quotes or explanation.`;

export const SYSTEM = "You read the transcript of a session between a user and Claude Code, an AI coding agent, and do only what the last message asks. You have no tools.";
export const MODEL = "claude-haiku-5-5";
export const TIMEOUT_MS = 90_000;
export const RECAP_CAP = 400;

/** Claude Code's clean-up of a suggestion: unwraps `<suggestion>…</suggestion>` and drops a leading "Suggestion:" label. */
export function clean(s: string): string {
  let t = s.trim();
  for (const tag of ["suggestion", "response", "output", "answer", "result"]) {
    const lower = t.toLowerCase();
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    if (lower.startsWith(open) && lower.endsWith(close) && t.length >= open.length + close.length) {
      const inner = t.slice(open.length, t.length - close.length);
      if (!inner.toLowerCase().includes(close)) t = inner;
      break;
    }
  }
  const trimmed = t.trimStart();
  const lower = trimmed.toLowerCase();
  const start = t.length - trimmed.length;
  for (const l of ["suggested response", "suggested reply", "suggested input", "suggested prompt", "suggestion", "response", "reply", "answer", "output", "result"]) {
    if (!lower.startsWith(l)) continue;
    const rest = lower.slice(l.length).trimStart();
    if (rest.startsWith(":") || rest.startsWith("：")) {
      const after = rest.slice(1);
      t = t.slice(start + lower.length - after.length);
      break;
    }
  }
  return t.trim();
}

const cp = (c: string): number => c.codePointAt(0) ?? 0;
const isHan = (c: string): boolean => {
  const n = cp(c);
  return (n >= 0x4e00 && n <= 0x9fff) || (n >= 0x3400 && n <= 0x4dbf) || (n >= 0xf900 && n <= 0xfaff);
};
const isPhonetic = (c: string): boolean => {
  const n = cp(c);
  return (n >= 0x3040 && n <= 0x30ff) || n === 0xff70 || (n >= 0x0e00 && n <= 0x0eff) || (n >= 0x1780 && n <= 0x17ff) || (n >= 0x1000 && n <= 0x109f);
};
const isHangul = (c: string): boolean => {
  const n = cp(c);
  return (n >= 0xac00 && n <= 0xd7af) || (n >= 0x1100 && n <= 0x11ff) || (n >= 0x3130 && n <= 0x318f);
};
const isAlnum = (c: string): boolean => /^[\p{L}\p{N}]$/u.test(c);

/** Words as Claude Code counts them: a CJK character is half (Han) or a quarter (kana) of one. */
export function words(s: string): number {
  let n = 0;
  for (const w of s.split(/\s+/).filter((x) => x !== "")) {
    let han = 0;
    let ph = 0;
    let hg = 0;
    let other = 0;
    for (const c of w) {
      if (isHan(c)) han++;
      else if (isPhonetic(c)) ph++;
      else if (isHangul(c)) hg++;
      else if (isAlnum(c)) other++;
    }
    n += han === 0 && ph === 0 ? 1 : (other + hg > 0 ? 1 : 0) + han / 2 + ph / 4;
  }
  return Math.ceil(n);
}

/** Why Claude Code would drop this suggestion, or null to show it. */
export function suppressed(s: string): string | null {
  if (s === "") return "empty";
  const t = s.toLowerCase();
  if (t === "done") return "done";
  if (
    t === "nothing found" ||
    t === "nothing found." ||
    t.startsWith("nothing to suggest") ||
    t.startsWith("no suggestion") ||
    t.includes("silence is") ||
    ["stay silent", "stays silent", "staying silent"].some((p) => t.includes(p)) ||
    t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") === "silence"
  )
    return "meta_text";
  if ((s.startsWith("(") && s.endsWith(")")) || (s.startsWith("[") && s.endsWith("]"))) return "meta_wrapped";
  if (["api error:", "prompt is too long", "request timed out", "invalid api key", "image was too large"].some((p) => t.startsWith(p))) return "error_message";
  if (/^[\p{L}\p{N}_]+:\s/u.test(s)) return "prefixed_label";
  const n = words(s);
  if (n < 2 && !s.startsWith("/")) {
    const cjk = [...s].filter((c) => isHan(c) || isPhonetic(c) || isHangul(c)).length;
    const ok = cjk > 0 ? cjk >= 2 : ["yes", "yeah", "yep", "yea", "yup", "sure", "ok", "okay", "push", "commit", "deploy", "stop", "continue", "check", "exit", "quit", "no"].includes(t);
    if (!ok) return "too_few_words";
  }
  if (n > 12) return "too_many_words";
  if ([...s].length >= 100) return "too_long";
  if (/[.!?]\s+[A-Z]/u.test(s)) return "multiple_sentences";
  if (s.includes("\n") || s.includes("*")) return "has_formatting";
  if (["thanks", "thank you", "looks good", "sounds good", "that works", "that worked", "that's all", "nice", "great", "perfect", "makes sense", "awesome", "excellent"].some((e) => t.includes(e)))
    return "evaluative";
  const voice = ["let me", "i'll", "i've", "i'm", "i can", "i would", "i think", "i notice", "here's", "here is", "here are", "that's", "this is", "this will", "you can", "you should", "you could", "sure,", "of course", "certainly"];
  if (voice.some((v) => t.startsWith(v))) return "claude_voice";
  return null;
}

/** At most `max` characters, cut at a word and ended with "…". */
export function cap(s: string, max: number): string {
  const cs = [...s];
  if (cs.length <= max) return s;
  let cut = cs.slice(0, max - 1).join("");
  const m = /\s(?=\S*$)/u.exec(cut);
  const i = m ? Buffer.byteLength(cut.slice(0, m.index)) : -1;
  if (m && i > Math.floor(max / 2)) cut = cut.slice(0, m.index);
  return `${cut.trimEnd()}…`;
}

/** The user's own messages (Claude Code's "real user messages"). */
export function userCount(items: readonly Item[]): number {
  return items.filter((i) => i.kind === "user").length;
}

/** Claude's messages: replies and tool calls. */
export function assistantCount(items: readonly Item[]): number {
  return items.filter((i) => i.kind === "text" || i.kind === "tool").length;
}

function clip(s: string, max: number): string {
  const cs = [...s];
  return cs.length <= max ? s : `${cs.slice(0, max).join("")}…`;
}

/** view.rs's name of a tool: Harbor's own in words, other MCP tools as "server · tool". */
export function toolLabel(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const rest = name.slice(5);
  const i = rest.indexOf("__");
  const [server, tool] = i < 0 ? ["", rest] : [rest.slice(0, i), rest.slice(i + 2)];
  if (server !== "harbor") return `${server} · ${tool}`;
  const t = tool.replaceAll("_", " ");
  const first = [...t][0];
  return first === undefined ? name : first.toUpperCase() + t.slice(first.length);
}

/** The conversation as plain text for the model: the first request, then as much of the end as fits in about `budget` characters. */
export function context(items: readonly Item[], budget: number): string {
  const line = (it: Item): string | null => {
    switch (it.kind) {
      case "user":
        return `User: ${clip(it.text, 2000)}`;
      case "text":
        return `Claude: ${clip(it.text, 2000)}`;
      case "tool":
        return `[${toolLabel(it.name)}${it.summary === "" ? "" : `: ${clip(it.summary, 160)}`}${it.is_error ? " (failed)" : ""}]`;
      case "error":
        return `[error: ${clip(it.text.split("\n")[0]?.replace(/\r$/, "") ?? "", 200)}]`;
      case "message":
        return `${it.from} → ${it.to}: ${clip(it.text, 1000)}`;
      case "notice":
        return `[${clip(it.text, 200)}]`;
      default:
        return null;
    }
  };
  const first = items.findIndex((i) => i.kind === "user");
  const tail: string[] = [];
  let used = 0;
  let cut = false;
  for (let i = items.length - 1; i >= 0; i--) {
    if (i === first) break;
    const l = line(items[i] as Item);
    if (l === null) continue;
    const len = Buffer.byteLength(l);
    if (used + len > budget && tail.length > 0) {
      cut = true;
      break;
    }
    used += len + 1;
    tail.push(l);
  }
  tail.reverse();
  const out: string[] = [];
  const f = first >= 0 ? line(items[first] as Item) : null;
  if (f !== null) out.push(f);
  if (cut) out.push("[… earlier part of the session left out …]");
  out.push(...tail);
  return out.join("\n");
}

export function fullPrompt(items: readonly Item[], ask: string): string {
  return `<transcript>\n${context(items, 12_000)}\n</transcript>\n\n${ask}`;
}

export type Env = readonly [string, string | null][];

/** One question to Haiku through the account's Claude Code: no tools, servers, hooks or session. */
export function ask(bin: string, env: Env, system: string, prompt: string): Promise<string> {
  return askWithin(bin, env, system, prompt, TIMEOUT_MS);
}

/** `ask` with its own time limit; rejects with the reason. */
export async function askWithin(bin: string, env: Env, system: string, prompt: string, timeoutMs: number): Promise<string> {
  const dir = join(dataDir(), "recap");
  mkdirSync(dir, { recursive: true });
  const e: Record<string, string | undefined> = { ...process.env };
  for (const [k, v] of env) {
    if (v === null) delete e[k];
    else e[k] = v;
  }
  const p = Bun.spawn(
    [bin, "-p", "--model", MODEL, "--output-format", "json", "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--setting-sources", "user", "--settings", '{"disableAllHooks":true}', "--system-prompt", system],
    { cwd: dir, env: e, stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  );
  try {
    p.stdin.write(prompt);
    await p.stdin.end();
  } catch {}
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill("SIGKILL");
  }, timeoutMs);
  const text = await new Response(p.stdout).text();
  await p.exited;
  clearTimeout(timer);
  if (timedOut) throw new Error("timed out");
  const v = parse(text.trim());
  if (v === undefined) throw new Error("no answer");
  if (at(v, "is_error") === true) throw new Error(optStr(at(v, "result")) ?? "error");
  return (optStr(at(v, "result")) ?? "").trim();
}

/** After a turn ends, how long the user has to be away before the recap (`HARBOR_TEST_RECAP_S` shortens it for rigs). */
function delayMs(): number {
  const v = Number(process.env.HARBOR_TEST_RECAP_S);
  return (Number.isInteger(v) && v >= 0 ? v : 180) * 1000;
}
/** …and at least this long into the absence. */
const MIN_AWAY_MS = 2000;
/** Claude Code stops once its prompt cache would be stale (0.9 × the 1 h TTL). */
const STALE_MS = 54 * 60_000;
const RETRY_MS = 30_000;
const MAX_FAILS = 3;
/** The first recaps say how to turn them off. */
const HINTED = 3;
/** A phone that fetched the chat this recently has it open. */
const PHONE_SEEN_MS = 20_000;

type What = "recap" | "suggestion";

interface Entry {
  /** When its last turn ended (ms), while a recap is still due for it. */
  turnEnd: number | null;
  awaySince: number | null;
  /** Bumped by every turn: results from before it are dropped. */
  turn: number;
  busy: boolean;
  fails: number;
  retryAt: number | null;
}

/** What `Recaps` needs from the engine around it. */
export interface RecapHost {
  store: import("@harbor/store").Store;
  chat(id: number): import("@harbor/store").Chat | undefined;
  items(id: number): readonly Item[];
  running(id: number): boolean;
  /** Its lead's sub-agents still at work. */
  subsRunning(id: number): boolean;
  /** The Claude binary and environment the chat's account asks with; null: not Claude, or at its usage limit. */
  asker(id: number): { bin: string; env: Env } | null;
  /** On this PC's focused window. */
  watched?(id: number): boolean;
  /** Text in the chat's composer. */
  draft?(id: number): string;
  changed(id: number): void;
}

/** Recaps and suggestions per chat, kept in kv `recap:<id>` / `suggestion:<id>` as "gid\ntext". */
export class Recaps {
  private readonly entries = new Map<number, Entry>();
  private readonly shown = new Map<number, [string | null, string | null]>();
  private readonly phoneSeen = new Map<number, number>();
  ask: (bin: string, env: Env, system: string, prompt: string) => Promise<string> = ask;

  constructor(private readonly host: RecapHost) {}

  private on(key: string): boolean {
    return this.host.store.get(key) !== "0";
  }

  recapEnabled(): boolean {
    return this.on("recap_enabled");
  }

  suggestEnabled(): boolean {
    return this.on("suggest_enabled");
  }

  /** A phone fetched the chat: it counts as being looked at. */
  seen(chat: number): void {
    this.phoneSeen.set(chat, Date.now());
  }

  private watched(chat: number): boolean {
    const t = this.phoneSeen.get(chat);
    return (this.host.watched?.(chat) ?? false) || (t !== undefined && Date.now() - t < PHONE_SEEN_MS);
  }

  private entry(chat: number): Entry {
    let e = this.entries.get(chat);
    if (!e) this.entries.set(chat, (e = { turnEnd: null, awaySince: null, turn: 0, busy: false, fails: 0, retryAt: null }));
    return e;
  }

  private load(chat: number): [string | null, string | null] {
    let v = this.shown.get(chat);
    if (!v) {
      const gid = this.host.chat(chat)?.gid ?? "";
      const get = (k: string): string | null => {
        const raw = this.host.store.get(`${k}:${chat}`);
        const i = raw?.indexOf("\n") ?? -1;
        if (raw === null || raw === undefined || i < 0) return null;
        const t = raw.slice(i + 1);
        return raw.slice(0, i) === gid && t !== "" ? t : null;
      };
      v = [get("recap"), get("suggestion")];
      this.shown.set(chat, v);
    }
    return v;
  }

  private save(chat: number, what: What, text: string | null): void {
    const gid = this.host.chat(chat)?.gid ?? "";
    this.host.store.set(`${what}:${chat}`, text === null ? "" : `${gid}\n${text}`);
    const slot = this.load(chat);
    slot[what === "recap" ? 0 : 1] = text;
    this.host.changed(chat);
  }

  /** What shows for a chat: its recap and its suggestion (nothing while its turn runs). */
  shownFor(chat: number): [string | null, string | null] {
    const [r, s] = this.load(chat);
    const running = this.host.running(chat);
    return [this.recapEnabled() && !running ? r : null, this.suggestEnabled() && !running ? s : null];
  }

  private spawn(chat: number, what: What): boolean {
    const a = this.host.asker(chat);
    if (!a) return false;
    const prompt = fullPrompt(this.host.items(chat), what === "recap" ? RECAP_PROMPT : SUGGEST_PROMPT);
    const turn = this.entry(chat).turn;
    this.ask(a.bin, a.env, SYSTEM, prompt).then(
      (t) => this.landed(chat, what, turn, t),
      () => this.landed(chat, what, turn, null),
    );
    return true;
  }

  /** A turn ended: the suggestion now; the recap once the user has been away a while. */
  exited(chat: number, stopped: boolean): void {
    const c = this.host.chat(chat);
    // Claude Code: the main thread only (not sub-agents), this PC's own chats.
    if (!c || c.home !== "" || c.role === "sub") return;
    const e = this.entry(chat);
    Object.assign(e, { turn: e.turn + 1, turnEnd: Date.now(), awaySince: null, fails: 0, retryAt: null, busy: false });
    if (stopped || c.access === "plan" || !this.suggestEnabled()) return;
    const items = this.host.items(chat);
    // Not this early, and not after an error (let them assess it).
    if (assistantCount(items) < 2 || items[items.length - 1]?.kind === "error") return;
    this.spawn(chat, "suggestion");
  }

  private landed(chat: number, what: What, turn: number, r: string | null): void {
    const e = this.entries.get(chat);
    if (!e || e.turn !== turn) return;
    const running = this.host.running(chat);
    if (what === "suggestion") {
      if (r === null) return;
      const s = clean(r);
      if (suppressed(s) === null && !running) this.save(chat, "suggestion", s);
      return;
    }
    e.busy = false;
    const text = r === null ? null : r.trim() || null;
    if (text === null) {
      e.fails++;
      e.retryAt = Date.now() + RETRY_MS;
      return;
    }
    if (running) return;
    e.turnEnd = null;
    const n = Number(this.host.store.get("recap_count") ?? "0") || 0;
    this.host.store.set("recap_count", String(n + 1));
    const t = cap(text, RECAP_CAP);
    this.host.store.set(`recap_users:${chat}`, String(userCount(this.host.items(chat))));
    this.save(chat, "recap", n < HINTED ? `${t} (disable recaps in Settings)` : t);
  }

  /** Now and then: a new turn hides what showed, recaps that are due go out; returns ms until the next is due (null: none). */
  tick(): number | null {
    for (const [id, [r, s]] of this.shown) {
      if ((r !== null || s !== null) && this.host.running(id)) {
        this.save(id, "recap", null);
        this.save(id, "suggestion", null);
        const e = this.entries.get(id);
        if (e) Object.assign(e, { turn: e.turn + 1, turnEnd: null });
      }
    }
    if (!this.recapEnabled()) return null;
    const t = Date.now();
    let next: number | null = null;
    const soon = (ms: number): void => {
      next = next === null ? ms : Math.min(next, ms);
    };
    for (const [id, e] of this.entries) {
      if (e.turnEnd === null || e.busy) continue;
      if (t - e.turnEnd > STALE_MS || e.fails >= MAX_FAILS) {
        e.turnEnd = null;
        continue;
      }
      if (this.watched(id)) {
        e.awaySince = null;
        // A phone's look runs out without any event here: wake then.
        const seen = this.phoneSeen.get(id);
        if (seen !== undefined && t - seen < PHONE_SEEN_MS) soon(PHONE_SEEN_MS - (t - seen));
        continue;
      }
      e.awaySince ??= t;
      const due = Math.max(e.turnEnd + delayMs(), e.awaySince + MIN_AWAY_MS, e.retryAt ?? t);
      if (due > t) {
        soon(due - t);
        continue;
      }
      if (this.wanted(id)) e.busy = this.spawn(id, "recap");
      // Not for this turn (too early in the session, a draft, sub-agents at work…).
      else e.turnEnd = null;
    }
    return next;
  }

  /** Claude Code's checks when the recap is due. */
  private wanted(chat: number): boolean {
    if (this.host.running(chat) || (this.host.draft?.(chat) ?? "").trim() !== "") return false;
    if (this.host.chat(chat)?.role === "lead" && this.host.subsRunning(chat)) return false;
    if (this.load(chat)[0] !== null) return false;
    const users = userCount(this.host.items(chat));
    if (users < 3) return false;
    const before = Number(this.host.store.get(`recap_users:${chat}`) ?? "");
    return Number.isInteger(before) && this.host.store.get(`recap_users:${chat}`) !== null && before <= users ? users - before >= 2 : true;
  }
}
