import { expect, test } from "bun:test";
import { Debounce, fresh, keptJson, parseKept, parseSnapshot, snapshotJson, SNAPSHOT_FRESH_MS, type UiSnapshot } from "../src/logic/uistate.ts";
import { filledBlocks } from "../src/pages/settings.ts";
import { field, row, type Block } from "../src/logic/settings-blocks.ts";

const entry = (text: string, cursor = Buffer.byteLength(text)) => ({ text, cursor, mentions: [], files: [], picked: [] });

test("an older Harbor's snapshot (view and plain drafts) still restores: chat, drafts with the cursor at their end", () => {
  const s = parseSnapshot({ view: { t: "chat", id: 4 }, drafts: { "4": "héllo", "0": "new", x: "no" }, draft_repo: 2, draft_main: true });
  expect(s?.view).toEqual({ t: "chat", id: 4 });
  expect(s?.composers.get(4)).toEqual(entry("héllo"));
  expect(s?.composers.get(0)?.text).toBe("new");
  expect(s?.composers.size).toBe(2);
  expect(s?.draftRepo).toBe(2);
  expect(s?.draftMain).toBe(true);
  expect(s?.page).toBeNull();
  expect(s?.panes).toBeNull();
  // No time in it: written right before this process started.
  expect(fresh(s as UiSnapshot, Date.now())).toBe(true);
});

test("a snapshot goes through JSON and back whole", () => {
  const snap: UiSnapshot = {
    at: 1000,
    view: { t: "chat", id: 7 },
    draftRepo: null,
    draftMain: false,
    composers: new Map([
      [7, { text: "see [Image #1] and", cursor: 4, mentions: [{ kind: "message", chat: 3 }], files: ["/tmp/a.png"], picked: ["@file.ts"] }],
      [0, entry("a new chat")],
    ]),
    sel: { account: "claude", model: "m", effort: "high", access: "full", device: "" },
    draftWt: { on: true, base: "main" },
    draftHere: [3],
    draftPicked: [[3, "pc#mac"]],
    page: { kind: "settings", tab: "devices", search: "dev", scroll: -320, fields: { "dev-host": "box.local" } },
    pageBack: 7,
    transcript: { chat: 7, limit: 30, follow: false, fromEnd: 1400, groups: [5], cards: [9] },
    sideQuery: "harb",
    sideScroll: -180,
    panes: { right: { open: true, active: 1, tabs: [{ kind: "devices" }, { kind: "browser", url: "localhost:3000" }] }, bottom: { open: false, active: 0, tabs: [{ kind: "shell", title: "wt", cwd: "/tmp" }] }, max: "right" },
    dialog: { kind: "rename-chat", id: 7, input: "A better tit" },
    revs: [[7, 1234]],
  };
  const back = parseSnapshot(JSON.parse(JSON.stringify(snapshotJson(snap))) as Record<string, unknown>);
  expect(back).toEqual(snap);
  // An older Harbor started after this one still finds the drafts' text.
  expect(snapshotJson(snap).drafts).toEqual({ "7": "see [Image #1] and", "0": "a new chat" });
});

test("junk in a snapshot is dropped, not trusted", () => {
  const s = parseSnapshot({ at: 5, view: { t: "chat", id: "7" }, composers: { "1": { text: 3 }, x: { text: "a" }, "2": "plain" }, panes: { right: { open: true, active: 9, tabs: [{ kind: "shell" }, { kind: "browser", url: "" }, { kind: "nope" }, { kind: "files", device: "pc#a" }] }, bottom: null, max: "left" }, page: { kind: "settings" }, transcript: { chat: 1.5 }, dialog: { kind: "rename-chat" } });
  expect(s?.view).toEqual({ t: "draft" });
  expect(s?.composers.get(1)).toEqual(entry(""));
  expect(s?.composers.get(2)).toEqual(entry("plain"));
  expect(s?.composers.has(Number.NaN)).toBe(false);
  expect(s?.panes?.right).toEqual({ open: true, active: 0, tabs: [{ kind: "files", device: "pc#a", path: "~" }] });
  expect(s?.panes?.bottom).toEqual({ open: false, active: 0, tabs: [] });
  expect(s?.panes?.max).toBeNull();
  expect(s?.page).toEqual({ kind: "settings", tab: "general", search: "", scroll: 0, fields: {} });
  expect(s?.transcript).toBeNull();
  expect(s?.dialog).toBeNull();
  expect(parseSnapshot(null)).toBeNull();
});

