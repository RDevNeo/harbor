import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Auth, type Label, Gmail, Parts, addrEmail, addrs, b64, b64url, blankMail, build, charset, clip, describe, encodeWords, entities, htmlText,
  listAccounts, mimeFor, plan, profileEmail, reSubject, replyAllCc, resolve, safeName, serve, size, splitAddrs, strs, tidy, tools, unb64, walk,
} from "../src/gmail.ts";

const utf8 = (b: Uint8Array): string => Buffer.from(b).toString("utf8");
const bytes = (...n: number[]): Uint8Array => Uint8Array.from(n);

const lbl: Label[] = [["INBOX", "INBOX"], ["UNREAD", "UNREAD"], ["STARRED", "STARRED"], ["Label_1", "Work"], ["Label_2", "Clients/Acme"]];

test("base64url both ways", () => {
  for (const data of [bytes(), bytes(0x66), Buffer.from("fo"), Buffer.from("foo"), Buffer.from("foob"), bytes(0xff, 0xfe, 0xfd, 0, ...Buffer.from("binary?>")), Buffer.from("Olá, ação ✓")]) {
    expect(unb64(b64url(data))).toEqual(Uint8Array.from(data));
    expect(unb64(b64(data))).toEqual(Uint8Array.from(data));
  }
  expect(b64url(bytes(0xfb, 0xff, 0xbf))).not.toMatch(/[+/=]/);
  expect(utf8(unb64("SGVsbG8sIHdvcmxk\r\nIQ=="))).toBe("Hello, world!");
  expect(Array.from(unb64("_-8"))).toEqual([0xff, 0xef]);
});

const bodyOf = (part: string): string => part.split("\r\n\r\n").slice(1).join("\r\n\r\n");

test("builds a plain message", () => {
  const m = blankMail({ to: "Ana <ana@example.com>, bo@example.com", subject: "Hi\r\nBcc: evil@example.com", text: "Hello\nthere" });
  const raw = build(m, "B");
  const head = raw.split("\r\n\r\n")[0] ?? "";
  expect(head).toContain("To: Ana <ana@example.com>, bo@example.com\r\n");
  expect(head).toContain("Subject: Hi  Bcc: evil@example.com\r\n");
  expect(head).not.toContain("\r\nBcc:");
  expect(head).toContain("Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64");
  expect(utf8(unb64(bodyOf(raw)))).toBe("Hello\nthere");
  expect(raw).not.toContain("In-Reply-To");
});

test("builds html, attachments and reply headers", () => {
  const m = blankMail({
    to: "Zoë Müller <z@example.com>",
    subject: "Relatório de ação",
    html: "<p>Olá <b>mundo</b></p>",
    files: [
      { name: "relatório.pdf", mime: "application/pdf", data: bytes(0, 1, 2, 255) },
      { name: "a.txt", mime: "text/plain", data: Buffer.from("x") },
    ],
    inReplyTo: "<m1@example.com>",
    references: "<m0@example.com> <m1@example.com>",
  });
  const raw = build(m, "B");
  expect(raw).toContain("In-Reply-To: <m1@example.com>\r\nReferences: <m0@example.com> <m1@example.com>\r\n");
  expect(raw).toContain(`Subject: =?UTF-8?B?${b64(Buffer.from("Relatório de ação"))}?=\r\n`);
  expect(raw).toContain(`To: =?UTF-8?B?${b64(Buffer.from("Zoë Müller"))}?= <z@example.com>\r\n`);
  expect(raw).toContain('Content-Type: multipart/mixed; boundary="B-mix"\r\n');
  expect(raw).toContain('Content-Type: multipart/alternative; boundary="B-alt"\r\n');
  expect(raw.endsWith("--B-mix--\r\n")).toBe(true);
  const parts = raw.split("--B-alt\r\n").slice(1);
  expect(parts.length).toBe(2);
  expect(utf8(unb64(bodyOf(parts[0] ?? "")))).toBe("Olá mundo");
  expect(parts[1]?.startsWith("Content-Type: text/html; charset=UTF-8")).toBe(true);
  const pdf = raw.split("--B-mix\r\n").find((p) => p.includes("application/pdf")) ?? "";
  expect(pdf).toContain("filename*=UTF-8''relat%C3%B3rio.pdf");
  expect(Array.from(unb64(bodyOf(pdf).split("\r\n--")[0] ?? ""))).toEqual([0, 1, 2, 255]);
  expect(raw).toContain('Content-Disposition: attachment; filename="a.txt"\r\n');
});

