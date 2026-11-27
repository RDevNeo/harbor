import { expect, test } from "bun:test";
import { attachmentKind, preview } from "../src/model/conversation.ts";
import { slimWa } from "../src/conn/whatsapp-core.ts";
import type { Message } from "../src/model/types.ts";

test("videos are their own kind, by type or extension", () => {
  expect(attachmentKind({ name: "clip", url: "x", type: "video/mp4" })).toBe("video");
  expect(attachmentKind({ name: "clip.MOV", url: "x" })).toBe("video");
  expect(attachmentKind({ name: "a.3gp", url: "x" })).toBe("video");
  expect(attachmentKind({ name: "a.mp4", url: "x" }, true)).toBe("audio");
  expect(attachmentKind({ name: "a.pdf", url: "x" })).toBe("file");
  const m = { id: "1", content: "", attachments: [{ name: "v.mp4", url: "x" }] } as unknown as Message;
  expect(preview(m)).toBe("🎥 Video");
});

test("a WhatsApp video keeps its size and length, named by a real extension", () => {
  const raw = { key: { id: "ABCDEF123456", fromMe: false }, messageTimestamp: 1_760_000_000, message: { videoMessage: { mimetype: "video/quicktime", seconds: 17, width: 720, height: 1280, fileLength: 3_100_000 } } };
  const m = slimWa(raw, "5511999990000@s.whatsapp.net", "wa");
  const a = m?.attachments?.[0];
  expect(a?.name).toBe("video-ABCDEF.mov");
  expect([a?.width, a?.height, a?.duration, a?.size]).toEqual([720, 1280, 17, 3_100_000]);
  expect(attachmentKind(a!)).toBe("video");
});
