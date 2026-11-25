// The Discord connection's session handling with a stand-in for the Electron helper (no network, no Electron).
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnContext } from "../src/conn/types.ts";
import { createDiscord, discordSessionDir, type SessionMode } from "../src/conn/discord.ts";
import type { ConnEvent } from "../src/model/types.ts";
import type { HelperResult } from "../src/conn/discord-core.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(id: string, answers: Partial<Record<SessionMode, HelperResult>>) {
  const dir = mkdtempSync(join(tmpdir(), "persons-discord-"));
  dirs.push(dir);
  const events: ConnEvent[] = [];
  const calls: SessionMode[] = [];
  const ctx: ConnContext = { id, kind: "discord", section: "stores", dir, emit: (e) => events.push(e), log: () => {}, openExternal: () => {} };
  const conn = createDiscord(ctx, {
    session: async (mode) => {
      calls.push(mode);
      return answers[mode] ?? { error: "no answer" };
    },
  });
  return { dir, events, calls, conn };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("Discord connection", () => {
  it("puts each account's Electron profile in its own folder", () => {
    expect(discordSessionDir("/d", "stores")).toBe(join("/d", "discord", "stores"));
    expect(() => discordSessionDir("/d", "../x")).toThrow();
  });

  it("starts signed out when the session has no login", async () => {
    const { conn, calls, events } = setup("stores", { token: { signedOut: true } });
    expect(conn.state().status).toBe("starting");
    await conn.start();
    await settle();
    expect(calls).toEqual(["token"]);
    expect(conn.state()).toEqual({ status: "signed-out", me: null, gateway: "down", error: null });
    expect(events.at(-1)).toEqual({ type: "state", state: conn.state() });
    await conn.stop();
  });

  it("signs in through the shown helper; closing it leaves the account signed out", async () => {
    const { conn, calls } = setup("spokpay", { token: { signedOut: true }, signin: { cancelled: true } });
    await conn.start();
    await settle();
    const s = await conn.connect();
    expect(s.status).toBe("signing-in");
    await settle();
    expect(calls).toEqual(["token", "signin"]);
    expect(conn.state().status).toBe("signed-out");
    await conn.stop();
  });

  it("loads Person Hub's cache for the tracked people, and disconnect clears it and the session", async () => {
    const peer = "581633588764606504";
    const { conn, calls, dir } = setup("spokpay", { token: { signedOut: true }, signout: { ok: true } });
    const msg = { id: "1300000000000000000", channelId: "1200000000000000000", authorId: peer, fromMe: false, content: "oi", timestamp: "2026-01-01T00:00:00.000Z" };
    // (created after the connection: it reads the cache when made, so make a second one)
    writeFileSync(join(dir, "discord-cache-spokpay.json"), JSON.stringify({ version: 1, conversations: { [peer]: { channelId: msg.channelId, messages: [msg] } } }));
    const ctx: ConnContext = { id: "spokpay", kind: "discord", section: "spokpay", dir, emit: () => {}, log: () => {}, openExternal: () => {} };
    const again = createDiscord(ctx, { session: async (m) => (calls.push(m), m === "signout" ? { ok: true } : { signedOut: true }) });
    expect(await again.track([peer, "not-an-id"])).toEqual({ [peer]: { channelId: msg.channelId, messages: [msg] } });
    const s = await again.disconnect();
    expect(s.status).toBe("signed-out");
    expect(calls).toContain("signout");
    expect(existsSync(join(dir, "discord-cache-spokpay.json"))).toBe(false);
    expect(await again.track([peer])).toEqual({});
    await again.stop();
    await conn.stop();
  });

  it("needs a connection for the calls that reach Discord, and downloads only from its CDN", async () => {
    const { conn } = setup("stores", { token: { signedOut: true } });
    await expect(conn.lookup("ana")).rejects.toThrow("Connect Discord first");
    await expect(conn.history("581633588764606504")).rejects.toThrow("Connect Discord first");
    await expect(conn.fetchAttachment?.("https://evil.example/x.png", "x.png") ?? Promise.resolve()).rejects.toThrow("Not a Discord attachment");
    expect(await conn.typing?.("581633588764606504", true)).toEqual({ ok: true });
    await conn.stop();
  });
});