test("long subjects fold into short words", () => {
  const s = "ação ".repeat(30);
  const h = encodeWords(s);
  for (const l of h.split("\r\n")) expect(Buffer.byteLength(l.trimEnd())).toBeLessThanOrEqual(76);
  const back = h.split("\r\n ").map((w) => utf8(unb64(w.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, "")))).join("");
  expect(back).toBe(s);
  expect(encodeWords("plain")).toBe("plain");
});

const part = (mime: string, text: string) => ({
  mimeType: mime,
  filename: "",
  headers: [{ name: "Content-Type", value: `${mime}; charset="UTF-8"` }],
  body: { size: text.length, data: b64url(Buffer.from(text)) },
});

test("reads a Gmail payload", () => {
  const p = {
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "multipart/alternative", parts: [part("text/plain", "Hi Ana,\r\n\r\n\r\n\r\nsee the report."), part("text/html", "<p>Hi Ana</p>")] },
      { mimeType: "application/pdf", filename: "report.pdf", headers: [], body: { attachmentId: "ANG1", size: 120_000 } },
      { mimeType: "image/png", filename: "", headers: [{ name: "Content-ID", value: "<img1>" }], body: { attachmentId: "ANG2", size: 900 } },
    ],
  };
  const parts = new Parts();
  walk(p, parts);
  expect(parts.body()).toBe("Hi Ana,\n\nsee the report.");
  expect(parts.files.length).toBe(2);
  expect(parts.files[0]).toMatchObject({ name: "report.pdf", id: "ANG1", size: 120_000 });
  expect(parts.files[1]?.name).toBe("(unnamed)");

  const h = new Parts();
  walk({ mimeType: "multipart/alternative", parts: [part("text/html", '<div>Code: <b>42</b></div><a href="https://example.com/v?a=1&amp;b=2">Verify</a>')] }, h);
  expect(h.body()).toBe("Code: 42\nVerify (https://example.com/v?a=1&b=2)");

  const l = new Parts();
  walk({ mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=ISO-8859-1" }], body: { data: b64url(bytes(0x6f, 0x6c, 0xe1)) } }, l);
  expect(l.body()).toBe("olá");
});

test("html as text", () => {
  const h =
    "<html><head><style>p{color:red}</style><title>T</title></head><body><!-- x --><p>Hello&nbsp;&amp; welcome&#33;</p>\n<ul><li>one</li><li>two</li></ul><script>alert(1)</script><table><tr><td>a</td><td>b</td></tr></table><a href='mailto:x@example.com'>x@example.com</a> <a href=\"https://example.com\">https://example.com</a> &unknown; &#x263A;</body></html>";
  expect(tidy(htmlText(h))).toBe("Hello & welcome!\n\n- one\n- two\n\na b\n\nx@example.com https://example.com &unknown; ☺");
  expect(entities("Tom &amp; Jerry&#39;s &quot;show&quot;")).toBe("Tom & Jerry's \"show\"");
});

test("label changes", () => {
  const p = (a: Record<string, unknown>) => plan(a, lbl);
  expect(p({ move_to: "work" })).toEqual([["Label_1"], ["INBOX"]]);
  expect(p({ move_to: "Clients/Acme", remove_labels: ["Work"] })).toEqual([["Label_2"], ["Label_1", "INBOX"]]);
  expect(p({ move_to: "inbox" })).toEqual([["INBOX"], []]);
  expect(p({ archive: true, read: true, starred: true })).toEqual([["STARRED"], ["INBOX", "UNREAD"]]);
  expect(p({ read: false, starred: false })).toEqual([["UNREAD"], ["STARRED"]]);
  expect(p({ add_labels: "Work, Label_2", archive: true, move_to: "Work" })).toEqual([["Label_1", "Label_2"], ["INBOX"]]);
  expect(() => p({ move_to: "INBOX", archive: true })).toThrow("both added and removed");
  expect(() => p({ move_to: "Nope" })).toThrow('No label "Nope"');
  expect(() => p({ move_to: "trash" })).toThrow("use trash");
  expect(plan({ add_labels: ["important", "category_updates"] }, [])[0]).toEqual(["IMPORTANT", "CATEGORY_UPDATES"]);
  expect(describe(["Label_1"], ["INBOX"], lbl)).toBe("+Work, -INBOX");
});

