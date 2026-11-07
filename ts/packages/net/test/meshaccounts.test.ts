import { describe, expect, test } from "bun:test";
import {
  accountsByPc,
  helloAccounts,
  identOf,
  initials,
  isSharedId,
  type LocalAccount,
  type MeshAccount,
  meshAccountJson,
  meshAccounts,
  personBadges,
  personOfEmail,
  sharedAccess,
  sharedAccounts,
  sharedTarget,
  sharedWith,
} from "../src/meshaccounts.ts";
import { meshPcs, peopleNote } from "../src/meshctx.ts";
import { MemKv } from "../src/kv.ts";
import { newPeer, type Peer } from "../src/shared.ts";

const MARA = "mlx99@example.com";
const DANA = "dr.danareyes@example.com";
const DARIO = "dr.darioreis@example.com";

const local = (id: string, kind: string, email: string, badge: string, usable = true): LocalAccount => ({ id, kind, email, badge, short: kind === "Claude" ? `Claude · ${badge}` : kind, usable });
const told = (id: string, kind: string, email: string, p: Partial<MeshAccount> = {}): MeshAccount => ({ id, short: id, kind, ident: identOf(kind, email), person: "", main: id === kind, models: [], ...p });
const peer = (id: string, name: string, owner: string, online: boolean, provs: MeshAccount[]): Peer => newPeer({ id, name, owner, online, provs, accounts: provs.map((a) => [a.id, a.short, a.kind]) });

describe("who an account is", () => {
  test("a sign-in's identity is a hash of provider and email: the same anywhere, never the email", () => {
    expect(identOf("claude", "Dr.DanaReyes@Example.com ")).toBe(identOf("claude", DANA));
    expect(identOf("claude", DANA)).not.toBe(identOf("claude", DARIO));
    expect(identOf("codex", DANA)).not.toBe(identOf("claude", DANA));
    expect(identOf("claude", DANA)).not.toContain("dana");
    expect(identOf("opencode", "")).toBe("");
  });

  test("an email names the person whose name or GitHub login is in it; two equally good ones name nobody", () => {
    const people = [
      { name: "Mara Lind", github: "mlind" },
      { name: "Dana Reyes", github: "danareyes" },
      { name: "Dario Reis", github: "" },
    ];
    expect(personOfEmail(DANA, people)).toBe("Dana Reyes");
    expect(personOfEmail(DARIO, people)).toBe("Dario Reis");
    expect(personOfEmail("mlind@example.com", people)).toBe("Mara Lind");
    // "mlx99" holds neither "maralind" nor "mlind".
    expect(personOfEmail(MARA, people)).toBe("");
    expect(personOfEmail("sales@example.com", people)).toBe("");
    expect(personOfEmail("x@y", [{ name: "Ana Li", github: "" }, { name: "Ana Li", github: "" }])).toBe("");
  });

  test("badges are the owner's initials; two people with the same ones are told apart the same way on every PC", () => {
    expect(initials("Mara Lind")).toBe("ML");
    expect(initials("Dana  de Reyes")).toBe("DR");
    expect(initials("Mononym")).toBe("MO");
    expect(initials("")).toBe("");
    const b = personBadges(["Dario Reis", "Mara Lind", "Dana Reyes", ""]);
    expect(Object.fromEntries(b)).toEqual({ "Dana Reyes": "DR", "Dario Reis": "DaR", "Mara Lind": "ML" });
    // The order they come in doesn't matter.
    expect(Object.fromEntries(personBadges(["Dana Reyes", "Dario Reis"]))).toEqual(Object.fromEntries(personBadges(["Dario Reis", "Dana Reyes"])));
    expect(Object.fromEntries(personBadges(["Ana Silva", "Ana Souza"]))).toEqual({ "Ana Silva": "AS", "Ana Souza": "AnS" });
    // Nothing more in the first name: a number.
    expect(Object.fromEntries(personBadges(["A Bo", "A B"]))).toEqual({ "A B": "AB", "A Bo": "AB2" });
  });
});

describe("hello's accounts", () => {
  test("old [id, short, kind] lists and new objects both read; junk is dropped", () => {
    expect(meshAccounts([["claude", "Claude · MX", "Claude"], ["", "x", "y"], 3])).toEqual([{ id: "claude", short: "Claude · MX", kind: "claude", ident: "", person: "", main: false, models: [] }]);
    const a = told("opencode", "opencode", "", { models: [["nvidia/z-ai/glm-5.3-flash", "GLM 5.3 Flash"]], main: true });
    expect(meshAccounts([meshAccountJson(a)])).toEqual([a]);
    expect(meshAccounts({})).toEqual([]);
  });

  test("this PC tells each sign-in once, who it is when the email says, and which is its main one", () => {
    const people = [{ name: "Dana Reyes", github: "" }];
    const v = helloAccounts([local("claude", "Claude", DANA, "DR"), local("claude2", "Claude", DANA, "DR"), local("claude3", "Claude", MARA, "MX"), local("codex", "Codex", "", "", false), local("opencode", "OpenCode", "", "")], people);
    expect(v.map((a) => [a.id, a.person, a.main])).toEqual([
      ["claude", "Dana Reyes", true],
      ["claude3", "", false],
      ["opencode", "", true],
    ]);
    // No email in it, only its hash.
    expect(JSON.stringify(v)).not.toContain("danareyes");
  });
});

