// The WhatsApp connection over a stand-in engine (no Baileys, no network): linking by QR (the raw
// payload in the state), Person Hub's folder layout, live messages, ticks, presence, sends, media
// and profile photos.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnEvent } from "../src/model/types.ts";
import { createWhatsapp } from "../src/conn/whatsapp.ts";
import type { WaEngine } from "../src/conn/whatsapp-engine.ts";
import type { ConnContext, Connection } from "../src/conn/types.ts";

type Json = Record<string, unknown>;
const ANA = "5511912345678";
const JID = `${ANA}@s.whatsapp.net`;

class FakeEngine implements WaEngine {
  ops: { op: string; args: Json }[] = [];
  onEvent: (ev: string, data: unknown) => void = () => {};
  onExit: () => void = () => {};
  up = false;
  photoUrl = "https://pps.whatsapp.net/v/photo.jpg";
  constructor(readonly authDir: string) {}
  async start(onEvent: (ev: string, data: unknown) => void, onExit: () => void): Promise<void> {
    this.onEvent = onEvent;
    this.onExit = onExit;
    this.up = true;
    this.ops.push({ op: "start", args: {} });
  }
  running(): boolean {
    return this.up;
  }
  async request(op: string, args: Json = {}): Promise<Json> {
    this.ops.push({ op, args });
    if (op === "send") {
      const content = args.content as Json;
      return { message: { key: { remoteJid: args.jid, fromMe: true, id: `S${this.ops.length}` }, messageTimestamp: 1795540100, status: 1, message: typeof content.text === "string" ? { conversation: content.text } : { documentMessage: { mimetype: "application/pdf", fileName: "a.pdf" } } } };
    }
    if (op === "download") {
      writeFileSync(String(args.to), "MEDIA");
      return { bytes: 5 };
    }
    if (op === "profile_picture") return { url: this.photoUrl };
    if (op === "on_whatsapp") return { found: [{ jid: JID, exists: true }] };
    return {};
  }
  async stop(): Promise<void> {
    if (!this.up) return;
    this.up = false;
    this.onExit();
  }
  emit(ev: string, data: unknown): void {
    this.onEvent(ev, data);
  }
}