test("replies", () => {
  expect(splitAddrs('"Doe, Jane" <jane@example.com>, bo@example.com; <c@example.com>')).toEqual(['"Doe, Jane" <jane@example.com>', "bo@example.com", "<c@example.com>"]);
  expect(addrEmail(" Ana <Ana@Example.COM> ")).toBe("ana@example.com");
  expect(addrEmail("bo@example.com")).toBe("bo@example.com");
  const cc = replyAllCc("me@example.com", "Ana <ana@example.com>", 'Me <me@example.com>, ana@example.com, "Doe, Jane" <jane@example.com>, ', "bo@example.com, Jane <JANE@example.com>");
  expect(cc).toBe("bo@example.com, Jane <JANE@example.com>");
  expect(reSubject("Lunch")).toBe("Re: Lunch");
  expect(reSubject("RE: Lunch")).toBe("RE: Lunch");
});

test("accounts and their errors", () => {
  const acc = ["ana@example.com", "Work@Example.com"];
  expect(resolve("", acc)).toBe("ana@example.com");
  expect(resolve(" work@example.com ", acc)).toBe("Work@Example.com");
  expect(() => resolve("bo@example.com", acc)).toThrow(/No Gmail account bo@example.com is connected.*ana@example.com, Work@Example.com.*default \(ana@example.com\)/);
  expect(() => resolve("", [])).toThrow("isn't signed in");
  const l = listAccounts(acc);
  expect(l.startsWith("2 Gmail accounts connected")).toBe(true);
  expect(l).toContain("- ana@example.com (default)\n- Work@Example.com\n");
  expect(() => listAccounts([])).toThrow();
  const t = tools();
  expect(t.every((x) => x.name === "accounts" || JSON.stringify(x).includes('"account":{"type":"string"'))).toBe(true);
  const search = t.find((x) => x.name === "search");
  expect(JSON.stringify(search)).toContain('\\"all\\"');
  expect(t.some((x) => x.name === "accounts")).toBe(true);
});

test("small things", () => {
  expect(charset('text/plain; charset="ISO-8859-1"; format=flowed')).toBe("iso-8859-1");
  expect(charset("text/plain")).toBe("utf-8");
  expect(safeName("../../etc/passwd")).toBe("_.._etc_passwd");
  expect(safeName("")).toBe("attachment");
  expect(size(512)).toBe("512 B");
  expect(size(2048)).toBe("2 KB");
  expect(size(3 * 1_048_576)).toBe("3.0 MB");
  expect(mimeFor("a.PDF")).toBe("application/pdf");
  expect(strs({ ids: "a, b,," }, "ids")).toEqual(["a", "b"]);
  expect(addrs({ to: ["a@example.com", " b@example.com"] }, "to")).toBe("a@example.com, b@example.com");
  expect(clip("x".repeat(300), 200)).toContain("100 more characters");
  for (const t of tools()) {
    const props = (t.inputSchema as { properties: Record<string, { type: string; items?: unknown }> }).properties;
    for (const p of Object.values(props)) expect(p.type !== "array" || typeof p.items === "object").toBe(true);
  }
});

interface Seen {
  method: string;
  path: string;
  auth: string;
  length: string | null;
  type: string | null;
  body: string;
}

const seen: Seen[] = [];
let refused = 0;
let server: ReturnType<typeof Bun.serve>;
let gmail: Gmail;
const tokens = { current: "tok-1", forced: 0 };
const dir = mkdtempSync(join(tmpdir(), "gmail-test-"));

const message = (id: string, thread: string, subject: string, labels: string[] = ["INBOX"], from = "Ana <ana@example.com>") => ({
  id,
  threadId: thread,
  labelIds: labels,
  snippet: "Tom &amp; Jerry",
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: from },
      { name: "To", value: "me@example.com, bo@example.com" },
      { name: "Cc", value: "cy@example.com" },
      { name: "Subject", value: subject },
      { name: "Date", value: "Mon, 26 Oct 2026 10:00:00 +0000" },
      { name: "Message-ID", value: `<${id}@example.com>` },
    ],
    body: { size: 5, data: b64url(Buffer.from("hello")) },
  },
});

