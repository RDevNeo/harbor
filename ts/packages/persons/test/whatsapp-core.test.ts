// Ported from Person Hub's src/lib/whatsapp-core.test.ts, plus pacing, uploads and chwa:// URLs.
import { describe, expect, it } from "bun:test";
import * as wa from "../src/conn/whatsapp-core.ts";

describe("WhatsApp helpers (ported from Hub)", () => {
  it("normalizes jids and numbers", () => {
    expect(wa.normJid("5511912345678:12@s.whatsapp.net")).toBe("5511912345678@s.whatsapp.net");
    expect(wa.normJid("5511912345678@c.us")).toBe("5511912345678@s.whatsapp.net");
    expect(wa.digitsOf("5511912345678@s.whatsapp.net")).toBe("5511912345678");
    expect(wa.isLid("123@lid")).toBe(true);
    expect(wa.skipped("status@broadcast")).toBe(true);
    expect(wa.normPhone("+55 11 91234-5678")).toBe("5511912345678");
  });

  it("reads what a message says, through wrappers", () => {
    expect(wa.parseContent({ conversation: "oi" })).toEqual({ kind: "text", text: "oi" });
    expect(wa.parseContent({ ephemeralMessage: { message: { extendedTextMessage: { text: "sumiu", contextInfo: { stanzaId: "Q1", quotedMessage: { conversation: "antes" } } } } } })).toEqual({
      kind: "text",
      text: "sumiu",
      quoted: { id: "Q1", text: "antes" },
    });
    expect(wa.parseContent({ audioMessage: { ptt: true, seconds: 8, mimetype: "audio/ogg; codecs=opus" } })).toMatchObject({ kind: "voice", media: { seconds: 8 } });
    expect(wa.parseContent({ protocolMessage: {} })).toBeUndefined();
    expect(wa.parseContent({ messageContextInfo: {}, imageMessage: { caption: "foto", mimetype: "image/jpeg" } })).toMatchObject({ kind: "image", text: "foto" });
  });

  it("slims a message into the chat shape, with chwa:// media and quoted replies", () => {
    const raw = {
      key: { remoteJid: "5511912345678@s.whatsapp.net", fromMe: false, id: "ABC123" },
      messageTimestamp: 1795540000,
      message: { audioMessage: { ptt: true, seconds: 8, mimetype: "audio/ogg; codecs=opus", waveform: { $b: "AAEC" } } },
    };
    const m = wa.slimWa(raw, "5511912345678@s.whatsapp.net", "stores-wa");
    expect(m).toMatchObject({ id: "ABC123", fromMe: false, voice: true, timestamp: new Date(1795540000 * 1000).toISOString() });
    expect(m?.attachments?.[0]).toMatchObject({ type: "audio/ogg; codecs=opus", duration: 8, waveform: "AAEC" });
    expect(m?.attachments?.[0]?.url.startsWith("chwa://stores-wa/ABC123?")).toBe(true);
    expect(wa.parseMediaUrl(m?.attachments?.[0]?.url ?? "")).toMatchObject({ msgId: "ABC123", type: "audio/ogg; codecs=opus" });
    expect(() => wa.parseMediaUrl("chwa://c/..%2Fx")).toThrow();
    const r = wa.slimWa(
      { key: { remoteJid: "x@s.whatsapp.net", fromMe: true, id: "R1" }, messageTimestamp: 1, message: { extendedTextMessage: { text: "sim", contextInfo: { stanzaId: "Q1", quotedMessage: { conversation: "pergunta" } } } } },
      "x@s.whatsapp.net",
      "c",
    );
    expect(r).toMatchObject({ fromMe: true, content: "sim", reply: { id: "Q1", content: "pergunta" } });
  });

  it("builds what to send for a file", () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(wa.contentFor({ name: "a.png", type: "image/png", data }, "olha")).toMatchObject({ image: { $b: "AQID" }, caption: "olha" });
    expect(wa.contentFor({ name: "a.pdf", type: "application/pdf", data }, "")).toMatchObject({ document: { $b: "AQID" }, fileName: "a.pdf" });
    expect(wa.contentFor({ name: "v.ogg", type: "audio/ogg", data, voice: { duration: 3.4, waveform: "AAEC" } })).toMatchObject({ audio: { $b: "AQID" }, ptt: true, seconds: 3, waveform: { $b: "AAEC" } });
  });

  it("normalizes typed WhatsApp numbers like the app does", () => {
    expect(wa.normWhatsApp("+55 11 91234-5678")).toBe("5511912345678");
    expect(wa.normWhatsApp("(11) 91234-5678")).toBe("5511912345678");
    expect(wa.normWhatsApp("011 91234-5678")).toBe("5511912345678");
    expect(wa.normWhatsApp("+55 31 8765-4321")).toBe("5531987654321");
    expect(wa.normWhatsApp("11 3456-7890")).toBe("551134567890");
    expect(wa.normWhatsApp("+1 415 555 1234")).toBe("14155551234");
    expect(wa.normWhatsApp("+44 7700 900123")).toBe("447700900123");
    expect(wa.normWhatsApp("12")).toBe("");
    expect(wa.phoneVariants("5531987654321")).toEqual(["5531987654321", "553187654321"]);
    expect(wa.phoneVariants("551134567890")).toEqual(["551134567890"]);
    expect(wa.phoneVariants("14155551234")).toEqual(["14155551234"]);
  });

  it("parses presence updates (online, typing, last seen)", () => {
    expect(wa.parsePresence({ id: "x", presences: { x: { lastKnownPresence: "available" } } })).toEqual({ online: true, activity: null, lastSeen: undefined });
    expect(wa.parsePresence({ id: "x", presences: { x: { lastKnownPresence: "composing" } } })).toEqual({ online: true, activity: "typing", lastSeen: undefined });
    expect(wa.parsePresence({ id: "x", presences: { x: { lastKnownPresence: "recording" } } })?.activity).toBe("recording");
    expect(wa.parsePresence({ id: "x", presences: { x: { lastKnownPresence: "unavailable", lastSeen: 1764080000 } } })).toEqual({ online: false, activity: null, lastSeen: 1764080000000 });
    expect(wa.parsePresence({ id: "x", presences: {} })).toBeNull();
    expect(wa.parsePresence(null)).toBeNull();
  });

  it("moves ticks forward only", () => {
    expect(wa.waStatus(3)).toBe("delivered");
    expect(wa.waStatus("PLAYED")).toBe("read");
    expect(wa.mergeStatus("read", "delivered")).toBe("read");
    expect(wa.mergeStatus("sent", "error")).toBe("error");
    expect(wa.mergeStatus("delivered", "error")).toBe("delivered");
    expect(wa.mergeStatus("error", "read")).toBe("read");
    expect(wa.mergeStatus(undefined, "sent")).toBe("sent");
  });
});

