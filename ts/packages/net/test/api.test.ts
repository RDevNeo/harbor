import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect as tcpConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Api, apkAllowed, byteRange, type ApiDeps, type Call } from "../src/api.ts";
import { HttpError, ok, readBody, readChunked, readHead, Reader, urlDecode, urlEncode, bearer, header, query, segments, type Request } from "../src/http.ts";
import { APP_INBOX, deviceId, loadTokens, saveTokens, draftFileOf, draftFromJson, draftJson, Hub, INBOX_TTL, newToken, PREVIEW_CHARS, PREVIEW_GAP, resolveUpload, safeName, shouldApply, type Parcel, type SharedDraft, type Token } from "../src/hub.ts";
import { MemKv } from "../src/kv.ts";
import { wire } from "../src/wire.ts";

const tmp = mkdtempSync(join(tmpdir(), "harbor-api-"));
const apis: Api[] = [];
afterAll(() => {
  for (const a of apis) a.close();
  rmSync(tmp, { recursive: true, force: true });
});

function tok(token: string, group = "", name = ""): Token {
  return { token, name, created: 0, group, fp: "", account: "", account_name: "" };
}

function reader(s: string | Buffer): Reader {
  const p = new PassThrough();
  p.end(s);
  return new Reader(p);
}

async function head(s: string): Promise<Request> {
  return readHead(reader(s));
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 0;
  } catch (e) {
    return e instanceof HttpError ? e.status : -1;
  }
}

/** A clock the tests move by hand, in ms. */
function clock() {
  const c = { t: 1000, now: () => c.t };
  return c;
}

async function serve(hub: Hub, route: (c: Call) => Promise<import("../src/http.ts").Reply> = async () => ok({}), extra: Partial<ApiDeps> = {}) {
  const api = new Api({
    hub,
    id: () => null,
    uploadsDir: join(tmp, "uploads"),
    route,
    account: null,
    appInfo: () => ({ version_code: 0, url: "/app.apk", hub: null }),
    apk: () => null,
    mesh: async () => ({ status: 404, body: { error: "no such call" } }),
    meshAdmitted: () => false,
    relay: async () => {},
    hubs: () => ({ hubs: [] }),
    ...extra,
  });
  hub.port = 0;
  await api.listen(["127.0.0.1"]);
  apis.push(api);
  return api.port();
}

/** One request over a real socket: [status, JSON body, raw answer]. */
function call(port: number, raw: string): Promise<[number, unknown, string]> {
  return new Promise((resolve, reject) => {
    const c = tcpConnect(port, "127.0.0.1", () => c.write(raw));
    let out = Buffer.alloc(0);
    c.on("data", (d: Buffer) => {
      out = Buffer.concat([out, d]);
    });
    c.on("error", reject);
    c.on("close", () => {
      const t = out.toString();
      const i = t.indexOf("\r\n\r\n");
      if (i < 0) return resolve([0, null, t]);
      const h = t.slice(0, i);
      const body = t.slice(i + 4);
      expect(h).toContain(`Content-Length: ${Buffer.byteLength(body)}`);
      let v: unknown = null;
      try {
        v = JSON.parse(body);
      } catch {
        v = null;
      }
      resolve([Number(h.split(" ")[1]), v, t]);
    });
  });
}

