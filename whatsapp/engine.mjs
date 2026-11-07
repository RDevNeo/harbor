// Harbor's WhatsApp engine: one linked device of the user's personal WhatsApp account, through
// Baileys. A process of its own: Harbor's WhatsApp host (MIT, ts/packages/mcp/src/whatsapphost.ts)
// starts it and talks to it in JSON lines, commands on stdin, answers and events on stdout. This
// file stays thin on purpose: what's stored, what agents may do and how fast is the host's.
//
// Copyright (C) 2026 Harbor's authors. GPL-3.0-or-later (see LICENSE): Baileys' Signal code is GPL.
//
//   BUN_BE_BUN=1 harbor engine.mjs AUTH_DIR
//
// Commands: {id, op, ...}; answers {id, ok: true, result} or {id, ok: false, error}.
// Events: {ev: "qr" | "open" | "close" | <Baileys event name>, data}.

import { mkdirSync, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";

/** The Baileys events the host stores from. */
export const EVENTS = [
  "messaging-history.set",
  "messaging-history.status",
  "messages.upsert",
  "messages.update",
  "messages.delete",
  "messages.reaction",
  "chats.upsert",
  "chats.update",
  "chats.delete",
  "contacts.upsert",
  "contacts.update",
  "groups.upsert",
  "groups.update",
  "lid-mapping.update",
];

/** Long numbers become numbers, bytes `{$b: base64}`: what the host stores and sends back. */
export function replacer(_k, v) {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Uint8Array) return { $b: Buffer.from(v).toString("base64") };
  if (v.type === "Buffer" && Array.isArray(v.data)) return { $b: Buffer.from(v.data).toString("base64") };
  if (typeof v.low === "number" && typeof v.high === "number" && typeof v.unsigned === "boolean") {
    return typeof v.toNumber === "function" ? v.toNumber() : v.high * 4294967296 + (v.low >>> 0);
  }
  return v;
}

export function reviver(_k, v) {
  return v !== null && typeof v === "object" && typeof v.$b === "string" && Object.keys(v).length === 1 ? Buffer.from(v.$b, "base64") : v;
}

const revive = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v), reviver));

function quietLogger(say) {
  const l = {
    level: "error",
    child: () => l,
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error(o, m) {
      say(`error: ${m ?? ""} ${o instanceof Error ? o.message : typeof o === "object" ? JSON.stringify(o, replacer).slice(0, 400) : String(o)}`);
    },
    fatal(o, m) {
      l.error(o, m);
    },
  };
  return l;
}

/** How long Baileys shows each QR of a link by default: the first 60 s, the rest 20 s. */
const FIRST_QR = 60_000;
const NEXT_QR = 20_000;
/**
 * A link made for a pairing code shows each of its QRs this long instead: nobody scans those, and
 * the link's whole time (about six minutes) is the code's. Baileys ends a link when its QRs run out,
 * and its code goes with it.
 */
const CODE_QR = 60_000;
/** How long to wait for WhatsApp to take a code request, and for a new link's first QR. */
const ACK_WAIT = 5000;
const QR_WAIT = 30_000;
/** The WhatsApp Web version WhatsApp serves today, asked again after this. */
const VERSION_TTL = 6 * 3600_000;

/** A number for the log: its country code, how long it is and its last two digits, never all of it. */
export function maskPhone(digits) {
  const d = String(digits).replace(/\D/g, "");
  return d.length < 6 ? `(${d.length} digits)` : `+${d.slice(0, 2)}…${d.slice(-2)} (${d.length} digits)`;
}

const childNodes = (n) => (Array.isArray(n?.content) ? n.content.filter((c) => c && typeof c === "object" && typeof c.tag === "string") : []);
const child = (n, tag) => childNodes(n).find((c) => c.tag === tag);

/**
 * The engine over `baileys` (the module, or a test's stand-in with the same names). `write` takes
 * one line out; `say` the log (host.log: what a failed link left behind). Returns what a command line goes to.
 */
