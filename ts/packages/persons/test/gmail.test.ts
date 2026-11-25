// The Gmail connection against a fake Google (no network): the migrated account file, threads,
// read state, attachments and sending. Tokens never reach the log or the state.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnEvent } from "../src/model/types.ts";
import { createGmail } from "../src/conn/gmail.ts";
import type { ConnContext, Connection } from "../src/conn/types.ts";

const REFRESH = "1//refresh-token-secret";
const ACCESS = "ya29.access-token-secret";
const b64 = (s: string): string => Buffer.from(s).toString("base64url");

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function fakeGoogle() {
  const calls: Call[] = [];
  const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const message = (id: string, from: string, text: string, labels: string[] = ["INBOX"]) => ({
    id,
    threadId: "t1",
    internalDate: String(Date.UTC(2026, 10, 24, 10, Number(id.slice(-1)))),
    labelIds: labels,
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: from },
        { name: "To", value: from.includes("me@") ? "ana@x.com" : "me@x.com" },
        { name: "Subject", value: "Parceria" },
        { name: "Message-ID", value: `<${id}@x.com>` },
      ],
      parts: [{ mimeType: "text/plain", body: { data: b64(text) } }, ...(id === "m00001" ? [{ mimeType: "application/pdf", filename: "kit.pdf", body: { attachmentId: "ATT_abcdefgh", size: 4 } }] : [])],
    },
  });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body });
    if (url === "https://oauth2.googleapis.com/token") {
      const p = new URLSearchParams(String(init?.body));
      if (p.get("refresh_token") !== REFRESH || p.get("client_id") !== "cid") return json(400, { error: "invalid_grant" });
      return json(200, { access_token: ACCESS, expires_in: 3600 });
    }
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${ACCESS}`) return json(401, { error: { message: "no" } });
    const u = new URL(url);
    const p = u.pathname.replace("/gmail/v1/users/me", "").replace("/upload", "");
    if (p.startsWith("/threads") && p !== "/threads") return json(200, { messages: [message("m00001", "Ana <ana@x.com>", "Oi!", ["INBOX", "UNREAD"]), message("m00002", "Me <me@x.com>", "Olá"), message("m00003", "Spam <ana@x.com>", "x", ["SPAM"])] });
    if (p === "/threads") return json(200, { threads: [{ id: "t1", historyId: "9" }] });
    if (p === "/messages/batchModify") return json(200, {});
    if (p === "/messages/m00001/attachments/ATT_abcdefgh") return json(200, { data: b64("%PDF") });
    if (p === "/messages/send") return json(200, { id: "m00004" });
    if (p === "/messages/m00004") return json(200, message("m00004", "Me <me@x.com>", "Resposta", ["SENT"]));
    if (p === "/profile") return json(200, { emailAddress: "me@x.com", historyId: "10" });
    if (p === "/history") return json(200, { historyId: "11" });
    return json(404, { error: { message: `no route ${p}` } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("Gmail connection", () => {
  let dir = "";
  const logs: string[] = [];
  const events: ConnEvent[] = [];
  let conn: Connection | undefined;
  const ctx = (): ConnContext => ({
    id: "gmail",
    kind: "gmail",
    section: "creators",
    dir,
    emit: (e) => events.push(e),
    log: (...a) => logs.push(a.join(" ")),
    openExternal: () => {},
  });
  const account = (enc: "none" | "safeStorage"): void =>
    writeFileSync(join(dir, "gmail-account.json"), JSON.stringify({ version: 1, account: "me@x.com", refresh_token: { enc, data: enc === "none" ? REFRESH : "c2VhbGVk" }, history_id: "10", scopes: "https://www.googleapis.com/auth/gmail.modify" }));
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "persons-gmail-"));
    logs.length = 0;
    events.length = 0;
    writeFileSync(join(dir, "google-client.json"), JSON.stringify({ client_id: "cid", client_secret: "csecret" }));
  });
  afterEach(async () => {
    await conn?.stop();
    conn = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it("an Electron-sealed session is signed out (nothing is asked of Google)", async () => {
    account("safeStorage");
    const g = fakeGoogle();
    conn = createGmail(ctx(), { fetch: g.fetchImpl, hubClient: async () => undefined });
    await conn.start();
    expect(conn.state()).toMatchObject({ status: "signed-out", me: null });
    expect(conn.state().error).toContain("me@x.com");
    expect(g.calls).toEqual([]);
  });

  it("no session: signed out", async () => {
    conn = createGmail(ctx(), { fetch: fakeGoogle().fetchImpl });
    await conn.start();
    expect(conn.state().status).toBe("signed-out");
  });

  it("a plain session connects, loads threads, marks read, downloads attachments and sends threaded replies", async () => {
    account("none");
    const g = fakeGoogle();
    conn = createGmail(ctx(), { fetch: g.fetchImpl });
    await conn.start();
    for (let i = 0; i < 50 && conn.state().status !== "connected"; i++) await Bun.sleep(5);
    expect(conn.state()).toMatchObject({ status: "connected", gateway: "up", me: { id: "me@x.com" } });

    await conn.track(["Ana@X.com", "not an email"]);
    const h = await conn.history("ana@x.com");
    expect(h.messages.map((m) => [m.id, m.fromMe, m.content, m.unread])).toEqual([
      ["m00001", false, "Oi!", true],
      ["m00002", true, "Olá", false],
    ]);
    expect(events.some((e) => e.type === "messages" && e.peerId === "ana@x.com")).toBe(true);

    await conn.markRead?.("ana@x.com");
    const mod = g.calls.find((c) => c.url.endsWith("/messages/batchModify"));
    expect(JSON.parse(String(mod?.body))).toEqual({ ids: ["m00001"], removeLabelIds: ["UNREAD"] });

    const url = h.messages[0]?.attachments?.[0]?.url ?? "";
    const file = await conn.fetchAttachment?.(url, "kit.pdf");
    expect(file?.startsWith(join(dir, "files", "gmail"))).toBe(true);
    expect(readFileSync(file ?? "", "utf8")).toBe("%PDF");
    expect(statSync(file ?? "").mode & 0o777).toBe(0o600);

    const sent = await conn.send("ana@x.com", "Resposta", [], "m00001");
    expect(sent).toMatchObject({ ok: true, message: { id: "m00004", fromMe: true } });
    const raw = String(g.calls.find((c) => c.url.includes("/messages/send"))?.body);
    expect(raw).toContain('{"threadId":"t1"}');
    expect(raw).toContain("In-Reply-To: <m00001@x.com>");
    expect(raw).toContain("Subject: Re: Parceria");
    expect(await conn.send("ana@x.com", "x", [])).toMatchObject({ ok: true }); // the latest thread
    expect(await conn.send("ana@x.com", "x", [], undefined, " ")).toEqual({ ok: false, error: "Add a subject" });
    expect(await conn.send("bob@y.com", "new", [])).toEqual({ ok: false, error: "Add a subject" });

    await conn.stop();
    const cache = JSON.parse(readFileSync(join(dir, "gmail-cache.json"), "utf8"));
    expect(Object.keys(cache.conversations)).toEqual(["ana@x.com"]);
    const all = logs.join("\n") + JSON.stringify(events) + JSON.stringify(conn.state());
    expect(all).not.toContain(REFRESH);
    expect(all).not.toContain(ACCESS);
    expect(all).not.toContain("csecret");
  });

  it("a session Google refuses is forgotten", async () => {
    writeFileSync(join(dir, "google-client.json"), JSON.stringify({ client_id: "other", client_secret: "s" }));
    account("none");
    conn = createGmail(ctx(), { fetch: fakeGoogle().fetchImpl });
    await conn.start();
    for (let i = 0; i < 50 && conn.state().status !== "signed-out"; i++) await Bun.sleep(5);
    expect(conn.state().status).toBe("signed-out");
    expect(existsSync(join(dir, "gmail-account.json"))).toBe(false);
  });
});
