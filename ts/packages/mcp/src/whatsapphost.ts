// `harbor app whatsapp-host`: the one process per user that holds the WhatsApp link. It runs the
// engine (whatsapp/engine.mjs, a child process), stores what it hears (whatsappstore.ts), runs the
// tools (whatsapptools.ts) and answers Harbor's other processes on a private socket: the app's
// Settings card and phone routes, and each agent's `harbor app whatsapp`.
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { writePrivate } from "@harbor/store";
import { bundleStamp } from "./discordsetup.ts";
import { takeLock } from "./discordhost.ts";
import * as setup from "./whatsappsetup.ts";
import { type Raw, Store, normJid } from "./whatsappstore.ts";
import { type Engine, type State, Tools } from "./whatsapptools.ts";

const obj = (v: unknown): Raw => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Raw) : {});
const list = (v: unknown): Raw[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** host.log (the host's stderr): never a whole number or a code. */
const log = (s: string): void => {
  process.stderr.write(`${new Date().toISOString()} ${s}\n`);
};

/**
 * The other way a Brazilian mobile number may be on WhatsApp: mobiles got a 9 after the area code
 * (2012-2016), and older accounts often still have their number without it (and the code WhatsApp
 * sends is for the account's own number). Digits in, digits out; undefined when there's no other.
 */
export function brazilAlt(digits: string): string | undefined {
  if (!digits.startsWith("55")) return undefined;
  const area = digits.slice(2, 4);
  const rest = digits.slice(4);
  if (rest.length === 9 && rest.startsWith("9")) return `55${area}${rest.slice(1)}`;
  if (rest.length === 8 && /^[6-9]/.test(rest)) return `55${area}9${rest}`;
  return undefined;
}

/** "+55 21 98765 4321" / "+55 21 8765 4321": a Brazilian number the way the hint shows it. */
const brazilShow = (d: string): string => `+55 ${d.slice(2, 4)} ${d.slice(4, d.length - 4)} ${d.slice(-4)}`;

/** A time left as "4:05". */
const left = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The engine as a child process speaking JSON lines (or a test's stand-in). */
export interface EngineProc extends Engine {
  start(onEvent: (ev: string, data: unknown) => void, onExit: () => void): Promise<void>;
  stop(): Promise<void>;
  running(): boolean;
}

export class ChildEngine implements EngineProc {
  private child: ChildProcess | undefined;
  private next = 1;
  private readonly waiting = new Map<number, { ok: (r: Raw) => void; no: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly say: (s: string) => void) {}

  running(): boolean {
    return this.child !== undefined && this.child.exitCode === null;
  }

  async start(onEvent: (ev: string, data: unknown) => void, onExit: () => void): Promise<void> {
    const dir = await setup.ensureEngine(this.say);
    const bun = setup.bunCommand();
    const log = openSync(setup.logPath(), "a", 0o600);
    const env: Record<string, string> = { ...bun.env };
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && (["HOME", "PATH", "LANG", "TZ", "SSL_CERT_FILE"].includes(k) || k.startsWith("XDG_"))) env[k] = v;
    const child = spawn(bun.exe, [join(dir, "engine.mjs"), setup.authDir()], { cwd: dir, env, stdio: ["pipe", "pipe", log] });
    closeSync(log);
    this.child = child;
    child.on("error", (e) => this.say(`engine: ${msg(e)}`));
    child.on("exit", () => {
      if (this.child === child) this.child = undefined;
      for (const [, w] of this.waiting) {
        clearTimeout(w.timer);
        w.no(new Error("WhatsApp's engine stopped."));
      }
      this.waiting.clear();
      onExit();
    });
    const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    lines.on("line", (l) => {
      let v: Raw;
      try {
        v = obj(JSON.parse(l));
      } catch {
        return;
      }
      if (typeof v.id === "number") {
        const w = this.waiting.get(v.id);
        if (w === undefined) return;
        this.waiting.delete(v.id);
        clearTimeout(w.timer);
        if (v.ok === true) w.ok(obj(v.result));
        else w.no(new Error(str(v.error) ?? "WhatsApp failed."));
      } else if (typeof v.ev === "string") onEvent(v.ev, v.data);
    });
    await this.request("start", {});
  }

  request(op: string, args: Raw, waitMs = 30_000): Promise<Raw> {
    const child = this.child;
    if (child === undefined || child.stdin === null) return Promise.reject(new Error("WhatsApp's engine isn't running."));
    const id = this.next++;
    return new Promise((ok, no) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        no(new Error("WhatsApp didn't answer in time."));
      }, waitMs);
      this.waiting.set(id, { ok, no, timer });
      child.stdin?.write(`${JSON.stringify({ ...args, id, op })}\n`);
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    await this.request("stop", {}, 3000).catch(() => {});
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        r();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(t);
        r();
      });
    });
  }
}