describe("HTTP (api.rs)", () => {
  test("parses_requests", async () => {
    const r = await head("GET /v1/chats/12/items?since=40&x=a%20b+c HTTP/1.1\r\nHost: h\r\nAuthorization: Bearer abc\r\nContent-Length: 5\r\n\r\nhello");
    expect(r.method).toBe("GET");
    expect(r.path).toBe("/v1/chats/12/items");
    expect(segments(r.path)).toEqual(["v1", "chats", "12", "items"]);
    expect(query(r, "since")).toBe("40");
    expect(query(r, "x")).toBe("a b c");
    expect(r.len).toBe(5);
    expect(bearer(r)).toBe("abc");
    expect(header(r, "host")).toBe("h");
  });

  test("rejects_bad_requests", async () => {
    expect(await status(head(""))).toBe(400);
    expect(await status(head("GARBAGE\r\n\r\n"))).toBe(400);
    expect(await status(head("GET nopath HTTP/1.1\r\n\r\n"))).toBe(400);
    expect(await status(head("GET / SPDY/3\r\n\r\n"))).toBe(400);
    expect(await status(head("POST / HTTP/1.1\r\nContent-Length: x\r\n\r\n"))).toBe(400);
    expect(await status(head("POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n"))).toBe(411);
    expect(await status(head(`GET /${"a".repeat(9000)} HTTP/1.1\r\n\r\n`))).toBe(431);
    expect(await status(head(`GET / HTTP/1.1\r\n${"A: b\r\n".repeat(101)}\r\n`))).toBe(431);
    expect(await status(head("GET / HTTP/1.1\r\nHost: h\r\n"))).not.toBe(0);
  });

  test("bounds_bodies_and_connections", async () => {
    const chunked = (s: string, max: number) => readChunked(reader(s), max);
    expect((await chunked("5\r\nhello\r\n6;x=y\r\n world\r\n0\r\nTrailer: t\r\n\r\n", 100)).toString()).toBe("hello world");
    expect(await status(chunked("100000000000\r\n", 1 << 20))).toBe(413);
    expect(await status(chunked("5\r\nhello\r\n5\r\nworld\r\n0\r\n\r\n", 8))).toBe(413);
    expect(await status(chunked("5\r\nhel", 100))).toBe(400);
    expect(await status(chunked("zz\r\n", 100))).toBe(400);
    expect((await readBody(reader("hello"), 5, 5)).toString()).toBe("hello");
    expect(await status(readBody(reader("hello"), 6, 10))).toBe(400);
    expect(await status(readBody(reader("hello"), 2 ** 40, 10))).toBe(413);
    expect((await readHead(reader("POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n"), true)).chunked).toBe(true);
  });

  test("head_has_a_deadline_however_slow_the_peer", async () => {
    const hub = new Hub([tok("tok")], 0);
    hub.enabled = true;
    const port = await serve(hub);
    const t = performance.now();
    const c = tcpConnect(port, "127.0.0.1");
    const timer = setInterval(() => c.write("G"), 100);
    const closed = await new Promise<boolean>((resolve) => {
      c.on("close", () => resolve(true));
      c.on("error", () => resolve(true));
      setTimeout(() => resolve(false), 14_000);
    });
    clearInterval(timer);
    expect(closed).toBe(true);
    expect(performance.now() - t).toBeLessThan(12_000);
  }, 15_000);

  test("decodes_urls", async () => {
    expect(urlDecode("a%2Fb+c%zz%4")).toBe("a/b c%zz%4");
    expect(urlDecode("%E2%9C%93")).toBe("✓");
    expect(urlEncode("a b/é")).toBe("a%20b%2F%C3%A9");
    expect((await head("GET /a+b%20c HTTP/1.1\r\n\r\n")).path).toBe("/a+b c");
  });

  test("a_range_asks_for_part_of_a_file", () => {
    expect(byteRange("bytes=0-", 100)).toEqual([0, 99]);
    expect(byteRange("bytes=10-19", 100)).toEqual([10, 19]);
    expect(byteRange("bytes=90-500", 100)).toEqual([90, 99]);
    expect(byteRange("bytes=-30", 100)).toEqual([70, 99]);
    expect(byteRange("bytes=-500", 100)).toEqual([0, 99]);
    expect(byteRange("bytes=100-", 100)).toBe("past");
    for (const other of [null, "bytes=5-1", "bytes=0-1,5-6", "items=0-1", "bytes=a-", "bytes=-0"]) expect(byteRange(other, 100)).toBeNull();
  });

  test("JSON goes out as serde_json writes a json! object: keys sorted", () => {
    expect(wire({ rev: 1, changed_chats: [9], state_changed: false, inbox: 0 })).toBe('{"changed_chats":[9],"inbox":0,"rev":1,"state_changed":false}');
  });
});