describe("the mesh's accounts, each once", () => {
  const me = { id: "ts:desk", name: "desk", owner: "Mara Lind", github: "mlind" };
  const mine = [local("claude", "Claude", MARA, "MX"), local("claude2", "Claude", DANA, "DR"), local("claude3", "Claude", DARIO, "DR"), local("opencode", "OpenCode", "", "")];
  const laptopPc = peer("ts:laptop", "laptop", "Dana Reyes", true, [told("claude", "claude", DANA), told("opencode", "opencode", "", { models: [["opencode/big", "Big"]] })]);
  const towerPc = peer("ts:tower", "tower", "Dario Reis", false, [told("claude", "claude", DARIO), told("codex", "codex", "")]);
  const list = () => sharedAccounts({ me, local: mine, peers: [towerPc, laptopPc], provs: new Map([laptopPc, towerPc].map((p) => [p.id, p.provs])) });

  test("a sign-in this PC has too is this PC's; every badge is its owner's, the two DR logins apart", () => {
    const v = list();
    expect(v.map((s) => [s.label, s.pc, s.account, s.person])).toEqual([
      ["Claude · ML", "", "claude", "Mara Lind"],
      ["Claude · DR", "", "claude2", "Dana Reyes"],
      ["Claude · DaR", "", "claude3", "Dario Reis"],
      ["OpenCode · ML", "", "opencode", "Mara Lind"],
      ["OpenCode · DR", "ts:laptop", "opencode", "Dana Reyes"],
      ["Codex · DaR", "ts:tower", "codex", "Dario Reis"],
    ]);
    const dana = v[1]!;
    expect(dana.also).toEqual(["laptop"]);
    expect(dana.id).toBe("claude2");
    // Another PC's: picked by key, runs there, its own models.
    const oc = v[4]!;
    expect(isSharedId(oc.id)).toBe(true);
    expect(oc.models).toEqual([["opencode/big", "Big"]]);
    expect(sharedTarget(v, oc.id)).toEqual({ pc: "ts:laptop", account: "opencode", kind: "opencode", label: "OpenCode · DR", why: "" });
    // An off PC's shows, with why it can't be picked.
    expect(v[5]!.why).toBe("tower is offline");
    expect(sharedTarget(v, "claude2")).toMatchObject({ pc: "", account: "claude2", why: "" });
    expect(sharedTarget(v, "nope")).toBeNull();
  });

  test("the same on another PC: its own first, then this one's, one entry per sign-in", () => {
    const meLaptop = { id: "ts:laptop", name: "laptop", owner: "Dana Reyes", github: "danareyes" };
    const deskPc = peer("ts:desk", "desk", "Mara Lind", true, helloAccounts(mine, [{ name: "Mara Lind", github: "mlind" }, { name: "Dana Reyes", github: "danareyes" }, { name: "Dario Reis", github: "" }]));
    const v = sharedAccounts({ me: meLaptop, local: [local("claude", "Claude", DANA, "DR"), local("opencode", "OpenCode", "", "")], peers: [deskPc, towerPc], provs: new Map([deskPc, towerPc].map((p) => [p.id, p.provs])) });
    expect(v.map((s) => [s.label, s.pc])).toEqual([
      ["Claude · DR", ""],
      ["OpenCode · DR", ""],
      ["Claude · ML", "ts:desk"],
      ["Claude · DaR", "ts:desk"],
      ["OpenCode · ML", "ts:desk"],
      ["Codex · DaR", "ts:tower"],
    ]);
    // Dario's login is on the desk (on) and the tower (off): the desk runs it.
    expect(v[3]!.also).toEqual(["tower"]);
  });

  test("a sign-in on two other PCs runs on the first by id that is on, the same pick on every PC", () => {
    const a = peer("ts:a", "A", "Ana Li", false, [told("claude", "claude", "ana@example.com")]);
    const b = peer("ts:b", "B", "Ana Li", true, [told("claude2", "claude", "ana@example.com")]);
    const c = peer("ts:c", "C", "Ana Li", true, [told("claude", "claude", "ana@example.com")]);
    const run = (peers: Peer[]) => sharedAccounts({ me: { id: "ts:z", name: "Z", owner: "Zoe Q", github: "" }, local: [], peers, provs: new Map(peers.map((p) => [p.id, p.provs])) });
    const v = run([c, b, a]);
    expect(v.length).toBe(1);
    expect([v[0]!.pc, v[0]!.account, v[0]!.why]).toEqual(["ts:b", "claude2", ""]);
    // All off: the first, greyed.
    const off = run([{ ...b, online: false }, a]);
    expect([off[0]!.pc, off[0]!.why]).toEqual(["ts:a", "A is offline"]);
    // The key picks it wherever it runs now.
    expect(sharedTarget(v, off[0]!.id)?.pc).toBe("ts:b");
  });

  test("an older PC that says only [id, short, kind] still shares its accounts, as its own CLI each", () => {
    const old = newPeer({ id: "ts:old", name: "Old", owner: "Olga Ma", online: true, accounts: [["claude", "Claude · OM", "claude"], ["codex", "Codex", "codex"]] });
    const v = sharedAccounts({ me, local: [], peers: [old], provs: new Map() });
    expect(v.map((s) => [s.label, s.id])).toEqual([
      ["Claude · OM", "claude@ts:old/claude"],
      ["Codex · OM", "codex@ts:old/codex"],
    ]);
  });

  test("alone, the accounts keep their own badges, and two that read the same are numbered", () => {
    const v = sharedAccounts({ me, local: mine, peers: [], provs: new Map() });
    expect(v.map((s) => s.label)).toEqual(["Claude · MX", "Claude · DR", "Claude · DR2", "OpenCode"]);
  });

  test("the who is who lists each account once, under the PC that runs it, and each phone once", () => {
    const kv = new MemKv();
    const owners = { accountOwnerName: () => "Mara Lind", signedIn: () => false, fullName: () => "", githubUser: () => null };
    const pcs = meshPcs({
      kv,
      owners,
      me: { id: me.id, name: me.name },
      hostname: "desk",
      meshOn: true,
      localPhones: [
        { name: "Pixel 9", app: 0 },
        { name: "Dana's Galaxy", app: 0 },
        { name: "Pixel 9", app: 0 },
        { name: "Dana's Galaxy", app: 0 },
      ],
      versions: [],
      accounts: ["Claude · MX", "Claude · DR", "Claude · DR"],
      byPc: accountsByPc(list()),
      hosts: [laptopPc, towerPc],
      elsewhere: new Map(),
    });
    expect(pcs[0]!.phones).toEqual(["Pixel 9", "Dana's Galaxy"]);
    expect(pcs[0]!.accounts).toEqual(["Claude · ML (Mara Lind)", "Claude · DR (Dana Reyes)", "Claude · DaR (Dario Reis)", "OpenCode · ML (Mara Lind)"]);
    expect(pcs[1]!.accounts).toEqual(["OpenCode · DR (Dana Reyes)"]);
    const note = peopleNote(pcs);
    expect(note.match(/Pixel 9/g)?.length).toBe(1);
    expect(note.match(/Claude · DR \(Dana Reyes\)/g)?.length).toBe(1);
    expect(note).toContain("tower (offline): owner Dario Reis; agent accounts: Codex · DaR (Dario Reis)");
  });
});