type Phase = "idle" | "installing" | "pairing" | "connecting" | "open" | "closed";

/** How long a link may wait for the phone before Harbor gives up on it. */
const PAIR_WAIT = 5 * 60_000;
/** An unlinked host with nothing to do goes after this. */
const IDLE_EXIT = 3 * 60_000;

export class Host {
  phase: Phase = "idle";
  qr: string | undefined;
  code: string | undefined;
  error: string | undefined;
  note = "";
  sync = "";
  /** When the code runs out (the engine's link for it ends), and the number it's for (digits). */
  private codeUntil = 0;
  private codeFor = "";
  /** A code request is out; a code ran out before the phone linked. */
  private asking = false;
  private lost = false;
  private codeError: string | undefined;
  private pairUntil = 0;
  private idleSince = Date.now();
  private busy = 0;
  private stamp = bundleStamp();
  readonly tools: Tools;

  constructor(
    readonly store: Store,
    readonly engine: EngineProc,
  ) {
    const me = setup.linked();
    if (me !== undefined) store.me = normJid(me.jid);
    this.tools = new Tools(store, engine, { state: () => this.state() });
  }

  linked(): boolean {
    return setup.linked() !== undefined;
  }

  state(): State {
    const me = setup.linked();
    const s: State = {
      linked: me !== undefined,
      connection: this.phase === "open" ? "open" : this.phase === "pairing" ? "pairing" : this.phase === "installing" ? "installing" : this.phase === "connecting" ? "connecting" : "closed",
      me: me === undefined ? undefined : { jid: me.jid, name: me.name },
      sync: this.sync,
    };
    if (this.error !== undefined) s.note = this.error;
    return s;
  }

  status(): Raw {
    const me = setup.linked();
    return {
      phase: this.phase,
      linked: me !== undefined,
      account: me === undefined ? null : { jid: me.jid, name: me.name },
      pairing: this.phase === "pairing" || (this.phase === "installing" && this.pairUntil > 0) ? this.pairing() : null,
      error: this.error ?? null,
      sync: this.sync,
      busy: this.busy,
    };
  }

  /** A running link as the cards show it: its QR, its code, what to do, and what to try when a code didn't link. */
  private pairing(): Raw {
    const p: Raw = { qr: this.qr ?? null, code: this.code ?? null, note: this.note, hint: null, retry: null, until: null, left: null };
    if (this.asking) p.note = "Getting a code\u{2026}";
    else if (this.code !== undefined) {
      const ms = this.codeUntil - Date.now();
      p.note = this.codeUntil > 0 ? `Enter the code on your phone \u{b7} ${left(ms)} left` : "Enter the code on your phone";
      if (this.codeUntil > 0) {
        p.until = Math.floor(this.codeUntil / 1000);
        p.left = left(ms);
      }
      const alt = brazilAlt(this.codeFor);
      if (alt !== undefined) {
        const without = alt.length < this.codeFor.length;
        p.hint = without
          ? `Didn't link? Some Brazilian numbers are on WhatsApp without the 9 after the area code: try ${brazilShow(alt)}.`
          : `Didn't link? Most Brazilian mobiles are on WhatsApp with a 9 after the area code: try ${brazilShow(alt)}.`;
        p.retry = { phone: `+${alt}`, label: without ? "Try without the 9" : "Try with the 9" };
      } else p.hint = "Didn't link? Check the number has its country code, or get a new code.";
    } else if (this.codeError !== undefined) p.note = `Couldn't get a code: ${this.codeError}`;
    else if (this.lost) p.note = "That code ran out before the phone linked. Get a new one.";
    return p;
  }

  /** Starts the engine if it isn't running: to link (`pairing`) or to keep a link up. */
  private starting: Promise<void> | undefined;