describe("hub (api.rs)", () => {
  test("auth", async () => {
    const hub = new Hub([tok("s3cret")], 0);
    const known = (t: string) => {
      try {
        hub.auth(t, { kind: "loopback" });
        return true;
      } catch {
        return false;
      }
    };
    expect(known("s3cret")).toBe(true);
    expect(known("s3cre") || known("s3cretx") || known("")).toBe(false);
    expect(bearer(await head("GET / HTTP/1.1\r\nauthorization: bearer  s3cret \r\n\r\n"))).toBe("s3cret");
    expect(bearer(await head("GET / HTTP/1.1\r\nAuthorization: Basic s3cret\r\n\r\n"))).toBeNull();
    expect(bearer(await head("GET / HTTP/1.1\r\nAuthorization: Bearer\r\n\r\n"))).toBeNull();
    const empty = new Hub([tok("")], 0);
    expect(() => empty.auth("", { kind: "loopback" })).toThrow();
    expect(newToken()).toHaveLength(48);
    expect(newToken()).not.toBe(newToken());
  });

  test("the_app_from_the_internet_only_signed_in", () => {
    expect(apkAllowed(false, null) && apkAllowed(false, { level: "loopback" })).toBe(true);
    expect(apkAllowed(true, { level: null })).toBe(true);
    expect(apkAllowed(true, { level: "legacy" })).toBe(true);
    expect(apkAllowed(true, null)).toBe(false);
  });

  test("old_pairings_only_update_the_app", () => {
    const hub = new Hub([tok("tok", "g".repeat(16))], 0);
    expect(hub.auth("tok", { kind: "tls", fp: "a".repeat(64) })).toBe("legacy");
    expect(hub.auth("tok", { kind: "legacy" })).toBe("legacy");
    expect(hub.auth("tok", { kind: "loopback" })).toBe("loopback");
    expect(() => hub.auth("tok", { kind: "refused" })).toThrow();
    expect(() => hub.auth("nope", { kind: "loopback" })).toThrow();
    expect(() => hub.auth("", { kind: "loopback" })).toThrow();
  });

  test("signed_in_phones_get_a_handle_that_is_no_credential", () => {
    const hub = new Hub([], 0);
    const c = { sub: "user_1", name: "Sam", email: "" };
    const fp = "f".repeat(64);
    const h = hub.accountPhone(c, fp);
    expect(hub.accountPhone(c, fp)).toBe(h);
    expect(hub.groupOf(h)).toBe(fp);
    expect(hub.tokensDirty).toBe(true);
    expect(() => hub.auth(h, { kind: "loopback" })).toThrow();
    expect(hub.localPhones()[0]?.owner).toBe("Sam");
  });

  test("viewing_leases_are_apart_from_typing", () => {
    const hub = new Hub([], 0);
    expect(hub.setViewing(3, "pc:laptop", "laptop", true, true)).toBe(true);
    expect(hub.setViewing(3, "pc:laptop", "laptop", true, true)).toBe(false);
    expect(hub.setViewing(3, "pc:laptop", "laptop", false, true)).toBe(true);
    expect(hub.viewing(3).map((t) => t.kind)).toEqual(["away"]);
    expect(hub.typing(3)).toEqual([]);
    expect(hub.setViewing(3, "pc:laptop", "", false, false)).toBe(true);
    expect(hub.viewing(3)).toEqual([]);
  });

  test("typing_leases", async () => {
    const c = clock();
    const hub = new Hub([], 0, c.now);
    const r0 = hub.rev();
    expect(hub.setTyping(5, "tok:1", "phone", "Galaxy", true, null)).toBe(true);
    expect(hub.typing(5).map((t) => [t.device, t.kind, t.label])).toEqual([["tok:1", "phone", "Galaxy"]]);
    const [, chats, state] = await hub.wait(r0, 0);
    expect([chats, state]).toEqual([[5], true]);
    const r1 = hub.rev();
    expect(hub.setTyping(5, "tok:1", "phone", "Galaxy", true, null)).toBe(false);
    expect(hub.rev()).toBe(r1);
    expect(hub.setTyping(5, "pc:desk", "pc", "desk", true, null)).toBe(true);
    expect(hub.typing(5)).toHaveLength(2);
    expect(hub.setTyping(5, "tok:1", "phone", "", false, null)).toBe(true);
    expect(hub.setTyping(5, "tok:1", "phone", "", false, null)).toBe(false);
    expect(hub.typing(5)).toHaveLength(1);
    expect(hub.typing(6)).toEqual([]);
    // The lease runs out while a long-poll waits: it wakes without anyone calling in.
    const since = hub.rev();
    c.t += 6_000 - 50;
    setTimeout(() => {
      c.t += 100;
    }, 20);
    const t = performance.now();
    const [rev, chats2, state2] = await hub.wait(since, 5_000);
    expect(performance.now() - t).toBeLessThan(2_000);
    expect(rev).toBeGreaterThan(since);
    expect([chats2, state2]).toEqual([[5], true]);
    expect(hub.typing(5)).toEqual([]);
    expect(hub.nextTypingExpiry()).toBeNull();
    expect(deviceId("abc")).toBe(deviceId("abc"));
    expect(deviceId("abc")).not.toBe(deviceId("abd"));
    expect(deviceId("abc")).toMatch(/^tok:[0-9a-f]{8}$/);
  });

  test("typing_drafts", async () => {
    const c = clock();
    const hub = new Hub([], 0, c.now);
    expect(hub.setTyping(5, "tok:1", "phone", "Galaxy", true, "Hel")).toBe(true);
    expect(hub.typing(5)[0]?.text).toBe("Hel");
    const r1 = hub.rev();
    expect(hub.setTyping(5, "tok:1", "phone", "Galaxy", true, "Hell")).toBe(false);
    expect(hub.setTyping(5, "tok:1", "phone", "Galaxy", true, "Hello")).toBe(false);
    expect(hub.rev()).toBe(r1);
    expect(hub.typing(5)[0]?.text).toBe("Hello");
    const due = hub.nextTypingExpiry();
    expect(due !== null && due <= c.t + PREVIEW_GAP).toBe(true);
    c.t += PREVIEW_GAP;
    const [rev, chats] = await hub.wait(r1, 5_000);
    expect(rev).toBeGreaterThan(r1);
    expect(chats).toEqual([5]);
    expect(hub.typing(5)[0]?.held).toBe(false);
    c.t += PREVIEW_GAP;
    expect(hub.setTyping(5, "tok:1", "phone", "Galaxy", true, "Hello!")).toBe(true);
    c.t += PREVIEW_GAP;
    expect(hub.setTyping(5, "tok:1", "phone", "Galaxy", true, "Hello!")).toBe(false);
    expect(hub.setTyping(5, "tok:1", "phone", "Galaxy", true, null)).toBe(false);
    expect(hub.typing(5)[0]?.text).toBe("Hello!");
    expect(hub.setTyping(5, "tok:1", "phone", "", false, null)).toBe(true);
    expect(hub.typing(5)).toEqual([]);
    expect(hub.setTyping(5, "tok:1", "phone", "Galaxy", true, null)).toBe(true);
    expect(hub.typing(5)[0]?.text).toBe("");
    const long = `${"a".repeat(PREVIEW_CHARS + 20)}é`;
    expect(hub.setTyping(6, "tok:2", "phone", "Pixel", true, long)).toBe(true);
    const kept = hub.typing(6)[0]?.text ?? "";
    expect(Array.from(kept)).toHaveLength(PREVIEW_CHARS);
    expect(kept.endsWith("é")).toBe(true);
  });

  test("shared_drafts", async () => {
    const c = clock();
    const hub = new Hub([], 0, c.now);
    const up = join(tmp, "uploads-drafts");
    mkdirSync(join(up, "dtest01"), { recursive: true });
    writeFileSync(join(up, "dtest01", "shot.png"), "x");
    const res = (id: string) => draftFileOf(up, id);
    const d = { text: "Look at this", files: ["dtest01/shot.png", "nope/x.png"], mentions: [{ item: 3, from: "Claude", text: "hi" }] };
    expect(hub.report(7, "tok:1", "phone", "Galaxy", true, d, res)).toBe(true);
    let got = hub.draft(7) as SharedDraft;
    expect([got.text, got.by, got.label]).toEqual(["Look at this", "tok:1", "Galaxy"]);
    expect(got.files.map((f) => f.id)).toEqual(["dtest01/shot.png"]);
    expect(got.files[0]?.path.endsWith("shot.png") && got.files[0]?.name === "shot.png").toBe(true);
    expect(got.mentions).toHaveLength(1);
    expect(hub.typing(7)[0]?.text).toBe("Look at this");
    const r1 = got.rev;
    expect(hub.report(7, "tok:1", "phone", "Galaxy", true, d, res)).toBe(false);
    expect(hub.draft(7)?.rev).toBe(r1);
    const shot = draftFileOf(up, "dtest01/shot.png");
    expect(hub.setDraft(7, "pc:desk", "desk", "Look at this one", shot ? [shot] : [], [])).toBe(false);
    got = hub.draft(7) as SharedDraft;
    expect(got.rev).toBeGreaterThan(r1);
    expect([got.text, got.by, got.mentions.length]).toEqual(["Look at this one", "pc:desk", 0]);
    const since = hub.rev();
    c.t += PREVIEW_GAP;
    const [, chats] = await hub.wait(since, 3_000);
    expect(chats).toEqual([7]);
    c.t += PREVIEW_GAP;
    expect(hub.report(7, "tok:2", "phone", "Old", true, { text: "typed on 0.56" }, res)).toBe(true);
    expect(hub.report(7, "tok:2", "phone", "", false, { text: "" }, res)).toBe(true);
    got = hub.draft(7) as SharedDraft;
    expect([got.text, got.files.length]).toEqual(["typed on 0.56", 1]);
    c.t += PREVIEW_GAP;
    expect(hub.report(7, "tok:1", "phone", "", false, { text: "", files: [], mentions: [] }, res)).toBe(true);
    expect((hub.draft(7) as SharedDraft).text).toBe("");
    c.t += PREVIEW_GAP;
    hub.report(7, "tok:1", "phone", "Galaxy", true, d, res);
    const before = hub.draft(7)?.rev ?? 0;
    hub.clearDraft(7);
    got = hub.draft(7) as SharedDraft;
    expect(got.text === "" && got.files.length === 0 && got.rev > before && got.by === "").toBe(true);
    expect(hub.typing(7)).toEqual([]);
    c.t += PREVIEW_GAP;
    hub.report(7, "tok:1", "phone", "Galaxy", true, { text: "stays" }, res);
    c.t += 10_000;
    expect(hub.typing(7)).toEqual([]);
    expect(hub.draft(7)?.text).toBe("stays");
    const back = draftFromJson(JSON.parse(wire(draftJson(hub.draft(7) as SharedDraft))));
    expect([back?.text, back?.rev]).toEqual(["stays", hub.draft(7)?.rev]);
    expect(draftFromJson(null)).toBeNull();
  });

  test("a message out clears the draft on every device, even one this hub never had", () => {
    const c = clock();
    const hub = new Hub([], 0, c.now);
    // The desktop typed, the phone took its draft in; then the desktop sent the message.
    hub.report(4, "pc:desk", "pc", "desk", true, { text: "ship it", mentions: [] }, () => null);
    const typed = hub.draft(4) as SharedDraft;
    expect(shouldApply(typed, "tok:1", null, c.t)).toBe("now");
    hub.clearDraft(4);
    const cleared = hub.draft(4) as SharedDraft;
    expect([cleared.text, cleared.by, cleared.rev > typed.rev]).toEqual(["", "", true]);
    // The phone (which still shows "ship it") applies the newer, empty draft.
    expect(shouldApply(cleared, "tok:1", null, c.t)).toBe("now");
    // A chat whose draft the hub doesn't know (never reported, or the hub restarted): the clear still gets a rev,
    // so a phone that kept the text of a message sent elsewhere empties its composer when it opens the chat.
    expect(hub.draft(5)).toBeNull();
    const before = hub.rev();
    hub.clearDraft(5);
    expect(hub.draft(5)).toMatchObject({ text: "", by: "" });
    expect((hub.draft(5) as SharedDraft).rev).toBeGreaterThan(before);
    // Clearing an already empty draft again moves the rev on too (a second message, a phone that saw neither).
    const r5 = (hub.draft(5) as SharedDraft).rev;
    hub.clearDraft(5);
    expect((hub.draft(5) as SharedDraft).rev).toBeGreaterThan(r5);
  });

  test("shared drafts outlive a hub restart, and revs go on from them", () => {
    const kv = new MemKv();
    const up = join(tmp, "uploads-restart");
    mkdirSync(join(up, "4"), { recursive: true });
    writeFileSync(join(up, "4", "1-a.png"), "x");
    const a = new Hub([], 0);
    a.saveDrafts(kv);
    expect(kv.get("shared_drafts")).toBeNull();
    a.setDraft(3, "tok:1", "Galaxy", "half written", [draftFileOf(up, "4/1-a.png")!, { id: "4/gone.png", name: "gone.png", path: join(up, "4", "gone.png") }], [{ item: 2 }]);
    a.clearDraft(4);
    a.saveDrafts(kv);
    const sentRev = (a.draft(4) as SharedDraft).rev;
    // A clock that ran behind: the next run still numbers newer than what the devices saw.
    const stored = JSON.parse(kv.get("shared_drafts") ?? "[]") as [number, { rev: number }][];
    for (const e of stored) e[1].rev += 10_000_000;
    kv.set("shared_drafts", JSON.stringify(stored));
    const b = new Hub([], 0);
    b.loadDrafts(kv);
    expect(b.draft(3)).toMatchObject({ text: "half written", by: "tok:1", mentions: [{ item: 2 }] });
    expect(b.draft(3)?.files.map((f) => f.id)).toEqual(["4/1-a.png"]);
    expect(b.draft(4)).toMatchObject({ text: "", by: "", rev: sentRev + 10_000_000 });
    expect(b.rev()).toBeGreaterThan(sentRev + 10_000_000);
    b.setDraft(3, "pc:desk", "desk", "finished", null, null);
    expect((b.draft(3) as SharedDraft).rev).toBeGreaterThan(sentRev + 10_000_000);
  });

  test("draft_merge_rules", () => {
    const at = 10_000;
    const d: SharedDraft = { text: "x", files: [], mentions: [], by: "tok:1", label: "", rev: 3, quiet: null, held: false };
    expect(shouldApply(d, "tok:1", null, at)).toBe("skip");
    expect(shouldApply(d, "pc:desk", null, at)).toBe("now");
    expect(shouldApply(d, "pc:desk", at - 300, at)).toBe("later");
    expect(shouldApply(d, "pc:desk", at - 1001, at)).toBe("now");
    expect(shouldApply({ ...d, text: "", by: "", rev: 4 }, "pc:desk", null, at)).toBe("now");
  });

  test("revisions_and_long_poll", async () => {
    const hub = new Hub([], 0);
    const r0 = hub.rev();
    expect(r0).toBeGreaterThan(1_600_000_000_000);
    expect(await hub.wait(r0, 30)).toEqual([r0, [], false]);
    const waiting = hub.wait(r0, 5_000);
    await Bun.sleep(50);
    const r1 = hub.touch(7, false);
    expect(await waiting).toEqual([r1, [7], false]);
    hub.touch(null, true);
    const [, chats, state] = await hub.wait(r1, 0);
    expect([chats.length, state]).toEqual([0, true]);
    const [, , future] = await hub.wait(hub.rev() + 1000, 5_000);
    expect(future).toBe(true);
  });

  test("names_and_uploads", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("C:\\x\\photo.jpg")).toBe("photo.jpg");
    expect(safeName(".hidden")).toBe("hidden");
    expect(safeName("")).toBe("file");
    const up = join(tmp, "uploads");
    expect(resolveUpload(up, "../x")).toBeNull();
    expect(resolveUpload(up, "/etc/passwd")).toBeNull();
    expect(resolveUpload(up, "pending/../../x")).toBeNull();
    expect(resolveUpload(up, "a/b/c")).toBeNull();
  });

  test("paired_phones_one_per_pairing", () => {
    const hub = new Hub([tok("a1", "ga"), tok("a2", "ga", "Pixel"), tok("b", "gb")], 0);
    hub.seen.set("a1", ["Pixel 8", 50]);
    hub.ips.set("a1", "192.0.2.7");
    const p = hub.pairedPhones();
    expect(p).toHaveLength(2);
    expect([p[0]?.group, p[0]?.name, p[0]?.seen, p[0]?.ip]).toEqual(["ga", "Pixel 8", 50, "192.0.2.7"]);
    expect([p[1]?.group, p[1]?.seen]).toEqual(["gb", 0]);
  });

  test("phone_versions_outlive_a_restart", () => {
    const hub = new Hub([tok("a", "ga"), tok("b", "gb")], 0);
    hub.seen.set("a", ["Pixel", 1_700_000_000]);
    hub.apps.set("a", 66000);
    const kv = new MemKv();
    hub.rememberPhones(kv);
    const next = new Hub([tok("a2", "ga"), tok("b", "gb")], 0);
    next.loadRemembered(kv);
    const p = next.localPhones();
    const a = p.find((x) => x.group === "ga");
    expect([a?.name, a?.app, (a?.seen ?? 0) > 0]).toEqual(["Pixel", 66000, true]);
    expect(p.find((x) => x.group === "gb")?.seen).toBe(0);
  });
});

