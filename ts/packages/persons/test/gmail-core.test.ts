// Ported from Person Hub's src/lib/gmail-core.test.ts, plus the account file and attachment URLs.
import { describe, expect, it } from "bun:test";
import * as g from "../src/conn/gmail-core.ts";

const b64 = (s: string): string => Buffer.from(s).toString("base64url");

describe("Gmail helpers", () => {
  it("keeps only the new text of a reply", () => {
    expect(g.stripQuoted("Sure, tomorrow!\n\nOn Mon, Nov 24, 2026 at 10:00 Ana <ana@x.com> wrote:\n> can we talk?\n> thanks")).toBe("Sure, tomorrow!");
    expect(g.stripQuoted("Fechado!\r\n\r\nEm seg., 24 de nov. de 2026 às 10:00, Ana <ana@x.com>\r\nescreveu:\r\n> oi")).toBe("Fechado!");
    expect(g.stripQuoted("Thanks\n-- \nAna\nCEO")).toBe("Thanks");
    expect(g.stripQuoted("Ok\n\nEnviado do meu iPhone")).toBe("Ok");
    expect(g.stripQuoted("line 1\n> quoted\nline 2")).toBe("line 1\nline 2");
  });

  it("turns HTML into clean text with links, without quote/signature blocks", () => {
    const t = g.htmlText(
      '<html><head><style>p{}</style></head><body><p>Hi <b>Ana</b>,</p><p>see <a href="https://spokpay.com/x">our page</a> and https://a.b</p><div class="gmail_signature">Igor</div><div class="gmail_quote">On … wrote: old</div></body></html>',
    );
    expect(t).toContain("Hi Ana,");
    expect(t).toContain("our page (https://spokpay.com/x)");
    expect(t).not.toContain("Igor");
    expect(t).not.toContain("old");
  });

  it("slims a Gmail message: text, direction, thread, attachments through chmail://", () => {
    const msg = {
      id: "18c0aa",
      threadId: "t1",
      internalDate: String(Date.UTC(2026, 10, 24)),
      labelIds: ["INBOX", "UNREAD"],
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "Ana Souza <Ana@X.com>" },
          { name: "To", value: "me@spokpay.com" },
          { name: "Subject", value: "Parceria" },
          { name: "Message-ID", value: "<abc@x.com>" },
        ],
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: b64("Olá!\n\nOn Mon … wrote:\n> antigo") } },
              { mimeType: "text/html", body: { data: b64("<p>Olá!</p>") } },
            ],
          },
          { mimeType: "application/pdf", filename: "midia kit.pdf", body: { attachmentId: "ANGjdJ_abcdefgh", size: 2048 } },
        ],
      },
    };
    const s = g.slimEmail(msg, "me@spokpay.com");
    expect(s).toMatchObject({ id: "18c0aa", threadId: "t1", from: "ana@x.com", fromMe: false, content: "Olá!", subject: "Parceria", messageIdHeader: "<abc@x.com>", to: ["me@spokpay.com"], unread: true, timestamp: "2026-11-24T00:00:00.000Z" });
    expect(s.attachments?.[0]).toMatchObject({ name: "midia kit.pdf", type: "application/pdf", size: 2048 });
    expect(s.attachments?.[0]?.url).toBe("chmail://att/18c0aa/ANGjdJ_abcdefgh?name=midia%20kit.pdf&type=application%2Fpdf");
    expect(g.slimEmail({ ...msg, labelIds: ["SENT"] }, "me@spokpay.com").fromMe).toBe(true);
    expect(g.peerOf(s, "me@spokpay.com")).toBe("ana@x.com");
    expect(g.peerOf({ ...s, fromMe: true }, "me@spokpay.com")).toBe("");
  });

  it("builds a threaded reply (In-Reply-To / References) with UTF-8 subject and attachments", () => {
    const raw = g.buildMime(
      { to: "ana@x.com", subject: g.reSubject("Parceria ção"), text: "Oi", inReplyTo: "<abc@x.com>", references: "<z@x.com> <abc@x.com>", files: [{ name: "a.pdf", type: "application/pdf", data: Buffer.from("%PDF") }] },
      "B1",
    );
    expect(raw).toContain("To: ana@x.com\r\n");
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/);
    expect(raw).toContain("In-Reply-To: <abc@x.com>\r\nReferences: <z@x.com> <abc@x.com>\r\n");
    expect(raw).toContain('Content-Type: multipart/mixed; boundary="B1"');
    expect(raw).toContain('Content-Disposition: attachment; filename="a.pdf"');
    expect(g.reSubject("Re: x")).toBe("Re: x");
    expect(g.buildMime({ to: "a@b.co", subject: "Hi", text: "x" }, "B")).not.toContain("In-Reply-To");
  });

  it("reads addresses", () => {
    expect(g.addrList('"Souza, Ana" <ana@x.com>, bob@y.com')).toEqual(["ana@x.com", "bob@y.com"]);
    expect(g.isEmail("ana@x.com")).toBe(true);
    expect(g.isEmail("ana@x")).toBe(false);
  });
});

