import { describe, expect, test } from "bun:test";
import {
  accountOn,
  chatOwner,
  samePerson,
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
  photoBook,
  photosByName,
  sharedAccess,
  sharedAccounts,
  sharedIdent,
  sharedTarget,
  sharedTip,
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
      // OpenCode is nobody's: one entry, this PC's, the laptop's a copy of it.
      ["OpenCode", "", "opencode", ""],
      ["Codex · DaR", "ts:tower", "codex", "Dario Reis"],
    ]);
    const dana = v[1]!;
    expect(dana.also).toEqual(["laptop"]);
    expect(dana.id).toBe("claude2");
    expect(v[3]!.also).toEqual(["laptop"]);
    // Another PC's: picked by key, runs there.
    const codex = v[4]!;
    expect(isSharedId(codex.id)).toBe(true);
    expect(sharedTarget(v, codex.id)).toEqual({ pc: "ts:tower", account: "codex", kind: "codex", label: "Codex · DaR", why: "tower is offline" });
    // An off PC's shows, with why it can't be picked.
    expect(v[4]!.why).toBe("tower is offline");
    expect(sharedTarget(v, "claude2")).toMatchObject({ pc: "", account: "claude2", why: "" });
    expect(sharedTarget(v, "nope")).toBeNull();
  });

  test("someone else's account marks their chats: on this PC by its id, another PC's copy by that PC's", () => {
    const v = list();
    expect(v.map((s) => [s.account, s.pc, s.others, s.mark])).toEqual([
      ["claude", "", false, "ML"],
      ["claude2", "", true, "DR"],
      ["claude3", "", true, "DaR"],
      ["opencode", "", false, ""],
      ["codex", "ts:tower", true, "DaR"],
    ]);
    expect(chatOwner(v, { home: "", account: "claude" })).toBeNull();
    expect(chatOwner(v, { home: "", account: "claude2" })?.person).toBe("Dana Reyes");
    expect(chatOwner(v, { home: "ts:tower", account: "codex" })?.mark).toBe("DaR");
    expect(chatOwner(v, { home: "ts:tower", account: "claude9" })).toBeNull();
    expect(samePerson("Mara Lind", "mara  lind")).toBe(true);
    expect(samePerson("Mara", "Mara Lind")).toBe(true);
    expect(samePerson("Dana Reyes", "Dario Reyes")).toBe(false);
    expect(samePerson("", "Mara Lind")).toBe(false);
  });

  test("run on another PC, this PC's account is that PC's id for the same sign-in", () => {
    const v = list();
    // Dana's login is claude2 here and claude on the laptop.
    expect(accountOn(v, "claude2", "ts:laptop")).toBe("claude");
    expect(accountOn(v, "claude2", "")).toBe("claude2");
    // Mara's login isn't on the laptop: the id stays.
    expect(accountOn(v, "claude", "ts:laptop")).toBe("claude");
  });

  test("one Codex sign-in on two PCs is one entry", () => {
    const here = sharedAccounts({ me, local: [...mine, local("codex", "Codex", DARIO, "")], peers: [towerPc, laptopPc], provs: new Map([laptopPc, towerPc].map((p) => [p.id, p.provs])) });
    const twin = peer("ts:tower", "tower", "Dario Reis", true, [told("codex", "codex", DARIO)]);
    const both = sharedAccounts({ me, local: [...mine, local("codex", "Codex", DARIO, "")], peers: [twin], provs: new Map([[twin.id, twin.provs]]) });
    expect(both.filter((s) => s.kind === "codex").map((s) => [s.pc, s.also])).toEqual([["", ["tower"]]]);
    // The tower that told no sign-in (an older PC) stays apart.
    expect(here.filter((s) => s.kind === "codex").length).toBe(2);
  });

  test("OpenCode is one entry on the whole mesh, whoever's PCs have it: it has no sign-in", () => {
    const deskTwo = peer("ts:desk2", "desk2", "Mara Lind", true, [told("opencode", "opencode", "")]);
    const v = sharedAccounts({ me, local: mine, peers: [laptopPc, deskTwo], provs: new Map([laptopPc, deskTwo].map((p) => [p.id, p.provs])) });
    // This PC has it: it runs here, the others are copies.
    expect(v.filter((s) => s.kind === "opencode").map((s) => [s.id, s.pc, s.label, s.photo, s.also])).toEqual([["opencode", "", "OpenCode", "", ["desk2", "laptop"]]]);
    // A PC whose owner isn't known is the same OpenCode.
    const nobody = peer("ts:box", "box", "", true, [told("opencode", "opencode", "")]);
    const w = sharedAccounts({ me, local: mine, peers: [nobody], provs: new Map([[nobody.id, nobody.provs]]) });
    expect(w.filter((s) => s.kind === "opencode").length).toBe(1);
    expect(sharedIdent({ kind: "opencode", ident: "" })).toBe(sharedIdent({ kind: "opencode", ident: "x" }));
    expect(sharedIdent({ kind: "codex", ident: "" })).toBe("");
  });

  test("without OpenCode here, the one entry runs on Auto's pick: the PC that is on with the most free memory", () => {
    const pc = (id: string, online: boolean, ram: number | null) => ({ ...peer(`ts:${id}`, id, `${id} owner`, online, [told("opencode", "opencode", "", { photo: "https://img.example/p.png" })]), ram });
    const run = (peers: ReturnType<typeof pc>[]) => {
      const v = sharedAccounts({ me, local: mine.filter((a) => a.kind !== "OpenCode"), peers, provs: new Map(peers.map((p) => [p.id, p.provs])) }).filter((s) => s.kind === "opencode");
      expect(v.length).toBe(1);
      return v[0]!;
    };
    const oc = run([pc("a", true, 2000), pc("b", true, 9000), pc("c", false, 50000)]);
    expect([oc.id, oc.pc, oc.label, oc.badge, oc.photo, oc.person, oc.others, oc.why]).toEqual(["opencode:any", "ts:b", "OpenCode", "", "", "", false, ""]);
    expect(oc.copies?.map((c) => c.pc)).toEqual(["ts:a", "ts:b", "ts:c"]);
    expect(sharedTarget([oc], "opencode:any")).toMatchObject({ pc: "ts:b", account: "opencode" });
    // No PC says its memory (older Harbor): the first that is on; none on: the first, greyed.
    expect(run([pc("a", false, null), pc("b", true, null)]).pc).toBe("ts:b");
    expect(run([pc("a", false, null), pc("b", false, null)]).why).toBe("a is offline");
  });

  test("the real shape of 0.171.3's bug: three PCs of three owners, each with OpenCode and none told a sign-in, are one entry", () => {
    // This PC (Mara's) has OpenCode; the laptop (Dana's) tells one with her photo; a third PC's (Dario's) Claude is
    // Mara's sign-in (her photo), the photo that made 0.171.3's second OpenCode look like Mara's.
    const tower = peer("ts:tower", "tower", "Dario Reis", true, [told("claude2", "claude", MARA, { photo: "https://img.example/mara.png" }), told("opencode", "opencode", "")]);
    const laptop = peer("ts:laptop", "laptop", "Dana Reyes", true, [told("claude", "claude", DANA), told("opencode", "opencode", "", { main: true, photo: "https://img.example/dana.png" })]);
    for (const local_ of [mine, mine.filter((a) => a.kind !== "OpenCode")]) {
      const v = sharedAccounts({ me, local: local_, peers: [laptop, tower], provs: new Map([laptop, tower].map((p) => [p.id, p.provs])) });
      const oc = v.filter((s) => s.kind === "opencode");
      expect(oc.map((s) => [s.label, s.photo, s.badge])).toEqual([["OpenCode", "", ""]]);
      expect(oc[0]!.copies?.length).toBe(local_ === mine ? 3 : 2);
    }
  });

  test("the same on another PC: its own first, then this one's, one entry per sign-in", () => {
    const meLaptop = { id: "ts:laptop", name: "laptop", owner: "Dana Reyes", github: "danareyes" };
    const deskPc = peer("ts:desk", "desk", "Mara Lind", true, helloAccounts(mine, [{ name: "Mara Lind", github: "mlind" }, { name: "Dana Reyes", github: "danareyes" }, { name: "Dario Reis", github: "" }]));
    const v = sharedAccounts({ me: meLaptop, local: [local("claude", "Claude", DANA, "DR"), local("opencode", "OpenCode", "", "")], peers: [deskPc, towerPc], provs: new Map([deskPc, towerPc].map((p) => [p.id, p.provs])) });
    expect(v.map((s) => [s.label, s.pc])).toEqual([
      ["Claude · DR", ""],
      ["OpenCode", ""],
      ["Claude · ML", "ts:desk"],
      ["Claude · DaR", "ts:desk"],
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
    expect(pcs[0]!.accounts).toEqual(["Claude · ML (Mara Lind)", "Claude · DR (Dana Reyes)", "Claude · DaR (Dario Reis)", "OpenCode"]);
    expect(pcs[1]!.accounts).toEqual([]);
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

describe("owners' photos", () => {
  const me = { id: "ts:desk", name: "desk", owner: "Mara Lind", github: "mlind" };
  const MARA_PHOTO = "https://img.example/mara.png";
  const DANA_PHOTO = "https://img.example/dana.png";
  const DARIO_TOLD = "https://img.example/dario-told.png";
  const dir = [
    { name: "Mara  Lind", image: MARA_PHOTO },
    { name: "dana reyes", image: DANA_PHOTO },
    { name: "Dana Reyes", image: "https://img.example/second.png" },
    { name: "Nope", image: "http://img.example/plain.png" },
  ];
  const photoOf = photosByName(dir);
  const photos = photoBook(dir);

  test("a person's photo is the directory's first by name, case and spaces aside; only HTTPS counts", () => {
    expect(photoOf("Mara Lind")).toBe(MARA_PHOTO);
    expect(photoOf(" Dana Reyes ")).toBe(DANA_PHOTO);
    expect(photoOf("Nope")).toBe("");
    expect(photoOf("")).toBe("");
  });

  test("hello tells each account's owner's photo, never a plain-HTTP one, and reads it back", () => {
    const v = helloAccounts([local("claude", "Claude", DANA, "DR"), local("opencode", "OpenCode", "", "")], [{ name: "Dana Reyes", github: "" }], { owner: "Mara Lind", book: photos });
    expect(v.map((a) => [a.id, a.photo])).toEqual([
      ["claude", DANA_PHOTO],
      ["opencode", MARA_PHOTO],
    ]);
    expect(meshAccounts(v.map(meshAccountJson))).toEqual(v);
    expect(meshAccounts([{ id: "claude", kind: "claude", photo: "http://img.example/x.png" }])[0]!.photo).toBeUndefined();
    // Without photos it says none.
    expect(helloAccounts([local("claude", "Claude", DANA, "DR")], [])[0]!.photo).toBeUndefined();
  });

  test("with a photo the badge is the photo and the label names them; without one, initials, and the tip says so", () => {
    const laptop = peer("ts:laptop", "laptop", "Dana Reyes", true, [told("codex", "codex", ""), told("opencode", "opencode", "", { photo: DANA_PHOTO })]);
    const tower = peer("ts:tower", "tower", "Dario Reis", true, [told("codex", "codex", "", { photo: DARIO_TOLD }), told("claude", "claude", DARIO)]);
    const v = sharedAccounts({ me, local: [local("claude", "Claude", MARA, "MX")], peers: [laptop, tower], provs: new Map([laptop, tower].map((p) => [p.id, p.provs])), photos });
    expect(v.map((s) => [s.label, s.badge, s.photo, s.noPhoto])).toEqual([
      ["Claude · Mara Lind", "ML", MARA_PHOTO, false],
      ["Codex · Dana Reyes", "DR", DANA_PHOTO, false],
      // OpenCode is nobody's: no badge, no photo, even one its PC told.
      ["OpenCode", "", "", false],
      // Not in this PC's directory: the photo its PC told.
      ["Codex · Dario Reis", "DaR", DARIO_TOLD, false],
      ["Claude · Dario Reis", "DaR", DARIO_TOLD, false],
    ]);
    expect(sharedTip(v[1]!)).toBe("Dana Reyes's, runs on laptop");
    // Nobody knows a photo of Dario: his initials, said in the tooltip.
    const bare = sharedAccounts({ me, local: [], peers: [peer("ts:tower", "tower", "Dario Reis", true, [told("codex", "codex", "")])], provs: new Map(), photos });
    expect([bare[0]!.label, bare[0]!.photo, bare[0]!.noPhoto]).toEqual(["Codex · DR", "", true]);
    expect(sharedTip(bare[0]!)).toBe("Dario Reis's, runs on tower · no workspace photo of Dario Reis, so the badge is DR");
    // One person's two sign-ins of a kind are numbered, photo or not.
    const twice = sharedAccounts({ me, local: [local("claude", "Claude", MARA, "MX"), local("claude2", "Claude", "mara.lind@example.com", "ML")], peers: [laptop], provs: new Map([[laptop.id, laptop.provs]]), photos });
    expect(twice.slice(0, 2).map((s) => [s.label, s.badge])).toEqual([
      ["Claude · Mara Lind", "ML"],
      ["Claude · Mara Lind 2", "ML2"],
    ]);
    // The who is who names them once.
    expect(accountsByPc(v).get("ts:laptop")).toEqual(["Codex · Dana Reyes", "OpenCode"]);
  });

  test("alone, only a sign-in names a photo: own badges, none by name", () => {
    const v = sharedAccounts({ me, local: [local("claude", "Claude", MARA, "MX")], peers: [], provs: new Map(), photos });
    expect(v.map((s) => [s.label, s.photo, s.noPhoto])).toEqual([["Claude · MX", "", false]]);
    const signed = sharedAccounts({ me, local: [local("claude", "Claude", MARA, "MX")], peers: [], provs: new Map(), photos: photoBook([{ name: "Mara Lind", email: MARA, image: MARA_PHOTO }]) });
    expect(signed.map((s) => [s.label, s.badge, s.photo, s.noPhoto])).toEqual([["Claude · Mara Lind", "MX", MARA_PHOTO, false]]);
  });

  // The workspace calls Filip "Fizz": their PCs' owner detection knows them as Filip Sato.
  const FILIP = "filip.sato@example.com";
  const FIZZ_PHOTO = "https://img.example/fizz.png";
  const nick = photoBook([
    { name: "Mara Lind", email: "mara@example.com", image: MARA_PHOTO },
    { name: "Fizz", email: "Filip.Sato@Example.com", image: FIZZ_PHOTO },
  ]);
  const fern = peer("ts:fern", "fern", "Fern Sato", true, [told("codex", "codex", "")]);
  const lab = peer("ts:lab", "lab", "Filip Sato", false, [told("codex", "codex", "")]);

  test("a member's workspace nickname still finds their photo by the email their account signs in with", () => {
    expect(nick.byEmail(" filip.sato@example.com")).toEqual({ name: "Fizz", photo: FIZZ_PHOTO });
    expect(nick.byName("Filip Sato")).toBe("");
    expect(nick.byIdent("claude", identOf("claude", FILIP))).toEqual({ name: "Fizz", photo: FIZZ_PHOTO });
    expect(nick.byIdent("codex", identOf("claude", FILIP))).toBeNull();
    expect(nick.byIdent("claude", "")).toBeNull();
    // Without a photo (or only a plain-HTTP one) a member names nobody's photo.
    expect(photoBook([{ name: "Fizz", email: FILIP, image: "http://img.example/x.png" }]).byEmail(FILIP)).toBeNull();
  });

  test("this PC's account of another member: their photo, their workspace name, and the tip says both names", () => {
    const v = sharedAccounts({ me, local: [local("claude", "Claude", MARA, "MX"), local("claude3", "Claude", FILIP, "FS")], peers: [fern, lab], provs: new Map([fern, lab].map((p) => [p.id, p.provs])), photos: nick });
    const f = v.find((s) => s.account === "claude3")!;
    expect([f.person, f.shown, f.badge, f.photo, f.noPhoto, f.label]).toEqual(["Filip Sato", "Fizz", "FiS", FIZZ_PHOTO, false, "Claude · Fizz"]);
    expect(sharedTip(f)).toBe("Fizz's (Filip Sato), runs on this PC");
    expect(accountsByPc(v).get("")).toEqual(["Claude · Mara Lind", "Claude · Fizz (Filip Sato)"]);
    // The PC owner's own sign-in finds theirs by email too, though the directory names nobody "Mara Lind" with it.
    const m = sharedAccounts({ me, local: [local("claude", "Claude", "mara@example.com", "MA")], peers: [fern], provs: new Map([[fern.id, fern.provs]]), photos: nick });
    expect([m[0]!.label, m[0]!.photo]).toEqual(["Claude · Mara Lind", MARA_PHOTO]);
    // Hello tells that photo to the mesh, never the email.
    const h = helloAccounts([local("claude3", "Claude", FILIP, "FS")], [{ name: "Filip Sato", github: "" }], { owner: "Mara Lind", book: nick });
    expect([h[0]!.person, h[0]!.photo]).toEqual(["Filip Sato", FIZZ_PHOTO]);
    expect(JSON.stringify(h.map(meshAccountJson))).not.toContain("example.com");
  });

  test("another PC's account is matched to the member by the hash of its sign-in", () => {
    const tower = peer("ts:tower", "tower", "Fern Sato", true, [told("claude", "claude", FILIP, { main: false })]);
    const v = sharedAccounts({ me, local: [], peers: [tower, lab], provs: new Map([tower, lab].map((p) => [p.id, p.provs])), photos: nick });
    const f = v.find((s) => s.pc === "ts:tower")!;
    // Its PC knew no one by the email: the member it signs in as is who it is.
    expect([f.person, f.shown, f.photo, f.label]).toEqual(["Fizz", "Fizz", FIZZ_PHOTO, "Claude · Fizz"]);
    expect(sharedTip(f)).toBe("Fizz's, runs on tower");
    // Its PC worked out who it is: that name stays the person (badges agree on every PC); the label is the workspace's.
    const named = peer("ts:tower", "tower", "Fern Sato", true, [told("claude", "claude", FILIP, { person: "Filip Sato" })]);
    const w = sharedAccounts({ me, local: [], peers: [named, lab], provs: new Map([named, lab].map((p) => [p.id, p.provs])), photos: nick });
    const g = w.find((s) => s.pc === "ts:tower")!;
    expect([g.person, g.shown, g.photo, g.label, g.noPhoto]).toEqual(["Filip Sato", "Fizz", FIZZ_PHOTO, "Claude · Fizz", false]);
    // Not in this PC's directory: the photo its PC told for that very account.
    const toldPhoto = peer("ts:tower", "tower", "Fern Sato", true, [told("claude", "claude", "other@example.com", { person: "Filip Sato", photo: FIZZ_PHOTO })]);
    const x = sharedAccounts({ me, local: [], peers: [toldPhoto], provs: new Map([[toldPhoto.id, toldPhoto.provs]]), photos: nick });
    expect([x[0]!.photo, x[0]!.label]).toEqual([FIZZ_PHOTO, "Claude · Filip Sato"]);
  });
});