describe("the listener (api.rs)", () => {
  test("http_end_to_end", async () => {
    const hub = new Hub([tok("tok")], 0);
    hub.enabled = true;
    const port = await serve(hub, async (c) => ok({ method: c.method, path: c.path, body: c.body as null, device: c.device }));
    let [st, v] = await call(port, "GET /v1/state HTTP/1.1\r\n\r\n");
    expect(st).toBe(401);
    expect(typeof (v as { error?: unknown }).error).toBe("string");
    expect((await call(port, "GET /v1/state HTTP/1.1\r\nAuthorization: Bearer nope\r\n\r\n"))[0]).toBe(401);
    const body = '{"title":"x"}';
    [st, v] = await call(port, `PATCH /v1/chats/4 HTTP/1.1\r\nAuthorization: Bearer tok\r\nX-Harbor-Device: Pixel\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
    expect(st).toBe(200);
    expect(v).toEqual({ method: "PATCH", path: ["v1", "chats", "4"], body: { title: "x" }, device: "Pixel" });
    expect(hub.seen.get("tok")?.[0]).toBe("Pixel");
    expect((await call(port, "POST /v1/chats HTTP/1.1\r\nAuthorization: Bearer tok\r\nContent-Length: 3\r\n\r\n{x}"))[0]).toBe(400);
    [st, v] = await call(port, "GET /v1/app HTTP/1.1\r\nAuthorization: Bearer tok\r\n\r\n");
    expect([st, (v as { url?: string }).url]).toEqual([200, "/app.apk"]);
    await call(port, "GET /v1/app HTTP/1.1\r\nAuthorization: Bearer tok\r\nX-Harbor-Platform: Samsung SM-A135M, Android 12 (SDK 31)\tABIs armeabi-v7a\r\n\r\n");
    expect(hub.platforms.get("tok")).toBe("Samsung SM-A135M, Android 12 (SDK 31)ABIs armeabi-v7a");
    const [, , raw] = await call(port, "HEAD /app.apk HTTP/1.1\r\n\r\n");
    expect(raw.startsWith("HTTP/1.1 200") || raw.startsWith("HTTP/1.1 404")).toBe(true);
    expect((await call(port, "POST /v1/chats/4/typing HTTP/1.1\r\nAuthorization: Bearer tok\r\nX-Harbor-Device: Pixel\r\nContent-Length: 2\r\n\r\n{}"))[0]).toBe(200);
    const t = hub.typing(4);
    expect([t[0]?.label, t[0]?.kind, t[0]?.device, t[0]?.text]).toEqual(["Pixel", "phone", deviceId("tok"), ""]);
    await Bun.sleep(PREVIEW_GAP + 20);
    let b = '{"typing":true,"text":"fix the build"}';
    await call(port, `POST /v1/chats/4/typing HTTP/1.1\r\nAuthorization: Bearer tok\r\nContent-Length: ${b.length}\r\n\r\n${b}`);
    expect(hub.typing(4)[0]?.text).toBe("fix the build");
    b = '{"typing":false}';
    await call(port, `POST /v1/chats/4/typing HTTP/1.1\r\nAuthorization: Bearer tok\r\nContent-Length: ${b.length}\r\n\r\n${b}`);
    expect(hub.typing(4)).toEqual([]);
    const since = hub.rev();
    setTimeout(() => hub.touch(9, false), 100);
    const t0 = performance.now();
    const [st2, v2, raw2] = await call(port, `GET /v1/events?since=${since} HTTP/1.1\r\nAuthorization: Bearer tok\r\n\r\n`);
    expect(st2).toBe(200);
    expect(performance.now() - t0).toBeLessThan(5_000);
    expect(v2).toEqual({ rev: since + 1, changed_chats: [9], state_changed: false, inbox: 0 });
    expect(raw2.endsWith(`{"changed_chats":[9],"inbox":0,"rev":${since + 1},"state_changed":false}`)).toBe(true);
    hub.enabled = false;
    const [, , off] = await call(port, "GET /v1/app HTTP/1.1\r\nAuthorization: Bearer tok\r\n\r\n");
    expect(off).toBe("");
  });

  test("plain HTTP from another address gets 426 and nothing else", async () => {
    const hub = new Hub([tok("tok")], 0);
    hub.enabled = true;
    const api = new Api({
      hub,
      id: () => null,
      uploadsDir: join(tmp, "uploads"),
      route: async () => ok({}),
      account: null,
      appInfo: () => null,
      apk: () => null,
      mesh: async () => ({ status: 404, body: null }),
      meshAdmitted: () => false,
      relay: async () => {},
      hubs: () => null,
    });
    const out: Buffer[] = [];
    const sink = new PassThrough();
    sink.on("data", (d: Buffer) => out.push(d));
    const r = reader("GET /v1/app HTTP/1.1\r\n\r\n");
    const req = await readHead(r);
    await api.handle({ ip: "10.0.0.9", via: { kind: "refused" } }, req, r, sink, false);
    await Bun.sleep(10);
    const text = Buffer.concat(out).toString();
    expect(text.startsWith("HTTP/1.1 426 ")).toBe(true);
    expect(text.endsWith('{"error":"Harbor answers other devices over TLS only"}')).toBe(true);
  });

  test("the_phone_inbox", async () => {
    const hub = new Hub([tok("a", "ga"), tok("b", "gb")], 0);
    hub.enabled = true;
    const port = await serve(hub);
    const log: [number, boolean, string | null][] = [];
    const report = (s: number, d: boolean, e: string | null) => {
      log.push([s, d, e]);
    };
    const dir = join(tmp, "inbox");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "note.bin");
    writeFileSync(file, "hello phone");
    const since = hub.rev();
    const parcel = (p: Partial<Parcel> & Pick<Parcel, "id" | "kind">): Parcel => ({ group: "ga", name: "Text", text: "", path: null, temp: false, size: 0, at: performance.now(), report, ...p });
    hub.post(parcel({ id: "t1", kind: "text", text: "copied" }));
    hub.post(parcel({ id: "f1", kind: "file", name: "note.bin", path: file, temp: true, size: 11 }));
    let [st, v] = await call(port, `GET /v1/events?since=${since} HTTP/1.1\r\nAuthorization: Bearer a\r\n\r\n`);
    expect([st, (v as { inbox: number }).inbox]).toEqual([200, 2]);
    [, v] = await call(port, "GET /v1/inbox HTTP/1.1\r\nAuthorization: Bearer a\r\n\r\n");
    expect((v as { items: unknown }).items).toEqual([
      { id: "t1", kind: "text", name: "Text", size: 0, text: "copied" },
      { id: "f1", kind: "file", name: "note.bin", size: 11 },
    ]);
    expect(((await call(port, "GET /v1/inbox HTTP/1.1\r\nAuthorization: Bearer b\r\n\r\n"))[1] as { items: unknown }).items).toEqual([]);
    expect((await call(port, "GET /v1/inbox/f1 HTTP/1.1\r\nAuthorization: Bearer b\r\n\r\n"))[0]).toBe(404);
    expect((await call(port, "POST /v1/inbox/f1/done HTTP/1.1\r\nAuthorization: Bearer b\r\nContent-Length: 0\r\n\r\n"))[0]).toBe(404);
    const [, , raw] = await call(port, "GET /v1/inbox/f1 HTTP/1.1\r\nAuthorization: Bearer a\r\n\r\n");
    expect(raw.startsWith("HTTP/1.1 200") && raw.endsWith("\r\n\r\nhello phone")).toBe(true);
    expect(log.at(-1)).toEqual([11, false, null]);
    expect((await call(port, "POST /v1/inbox/f1/done HTTP/1.1\r\nAuthorization: Bearer a\r\nContent-Length: 2\r\n\r\n{}"))[0]).toBe(200);
    expect(log.at(-1)).toEqual([11, true, null]);
    expect(existsSync(file)).toBe(false);
    const body = '{"error":"no space"}';
    await call(port, `POST /v1/inbox/t1/done HTTP/1.1\r\nAuthorization: Bearer a\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
    expect(log.at(-1)).toEqual([0, false, "On the phone: no space"]);
    expect(((await call(port, "GET /v1/inbox HTTP/1.1\r\nAuthorization: Bearer a\r\n\r\n"))[1] as { items: unknown }).items).toEqual([]);
    hub.post(parcel({ id: "o1", kind: "text", text: "x", at: performance.now() - INBOX_TTL - 1000 }));
    expect(hub.inboxFor("ga")).toEqual([]);
    expect(log.at(-1)?.[2]).not.toBeNull();
  });

  test("phones_seen_elsewhere_and_their_apps", async () => {
    const hub = new Hub([tok("a", "ga"), tok("b", "gb"), tok("c", "gc")], 0);
    hub.enabled = true;
    const port = await serve(hub);
    await call(port, "GET /v1/app HTTP/1.1\r\nAuthorization: Bearer a\r\nX-Harbor-App: 18001\r\n\r\n");
    await call(port, "GET /v1/inbox HTTP/1.1\r\nAuthorization: Bearer b\r\n\r\n");
    const local = hub.localPhones();
    const app = (g: string) => local.find((p) => p.group === g)?.app;
    expect([app("ga"), app("gb"), app("gc")]).toEqual([18001, APP_INBOX, 0]);
    const later = Math.floor(Date.now() / 1000) + 1;
    hub.elsewhere.set("pc:box", [
      "box",
      [
        { group: "gc", name: "A13", seen: later, app: 16002, alive: 0, platform: "" },
        { group: "zz", name: "not ours", seen: later, app: 1, alive: 0, platform: "" },
      ],
    ]);
    const p = hub.pairedPhones();
    expect(p).toHaveLength(3);
    expect([p[0]?.group, p[0]?.seen, p[0]?.via, p[0]?.name, p[0]?.app]).toEqual(["gc", later, "box", "A13", 16002]);
    expect(p.find((x) => x.group === "ga")?.via).toBe("");
  });

  test("uploads_land_in_their_folder", async () => {
    const base = join(tmp, "up");
    const hub = new Hub([], 0);
    hub.mesh.gids.set(7, "4e47-gid");
    const api = new Api({
      hub,
      id: () => null,
      uploadsDir: base,
      route: async () => ok({}),
      account: null,
      appInfo: () => null,
      apk: () => null,
      mesh: async () => ({ status: 404, body: null }),
      meshAdmitted: () => false,
      relay: async () => {},
      hubs: () => null,
    });
    const raw = "GET /v1/upload?name=..%2Fphoto.jpg&chat=12 HTTP/1.1\r\nContent-Length: 4\r\n\r\n";
    let r = reader(`${raw}abcd`);
    let rep = await api.upload(r, await readHead(r));
    expect(rep.status).toBe(201);
    const id = (rep.body as { id: string }).id;
    expect(id.startsWith("12/") && id.endsWith("-photo.jpg")).toBe(true);
    expect(readFileSync(join(base, id), "utf8")).toBe("abcd");
    r = reader(`${raw}ab`);
    expect((await api.upload(r, await readHead(r))).status).toBe(400);
    expect(readdirSync(join(base, "12"))).toHaveLength(1);
    for (const [chat, dir] of [
      ["4e47-gid", "7/"],
      ["12", "12/"],
      ["someone-else", "pending/"],
    ] as const) {
      r = reader(`POST /v1/upload?name=a.png&chat=${chat} HTTP/1.1\r\nContent-Length: 2\r\n\r\nab`);
      rep = await api.upload(r, await readHead(r));
      expect(rep.status === 201 && (rep.body as { id: string }).id.startsWith(dir)).toBe(true);
    }
  });

  test("tokens are kept in kv api_tokens in Rust's field order", () => {
    const kv = new MemKv();
    const hub = new Hub([], 0);
    hub.accountPhone({ sub: "user_1", name: "", email: "sam@example.com" }, "f".repeat(64));
    saveTokens(kv, hub.tokens);
    const text = kv.get("api_tokens") ?? "";
    expect(text.startsWith('[{"token":')).toBe(true);
    expect(text).toContain(`"group":"${"f".repeat(64)}","fp":"${"f".repeat(64)}","account":"user_1","account_name":"sam@example.com"}]`);
    expect(loadTokens(kv)[0]?.account).toBe("user_1");
  });
});