export function createEngine({ baileys, authDir, write, say = () => {}, exit = () => {}, now = () => Date.now() }) {
  const logger = quietLogger(say);
  const { DisconnectReason } = baileys;
  const out = (o) => write(JSON.stringify(o, replacer));
  /** What this engine sent lately: a recipient's phone asks again when it can't decrypt one. */
  const sent = new Map();
  let sock;
  let state;
  let saveCreds = async () => {};
  let stopping = false;
  let attempt = 0;
  let timer;
  let qrSeen = false;
  /** This link had no account when it began (a QR or code link), and hasn't paired since. */
  let fresh = true;
  let paired = false;
  /** When this link's QRs run out (and Baileys ends it), from the refs WhatsApp gave it. */
  let until = 0;
  /** A pairing code is out on this link, for the number `codeFor` (digits). */
  let codeFor = "";
  /** Waiting for WhatsApp's answer to a code request. */
  let ackWait;
  let qrWaiters = [];
  let version;
  let versionAt = 0;

  async function waVersion() {
    if (version !== undefined && now() - versionAt < VERSION_TTL) return version;
    if (typeof baileys.fetchLatestWaWebVersion !== "function") return undefined;
    try {
      // Baileys' own version goes stale between its releases, and WhatsApp then refuses new links.
      const r = await baileys.fetchLatestWaWebVersion({ signal: AbortSignal.timeout(8000) });
      if (r?.isLatest === true && Array.isArray(r.version)) {
        version = r.version;
        versionAt = now();
        return version;
      }
      say(`WhatsApp Web version unknown (${r?.error?.message ?? "no answer"}): Baileys' own`);
    } catch (e) {
      say(`WhatsApp Web version unknown (${e?.message ?? e}): Baileys' own`);
    }
    return undefined;
  }

  function onFrame(f) {
    if (paired || !fresh || !f || typeof f !== "object") return;
    if (f.tag === "notification") {
      const reg = child(f, "link_code_companion_reg");
      if (reg) say(`the phone took the code (${reg.attrs?.stage ?? "?"}): linking`);
    } else if (f.tag === "iq" && ackWait !== undefined) {
      if (f.attrs?.type === "error") {
        const e = child(f, "error");
        ackWait({ ok: false, why: `${e?.attrs?.code ?? "?"} ${e?.attrs?.text ?? ""}`.trim() });
      } else if (f.attrs?.type === "result" && child(f, "link_code_companion_reg")) ackWait({ ok: true });
    }
  }

  async function connect(qrMs) {
    clearTimeout(timer);
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    const auth = await baileys.useMultiFileAuthState(authDir);
    state = auth.state;
    saveCreds = auth.saveCreds;
    qrSeen = false;
    until = 0;
    codeFor = "";
    paired = false;
    fresh = state.creds.me === undefined;
    const v = await waVersion();
    if (stopping) return;
    say(`connecting: ${fresh ? "a new link" : "the linked account"}, WhatsApp Web ${v ? v.join(".") : "(Baileys' own version)"}`);
    const keys = baileys.makeCacheableSignalKeyStore ? baileys.makeCacheableSignalKeyStore(state.keys, logger) : state.keys;
    const s = baileys.makeWASocket({
      auth: { creds: state.creds, keys },
      logger,
      ...(v ? { version: v } : {}),
      // A browser WhatsApp knows: links by code fail ("Couldn't link device") for a made-up one.
      browser: baileys.Browsers.ubuntu("Chrome"),
      ...(qrMs ? { qrTimeout: qrMs } : {}),
      // The phone keeps its notifications only while no other device says it's online.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => sent.get(key.id)?.message ?? undefined,
    });
    sock = s;
    s.ev.on("creds.update", (c) => {
      if (s === sock) void saveCreds(c);
    });
    s.ws?.on?.("frame", (f) => {
      if (s === sock) onFrame(f);
    });
    s.ws?.on?.("CB:iq,type:set,pair-device", (stanza) => {
      if (s !== sock) return;
      const refs = childNodes(child(stanza, "pair-device")).filter((c) => c.tag === "ref").length;
      until = refs > 0 ? now() + (qrMs || FIRST_QR) + (refs - 1) * (qrMs || NEXT_QR) : 0;
      say(`link waiting: ${refs} QR codes, ${Math.round((until - now()) / 1000)} s`);
    });
    s.ev.on("connection.update", (u) => {
      if (s !== sock) return;
      if (u.qr) {
        if (!qrSeen) say("QR ready");
        qrSeen = true;
        out({ ev: "qr", data: { qr: u.qr } });
        const w = qrWaiters;
        qrWaiters = [];
        for (const f of w) f();
      }
      if (u.isNewLogin) {
        paired = true;
        say("paired: WhatsApp restarts the connection");
      }
      if (u.connection === "open") {
        attempt = 0;
        paired = true;
        fresh = false;
        const me = s.user ?? state.creds.me ?? {};
        say("connected");
        out({ ev: "open", data: { id: me.id ?? "", lid: me.lid ?? "", name: me.name ?? me.notify ?? "" } });
      }
      if (u.connection === "close") {
        const err = u.lastDisconnect?.error;
        const code = err?.output?.statusCode ?? 0;
        const reason = err?.message ?? "";
        const linked = !fresh || paired || state.creds.registered === true;
        const restart = code === DisconnectReason.restartRequired;
        const lostCode = !linked && codeFor !== "" && !restart && !stopping;
        say(`closed: ${code} ${reason}`.trim() + (linked ? "" : lostCode ? " (a new link; its code is gone)" : " (a new link)"));
        // An unlinked link refused (WhatsApp's 401): not a logout, nothing was linked.
        const loggedOut = code === DisconnectReason.loggedOut && linked;
        const refused = code === DisconnectReason.loggedOut && !linked;
        // A new link that ran out of QR codes starts again by itself: the host gives up on it in time.
        out({ ev: "close", data: { code, loggedOut, refused, lostCode, reason } });
        if (stopping || loggedOut) return;
        if (!linked && !restart) {
          // The next link starts clean: a code's number in the keys would make it log in, and fail.
          if (state.creds.me !== undefined) {
            state.creds.me = undefined;
            delete state.creds.pairingCode;
            void saveCreds();
          }
          if (refused) return;
        }
        const wait = restart ? 0 : !linked && qrSeen ? 1000 : Math.min(60_000, 1000 * 2 ** attempt++);
        timer = setTimeout(() => void connect().catch((e) => say(`connect: ${e?.message ?? e}`)), wait);
      }
    });
    for (const name of EVENTS) {
      s.ev.on(name, (data) => {
        if (s === sock) out({ ev: name, data });
      });
    }
  }

  /** Ends this link and starts a new one whose QRs last `qrMs`: the whole of it for a code. */
  async function relink(qrMs) {
    const old = sock;
    sock = undefined;
    clearTimeout(timer);
    if (state?.creds && state.creds.me !== undefined) {
      state.creds.me = undefined;
      delete state.creds.pairingCode;
      await saveCreds();
    }
    try {
      old?.end(undefined);
    } catch {
      // already closed
    }
    const ready = new Promise((ok, no) => {
      const t = setTimeout(() => no(new Error("WhatsApp didn't start a link in time. Try again.")), QR_WAIT);
      qrWaiters.push(() => {
        clearTimeout(t);
        ok();
      });
    });
    ready.catch(() => {});
    await connect(qrMs);
    await ready;
  }

  async function pairCode(phone) {
    if (!sock) throw new Error("WhatsApp isn't started.");
    if (!fresh || paired) throw new Error("WhatsApp is already linked on this PC.");
    const digits = String(phone).replace(/\D/g, "");
    // A code of its own on a new link: the old link's QRs may be nearly out, and a second code on
    // one link breaks the first (Baileys keeps one).
    await relink(CODE_QR);
    const s = sock;
    say(`code asked for ${maskPhone(digits)}, ${Math.round((until - now()) / 1000)} s to enter it`);
    const ack = new Promise((ok) => {
      const t = setTimeout(() => ok(undefined), ACK_WAIT);
      ackWait = (a) => {
        clearTimeout(t);
        ok(a);
      };
    });
    let code;
    try {
      code = await s.requestPairingCode(digits);
    } catch (e) {
      ackWait = undefined;
      say(`code request failed: ${e?.message ?? e}`);
      throw e;
    }
    codeFor = digits;
    const a = await ack;
    ackWait = undefined;
    if (a === undefined) say("WhatsApp didn't answer the code request (it may still work)");
    else if (a.ok) say("WhatsApp took the code request: waiting for the phone");
    else {
      say(`WhatsApp refused the code request: ${a.why}`);
      codeFor = "";
      throw new Error(`WhatsApp refused a code for this number (${a.why}).`);
    }
    return { code, until };
  }

  const need = () => {
    if (!sock) throw new Error("WhatsApp isn't started.");
    return sock;
  };

  async function download(msg, to) {
    const s = need();
    const stream = await baileys.downloadMediaMessage(msg, "stream", {}, { logger, reuploadRequest: (m) => s.updateMediaMessage(m) });
    let bytes = 0;
    stream.on("data", (c) => {
      bytes += c.length;
    });
    await pipeline(stream, createWriteStream(to, { mode: 0o600 }));
    return { bytes };
  }

  async function run(c) {
    switch (c.op) {
      case "start":
        if (!sock) await connect();
        return {};
      case "pair_code":
        return pairCode(c.phone);
      case "send": {
        const m = await need().sendMessage(c.jid, revive(c.content), c.quoted ? { quoted: revive(c.quoted) } : {});
        if (m?.key?.id) {
          sent.set(m.key.id, m);
          if (sent.size > 300) sent.delete(sent.keys().next().value);
        }
        return { message: m };
      }
      case "read":
        await need().readMessages(c.keys);
        return {};
      case "download":
        return download(revive(c.message), c.to);
      case "groups":
        return { groups: Object.values(await need().groupFetchAllParticipating()).map((g) => ({ id: g.id, subject: g.subject ?? "" })) };
      case "on_whatsapp":
        return { found: (await need().onWhatsApp(...c.phones)) ?? [] };
      case "pn_for_lid": {
        const map = need().signalRepository?.lidMapping;
        const pairs = [];
        for (const lid of c.lids ?? []) {
          const pn = map?.getPNForLID ? await map.getPNForLID(lid).catch(() => undefined) : undefined;
          if (pn) pairs.push({ lid, pn });
        }
        return { pairs };
      }
      case "history":
        return { request: await need().fetchMessageHistory(c.count, c.key, c.ts) };
      case "logout":
        stopping = true;
        await need().logout().catch(() => {});
        return {};
      case "stop":
        stopping = true;
        clearTimeout(timer);
        sock?.end(undefined);
        setTimeout(exit, 50);
        return {};
      default:
        throw new Error(`unknown op ${c.op}`);
    }
  }

  return async function onLine(line) {
    let c;
    try {
      c = JSON.parse(line);
    } catch {
      return;
    }
    if (c === null || typeof c !== "object") return;
    try {
      out({ id: c.id, ok: true, result: await run(c) });
    } catch (e) {
      out({ id: c.id, ok: false, error: e?.message ?? String(e) });
    }
  };
}

if (import.meta.main) {
  const authDir = process.argv[2];
  if (!authDir) {
    console.error("usage: engine.mjs AUTH_DIR");
    process.exit(2);
  }
  const baileys = await import("@whiskeysockets/baileys");
  const onLine = createEngine({
    baileys: { ...baileys, makeWASocket: baileys.default ?? baileys.makeWASocket },
    authDir,
    write: (l) => process.stdout.write(`${l}\n`),
    say: (s) => process.stderr.write(`${new Date().toISOString()} ${s}\n`),
    exit: () => process.exit(0),
  });
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (l) => void onLine(l));
  // The host went away: so does the engine (its socket would answer to nobody).
  lines.on("close", () => process.exit(0));
}