const auth: Auth = {
  accounts: () => ["me@example.com", "other@example.com"],
  token: (_e, force) => {
    if (force) {
      tokens.forced++;
      tokens.current = "tok-2";
    }
    return tokens.current;
  },
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/gmail\/v1\/users\/me/, "").replace(/^\/upload\/gmail\/v1\/users\/me/, "/upload") + url.search;
      const body = await req.text();
      seen.push({ method: req.method, path, auth: req.headers.get("authorization") ?? "", length: req.headers.get("content-length"), type: req.headers.get("content-type"), body });
      const json = (v: unknown, status = 200): Response => Response.json(v, { status });
      if (req.headers.get("authorization") === "Bearer tok-1" && refused > 0) {
        refused--;
        return json({ error: { message: "Invalid Credentials" } }, 401);
      }
      if (url.pathname.endsWith("/profile")) return json({ emailAddress: "me@example.com" });
      if (url.pathname.endsWith("/labels") && req.method === "GET") return json({ labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "Label_1", name: "Work", type: "user" }, { id: "Label_2", name: "Alpha", type: "user" }] });
      if (url.pathname.includes("/labels/") && req.method === "GET") return json({ messagesTotal: 7, messagesUnread: 2 });
      if (url.pathname.endsWith("/messages") && req.method === "GET") {
        if (url.searchParams.get("q") === "nothing") return json({ resultSizeEstimate: 0 });
        return json({ messages: [{ id: "m1" }, { id: "m2" }], nextPageToken: "NEXT" });
      }
      if (url.pathname.endsWith("/threads") && req.method === "GET") return json({ threads: [{ id: "t1" }] });
      if (url.pathname.endsWith("/threads/t1")) {
        return json({ id: "t1", messages: [message("m1", "t1", "Lunch"), message("m2", "t1", "Re: Lunch", ["INBOX", "Label_1"])] });
      }
      if (url.pathname.endsWith("/messages/m1")) return json(message("m1", "t1", "Lunch"));
      if (url.pathname.endsWith("/messages/m2")) return json(message("m2", "t2", "Other", ["Label_1"]));
      if (url.pathname.endsWith("/messages/bad")) return json({ error: { message: "Not Found" } }, 404);
      if (url.pathname.endsWith("/attachments/a1")) return json({ data: b64url(Buffer.from("file bytes")) });
      if (url.pathname.endsWith("/messages/send") || url.pathname.endsWith("/drafts") && req.method === "POST") {
        return json({ id: "sent1", threadId: "t1", message: { id: "dm1", threadId: "t1" } });
      }
      if (url.pathname.includes("/drafts/send")) return json({ id: "sent2", threadId: "t3" });
      if (url.pathname.endsWith("/drafts") && req.method === "GET") return json({ drafts: [{ id: "d1" }] });
      if (url.pathname.endsWith("/drafts/d1") && req.method === "GET") return json({ id: "d1", message: { id: "dm1", threadId: "t1", snippet: "a &amp; b", payload: { headers: [{ name: "Subject", value: "Plan" }] } } });
      if (url.pathname.endsWith("/drafts/d1") && req.method === "PUT") return json({ id: "d1", message: { id: "dm2", threadId: "t1" } });
      if (url.pathname.endsWith("/batchModify")) return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/trash") || url.pathname.endsWith("/untrash")) return url.pathname.includes("/zzz/") ? json({ error: { message: "gone" } }, 404) : json({});
      if (url.pathname.endsWith("/modify")) return json({});
      if (url.pathname.endsWith("/settings/filters") && req.method === "GET") {
        return json({ filter: [{ id: "f1", criteria: { from: "a@example.com", hasAttachment: true }, action: { addLabelIds: ["Label_1"], removeLabelIds: ["INBOX"], forward: "z@example.com" } }] });
      }
      if (url.pathname.endsWith("/settings/filters")) return json({ id: "f2" });
      if (req.method === "DELETE" || req.method === "PATCH" || url.pathname.endsWith("/labels")) return json({ id: "x" });
      return json({ error: { message: "no route" } }, 404);
    },
  });
  gmail = new Gmail({ auth, api: `http://localhost:${server.port}/gmail/v1/users/me`, upload: `http://localhost:${server.port}/upload/gmail/v1/users/me`, attachmentDir: dir });
});

