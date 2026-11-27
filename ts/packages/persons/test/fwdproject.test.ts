import { describe, expect, it } from "bun:test";
import { forwardedNote, projectChatTitle, projectNote, splitForwarded } from "../src/forward.ts";
import { defaultProject, projectChoices, shortPath } from "../src/projects.ts";

const msg = { content: "Valeu", timestamp: "2026-11-26T21:41:00.000Z", attachments: [{ name: "print.png", url: "https://cdn/x/print.png", type: "image/png", size: 2048 }], voice: false };

describe("Forward to Projects: the new chat's first message", () => {
  it("the prompt first, then the forwarded message with who, the section, the time, the files and the text", () => {
    const n = projectNote({ prompt: "  Mark thank-you-only chats as resolved.\n", message: msg, from: "zeus.exxe", section: "SpokPay · Discord", files: ["/tmp/print.png"], transcripts: ["obrigado"] });
    expect(n.startsWith("Mark thank-you-only chats as resolved.\n\nThe message this is about, forwarded from Persons (SpokPay · Discord):\n<forwarded-message>\n")).toBe(true);
    expect(n).toContain("From: zeus.exxe\nSection: SpokPay · Discord\nTime: 2026-11-26 21:41\nAttachment: image · print.png (2 KB)\nAttachment URL: https://cdn/x/print.png\nAttachment file on this PC: /tmp/print.png\nTranscript of the audio: obrigado\nText:\nValeu\n</forwarded-message>");
    expect(n.endsWith("</forwarded-message>")).toBe(true);
  });
  it("a message without words says so; its block still reads back as a quote", () => {
    const n = projectNote({ prompt: "Look", message: { content: "", timestamp: "", attachments: [], voice: false }, from: "Lua", section: "Creators · Gmail" });
    expect(n).toContain("Text:\n(no text)");
    const back = splitForwarded(n);
    expect(back.forwarded?.from).toBe("Lua");
    expect(back.forwarded?.text).toBe("");
  });
  it("Forward to AI's note is unchanged by the shared block (no Section line)", () => {
    const n = forwardedNote({ message: msg, from: "Lua", question: "Qual o prazo?" });
    expect(n).not.toContain("Section:");
    expect(n.endsWith("\n\nQual o prazo?")).toBe(true);
  });
  it("the chat's title is the prompt's first line, collapsed and cut", () => {
    expect(projectChatTitle("\n  Fix   the badge \nmore lines")).toBe("Fix the badge");
    expect(projectChatTitle("x".repeat(100), 20)).toBe(`${"x".repeat(19)}…`);
    expect(projectChatTitle("   ")).toBe("");
  });
});

describe("Forward to Projects: Hub's projects for the picker", () => {
  const state = {
    projects: [
      { id: 1, name: "Persons [TAB]", path: "/home/u/Documents/harbor-projects/creators-hub/tabs/Persons" },
      { id: 2, name: "spokpay", path: "/home/u/Documents/harbor-projects/spokpay" },
      { id: 3, name: "", path: "/home/u/notes/" , settled: true },
    ],
    chats: [
      { project_id: 1, updated_ms: 100 },
      { project_id: 1, updated_ms: 300, retired: true, running: true },
      { project_id: 2, updated_ms: 200, working: true },
      { project_id: null, updated_ms: 999, running: true },
    ],
  };
  it("each project with its newest live chat, whether one works now, a short path, settled", () => {
    expect(projectChoices(state, "/home/u")).toEqual([
      { id: "1", name: "Persons [TAB]", path: "/home/u/Documents/harbor-projects/creators-hub/tabs/Persons", short: "creators-hub/tabs/Persons", last: 100, working: false, settled: false },
      { id: "2", name: "spokpay", path: "/home/u/Documents/harbor-projects/spokpay", short: "harbor-projects/spokpay", last: 200, working: true, settled: false },
      { id: "3", name: "notes", path: "/home/u/notes/", short: "notes", last: 0, working: false, settled: true },
    ]);
    expect(projectChoices(null)).toEqual([]);
  });
  it("short paths: the last three folders under home (or its Documents), ~ for home itself", () => {
    expect(shortPath("/home/u", "/home/u")).toBe("~");
    expect(shortPath("/srv/a/b/c/d", "/home/u")).toBe("b/c/d");
    expect(shortPath("/home/u/Documents/x", "/home/u")).toBe("x");
    expect(shortPath("/home/u/Documents", "/home/u")).toBe("Documents");
  });
  it("picked first: the last one used while it exists, else Persons' own project, else the newest", () => {
    const list = projectChoices(state, "/home/u");
    expect(defaultProject(list, "2")).toBe("2");
    expect(defaultProject(list, "gone")).toBe("1");
    expect(defaultProject(list.filter((p) => p.id !== "1"), null)).toBe("2");
    expect(defaultProject([], null)).toBe(null);
  });
});

