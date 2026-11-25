import { describe, expect, it } from "bun:test";
import { FORWARD_DEFAULT_QUESTION, forwardableFiles, forwardedNote, splitForwarded } from "../src/forward.ts";
import { chatImages, offersSiteRequests, wantsSpokpay } from "../src/spokpay-view.ts";

const msg = { content: "Pode trocar o banner?", timestamp: "2026-11-25T10:31:00.000Z", attachments: [{ name: "banner.png", url: "https://cdn/x/banner.png", type: "image/png", size: 2048 }], voice: false };

describe("Forward to AI", () => {
  it("the note carries the message in a marked block, then the question (default when empty)", () => {
    const n = forwardedNote({ message: msg, from: "Lua", question: "", files: ["/tmp/banner.png"] });
    expect(n).toContain("<forwarded-message>\nFrom: Lua\nTime: 2026-11-25 10:31\nAttachment: image · banner.png (2 KB)\nAttachment URL: https://cdn/x/banner.png\nAttachment file on this PC: /tmp/banner.png\nText:\nPode trocar o banner?\n</forwarded-message>");
    expect(n.endsWith(FORWARD_DEFAULT_QUESTION)).toBe(true);
  });
  it("reads back as the quote and the question", () => {
    const s = splitForwarded(forwardedNote({ message: msg, from: "Lua", question: "Qual o prazo?" }));
    expect(s.forwarded).toMatchObject({ from: "Lua", at: "2026-11-25 10:31", text: "Pode trocar o banner?" });
    expect(s.question).toBe("Qual o prazo?");
    expect(splitForwarded("just a note")).toEqual({ forwarded: null, question: "just a note" });
  });
  it("hands over images and PDFs only", () => {
    expect(forwardableFiles({ attachments: [...msg.attachments, { name: "a.zip", url: "u2" }, { name: "c.pdf", url: "u3" }] })).toEqual([{ url: "https://cdn/x/banner.png", name: "banner.png" }, { url: "u3", name: "c.pdf" }]);
  });
});

describe("where Open Site Request is offered (Person Hub d210e5a, f9c095e)", () => {
  const stores = [{ id: "s1", name: "Shark", ownerId: "owner" }];
  it("SpokPay people and store owners, SpokPay connected", () => {
    expect(wantsSpokpay({ id: "a", listIds: ["spokpay"] }, { stores })).toBe(true);
    expect(wantsSpokpay({ id: "owner", listIds: [] }, { stores })).toBe(true);
    expect(wantsSpokpay({ id: "b", listIds: ["creators"] }, { stores })).toBe(false);
    expect(offersSiteRequests({ connected: true, person: { id: "a", listIds: ["spokpay"] }, data: { stores }, proposals: 0 })).toBe(true);
    expect(offersSiteRequests({ connected: false, person: { id: "a", listIds: ["spokpay"] }, data: { stores }, proposals: 0 })).toBe(false);
  });
  it("anyone with a proposal in their chat", () => {
    expect(offersSiteRequests({ connected: true, person: { id: "b", listIds: [] }, data: { stores }, proposals: 1 })).toBe(true);
  });
  it("the message's images picked, the conversation's after them", () => {
    const im = chatImages(msg, [{ attachments: [{ name: "old.jpg", url: "o" }] }, { attachments: [{ name: "v.ogg", url: "v" }], voice: true }]);
    expect(im).toEqual([{ url: "https://cdn/x/banner.png", name: "banner.png", type: "image/png", picked: true }, { url: "o", name: "old.jpg", type: "", picked: false }]);
  });
});