  /** Starts the engine if it isn't running: to link (`pairing`) or to keep a link up. One start at a time. */
  up(pairing: boolean): Promise<void> {
    if (this.engine.running()) return Promise.resolve();
    this.starting ??= this.start(pairing).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(pairing: boolean): Promise<void> {
    this.phase = "installing";
    this.note = "Getting WhatsApp ready…";
    try {
      await this.engine.start(
        (ev, data) => this.event(ev, data),
        () => {
          if (this.phase !== "idle") this.phase = this.linked() ? "closed" : "idle";
        },
      );
      // The engine may have spoken already (a QR, the link up): that wins.
      if (this.phase === "installing") {
        this.phase = pairing ? "pairing" : "connecting";
        this.note = pairing ? "Waiting for the code…" : "";
      }
    } catch (e) {
      this.phase = "idle";
      this.error = msg(e);
      this.pairUntil = 0;
      throw e;
    }
  }

  async link(phone: string | undefined): Promise<void> {
    if (this.linked()) throw new Error("WhatsApp is already linked on this PC.");
    this.error = undefined;
    this.clearCode();
    this.pairUntil = Date.now() + PAIR_WAIT;
    if (!this.engine.running()) {
      this.forget();
      // The first link installs the engine (seconds to a minute): the card follows it in `status`.
      const starting = this.up(true).catch(() => {});
      if (phone === undefined) return;
      await starting;
    }
    if (this.engine.running()) this.phase = "pairing";
    if (phone !== undefined) await this.askCode(phone);
  }

  async askCode(phone: string): Promise<void> {
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) throw new Error("Enter the phone number with its country code, like +55 11 91234 5678.");
    for (let i = 0; i < 240 && this.qr === undefined && (this.phase === "pairing" || this.phase === "installing"); i++) await new Promise((r) => setTimeout(r, 250));
    if (this.qr === undefined) throw new Error(this.error ?? "WhatsApp isn't ready to link yet. Try again in a moment.");
    this.clearCode();
    this.codeError = undefined;
    this.asking = true;
    // The engine makes a new link for the code (its whole time is the code's): a minute at most.
    const ask = (d: string): Promise<Raw> => this.engine.request("pair_code", { phone: d }, 75_000);
    let used = digits;
    let r: Raw;
    try {
      try {
        r = await ask(digits);
      } catch (e) {
        // WhatsApp said no to this number: a Brazilian one may be on WhatsApp in its other form.
        const alt = brazilAlt(digits);
        if (alt === undefined || !/refused a code/.test(msg(e))) throw e;
        log(`whatsapp host: code refused for a +55 number of ${digits.length} digits, trying it ${alt.length < digits.length ? "without" : "with"} the 9`);
        r = await ask(alt);
        used = alt;
      }
    } catch (e) {
      this.codeError = msg(e);
      throw e;
    } finally {
      this.asking = false;
    }
    const code = str(r.code);
    if (code === undefined) throw new Error("WhatsApp gave no code.");
    this.code = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
    this.codeFor = used;
    this.codeUntil = typeof r.until === "number" && r.until > Date.now() ? r.until : 0;
    // The link waits for the phone as long as the code lasts.
    this.pairUntil = Math.max(this.pairUntil, this.codeUntil + 15_000, Date.now() + 2 * 60_000);
    this.note = "Enter the code on your phone";
  }

  private clearCode(): void {
    this.codeError = undefined;
    this.code = undefined;
    this.codeUntil = 0;
    this.codeFor = "";
    this.lost = false;
  }

  /** Back from a code to the QR and the number: another number, or the QR after all. */
  uncode(): void {
    this.clearCode();
    if (this.qr !== undefined) this.note = "Scan with WhatsApp";
  }

  async cancel(): Promise<void> {
    this.pairUntil = 0;
    this.qr = undefined;
    this.clearCode();
    if (!this.linked()) {
      await this.engine.stop();
      setup.wipe();
      this.phase = "idle";
    }
  }

  /** Unlinks this PC: WhatsApp drops the device, and everything stored here goes. */
  async signOut(): Promise<void> {
    this.pairUntil = 0;
    if (this.engine.running()) {
      await this.engine.request("logout", {}, 15_000).catch(() => {});
      await this.engine.stop();
    }
    this.forget();
    this.phase = "idle";
    this.qr = undefined;
    this.clearCode();
  }

  /** Everything of the account: its keys and all that was stored of it. */
  private forget(): void {
    setup.wipe();
    this.store.db.exec("DELETE FROM messages; DELETE FROM chats; DELETE FROM contacts; DELETE FROM lids; DELETE FROM meta; DELETE FROM sends;");
    this.store.db.exec("VACUUM;");
    this.store.me = "";
    this.store.meLid = "";
    this.sync = "";
  }

  event(ev: string, data: unknown): void {
    try {
      this.take(ev, data);
    } catch (e) {
      process.stderr.write(`whatsapp host: ${ev}: ${msg(e)}\n`);
    }
  }