afterAll(() => server.stop(true));

const call = async (name: string, args: Record<string, unknown> = {}) => gmail.callTool(name, { account: "me@example.com", ...args });
const last = (): Seen => seen[seen.length - 1] as Seen;

test("search lists messages with labels and a next page", async () => {
  const r = await call("search", { query: "from:ana", max_results: 500 });
  expect(r.ok).toBe(true);
  expect(r.text).toContain('2 messages for "from:ana":');
  expect(r.text).toContain("- m1 (thread t1) Mon, 26 Oct 2026 10:00:00 +0000\n  Ana <ana@example.com>: Lunch [INBOX]\n  Tom & Jerry\n");
  expect(r.text).toContain("[Work]");
  expect(r.text).toContain("More: page_token NEXT\n");
  const list = seen.find((s) => s.path.startsWith("/messages?"));
  expect(list?.path).toContain("maxResults=100&q=from%3Aana");
  expect(list?.auth).toBe("Bearer tok-1");
  expect((await call("search", { query: "nothing" })).text).toBe('No messages match "nothing".');
  expect((await call("search", { threads: true })).text).toContain("- thread t1, 2 messages, last");
});

test("search with account all asks every account", async () => {
  const r = await gmail.callTool("search", { account: "all", query: "x" });
  expect(r.text).toContain("## me@example.com\n2 messages for \"x\":");
  expect(r.text).toContain("## other@example.com\n");
});

test("a message and a thread are shown as text", async () => {
  const m = await call("get_message", { id: "m1" });
  expect(m.text).toBe("Message m1 (thread t1) [INBOX]\nFrom: Ana <ana@example.com>\nTo: me@example.com, bo@example.com\nCc: cy@example.com\nDate: Mon, 26 Oct 2026 10:00:00 +0000\nSubject: Lunch\n\nhello\n");
  const t = await call("get_thread", { id: "t1" });
  expect(t.text.startsWith("Thread t1: 2 messages\n\nMessage m1")).toBe(true);
  expect(t.text).toContain("\n---\n\nMessage m2");
  const bad = await call("get_message", { id: "bad" });
  expect(bad).toEqual({ ok: false, text: "Gmail: Not Found (404)" });
  expect((await call("get_message", {})).text).toBe("Pass id.");
});

test("an attachment is saved to a file", async () => {
  const r = await call("get_attachment", { message_id: "m1", attachment_id: "a1", filename: "../x.txt" });
  expect(r.ok).toBe(true);
  const path = join(dir, "harbor-gmail", "_x.txt");
  expect(r.text).toBe(`Saved _x.txt (10 B) to ${path}`);
  expect(readFileSync(path, "utf8")).toBe("file bytes");
  const to = join(dir, "chosen.bin");
  expect((await call("get_attachment", { message_id: "m1", attachment_id: "a1", path: to })).text).toContain(to);
  expect((await call("get_attachment", { message_id: "m1", attachment_id: "a1", filename: "n.txt", path: dir })).text).toContain(join(dir, "n.txt"));
});

test("send answers in the thread and attaches files", async () => {
  const file = join(dir, "note.txt");
  writeFileSync(file, "attached");
  const r = await call("send", { reply_to: "m1", body: "Sure", reply_all: true, attachments: [file] });
  expect(r.text).toBe("Sent to Ana <ana@example.com>, bo@example.com, cy@example.com (message sent1, thread t1).");
  const sent = last();
  expect(sent.path).toBe("/messages/send");
  expect(sent.length).not.toBeNull();
  const msg = JSON.parse(sent.body) as { raw: string; threadId: string };
  expect(msg.threadId).toBe("t1");
  const raw = utf8(unb64(msg.raw));
  expect(raw).toContain("To: Ana <ana@example.com>\r\n");
  expect(raw).toContain("Cc: bo@example.com, cy@example.com\r\n");
  expect(raw).toContain("Subject: Re: Lunch\r\n");
  expect(raw).toContain("In-Reply-To: <m1@example.com>\r\n");
  expect(raw).toContain('filename="note.txt"');
  expect((await call("send", { body: "x" })).text).toBe("Who to? Pass to, or reply_to.");
  expect((await call("send", { to: "a@example.com", attachments: [join(dir, "missing")] })).text).toContain("Can't attach");
});

