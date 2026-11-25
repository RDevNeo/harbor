// Keys for agents (Person Hub's engine): the team tools list_secrets, request_secret,
// request_secret_access, write_secret_to_env and run_with_secrets (declared by `harbor mcp`,
// packages/mcp/src/mcpshim.ts), and their cards as a phone API: GET /v1/secrets/asks,
// POST /v1/secrets/asks/{id}. The cards live in kv `secret_asks`, the uses allowed in
// `secret_grants`, the keys in secrets.json (packages/store/src/secrets.ts). An agent never sees a
// value: it gets a "[secret NAME]" message when the user answers, and run_with_secrets hides the
// values in what a command prints.
import { randomBytes } from "node:crypto";
import { type Chat, secrets, type Store } from "./packages/store/src/index.ts";
import type { Engine } from "./packages/agents/src/index.ts";

type Rec = Record<string, unknown>;

export interface SecretHost {
  store: Store;
  engine: () => Engine;
  /** A chat's cards or grants changed: it goes out in `changed_chats`. */
  touch: (chat: number) => void;
  /** secrets.json (tests: their own). */
  path?: string;
  now?: () => number;
}

export const TOOLS = new Set(["list_secrets", "request_secret", "request_secret_access", "write_secret_to_env", "run_with_secrets"]);

const str = (a: unknown, k: string): string => {
  const v = (a as Rec | null)?.[k];
  return typeof v === "string" ? v.trim() : "";
};
const list = (a: unknown, k: string): string[] => {
  const v = (a as Rec | null)?.[k];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x !== "") : typeof v === "string" && v.trim() !== "" ? [v.trim()] : [];
};
const clock = (t: number): string => new Date(t * 1000).toTimeString().slice(0, 5);

/** The JSON a card is in GET /v1/secrets/asks: the ask, and the times the user may pick. */
export function askJson(a: secrets.Ask, chatRef: string | number): Rec {
  const spans: Rec[] =
    a.kind === "env"
      ? []
      : [
          ...secrets.spans(a.minutes).map((s) => ({ ...s, label: secrets.spanLabel(s, a.minutes) })),
          ...(a.kind === "value" ? [{ kind: "not", label: secrets.spanLabel({ kind: "not" }, a.minutes) }] : []),
        ];
  return { id: a.id, chat: chatRef, kind: a.kind, names: a.names, reason: a.reason, agent: a.agent, minutes: a.minutes, how_to_get: a.how_to_get, env_file: a.env_file, env_var: a.env_var, spans };
}

/** A span from the card's answer: {kind:"minutes", minutes} (1..1440) or {kind:"not"}; null when it's neither. */
export function parseSpan(v: unknown): secrets.Span | null {
  if (typeof v !== "object" || v === null) return null;
  const s = v as Rec;
  if (s.kind === "not") return { kind: "not" };
  if (s.kind === "minutes" && typeof s.minutes === "number" && Number.isFinite(s.minutes)) return secrets.minutesSpan(secrets.askedMinutes(s.minutes));
  return null;
}