  private take(ev: string, data: unknown): void {
    const d = obj(data);
    switch (ev) {
      case "qr":
        if (this.linked()) return;
        this.qr = str(d.qr);
        this.phase = "pairing";
        if (this.code === undefined && !this.lost) this.note = "Scan with WhatsApp";
        return;
      case "open": {
        const jid = normJid(str(d.id) ?? "");
        const wasLinked = this.linked();
        writePrivate(setup.linkedPath(), JSON.stringify({ jid, name: str(d.name) ?? "", at: Math.floor(Date.now() / 1000) }));
        this.store.me = jid;
        const lid = str(d.lid);
        if (lid !== undefined) {
          this.store.meLid = normJid(lid);
          this.store.learnLid(lid, jid);
        }
        this.phase = "open";
        this.qr = undefined;
        this.clearCode();
        this.note = "";
        this.error = undefined;
        this.pairUntil = 0;
        if (!wasLinked) this.sync = "receiving recent chats";
        void this.engine
          .request("groups", {}, 60_000)
          .then((r) => {
            for (const g of list(r.groups)) this.store.groupName(str(g.id) ?? "", str(g.subject) ?? "");
          })
          .catch(() => {});
        return;
      }
      case "close":
        if (d.refused === true && !this.linked()) {
          // WhatsApp turned the new device down (its 401 before any link): nothing to forget but the keys.
          this.error = "WhatsApp refused to link this PC. Try again in a few minutes.";
          this.pairUntil = 0;
          this.qr = undefined;
          this.clearCode();
          void this.engine.stop().then(() => setup.wipe());
          this.phase = "idle";
          return;
        }
        if (d.lostCode === true && !this.linked()) {
          // The engine starts a new link by itself: a new QR, and a new code when asked.
          this.qr = undefined;
          this.clearCode();
          this.lost = true;
          this.note = "That code ran out before the phone linked. Get a new one.";
          // Time to ask for another before the link is given up.
          if (this.pairUntil > 0) this.pairUntil = Math.max(this.pairUntil, Date.now() + 2 * 60_000);
          return;
        }
        if (d.loggedOut === true) {
          const was = this.linked();
          void this.engine.stop();
          this.forget();
          this.phase = "idle";
          if (was) setup.notice("WhatsApp unlinked", "This PC was logged out of WhatsApp (from the phone, or by WhatsApp). Link it again in Settings › Integrations.", "whatsapp-unlinked");
          return;
        }
        if (d.expired === true && !this.linked()) {
          if (this.pairUntil > 0) this.error = "The code expired before the phone linked. Try again.";
          this.pairUntil = 0;
          this.qr = undefined;
          this.clearCode();
          void this.engine.stop();
          this.phase = "idle";
          return;
        }
        if (this.linked()) this.phase = "connecting";
        return;
      case "messaging-history.set": {
        this.store.db.transaction(() => {
          for (const m of list(d.lidPnMappings)) if (str(m.lid) && str(m.pn)) this.store.learnLid(str(m.lid) ?? "", str(m.pn) ?? "");
          for (const c of list(d.contacts)) this.contact(c);
          for (const c of list(d.chats)) this.store.chat(c);
          for (const m of list(d.messages)) this.store.message(m, "history");
        })();
        const p = typeof d.progress === "number" ? d.progress : undefined;
        this.sync = p !== undefined && p < 100 ? `${Math.round(p)}%` : "";
        return;
      }
      case "messaging-history.status":
        if (d.status === "complete" || d.status === "paused") this.sync = "";
        return;
      case "messages.upsert": {
        const how = d.type === "notify" ? "notify" : "append";
        for (const m of list(d.messages)) this.store.message(m, how);
        return;
      }
      case "messages.update":
        for (const u of list(data)) this.store.update(u);
        return;
      case "chats.upsert":
      case "chats.update":
        for (const c of list(data)) this.store.chat(c);
        return;
      case "chats.delete":
        for (const j of Array.isArray(data) ? data : []) if (typeof j === "string") this.store.dropChat(j);
        return;
      case "contacts.upsert":
      case "contacts.update":
        for (const c of list(data)) this.contact(c);
        return;
      case "groups.upsert":
      case "groups.update":
        for (const g of list(data)) this.store.groupName(str(g.id) ?? "", str(g.subject) ?? "");
        return;
      case "lid-mapping.update":
        for (const m of Array.isArray(data) ? list(data) : [d]) if (str(m.lid) && str(m.pn)) this.store.learnLid(str(m.lid) ?? "", str(m.pn) ?? "");
        return;
    }
  }

  private contact(c: Raw): void {
    const id = str(c.id);
    if (id === undefined) return;
    const lid = str(c.lid);
    const pn = str(c.phoneNumber) ?? str(c.jid);
    if (lid !== undefined && id.endsWith("@s.whatsapp.net")) this.store.learnLid(lid, id);
    if (pn !== undefined && id.endsWith("@lid")) this.store.learnLid(id, pn);
    this.store.contact(id, { name: str(c.name) ?? "", notify: str(c.notify) ?? "", verified: str(c.verifiedName) ?? "" });
  }

