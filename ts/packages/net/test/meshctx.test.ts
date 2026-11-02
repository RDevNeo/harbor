import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MemKv } from "../src/kv.ts";
import {
  GITHUB_KEY,
  OWNER_KEY,
  aboutOwner,
  acceptMemory,
  adoptCtx,
  apiPeople,
  apiPeopleSet,
  applyCtx,
  confirmOwner,
  ctxAfterTurn,
  cutBytes,
  githubOf,
  issuedIds,
  loadGuests,
  memNameOk,
  memoryChanges,
  memoryDir,
  newPc,
  outgoingCtx,
  overlay,
  overlays,
  ownerConfirmed,
  ownerOf,
  peopleNote,
  peoplePcLine,
  pick,
  pushMemory,
  readMemory,
  settingsOf,
  type CtxEnv,
  type Guest,
  type OwnerSources,
} from "../src/meshctx.ts";
import { PROFILE_KEY, newProfileDetected, newProfileProposal, profileDetectedText } from "../src/profile.ts";
import type { Dest } from "../src/shared.ts";
import { wire } from "../src/wire.ts";

function temp(): string {
  return mkdtempSync(join(tmpdir(), "ctx-"));
}

const NO_OWNER: OwnerSources = { accountOwnerName: () => null, signedIn: () => false, fullName: () => "gecos", githubUser: () => null };
const NOWHERE: Dest = { addr: "127.0.0.1:1", fp: "" };

