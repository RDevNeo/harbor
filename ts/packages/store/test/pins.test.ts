import { expect, test } from "bun:test";
import { accountIdent, chatPinKey, governing, parsePin, type Pin, pinJson, pinOf, Pins, pinTrouble, pinValue, projectKey, projectPinKey, projectPinned, resolvePin } from "../src/pins.ts";
import { classOf } from "../src/settingsync.ts";
import { blankChat, Store } from "../src/index.ts";

const ig = { id: "claude2", kind: "Claude", email: "ig@example.com", loggedIn: true, short: "Claude · IG" };
const fs = { id: "claude3", kind: "Claude", email: "fs@example.com", loggedIn: true, short: "Claude · FS" };
const codex = { id: "codex", kind: "Codex", email: "", loggedIn: true, short: "Codex" };

test("a pin round-trips through its kv value, and junk reads as no pin", () => {
  const p = pinOf(ig);
  expect(p).toEqual({ account: "claude2", kind: "claude", ident: accountIdent("claude", "ig@example.com"), label: "Claude · IG" });
  expect(parsePin(pinValue(p))).toEqual(p);
  expect(pinValue(null)).toBe("");
  for (const v of [null, "", "{", "[]", '{"account":""}', '{"account":3}']) expect(parsePin(v)).toBeNull();
});

test("pins are account settings: they sync to the user's other PCs", () => {
  expect(classOf(chatPinKey("g-1"))).toBe("account");
  expect(classOf(projectPinKey("git:github.com/o/r"))).toBe("account");
});

test("a project's key is its Git remote however it's written, else its name", () => {
  const k = projectKey({ remote: "git@github.com:Owner/Repo.git", name: "repo" });
  expect(k).toBe("git:github.com/owner/repo");
  expect(projectKey({ remote: "https://github.com/owner/repo/", name: "x" })).toBe(k);
  expect(projectKey({ remote: "ssh://git@github.com/owner/repo.git", name: "y" })).toBe(k);
  expect(projectKey({ remote: "", name: " notes " })).toBe("name:notes");
});

test("another PC resolves a pin by its sign-in first, then by the same id of the same provider", () => {
  const p = pinOf(ig);
  // The same sign-in has another id there.
  expect(resolvePin(p, [{ ...fs }, { ...ig, id: "claude5" }])?.id).toBe("claude5");
  // No sign-in known for it there: the same id and provider.
  expect(resolvePin(p, [{ ...ig, email: "" }])?.id).toBe("claude2");
  // The id there is another provider's: not it.
  expect(resolvePin({ ...p, ident: "" }, [{ ...codex, id: "claude2" }])).toBeUndefined();
  // Neither: missing here.
  expect(resolvePin(p, [fs, codex])).toBeUndefined();
});

test("what's wrong with a pinned account: missing, not installed, turned off, signed out", () => {
  expect(pinTrouble(undefined)).toBe("isn't on this PC");
  expect(pinTrouble({ ...ig, bin: null })).toBe("isn't installed on this PC");
  expect(pinTrouble({ ...ig, off: true })).toBe("is turned off in Settings › Providers");
  expect(pinTrouble({ ...ig, loggedIn: false })).toBe("is signed out");
  expect(pinTrouble({ ...ig, bin: "/x" })).toBe("");
});

test("a chat's own pin wins over its project's; a project's covers new chats and started ones of its provider", () => {
  const chatPin = pinOf(fs);
  const projectPin = pinOf(ig);
  const kindOf = (id: string) => [ig, fs, codex].find((a) => a.id === id)?.kind;
  const c = blankChat({ gid: "g", account: "claude3", started: true });
  expect(governing(c, chatPin, projectPin, kindOf)).toEqual({ pin: chatPin, scope: "chat" });
  expect(governing(c, null, projectPin, kindOf)).toEqual({ pin: projectPin, scope: "project" });
  // A started Codex chat isn't handed to Claude because its project got pinned; a new one is.
  expect(governing({ ...c, account: "codex" }, null, projectPin, kindOf)).toBeNull();
  expect(governing({ ...c, account: "codex", started: false }, null, projectPin, kindOf)?.scope).toBe("project");
  expect(governing(c, null, null, kindOf)).toBeNull();
});

test("Pins in kv: set, read, resolve, unpin; a pick by hand moves the pin and the project's becomes the chat's own", () => {
  const store = Store.openTemp();
  const p = new Pins(store);
  const repo = { remote: "https://github.com/o/r", name: "r" };
  const chat = blankChat({ gid: "g1", account: "claude2" });
  const accounts = [ig, fs, codex];
  expect(p.of(chat, repo, accounts)).toBeNull();
  p.setProject(repo, pinOf(ig));
  expect(store.get(projectPinKey("git:github.com/o/r"))).toBe(pinValue(pinOf(ig)));
  expect(p.of(chat, repo, accounts)).toEqual({ pin: pinOf(ig), scope: "project", account: "claude2", why: "" });
  // The chat's own pin wins.
  p.setChat("g1", pinOf(fs));
  expect(p.of(chat, repo, accounts)?.account).toBe("claude3");
  // A pick of the pinned account is no change; another moves the pin.
  expect(p.followPick(chat, repo, fs, accounts)).toBe(false);
  expect(p.followPick(chat, repo, codex, accounts)).toBe(true);
  expect(p.chat("g1")?.account).toBe("codex");
  // Governed by its project only: a pick by hand pins the chat itself.
  p.setChat("g1", null);
  expect(store.get(chatPinKey("g1"))).toBe("");
  expect(p.followPick(chat, repo, fs, accounts)).toBe(true);
  expect(p.of(chat, repo, accounts)).toMatchObject({ scope: "chat", account: "claude3" });
  // Not pinned at all: a pick pins nothing.
  const free = blankChat({ gid: "g2", account: "claude2" });
  expect(p.followPick(free, null, fs, accounts)).toBe(false);
  expect(p.chat("g2")).toBeNull();
  // The pinned account signed out: still pinned, with why (nothing moves it).
  p.setChat("g1", pinOf(ig));
  expect(p.of(chat, repo, [{ ...ig, loggedIn: false }, fs])).toMatchObject({ account: "claude2", why: "is signed out" });
  expect(p.of(chat, repo, [fs])).toMatchObject({ account: null, why: "isn't on this PC" });
  store.close();
});

test("the phone's pin JSON names the account as this PC does and says what's wrong", () => {
  const p: Pin = pinOf(ig);
  expect(pinJson({ pin: p, scope: "chat", account: "claude2", why: "" }, () => "Claude · IG2")).toEqual({ account: "claude2", label: "Claude · IG2", scope: "chat", why: "", tip: "Pinned to Claude · IG2: Hub won't switch it" });
  expect(pinJson({ pin: p, scope: "project", account: null, why: "isn't on this PC" }, () => undefined)?.tip).toBe("Pinned to Claude · IG (this project's pin), which isn't on this PC: pick another account or unpin");
  expect(pinJson(null, () => "")).toBeNull();
  expect(projectPinned(p, [fs])).toEqual({ pin: p, scope: "project", account: null, why: "isn't on this PC" });
  expect(projectPinned(null, [fs])).toBeNull();
});