describe("WhatsApp connection", () => {
  let dir = "";
  const logs: string[] = [];
  const events: ConnEvent[] = [];
  let conn: Connection | undefined;
  let engine: FakeEngine | undefined;
  let fetched: string[] = [];
  const make = (): Connection =>
    createWhatsapp(
      { id: "stores-wa", kind: "whatsapp", section: "stores", dir, emit: (e) => events.push(e), log: (...a) => logs.push(a.join(" ")), openExternal: () => {} } satisfies ConnContext,
      {
        engine: (o) => {
          engine = new FakeEngine(o.authDir);
          return engine;
        },
        fetch: async (url) => {
          fetched.push(url);
          return new Response(new Uint8Array([0xff, 0xd8, 0xff, 1]));
        },
      },
    );
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Bun.sleep(1);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "persons-wa-"));
    logs.length = 0;
    events.length = 0;
    fetched = [];
    engine = undefined;
  });
  afterEach(async () => {
    await conn?.stop();
    conn = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("not linked: signed out; connect shows the raw QR, then the link opens", async () => {
    conn = make();
    await conn.start();
    expect(conn.state().status).toBe("signed-out");
    expect(engine).toBeUndefined();
    await conn.connect();
    await settle();
    expect(engine?.authDir).toBe(join(dir, "whatsapp-stores-wa", "auth"));
    engine?.emit("qr", { qr: "2@abc,def,ghi" });
    expect(conn.state()).toMatchObject({ status: "signing-in", qr: "2@abc,def,ghi" });
    engine?.emit("open", { id: `${ANA.replace("5678", "0000")}:3@s.whatsapp.net`, name: "Igor" });
    expect(conn.state()).toMatchObject({ status: "connected", qr: null, me: { globalName: "Igor", username: "+5511912340000" } });
  });

  it("a migrated folder starts linked, keeps its chats, and takes live messages, ticks and presence", async () => {
    const wdir = join(dir, "whatsapp-stores-wa");
    mkdirSync(join(wdir, "auth"), { recursive: true });
    writeFileSync(join(wdir, "auth", "creds.json"), JSON.stringify({ me: { id: "1@s.whatsapp.net" } }));
    const old = { id: "OLD1", channelId: JID, authorId: JID, fromMe: false, content: "antes", timestamp: "2026-11-01T00:00:00.000Z" };
    writeFileSync(join(wdir, "chats.json"), JSON.stringify({ version: 1, chats: { [ANA]: [old] }, raws: {}, lids: { "99@lid": JID }, contacts: { [ANA]: { name: "Ana" } }, contactsAt: "2026-11-01", lastSeen: {} }));
    conn = make();
    await conn.start();
    await settle();
    expect(conn.state().status).toBe("connecting");
    engine?.emit("open", { id: "1@s.whatsapp.net", name: "Igor" });
    expect(conn.state().status).toBe("connected");

    const conv = await conn.track([`+${ANA}`]);
    expect(conv[ANA]?.messages.map((m) => m.id)).toEqual(["OLD1"]);

    // a message from their lid (resolved through the saved mapping), with media
    engine?.emit("messages.upsert", { messages: [{ key: { remoteJid: "99@lid", fromMe: false, id: "IN1" }, messageTimestamp: 1795540000, message: { imageMessage: { caption: "foto", mimetype: "image/jpeg" } } }] });
    const live = events.find((e) => e.type === "messages");
    expect(live).toMatchObject({ type: "messages", peerId: ANA, messages: [{ id: "IN1", content: "foto" }] });

    // ticks: a receipt before the message, then the message, then read
    engine?.emit("messages.update", [{ key: { remoteJid: JID, fromMe: true, id: "OUT1" }, update: { status: 3 } }]);
    engine?.emit("messages.upsert", { messages: [{ key: { remoteJid: JID, fromMe: true, id: "OUT1" }, messageTimestamp: 1795540001, status: 2, message: { conversation: "oi" } }] });
    expect((await conn.history(ANA)).messages.find((m) => m.id === "OUT1")?.status).toBe("delivered");
    engine?.emit("messages.update", [{ key: { remoteJid: JID, fromMe: true, id: "OUT1" }, update: { status: 4 } }]);
    expect((await conn.history(ANA)).messages.find((m) => m.id === "OUT1")?.status).toBe("read");

    // presence: typing and online, then last seen
    engine?.emit("presence.update", { id: JID, presences: { [JID]: { lastKnownPresence: "composing" } } });
    expect(events.filter((e) => e.type === "typing").at(-1)).toMatchObject({ peerId: ANA, kind: "typing" });
    expect(events.filter((e) => e.type === "presence").at(-1)).toMatchObject({ presence: { [ANA]: "online" } });
    engine?.emit("presence.update", { id: JID, presences: { [JID]: { lastKnownPresence: "unavailable", lastSeen: 1795540000 } } });
    expect(events.filter((e) => e.type === "presence").at(-1)).toMatchObject({ presence: { [ANA]: "offline" }, lastSeen: { [ANA]: 1795540000000 } });

    // media: downloaded once into media/, handed out under its name in files/
    const url = (await conn.history(ANA)).messages.find((m) => m.id === "IN1")?.attachments?.[0]?.url ?? "";
    const file = await conn.fetchAttachment?.(url, "foto.jpg");
    expect(file).toBe(join(dir, "files", "stores-wa", "IN1-foto.jpg"));
    expect(readFileSync(file ?? "", "utf8")).toBe("MEDIA");
    expect(existsSync(join(wdir, "media", "IN1"))).toBe(true);
    await conn.fetchAttachment?.(url, "foto.jpg");
    expect(engine?.ops.filter((o) => o.op === "download")).toHaveLength(1);

    // read receipts for their messages with keys
    await conn.markRead?.(ANA);
    expect(engine?.ops.find((o) => o.op === "read")?.args).toEqual({ keys: [{ remoteJid: "99@lid", fromMe: false, id: "IN1" }] });

    await conn.stop();
    const saved = JSON.parse(readFileSync(join(wdir, "chats.json"), "utf8"));
    expect(saved.chats[ANA].map((m: { id: string }) => m.id)).toEqual(["OLD1", "IN1", "OUT1"]);
    expect(saved.raws.IN1).toBeDefined();
  });

  it("sends text and files, replying to a message", async () => {
    conn = make();
    await conn.connect();
    await settle();
    engine?.emit("open", { id: "1@s.whatsapp.net", name: "" });
    await conn.track([ANA]);
    engine?.emit("messages.upsert", { messages: [{ key: { remoteJid: JID, fromMe: false, id: "Q1" }, messageTimestamp: 1795540000, message: { conversation: "pergunta" } }] });
    const r = await conn.send(ANA, "resposta", [], "Q1");
    expect(r).toMatchObject({ ok: true, message: { fromMe: true, content: "resposta", status: "sent" } });
    const send = engine?.ops.find((o) => o.op === "send");
    expect(send?.args).toMatchObject({ jid: JID, content: { text: "resposta" }, quoted: { key: { id: "Q1" } } });
    expect(await conn.send("12", "x")).toEqual({ ok: false, error: "Invalid WhatsApp number" });
    expect(await conn.send(ANA, "  ")).toEqual({ ok: false, error: "Empty message" });
  });

  it("profile photos: a local file, asked once a day; none remembered", async () => {
    conn = make();
    await conn.connect();
    await settle();
    engine?.emit("open", { id: "1@s.whatsapp.net", name: "" });
    const p = await conn.photo?.(ANA);
    expect(p).toBe(join(dir, "avatars", `wa_${ANA}_preview.jpg`));
    expect(readFileSync(p ?? "")[0]).toBe(0xff);
    expect(await conn.photo?.(`+${ANA}`)).toBe(p ?? "");
    expect(fetched).toHaveLength(1);
    if (engine) engine.photoUrl = "";
    expect(await conn.photo?.("5511900000000")).toBeNull();
    expect(existsSync(join(dir, "avatars", "wa_5511900000000_preview.none"))).toBe(true);
    expect(engine?.ops.filter((o) => o.op === "profile_picture")).toHaveLength(2);
  });

  it("Person Hub's photo files (no extension) are adopted", async () => {
    mkdirSync(join(dir, "avatars"), { recursive: true });
    writeFileSync(join(dir, "avatars", `wa_${ANA}_preview`), "JPEG");
    conn = make();
    expect(await conn.photo?.(ANA)).toBe(join(dir, "avatars", `wa_${ANA}_preview.jpg`));
    expect(fetched).toHaveLength(0);
  });

  it("logged out by the phone: the keys go, signed out", async () => {
    conn = make();
    await conn.connect();
    await settle();
    engine?.emit("open", { id: "1@s.whatsapp.net", name: "" });
    mkdirSync(join(dir, "whatsapp-stores-wa", "auth"), { recursive: true });
    engine?.emit("close", { loggedOut: true });
    await settle();
    expect(conn.state().status).toBe("signed-out");
    expect(existsSync(join(dir, "whatsapp-stores-wa", "auth"))).toBe(false);
  });
});