export class SecretTools {
  private readonly path: string;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly h: SecretHost) {
    this.path = h.path ?? secrets.secretsPath();
    this.now = h.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Every 30 s: uses whose time is up end, and their agents are told. */
  start(): void {
    this.timer ??= setInterval(() => this.expire(), 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  expire(): void {
    const grants = secrets.loadGrants(this.h.store);
    const gone = secrets.expire(grants, this.now());
    if (gone.length === 0) return;
    secrets.saveGrants(this.h.store, grants);
    const by = new Map<number, string[]>();
    for (const g of gone) by.set(g.chat, [...(by.get(g.chat) ?? []), g.name]);
    for (const [chat, names] of by) {
      this.h.touch(chat);
      this.tell(chat, `[secret ${names.join(", ")}] Your time to use ${names.length === 1 ? "it" : "them"} is up; request_secret_access asks again.`, false);
    }
  }

  /** The tool's answer, or undefined when `name` isn't one of these. */
  tool(me: Chat, name: string, a: unknown): Promise<string> | undefined {
    if (!TOOLS.has(name)) return undefined;
    return this.call(me, name, a);
  }

  private agentOf(me: Chat): string {
    return me.role === "sub" ? me.name : "lead";
  }

  private ask(me: Chat, a: Omit<secrets.Ask, "id" | "chat" | "agent">): secrets.Ask {
    const asks = secrets.loadAsks(this.h.store);
    // The same question again replaces the card it had.
    const kept = asks.filter((x) => !(x.chat === me.id && x.kind === a.kind && x.names.join() === a.names.join()));
    const ask: secrets.Ask = { id: randomBytes(6).toString("hex"), chat: me.id, agent: this.agentOf(me), ...a };
    secrets.saveAsks(this.h.store, [...kept, ask]);
    this.h.engine().notice(me.id, "key", `${ask.agent === "lead" ? "The agent" : ask.agent} asks ${a.kind === "value" ? "for" : a.kind === "use" ? "to use" : "to write"} ${a.names.join(", ")}`, a.reason);
    this.h.touch(me.id);
    return ask;
  }

  private async call(me: Chat, name: string, a: unknown): Promise<string> {
    const at = this.now();
    const saved = secrets.names(this.path);
    const grants = secrets.loadGrants(this.h.store);
    const until = (n: string): number | null => grants.find((g) => g.chat === me.id && g.name === n && g.until > at)?.until ?? null;
    switch (name) {
      case "list_secrets": {
        if (saved.length === 0) return "No keys saved in Hub yet. request_secret asks the user for one.";
        return saved
          .map((s) => {
            const u = until(s.name);
            return `- ${s.name}${s.description !== "" ? `: ${s.description}` : ""} [${u !== null ? `you may use it until ${clock(u)}` : "ask with request_secret_access"}]`;
          })
          .join("\n");
      }
      case "request_secret": {
        const n = secrets.envName(str(a, "name"));
        if (n === null) throw new Error("name: an environment variable name, like STRIPE_SECRET_KEY");
        const reason = str(a, "reason");
        if (reason === "") throw new Error("reason is required");
        const file = str(a, "env_file");
        const envVar = file === "" ? "" : (secrets.envVarName(str(a, "env_var") || n) ?? "");
        if (file !== "") {
          if (envVar === "") throw new Error("env_var: letters, digits and _ only");
          secrets.envPath(this.h.engine().chatCwd(me), file);
        }
        this.ask(me, { kind: "value", names: [n], reason, minutes: secrets.askedMinutes((a as Rec | null)?.minutes), how_to_get: str(a, "how_to_get"), env_file: file, env_var: envVar });
        return `Asked the user for ${n}. You'll get a [secret ${n}] message when they answer; you never see the value.`;
      }
      case "request_secret_access": {
        const names = [...new Set(list(a, "names").map((n) => secrets.envName(n) ?? n))];
        if (names.length === 0) throw new Error("names: the keys' names, from list_secrets");
        const missing = names.filter((n) => !saved.some((s) => s.name === n));
        if (missing.length > 0) throw new Error(`not saved in Hub: ${missing.join(", ")} (request_secret asks the user for a new one)`);
        const reason = str(a, "reason");
        if (reason === "") throw new Error("reason is required");
        const need = secrets.ungranted(grants, me.id, names, at);
        if (need.length === 0) return `You may use ${names.join(", ")} already (until ${clock(Math.min(...names.map((n) => until(n) ?? at)))}).`;
        this.ask(me, { kind: "use", names, reason, minutes: secrets.askedMinutes((a as Rec | null)?.minutes), how_to_get: "", env_file: "", env_var: "" });
        return `Asked the user to let you use ${names.join(", ")}. You'll get a [secret …] message when they answer.`;
      }
      case "write_secret_to_env": {
        const n = secrets.envName(str(a, "name")) ?? "";
        if (!saved.some((s) => s.name === n)) throw new Error(`not saved in Hub: ${str(a, "name")} (list_secrets shows the saved ones)`);
        const file = str(a, "file");
        if (file === "") throw new Error("file is required, e.g. .env.local");
        const envVar = secrets.envVarName(str(a, "var") || n);
        if (envVar === null) throw new Error("var: letters, digits and _ only");
        secrets.envPath(this.h.engine().chatCwd(me), file);
        this.ask(me, { kind: "env", names: [n], reason: str(a, "reason"), minutes: 0, how_to_get: "", env_file: file, env_var: envVar });
        return `Asked the user to let Hub write ${n} to ${file}. You'll get a [secret ${n}] message when it's written or refused.`;
      }
      case "run_with_secrets": {
        const cmd = str(a, "command");
        if (cmd === "") throw new Error("command is required");
        const names = [...new Set(list(a, "secrets").map((n) => secrets.envName(n) ?? n))];
        const need = secrets.ungranted(grants, me.id, names, at);
        if (need.length > 0) throw new Error(`not allowed now: ${need.join(", ")}. Ask with request_secret_access and wait for the [secret …] message.`);
        const values = secrets.load(this.path);
        const pairs = names.map((n): [string, string] => [n, values.find((s) => s.name === n)?.value ?? ""]);
        const gone = pairs.filter(([, v]) => v === "").map(([n]) => n);
        if (gone.length > 0) throw new Error(`no longer saved: ${gone.join(", ")}`);
        const base = this.h.engine().chatCwd(me);
        const sub = str(a, "cwd");
        const cwd = sub === "" ? base : sub.startsWith("/") ? sub : `${base}/${sub}`;
        const raw = (a as Rec | null)?.timeout;
        const secs = typeof raw === "number" && raw > 0 ? Math.min(raw, secrets.MAX_TIMEOUT) : secrets.DEFAULT_TIMEOUT;
        return secrets.run(cmd, cwd, pairs, secs * 1000);
      }
    }
    throw new Error(`unknown tool '${name}'`);
  }

  /** A message to the agent: it starts a turn, or waits behind the running one. */
  private tell(chat: number, text: string, notice: boolean): void {
    const e = this.h.engine();
    if (e.chat(chat) === undefined) return;
    if (notice) e.notice(chat, "key", text.replace(/^\[secret [^\]]*\] /, ""));
    e.trigger(chat, text, true);
  }

  /** The cards waiting on this PC, of one chat or all. */
  asks(chat: number | null): secrets.Ask[] {
    const e = this.h.engine();
    return secrets.loadAsks(this.h.store).filter((a) => (chat === null || a.chat === chat) && e.chat(a.chat) !== undefined);
  }

  /**
   * The user's answer to a card: {value, span} (request_secret; span {kind:"not"} saves it with no use),
   * {span} (request_secret_access), {} (write_secret_to_env) or {deny: true}. An Error's message is for the user.
   */
  answer(id: string, body: Rec): { chat: number } {
    const all = secrets.loadAsks(this.h.store);
    const ask = all.find((a) => a.id === id);
    if (ask === undefined) throw new NotFound("This request was answered already or is gone.");
    const e = this.h.engine();
    const chat = e.chat(ask.chat);
    const names = ask.names.join(", ");
    const done = (text: string): { chat: number } => {
      secrets.saveAsks(this.h.store, secrets.loadAsks(this.h.store).filter((a) => a.id !== id));
      this.h.touch(ask.chat);
      this.tell(ask.chat, text, true);
      return { chat: ask.chat };
    };
    if (body.deny === true) return done(`[secret ${names}] The user said no.`);
    const span = body.span === undefined ? null : parseSpan(body.span);
    if (body.span !== undefined && span === null) throw new Error("span: {kind: 'minutes', minutes} or {kind: 'not'}");
    const grantFor = (s: secrets.Span | null): string => {
      if (s === null || s.kind === "not") return "";
      const grants = secrets.loadGrants(this.h.store);
      secrets.grant(grants, ask.chat, ask.names, s, this.now());
      secrets.saveGrants(this.h.store, grants);
      return ` You may use ${ask.names.length === 1 ? "it" : "them"} with run_with_secrets for ${secrets.minutesLabel(s.minutes)} (until ${clock(this.now() + s.minutes * 60)}).`;
    };
    const toEnv = (value: string): string => {
      if (ask.env_file === "" || chat === undefined) return "";
      const root = e.chatCwd(chat);
      const file = secrets.envPath(root, ask.env_file);
      secrets.writeEnv(file, ask.env_var || ask.names[0] || "", value);
      let ignored = "";
      if (secrets.gitIgnored(root, file) === false) {
        try {
          secrets.addToGitignore(root, file);
          ignored = " (added to .gitignore)";
        } catch {
          ignored = " (it isn't in .gitignore: don't commit it)";
        }
      }
      return ` Written to ${ask.env_file} as ${ask.env_var}${ignored}.`;
    };
    if (ask.kind === "value") {
      const value = typeof body.value === "string" ? body.value : "";
      if ([...value.trim()].length < secrets.MIN_LEN) throw new Error(`The key needs at least ${secrets.MIN_LEN} characters.`);
      const n = secrets.save(ask.names[0] ?? "", value, ask.reason, this.path);
      const env = toEnv(value.trim());
      return done(`[secret ${n}] The user saved ${n} in Hub.${env}${grantFor(span ?? secrets.minutesSpan(ask.minutes))}`);
    }
    if (ask.kind === "use") {
      const s = span ?? secrets.minutesSpan(ask.minutes);
      if (s.kind === "not") return done(`[secret ${names}] The user said no.`);
      return done(`[secret ${names}] The user said yes.${grantFor(s)}`);
    }
    const value = secrets.load(this.path).find((s) => s.name === ask.names[0])?.value;
    if (value === undefined) throw new Error(`${names} isn't saved in Hub any more.`);
    return done(`[secret ${names}] ${toEnv(value).trim() || "Nothing written."}`);
  }
}

export class NotFound extends Error {}