describe("what another PC's chat may do on this PC's accounts", () => {
  const all = ["full", "edits", "plan"];
  test("it gets at most what this PC shares with that PC", () => {
    const who = { me: "desk", kind: "claude" };
    expect(sharedAccess("full", "full", all, who)).toEqual({ access: "full" });
    expect(sharedAccess("edit", "full", all, who)).toEqual({ access: "edits" });
    expect(sharedAccess("edit", "plan", all, who)).toEqual({ access: "plan" });
    expect(sharedAccess("read", "full", all, who)).toEqual({ access: "plan" });
    expect(sharedAccess("off", "plan", all, who)).toMatchObject({ why: expect.stringContaining("doesn't share its accounts") });
    // OpenCode can't be held to less than full access: refused below full.
    expect(sharedAccess("read", "full", ["full"], { me: "desk", kind: "opencode" })).toEqual({ why: "desk lets this PC's chats only read there, and OpenCode runs with full access only" });
  });

  test("hello offers only the kinds that can run within it", () => {
    expect(sharedWith("full", ["full"])).toBe(true);
    expect(sharedWith("edit", ["full"])).toBe(false);
    expect(sharedWith("read", all)).toBe(true);
    expect(sharedWith("off", all)).toBe(false);
  });
});

test("an account its PC doesn't let this PC use is left out of the picker, still read from hello", () => {
  const a = { ...told("claude", "claude", "kim@example.com"), shared: false };
  expect(meshAccounts([meshAccountJson(a)])).toEqual([a]);
  const p = peer("ts:k", "K", "Kim Ro", true, [a, told("codex", "codex", "")]);
  const v = sharedAccounts({ me: { id: "ts:z", name: "Z", owner: "Zoe Q", github: "" }, local: [], peers: [p], provs: new Map([[p.id, p.provs]]) });
  expect(v.map((s) => s.label)).toEqual(["Codex · KR"]);
});
