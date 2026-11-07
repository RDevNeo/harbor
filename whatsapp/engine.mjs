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

/**
 * The engine over `baileys` (the module, or a test's stand-in with the same names). `write` takes
 * one line out; `say` the log. Returns what a command line goes to.
 */
export function createEngine({ baileys, authDir, write, say = () => {}, exit = () => {} }) {
  const logger = quietLogger(say);
  const { DisconnectReason } = baileys;
  const out = (o) => write(JSON.stringify(o, replacer));
  /** What this engine sent lately: a recipient's phone asks again when it can't decrypt one. */
  const sent = new Map();
  let sock;
  let state;
  let stopping = false;
  let attempt = 0;
  let timer;
  let qrSeen = false;

  async function connect() {
    clearTimeout(timer);
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    const auth = await baileys.useMultiFileAuthState(authDir);
    state = auth.state;
    qrSeen = false;
    const keys = baileys.makeCacheableSignalKeyStore ? baileys.makeCacheableSignalKeyStore(state.keys, logger) : state.keys;
    const s = baileys.makeWASocket({
      auth: { creds: state.creds, keys },
      logger,
      browser: baileys.Browsers.ubuntu("Harbor"),
      // The phone keeps its notifications only while no other device says it's online.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => sent.get(key.id)?.message ?? undefined,
    });
    sock = s;
    s.ev.on("creds.update", auth.saveCreds);
    s.ev.on("connection.update", (u) => {
      if (s !== sock) return;
      if (u.qr) {
        qrSeen = true;
        out({ ev: "qr", data: { qr: u.qr } });
      }
      if (u.connection === "open") {
        attempt = 0;
        const me = s.user ?? state.creds.me ?? {};
        out({ ev: "open", data: { id: me.id ?? "", lid: me.lid ?? "", name: me.name ?? me.notify ?? "" } });
      }
      if (u.connection === "close") {
        const err = u.lastDisconnect?.error;
        const code = err?.output?.statusCode ?? 0;
        const loggedOut = code === DisconnectReason.loggedOut;
        const registered = state.creds.registered === true || state.creds.me !== undefined;
        // An unlinked pairing that ran out of codes: the host asks again when the user does.
        const expired = !registered && qrSeen && code !== DisconnectReason.restartRequired;
        out({ ev: "close", data: { code, loggedOut, expired, reason: err?.message ?? "" } });
        if (stopping || loggedOut || expired) return;
        const wait = code === DisconnectReason.restartRequired ? 0 : Math.min(60_000, 1000 * 2 ** attempt++);
        timer = setTimeout(() => void connect().catch((e) => say(`connect: ${e?.message ?? e}`)), wait);
      }
    });
    for (const name of EVENTS) {
      s.ev.on(name, (data) => {
        if (s === sock) out({ ev: name, data });
      });
    }
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
      case "pair_code": {
        const s = need();
        if (!qrSeen) throw new Error("WhatsApp isn't waiting for a link right now.");
        return { code: await s.requestPairingCode(String(c.phone).replace(/\D/g, "")) };
      }
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