describe("WhatsApp profile photo cache", () => {
  const H = 3600_000;
  const now = 100 * H;
  it("asks when nothing is cached or it is a day old", () => {
    expect(wa.photoCache(undefined, undefined, now)).toBe("ask");
    expect(wa.photoCache(now - 25 * H, undefined, now)).toBe("ask");
    expect(wa.photoCache(undefined, now - 24 * H, now)).toBe("ask");
  });
  it("serves the fresher of photo and \"none\"", () => {
    expect(wa.photoCache(now - H, undefined, now)).toBe("photo");
    expect(wa.photoCache(undefined, now - H, now)).toBe("none");
    expect(wa.photoCache(now - 2 * H, now - H, now)).toBe("none");
    expect(wa.photoCache(now - H, now - 2 * H, now)).toBe("photo");
  });
});

describe("pacing and uploads", () => {
  it("books sends a random 1.8–4.2 s apart", () => {
    let t = 1000;
    const p = wa.createPacer({ now: () => t, random: () => 0.5 });
    expect(p.reserve()).toBe(0);
    expect(p.reserve()).toBe(3000);
    t += 10_000;
    expect(p.reserve()).toBe(0);
  });
  it("checks files: names, types, sizes, voice notes", () => {
    const data = new Uint8Array([1]);
    expect(wa.checkUploads([{ name: "../a.png", type: "image/png", data }])).toEqual([{ name: "_a.png", type: "image/png", data }]);
    expect(wa.checkUploads([{ name: "x", type: "bad type", data }])[0]?.type).toBe("application/octet-stream");
    expect(() => wa.checkUploads([{ name: "e", type: "a/b", data: new Uint8Array() }])).toThrow(/empty/);
    expect(() => wa.checkUploads([{ name: "big", type: "a/b", data: new Uint8Array(11 * 1024 * 1024) }])).toThrow(/10 MB/);
    expect(wa.checkUploads([{ name: "v.ogg", type: "audio/ogg", data, voice: { duration: 3.456, waveform: "AAEC" } }])[0]?.voice).toEqual({ duration: 3.46, waveform: "AAEC" });
    expect(() => wa.checkUploads([{ name: "v", type: "audio/ogg", data, voice: { duration: 0, waveform: "" } }])).toThrow(/voice/);
    expect(wa.checkUploads(undefined)).toEqual([]);
  });
});