  async handle(req: Raw): Promise<Raw> {
    try {
      return { ok: true, result: await this.op(req) };
    } catch (e) {
      return { ok: false, error: msg(e) };
    }
  }

  private async op(req: Raw): Promise<unknown> {
    switch (req.op) {
      case "status":
        return this.status();
      case "link":
        await this.link(typeof req.phone === "string" && req.phone.trim() !== "" ? req.phone : undefined);
        return this.status();
      case "code":
        if (this.linked()) throw new Error("WhatsApp is already linked on this PC.");
        if (this.pairUntil === 0) await this.link(typeof req.phone === "string" ? req.phone : "");
        else await this.askCode(typeof req.phone === "string" ? req.phone : "");
        return this.status();
      case "uncode":
        this.uncode();
        return this.status();
      case "cancel":
        await this.cancel();
        return this.status();
      case "signout":
        await this.signOut();
        return this.status();
      case "call": {
        this.busy++;
        try {
          if (this.linked() && !this.engine.running()) await this.up(false).catch(() => {});
          return await this.tools.call(typeof req.name === "string" ? req.name : "", req.args);
        } finally {
          this.busy--;
          this.idleSince = Date.now();
        }
      }
      case "stop":
        setTimeout(() => this.onStop(), 10);
        return {};
      default:
        throw new Error("unknown op");
    }
  }

  onStop: () => void = () => {};

  /** Once in a while: true when the host should end (unlinked and idle, a link given up, Harbor updated). */
  async tick(): Promise<boolean> {
    const now = Date.now();
    if (this.pairUntil > 0 && now > this.pairUntil && !this.linked()) {
      this.error = "Nobody linked a phone in time. Try again when you have it at hand.";
      await this.cancel();
    }
    if (this.linked() && !this.engine.running() && this.phase !== "installing") await this.up(false).catch(() => {});
    if (!this.linked() && this.pairUntil === 0 && this.busy === 0 && now - this.idleSince > IDLE_EXIT) return true;
    if (this.pairUntil > 0 || this.phase === "pairing" || this.phase === "installing") this.idleSince = now;
    // An update came: this Harbor's app starts the new host (and engine) a minute later.
    if (this.busy === 0 && this.pairUntil === 0 && bundleStamp() !== this.stamp) return true;
    return false;
  }
}

function serveConn(h: Host, conn: Socket): void {
  let buf = "";
  conn.setEncoding("utf8");
  conn.on("error", () => {});
  conn.on("data", (d: string) => {
    buf += d;
    const i = buf.indexOf("\n");
    if (i < 0) return;
    let req: Raw;
    try {
      req = obj(JSON.parse(buf.slice(0, i)));
    } catch {
      conn.destroy();
      return;
    }
    conn.removeAllListeners("data");
    void h.handle(req).then((reply) => conn.end(`${JSON.stringify(reply)}\n`));
  });
}

/** `harbor app whatsapp-host`: one per user, held by a lock. */
export async function run(): Promise<number> {
  // Messages, keys and downloads are the user's alone: everything this process makes is owner-only.
  process.umask(0o077);
  mkdirSync(setup.root(), { recursive: true, mode: 0o700 });
  const lock = await takeLock(setup.lockPath());
  if (lock === undefined) return 0;
  const say = (s: string): void => {
    process.stderr.write(`${new Date().toISOString()} ${s}\n`);
  };
  try {
    if (statSync(setup.logPath()).size > 4 << 20) rmSync(setup.logPath(), { force: true });
  } catch {
    // no log yet
  }
  const store = new Store(setup.dbPath());
  const host = new Host(store, new ChildEngine(say));
  const sock = setup.socket();
  rmSync(sock, { force: true });
  const server: Server = createServer((c) => serveConn(host, c));
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(sock, () => res());
  });
  let end: (n: number) => void = () => {};
  const done = new Promise<number>((r) => {
    end = r;
  });
  const close = async (): Promise<void> => {
    clearInterval(timer);
    server.close();
    await host.engine.stop();
    rmSync(sock, { force: true });
    store.close();
    closeSync(lock);
    end(0);
  };
  host.onStop = () => void close();
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => void close());
  if (host.linked()) void host.up(false).catch((e: unknown) => say(`start: ${msg(e)}`));
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    host
      .tick()
      .then((over) => {
        if (over) void close();
      })
      .catch((e: unknown) => say(`tick: ${msg(e)}`))
      .finally(() => {
        ticking = false;
      });
  }, 10_000);
  return done;
}