test("a snapshot too old (a restart that didn't happen then) only gives its drafts back", () => {
  const s = parseSnapshot({ at: 1_000_000, view: { t: "draft" } }) as UiSnapshot;
  expect(fresh(s, 1_000_000 + 5_000)).toBe(true);
  expect(fresh(s, 1_000_000 + SNAPSHOT_FRESH_MS + 1)).toBe(false);
});

test("the crash store keeps the new chat's and other PCs' composers whole, only the cursor of this PC's own chats", () => {
  const all = new Map([
    [0, entry("draft text", 3)],
    [5, { ...entry("own chat text", 2), picked: ["@a.ts"] }],
    [6, entry("a copy's text")],
    [8, entry("")],
  ]);
  const json = JSON.stringify(keptJson(all, (k) => k === 5 || k === 8));
  expect(json).not.toContain("own chat text");
  const kept = parseKept(json);
  expect(kept.full.get(0)).toEqual(entry("draft text", 3));
  expect(kept.full.get(6)).toEqual(entry("a copy's text"));
  expect(kept.full.has(5)).toBe(false);
  expect(kept.cursors.get(5)).toBe(2);
  expect(kept.picked.get(5)).toEqual(["@a.ts"]);
  expect(kept.cursors.has(8)).toBe(false);
  expect(parseKept("not json").full.size).toBe(0);
  expect(parseKept(null).cursors.size).toBe(0);
});

test("a cursor past the text's end comes back at the end", () => {
  const kept = parseKept(JSON.stringify({ full: { "0": { text: "ab", cursor: 99 } } }));
  expect(kept.full.get(0)?.cursor).toBe(2);
});

test("edits in a burst are written once, after the last; flush writes a pending one now", async () => {
  let runs = 0;
  const d = new Debounce(20, () => void runs++);
  d.poke();
  d.poke();
  d.poke();
  expect(runs).toBe(0);
  await Bun.sleep(40);
  expect(runs).toBe(1);
  d.poke();
  expect(d.pending).toBe(true);
  d.flush();
  expect(runs).toBe(2);
  expect(d.pending).toBe(false);
  d.flush();
  expect(runs).toBe(2);
});

test("Settings fields get back what was typed in them, never into a password field", () => {
  const form = { kind: "form", key: "add-device", fields: [field("host", "Host"), field("pass", "Password", { password: true })], rows: [] } as unknown as Block;
  const rows = { kind: "rows", key: "r", fields: [], rows: [row("Name", { key: "name", control: "input", text: "old" }), row("Key", { key: "k", edit: [{ kind: "field", label: "", fields: [field("label", "Label")], buttons: [], toggles: [], text: "" }, { kind: "replace", label: "", fields: [field("secret", "")], buttons: [], toggles: [], text: "" }] })] } as unknown as Block;
  const typed = new Map([
    ["host", "box.local"],
    ["pass", "hunter2"],
    ["name", "renamed"],
    ["label", "my label"],
    ["secret", "s3cret"],
  ]);
  const [f, r] = filledBlocks([form, rows], typed);
  expect(f?.fields.map((x) => x.text)).toEqual(["box.local", ""]);
  expect(r?.rows[0]?.text).toBe("renamed");
  expect(r?.rows[1]?.edit[0]?.fields[0]?.text).toBe("my label");
  expect(r?.rows[1]?.edit[1]?.fields[0]?.text).toBe("");
  expect(filledBlocks([form], new Map())[0]).toBe(form);
});