test("a big message goes up as a multipart upload", async () => {
  const file = join(dir, "big.bin");
  writeFileSync(file, Buffer.alloc(4 << 20, 7));
  const r = await call("send", { to: "a@example.com", attachments: [file] });
  expect(r.text).toBe("Sent to a@example.com (message sent1, thread t1).");
  const up = last();
  expect(up.path).toBe("/upload/messages/send?uploadType=multipart");
  expect(up.type).toStartWith("multipart/related; boundary=harbor-");
  expect(up.body).toContain("Content-Type: message/rfc822\r\n\r\nTo: a@example.com\r\n");
});

test("drafts are saved, listed, replaced, sent and deleted", async () => {
  const saved = await call("save_draft", { to: "a@example.com", body: "x" });
  expect(saved.text).toBe("Draft sent1 saved (message dm1, thread t1). It is in Gmail's Drafts.");
  expect(JSON.parse(last().body)).toHaveProperty("message.raw");
  const replaced = await call("save_draft", { draft_id: "d1", to: "a@example.com" });
  expect(replaced.text).toContain("Draft d1 saved (message dm2");
  expect(last().method).toBe("PUT");
  expect(JSON.parse(last().body)).toHaveProperty("id", "d1");
  expect((await call("list_drafts")).text).toBe("1 drafts:\n- d1 (message dm1, thread t1)\n  To: (nobody yet) · Plan\n  a & b\n");
  expect((await call("send_draft", { draft_id: "d1" })).text).toBe("Sent the draft (message sent2, thread t3).");
  expect(last().body).toBe('{"id":"d1"}');
  expect((await call("delete_draft", { draft_id: "d1" })).text).toBe("Deleted draft d1.");
  expect(last().method).toBe("DELETE");
});

test("modify and trash report what changed and what failed", async () => {
  const r = await call("modify", { ids: ["m1", "m2"], move_to: "Work", read: true });
  expect(r.text).toBe("2 messages updated: +Work, -INBOX, -UNREAD.");
  expect(JSON.parse(last().body)).toEqual({ addLabelIds: ["Label_1"], removeLabelIds: ["INBOX", "UNREAD"], ids: ["m1", "m2"] });
  expect((await call("modify", { ids: ["t1"], threads: true, starred: true })).text).toBe("1 conversation updated: +STARRED.");
  expect((await call("modify", { ids: ["m1"] })).text).toStartWith("Nothing to change");
  expect((await call("modify", {})).text).toBe("Pass ids.");
  expect((await call("trash", { ids: ["m1", "zzz"] })).text).toBe("1 messages moved to the trash.\nFailed:\nzzz: Gmail: gone (404)");
  expect(seen.find((s) => s.path === "/messages/m1/trash")?.length).toBe("0");
  expect((await call("trash", { ids: "m1", undo: true })).text).toBe("1 messages taken out of the trash.");
});

test("labels are listed, counted and edited", async () => {
  const r = await call("list_labels", { counts: true });
  expect(r.text).toBe("Signed in as me@example.com.\nYour labels:\n- Alpha (id Label_2): 7 messages, 2 unread\n- Work (id Label_1): 7 messages, 2 unread\nSystem labels:\n- INBOX (id INBOX): 7 messages, 2 unread\n");
  expect((await call("edit_label", { action: "create", label: "Clients/Acme" })).text).toBe("Created label Clients/Acme (id x).");
  expect((await call("edit_label", { action: "rename", label: "work", new_name: "Job" })).text).toBe("Renamed work to Job.");
  expect(last().path).toBe("/labels/Label_1");
  expect((await call("edit_label", { action: "delete", label: "Nope" })).text).toContain('No label "Nope"');
  expect((await call("edit_label", { action: "zap", label: "x" })).text).toBe('No action "zap": create, rename or delete.');
});

