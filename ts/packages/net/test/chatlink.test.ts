import { describe, expect, test } from "bun:test";
import {
  CHAT_SCHEME as SCHEME,
  chatLink,
  chatLinkTarget,
  chatLinkTargets,
  chatLinkTitle,
  chatLinks,
  labelChatLinks,
  openChatLink,
  parseChatLink,
  type ChatLinkWorld,
} from "../src/chatlink.ts";

const G = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";

describe("chatlink", () => {
  test("parses_links", () => {
    const s = `${SCHEME}${G}?pc=desk. Next`;
    expect(parseChatLink(s)).toEqual({ len: SCHEME.length + G.length + 8, gid: G, pc: "desk" });
    expect(parseChatLink(`${SCHEME}${G})`)).toEqual({ len: SCHEME.length + G.length, gid: G, pc: "" });
    expect(parseChatLink(SCHEME)).toBeNull();
    expect(parseChatLink("harbor://pair?v=3")).toBeNull();
    expect(chatLink(G, "my pc")).toBe(`${SCHEME}${G}?pc=my%20pc`);
    expect(parseChatLink(`${SCHEME}${"a".repeat(65)}`)).toBeNull();
  });

  test("labels_bare_links_only", () => {
    const md = `See ${SCHEME}${G}, or [that one](${SCHEME}abc) and <${SCHEME}${G}?pc=desk>; not \`${SCHEME}${G}\`.`;
    const out = labelChatLinks(md, (u) => (u.includes(G) ? "Fix [login]" : "?"));
    expect(out).toBe(`See [Fix \\[login\\]](${SCHEME}${G}), or [that one](${SCHEME}abc) and [Fix \\[login\\]](${SCHEME}${G}?pc=desk); not \`${SCHEME}${G}\`.`);
    const l = chatLinks(md);
    expect(l.map(([, g]) => g)).toEqual([G, "abc", G]);
    expect(l[2]?.[0]).toBe(`${SCHEME}${G}?pc=desk`);
    expect(labelChatLinks("plain text", () => "")).toBe("plain text");
  });

  const world: ChatLinkWorld = {
    chats: [
      { id: 1, gid: G, title: "  Fix login ", name: "", role: "lead", parent: null },
      { id: 2, gid: "sub1", title: "", name: "tests", role: "sub", parent: 1 },
      { id: 3, gid: "blank", title: " ", name: "", role: "lead", parent: null },
    ],
    peers: [
      { name: "Laptop", online: false },
      { name: "desk", online: true },
    ],
  };

  test("targets: a chat here, a sub-agent under its lead, an offline or unknown PC", () => {
    expect(chatLinkTarget(world, `${SCHEME}${G}`)).toEqual({ id: 1, title: "Fix login", missing: "" });
    expect(chatLinkTarget(world, `${SCHEME}sub1`).title).toBe("Fix login › tests");
    expect(chatLinkTitle(world, world.chats[2]!)).toBe("Untitled chat");
    expect(chatLinkTarget(world, `${SCHEME}nope?pc=laptop`)).toEqual({ id: null, title: "laptop is offline", missing: "laptop is offline" });
    expect(chatLinkTarget(world, `${SCHEME}nope?pc=desk`).missing).toBe("Chat not found");
    expect(chatLinkTarget(world, "https://x").missing).toBe("Not a chat link");
    expect(Object.keys(chatLinkTargets(world, `a ${SCHEME}${G} b ${SCHEME}nope`))).toEqual([`${SCHEME}${G}`, `${SCHEME}nope`]);
    expect(JSON.stringify(chatLinkTargets(world, `${SCHEME}nope`))).toBe(`{"${SCHEME}nope":{"title":"Chat not found","chat":null,"missing":"Chat not found"}}`);
    const opened: number[] = [];
    expect(openChatLink(world, `${SCHEME}${G}`, (id) => opened.push(id))).toEqual({ id: 1 });
    expect(openChatLink(world, `${SCHEME}nope`, (id) => opened.push(id))).toEqual({ error: "Chat not found" });
    expect(opened).toEqual([1]);
  });

  test("a link with this PC's own chat id for a gid (as agents sometimes write) opens that chat here, never a copy's or another PC's", () => {
    const here: ChatLinkWorld = { ...world, me: "Box", chats: [...world.chats, { id: 7, gid: "g7", title: "Bike", name: "", role: "lead", parent: null }, { id: 8, gid: "g8", title: "Copy", name: "", role: "lead", parent: null, home: "pc:desk" }] };
    expect(chatLinkTarget(here, `${SCHEME}7?pc=box`)).toEqual({ id: 7, title: "Bike", missing: "" });
    expect(chatLinkTarget(here, `${SCHEME}7`).id).toBe(7);
    expect(chatLinkTarget(here, `${SCHEME}7?pc=desk`).id).toBeNull();
    expect(chatLinkTarget(here, `${SCHEME}8?pc=box`).id).toBeNull();
    expect(chatLinkTarget(world, `${SCHEME}7?pc=box`).missing).toBe("Chat not found");
  });
});