describe("meshctx", () => {
  test("memory_names_and_settings", () => {
    expect(memNameOk("MEMORY.md") && memNameOk("user_role.md")).toBe(true);
    expect(cutBytes("aé", 2)).toBe("a");
    expect(memNameOk("../x.md") || memNameOk("a/b.md") || memNameOk(".hidden.md") || memNameOk("x.sh")).toBe(false);
    const s = settingsOf({ language: "en", hooks: { Stop: [] }, env: { X: "1" }, permissions: {} });
    expect(s).toEqual({ language: "en" });
  });

  test("typed_beats_detected", () => {
    expect(pick(" Sam ", "Samuel", () => "gecos")).toBe("Sam");
    expect(pick("  ", "Samuel", () => "gecos")).toBe("Samuel");
    expect(pick(null, "", () => "gecos")).toBe("gecos");
    const kv = new MemKv();
    const d = newProfileDetected({ me: newProfileProposal({ owner: "Samuel Lee", github: "samlee" }) });
    kv.set(PROFILE_KEY, profileDetectedText(d));
    expect([ownerOf(kv, NO_OWNER), githubOf(kv, NO_OWNER)]).toEqual(["Samuel Lee", "samlee"]);
    expect(aboutOwner(kv, NO_OWNER).owner_suggested).toBe(true);
    // The user typed a GitHub login: it stays; Confirm fills only the empty name.
    kv.set(GITHUB_KEY, "@sam-gh");
    expect(githubOf(kv, NO_OWNER)).toBe("sam-gh");
    confirmOwner(kv, NO_OWNER);
    expect([kv.get(OWNER_KEY), kv.get(GITHUB_KEY)]).toEqual(["Samuel Lee", "@sam-gh"]);
    expect(ownerConfirmed(kv, NO_OWNER) && !aboutOwner(kv, NO_OWNER).owner_suggested).toBe(true);
    // A later detection never overwrites what the user has.
    const d2 = newProfileDetected({ me: newProfileProposal({ owner: "Someone Else", github: "else" }) });
    kv.set(PROFILE_KEY, profileDetectedText(d2));
    confirmOwner(kv, NO_OWNER);
    expect([ownerOf(kv, NO_OWNER), githubOf(kv, NO_OWNER)]).toEqual(["Samuel Lee", "sam-gh"]);
  });

  test("people_note_lists_pcs", () => {
    expect(peopleNote([newPc({ name: "desk", me: true })])).toBe("");
    const n = peopleNote([
      newPc({ name: "desk", me: true, online: true, owner: "Sam", github: "sam-gh", phones: ["Pixel", "Tab"], harbor: "0.66.0 (latest)", phone_apps: new Map([["Pixel", "app 0.66.0"]]) }),
      newPc({ name: "laptop", owner: "Alex" }),
    ]);
    expect(n).toContain("- desk (this PC, where you run): owner Sam; GitHub sam-gh; Harbor 0.66.0 (latest); phones: Pixel (app 0.66.0), Tab");
    expect(n).toContain("- laptop (offline): owner Alex");
    const g = newPc({ name: "lap", owner: "Alex", suggested: true, guessed: true });
    expect(peoplePcLine(g)).toBe("Alex (guessed here, not confirmed) · offline");
  });

  test("overlay_round_trip", () => {
    const dataDir = temp();
    const cwd = temp();
    const env = { dataDir };
    const peer = "pc:test-1a2b";
    const ctx = {
      v: 1,
      instructions: "Answer in English.",
      memory: { "MEMORY.md": "- [a](a.md)\n", "a.md": "A", "../evil.md": "x" },
      memory_id: "m1",
      settings: { language: "en", hooks: {} },
      owner: "Sam",
    };
    try {
      const g = applyCtx(env, peer, "laptop", ctx, cwd);
      expect([g.owner, g.memory_id, g.off]).toEqual(["Sam", "m1", false]);
      const o = overlay(env, peer);
      expect(readFileSync(join(o, "CLAUDE.md"), "utf8")).toBe("Answer in English.");
      expect(readFileSync(join(o, "settings.json"), "utf8")).toBe('{"language":"en"}');
      const mem = memoryDir(o, cwd);
      expect(readMemory(mem).size).toBe(2);
      // The agent saves a memory and drops one: those are the changes.
      writeFileSync(join(mem, "b.md"), "B");
      rmSync(join(mem, "a.md"));
      expect(wire(Object.fromEntries(memoryChanges(env, g, cwd)))).toBe('{"a.md":null,"b.md":"B"}');
      // Not sent yet: the next ctx keeps them.
      const stateFile = join(dirname(mem), "harbor-memory.json");
      expect(readFileSync(stateFile, "utf8")).toContain('"pending":false');
      writeFileSync(stateFile, readFileSync(stateFile, "utf8").replace('"pending":false', '"pending":true'));
      applyCtx(env, peer, "laptop", ctx, cwd);
      expect(readFileSync(join(mem, "b.md"), "utf8")).toBe("B");
      expect(existsSync(join(mem, "a.md"))).toBe(true);
      // Sent: the next ctx is the truth.
      writeFileSync(stateFile, readFileSync(stateFile, "utf8").replace('"pending":true', '"pending":false'));
      const off = applyCtx(env, peer, "laptop", { v: 1, off: true }, cwd);
      expect(off.off && !existsSync(join(o, "CLAUDE.md")) && readMemory(mem).size === 0).toBe(true);
      expect(overlays(env)).toEqual([o]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("meshctx beyond the Rust tests", () => {
  test("outgoing ctx registers the memory folder and accept_memory writes only there", () => {
    const home = temp();
    const kv = new MemKv();
    const env: CtxEnv = { home, dataDir: join(home, "data"), hostname: "desk" };
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "CLAUDE.md"), "Be brief.");
      writeFileSync(join(home, ".claude", "settings.json"), '{"language":"pt","hooks":{"Stop":[]}}');
      const dir = memoryDir(join(home, ".claude"), home);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "MEMORY.md"), "- x");
      const c = outgoingCtx(kv, env, NO_OWNER, null, 1000) as Record<string, unknown>;
      expect(c.instructions).toBe("Be brief.");
      expect(c.settings).toEqual({ language: "pt" });
      expect(c.memory).toEqual({ "MEMORY.md": "- x" });
      const id = c.memory_id as string;
      expect(id).toMatch(/^[0-9a-f]{24}$/);
      expect((outgoingCtx(kv, env, NO_OWNER, null, 1001) as Record<string, unknown>).memory_id).toBe(id);
      expect(issuedIds(kv, 1002).has(id)).toBe(true);
      expect(issuedIds(kv, 1000 + 31 * 86400).has(id)).toBe(false);
      expect(acceptMemory(kv, { id: "nope", files: {} }, 1002)).toEqual({ ok: false, error: "no such memory here" });
      expect(acceptMemory(kv, { id }, 1002)).toEqual({ ok: false, error: "files is required" });
      expect(acceptMemory(kv, { id, files: { "a.md": "A", "../x.md": "bad", "MEMORY.md": null } }, 1002)).toEqual({ ok: true, value: 2 });
      expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("A");
      expect(existsSync(join(dir, "MEMORY.md"))).toBe(false);
      kv.set(OWNER_KEY, "Sam");
      kv.set("ctx_send", "0");
      expect(outgoingCtx(kv, env, NO_OWNER, null)).toEqual({ v: 1, off: true, owner: "Sam", github: "" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("guests, adoptCtx and push", async () => {
    const dataDir = temp();
    const cwd = temp();
    const env = { dataDir };
    const kv = new MemKv();
    const guests = new Map<number, Guest>();
    try {
      const call = { peer: "pc:a", name: "laptop", ctx: { v: 1, instructions: "x", memory_id: "m1", owner: "Sam" } };
      expect(adoptCtx({ kv, env, guests, chatId: 7, cwd, call, me: "desk" })).toBe("Runs with the instructions and memory of Sam (laptop)");
      expect(adoptCtx({ kv, env, guests, chatId: 7, cwd, call, me: "desk" })).toBeNull();
      expect(loadGuests(kv).get(7)?.memory_id).toBe("m1");
      const g = guests.get(7) as Guest;
      const mem = memoryDir(overlay(env, "pc:a"), cwd);
      writeFileSync(join(mem, "n.md"), "N");
      const sent: unknown[] = [];
      await pushMemory(env, NOWHERE, g, cwd, async (_d, body) => {
        sent.push(body);
        return 500;
      });
      expect(memoryChanges(env, g, cwd).get("n.md")).toBe("N");
      await ctxAfterTurn({
        env,
        guest: g,
        device: "",
        peer: () => ({ online: true, dest: NOWHERE }),
        cwd,
        send: async (_d, body) => {
          sent.push(body);
          return 200;
        },
      });
      expect(sent.length).toBe(2);
      expect(memoryChanges(env, g, cwd).size).toBe(0);
      expect(adoptCtx({ kv, env, guests, chatId: 7, cwd, call: null, me: "desk" })).toBe("Runs with desk's own instructions and memory again");
      expect(loadGuests(kv).size).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("people api", () => {
    const kv = new MemKv();
    const calls: string[] = [];
    apiPeopleSet(kv, { op: "confirm", owner: "Sam", send_context: false, share: { pc: "p1", level: "all" } }, {
      confirm: () => calls.push("confirm"),
      detect: () => calls.push("detect"),
      hasPeer: (id) => id === "p1",
      setShare: (pc, l) => calls.push(`share ${pc} ${l}`),
      levelOk: (l) => l === "all",
      setShareGithub: () => calls.push("gh"),
      republish: () => calls.push("republish"),
    });
    expect(calls).toEqual(["confirm", "share p1 all", "republish"]);
    expect([kv.get(OWNER_KEY), kv.get("ctx_send")]).toEqual(["Sam", "0"]);
    const out = wire(
      apiPeople(kv, NO_OWNER, {
        pcs: [newPc({ id: "a", name: "desk", me: true }), newPc({ id: "b", name: "lap" })],
        share: () => ({ slug: "all", label: "Everything" }),
        levels: [],
        detecting: false,
        check: null,
        shareGithub: false,
      }),
    );
    expect(out).toContain('"share":"all","share_label":"Everything"');
    expect(out).toContain('"send_context":false');
  });
});