test("filters are listed, created and deleted", async () => {
  expect((await call("filters", { action: "list" })).text).toBe("1 filters:\n- f1: from:a@example.com has:attachment → +Work, -INBOX, forward to z@example.com\n");
  expect((await call("filters", { action: "create", from: "a@example.com", archive: true, forward: "z@example.com" })).text).toBe("Created filter f2.");
  expect(JSON.parse(last().body)).toEqual({ criteria: { from: "a@example.com" }, action: { removeLabelIds: ["INBOX"], forward: "z@example.com" } });
  expect((await call("filters", { action: "create", archive: true })).text).toStartWith("Pass at least one criterion");
  expect((await call("filters", { action: "create", from: "a@example.com" })).text).toStartWith("Pass what it does");
  expect((await call("filters", { action: "delete", id: "f1" })).text).toBe("Deleted filter f1.");
});

test("a refused token is refreshed once", async () => {
  refused = 3;
  tokens.forced = 0;
  tokens.current = "tok-1";
  const r = await call("get_message", { id: "m1" });
  expect(r.ok).toBe(true);
  expect(tokens.forced).toBe(1);
  expect(last().auth).toBe("Bearer tok-2");
  refused = 0;
  tokens.current = "tok-1";
});

test("a sign-in that stays refused or is gone says so", async () => {
  const stuck = new Gmail({ auth: { accounts: auth.accounts, token: () => "tok-1" }, api: `http://localhost:${server.port}/gmail/v1/users/me` });
  refused = 5;
  const r = await stuck.callTool("get_message", { account: "me@example.com", id: "m1" });
  refused = 0;
  expect(r.ok).toBe(false);
  expect(r.text).toBe("Gmail refused the sign-in of me@example.com (Invalid Credentials). Sign in to it again in Harbor (Settings › Integrations › Apps).");
  const gone = new Gmail({ auth: { accounts: auth.accounts, token: () => null } });
  expect((await gone.callTool("search", {})).text).toBe("The sign-in of me@example.com has expired or was revoked. Sign in to it again in Harbor (Settings › Integrations › Apps).");
  const none = new Gmail({ auth: { accounts: () => [], token: () => null } });
  expect((await none.callTool("accounts", {})).text).toContain("isn't signed in");
  const down = new Gmail({ auth, api: "http://localhost:1/x" });
  expect((await down.callTool("search", {})).text).toStartWith("Gmail didn't answer:");
  expect((await call("nonsense")).text).toBe("No tool nonsense.");
});

test("a new sign-in's address comes from the profile", async () => {
  expect(await profileEmail("tok-9", `http://localhost:${server.port}/gmail/v1/users/me`)).toBe("me@example.com");
  expect(last().auth).toBe("Bearer tok-9");
});

async function* lines(...l: string[]): AsyncGenerator<string> {
  for (const x of l) yield x;
}

test("the stdio server speaks MCP", async () => {
  const out: unknown[] = [];
  await serve(
    gmail,
    lines(
      "not json",
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "accounts", arguments: {} } }),
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_message", arguments: {} } }),
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" }),
      JSON.stringify({ jsonrpc: "2.0", id: 6, method: "nope" }),
    ),
    (l) => {
      out.push(JSON.parse(l));
      return true;
    },
  );
  const [init, list, accounts, bad, ping, unknown] = out as { result?: Record<string, unknown>; jsonrpc?: string; id?: number; error?: unknown }[];
  expect(out.length).toBe(6);
  expect(init?.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "gmail" } });
  expect((list?.result?.tools as unknown[]).length).toBe(15);
  expect(accounts?.result).toMatchObject({ isError: false });
  expect(JSON.stringify(accounts?.result)).toContain("2 Gmail accounts connected");
  expect(bad?.result).toEqual({ content: [{ type: "text", text: "Pass id." }], isError: true });
  expect(ping?.result).toEqual({});
  expect(unknown).toEqual({ jsonrpc: "2.0", id: 6, error: { code: -32601, message: "method not found" } });
});

test("the server stops when the client goes away", async () => {
  let writes = 0;
  await serve(gmail, lines(JSON.stringify({ id: 1, method: "ping" }), JSON.stringify({ id: 2, method: "ping" })), () => ++writes < 1);
  expect(writes).toBe(1);
});