describe("Forward to Projects: the routes", () => {
  const DC = "222222222222222222";
  const T0 = "2026-11-20T10:00:00.000Z";
  async function setup() {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { PersonsRoutes } = await import("../src/routes.ts");
    const { PersonsService } = await import("../src/service.ts");
    const { PersonAi } = await import("../src/ai.ts");
    const dir = mkdtempSync(join(tmpdir(), "hub-fwdproject-"));
    writeFileSync(join(dir, "data.json"), JSON.stringify({ version: 7, updatedAt: T0, readSince: T0, stores: [], lists: [{ id: "spokpay", name: "SpokPay", accountId: "spokpay" }], people: [{ id: "pz", name: "zeus.exxe", discordId: DC, storeIds: [], listIds: ["spokpay"], createdAt: T0, updatedAt: T0 }] }));
    writeFileSync(join(dir, "connections.json"), JSON.stringify({ version: 1, connections: [{ id: "spokpay", kind: "discord", section: "spokpay" }] }));
    writeFileSync(join(dir, "discord-cache-spokpay.json"), JSON.stringify({ conversations: { [DC]: { channelId: "dm", messages: [{ id: "d1", channelId: "dm", authorId: "them", fromMe: false, content: "Valeu", timestamp: "2026-11-26T21:41:00.000Z" }] } } }));
    const s = new PersonsService({ dir, offline: true, offlineConnected: true });
    await s.start();
    const sent: { path: string; body: unknown }[] = [];
    const hub = async (method: string, path: string, _q?: Record<string, string>, body?: unknown) => {
      if (method === "GET" && path === "v1/state") return { status: 200, body: { projects: [{ id: 7, name: "Persons [TAB]", path: "/x/creators-hub/tabs/Persons" }, { id: 9, name: "spokpay", path: "/x/spokpay" }], chats: [{ project_id: 9, updated_ms: 5, running: true }] } };
      if (method === "POST" && path === "v1/chats") {
        sent.push({ path, body });
        return { status: 200, body: { id: 42 } };
      }
      return { status: 404, body: null };
    };
    const r = new PersonsRoutes(s, { ai: new PersonAi(dir, hub) });
    const call = async (method: string, path: string, body: unknown = null) => (await r.route({ method, path: ["v1", "persons", ...path.split("/")], query: [], body }))!;
    return { s, call, sent, dir };
  }

  it("lists Hub's projects with Persons' own picked first, starts the chat there and remembers the project", async () => {
    const { s, call, sent, dir } = await setup();
    const list = (await call("GET", "projects")).body as { projects: { id: string; working: boolean }[]; selected: string };
    expect(list.projects.map((p) => [p.id, p.working])).toEqual([["7", false], ["9", true]]);
    expect(list.selected).toBe("7");

    expect((await call("POST", "chat/pz/to-project", { section: "spokpay", messageId: "d1", project: "9", prompt: "  " })).status).toBe(400);
    expect((await call("POST", "chat/pz/to-project", { section: "spokpay", messageId: "nope", project: "9", prompt: "x" })).status).toBe(404);

    const r = await call("POST", "chat/pz/to-project", { section: "spokpay", messageId: "d1", project: "9", prompt: "Auto-resolve thank-you chats\nand clear the badge" });
    expect(r.body).toEqual({ ok: true, chat: "42" });
    const b = sent[0]!.body as { project_id: number; title: string; text: string };
    expect(b.project_id).toBe(9);
    expect(b.title).toBe("Auto-resolve thank-you chats");
    expect(b.text.startsWith("Auto-resolve thank-you chats\nand clear the badge\n\nThe message this is about, forwarded from Persons (SpokPay · Discord):\n<forwarded-message>\nFrom: zeus.exxe\n")).toBe(true);
    expect(b.text).toContain("Text:\nValeu\n</forwarded-message>");
    // picked first next time
    expect(((await call("GET", "projects")).body as { selected: string }).selected).toBe("9");
    await s.stop();
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  });
});