describe("Gmail account file and attachments", () => {
  it("reads Person Hub's account file: plain tokens as they are, Electron-sealed ones as signed out", () => {
    expect(g.readAccount({ version: 1, account: "Me@X.com", refresh_token: { enc: "none", data: "r-1" }, history_id: "42", scopes: "a b" })).toEqual({ kind: "ok", refresh: "r-1", me: "me@x.com", historyId: "42", scopes: "a b" });
    expect(g.readAccount({ version: 1, account: "me@x.com", refresh_token: { enc: "safeStorage", data: "AAAA" } })).toEqual({ kind: "sealed", me: "me@x.com" });
    expect(g.readAccount({ version: 1, refresh_token: { enc: "none", data: "r" } })).toEqual({ kind: "none" });
    expect(g.readAccount(null)).toEqual({ kind: "none" });
    const back = JSON.parse(g.accountJson("me@x.com", "r-2", null, "s"));
    expect(back).toEqual({ version: 1, account: "me@x.com", refresh_token: { enc: "none", data: "r-2" }, history_id: null, scopes: "s" });
    expect(g.fileSuffix("gmail")).toBe("");
    expect(g.fileSuffix("creators-gmail-8ce5c1")).toBe("-creators-gmail-8ce5c1");
  });

  it("parses chmail:// URLs strictly and names the file after the attachment", () => {
    const url = g.attachmentUrl("18c0aa", "ANGjdJ_abcdefgh", "midia kit.pdf", "application/pdf");
    const a = g.parseAtt(url);
    expect(a).toEqual({ mid: "18c0aa", aid: "ANGjdJ_abcdefgh", name: "midia kit.pdf", type: "application/pdf" });
    expect(g.attFileName(a)).toMatch(/^18c0aa-[0-9a-f]{12}-midia kit\.pdf$/);
    expect(g.attFileName(a, "../../etc/passwd")).toMatch(/-_\.\._etc_passwd$/);
    expect(() => g.parseAtt("https://x/att/18c0aa/ANGjdJ_abcdefgh")).toThrow();
    expect(() => g.parseAtt("chmail://att/../ANGjdJ_abcdefgh")).toThrow();
  });

  it("merges messages by id, oldest first, keeping the newest", () => {
    const m = (id: string, t: string, unread = false) => ({ id, timestamp: t, unread });
    const a = [m("1", "2026-01-01"), m("2", "2026-01-03")];
    expect(g.mergeMessages(a, [m("1", "2026-01-01")], 10)).toBeNull();
    expect(g.mergeMessages(a, [m("3", "2026-01-02"), m("1", "2026-01-01", true)], 10)?.map((x) => [x.id, x.unread])).toEqual([
      ["1", true],
      ["3", false],
      ["2", false],
    ]);
    expect(g.mergeMessages(a, [m("3", "2026-01-02")], 2)?.map((x) => x.id)).toEqual(["3", "2"]);
  });

  it("prices calls and backs off on 429", () => {
    expect(g.costOf("/messages/send?uploadType=multipart")).toBe(100);
    expect(g.costOf("/history?startHistoryId=1")).toBe(2);
    expect(g.costOf("/threads?maxResults=15")).toBe(10);
    expect(g.coolMs("7", 1)).toBe(7000);
    expect(g.coolMs(null, 1)).toBe(10_000);
    expect(g.coolMs(null, 3)).toBe(40_000);
    expect(g.coolMs(null, 6)).toBe(300_000);
    expect(g.sizedPhoto("https://lh3.googleusercontent.com/a/x=s96-c")).toBe("https://lh3.googleusercontent.com/a/x=s128-c");
  });
});
