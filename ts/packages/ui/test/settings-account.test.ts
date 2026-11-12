import { describe, expect, test } from "bun:test";
import { newHost, newPeer, type AccountDir, type AccountDirectory, type AccountPendingInvite, type AccountStatus, type AccountUser } from "@harbor/net";
import { accountBlocks, accountTab, type AccountHost, type AccountPort } from "../src/logic/settings-account.ts";
import type { Block } from "../src/logic/settings-blocks.ts";
import { ownersWorkspace, type DevicesHost } from "../src/logic/settings-devices.ts";
import { ICONS } from "../src/icons.ts";

const NOW = 1_000_000;
const MINE = "a".repeat(64);
const OTHER = "b".repeat(64);

const quiet = (): AccountStatus => ({ signingIn: false, url: "", error: "", expired: false, offlineSince: 0, pick: false, syncedAt: 0, busy: false, notice: "" });
const ws = (id: string, name: string, role: "owner" | "member", personal = false) => ({ id, name, role, personal });

class Fake implements AccountPort {
  calls: string[] = [];
  st = quiet();
  user: AccountUser | null = null;
  pending: AccountPendingInvite[] = [];
  ws = "";
  dir: AccountDirectory = { at: 0, peers: [], workspaces: [] };
  isConfigured = true;
  status() {
    return this.st;
  }
  account() {
    return this.user;
  }
  invites() {
    return this.pending;
  }
  workspace() {
    return this.ws;
  }
  directory() {
    return this.dir;
  }
  configured() {
    return this.isConfigured;
  }
  async signIn() {
    this.calls.push("signIn");
  }
  cancelSignIn() {
    this.calls.push("cancelSignIn");
  }
  signOut() {
    this.calls.push("signOut");
  }
  async chooseWorkspace(w: string) {
    this.calls.push(`choose ${w}`);
  }
  async invite(w: string, email: string) {
    this.calls.push(`invite ${w} ${email}`);
  }
  async acceptInvite(id: string) {
    this.calls.push(`accept ${id}`);
  }
  async declineInvite(id: string) {
    this.calls.push(`decline ${id}`);
  }
  async cancelInvite(w: string, id: string) {
    this.calls.push(`cancelInvite ${w} ${id}`);
  }
  async removeMember(w: string, u: string) {
    this.calls.push(`remove ${w} ${u}`);
  }
}

const host = (account: Fake, online: string[] = []): AccountHost => ({ account, myFp: () => MINE, onlineFps: () => new Set(online), openUrl: (u) => account.calls.push(`open ${u}`), now: () => NOW });

const dirOf = (role: "owner" | "member"): AccountDir => ({
  ...ws("w1", "Home", role),
  members: [
    { id: "u1", name: "Ana", email: "ana@example.com", role },
    { id: "u2", name: "", email: "leo@example.com", role: "member" },
  ],
  pcs: [
    { fp: MINE, id: "pc:a", name: "desk", addrs: [], owner: "u1", owner_name: "Ana", seen: NOW - 120, version: "0.1.0" },
    { fp: OTHER, id: "pc:b", name: "laptop", addrs: [], owner: "", owner_name: "", seen: NOW - 7200, version: "" },
  ],
  devices: [],
  invites: [{ id: "i1", email: "mia@example.com", at: NOW - 3600, no_account: false, near: "" }],
});

function signedIn(role: "owner" | "member"): Fake {
  const f = new Fake();
  f.user = { id: "u1", email: "ana@example.com", name: "Ana", image: "", workspaces: [ws("w1", "Home", role), ws("w2", "Studio", "member"), ws("w3", "Mine", "owner", true)] };
  f.ws = "w1";
  f.dir = { at: 0, peers: [], workspaces: [dirOf(role), { ...dirOf("member"), ...ws("w2", "Studio", "member"), members: [], pcs: [] }, { ...dirOf("owner"), ...ws("w3", "Mine", "owner", true) }] };
  return f;
}

const kinds = (b: Block[]) => b.map((x) => x.kind);
const titles = (b: Block[]) => b.filter((x) => x.kind === "title").map((x) => x.title);
/** The People section: one card (list) per person, the person first, then their devices. */
const peopleCards = (b: Block[]) => {
  const at = b.findIndex((x) => x.title.startsWith("Home · "));
  const end = b.findIndex((x, i) => i > at && x.kind !== "list");
  return b.slice(at + 1, end < 0 ? undefined : end).filter((x) => x.kind === "list");
};
const buttonKeys = (b: Block[]) => b.flatMap((x) => [...x.buttons, ...x.rows.flatMap((r) => r.buttons)]).map((x) => x.key);

describe("accountui.rs account_tab", () => {
  test("signed_out_offers_sign_in", () => {
    const f = new Fake();
    const b = accountBlocks(host(f));
    expect(kinds(b)).toEqual(["rows"]);
    expect(b[0]?.rows[0]?.title).toBe("Sign in with Google");
    expect(b[0]?.rows[0]?.buttons.map((x) => [x.key, x.label, x.variant])).toEqual([["signin", "Sign in", "primary"]]);
  });

  test("waiting_for_the_browser_can_be_cancelled", () => {
    const f = new Fake();
    f.st = { ...quiet(), signingIn: true, url: "http://127.0.0.1:1/x" };
    const b = accountBlocks(host(f));
    expect(b[0]?.rows[0]?.buttons.map((x) => x.key)).toEqual(["cancel"]);
    expect(b[1]?.text).toBe("Waiting for the browser.");
    const tab = accountTab(host(f));
    tab.pressed("open_page");
    tab.pressed("cancel");
    expect(f.calls).toEqual(["open http://127.0.0.1:1/x", "cancelSignIn"]);
  });

  test("a_build_without_a_service_says_so", () => {
    const f = new Fake();
    f.isConfigured = false;
    expect(accountBlocks(host(f)).at(-1)?.text).toContain("a development build");
  });

  test("banners_sit_above_the_page", () => {
    const f = signedIn("owner");
    f.st = { ...quiet(), expired: true, offlineSince: NOW - 600, error: "boom", syncedAt: NOW - 30 };
    const b = accountBlocks(host(f));
    expect(b.slice(0, 4).map((x) => x.badge.text || x.text)).toEqual(["Sign in again", "Offline", "Account", "Synced just now."]);
    expect(b[1]?.text).toBe("The account service hasn't answered since 10m ago: working with what this PC has cached.");
    expect(b[4]?.kind).toBe("gap");
  });

  test("signed_in_member_sees_people_and_pcs_without_the_invite_form", () => {
    const f = signedIn("member");
    const b = accountBlocks(host(f, [OTHER]));
    expect(titles(b)).toEqual(["Home · Member", "PCs", "Your other workspaces"]);
    expect(b.some((x) => x.kind === "form")).toBe(false);
    expect(peopleCards(b).map((c) => c.rows.length)).toEqual([1, 1]);
    expect(peopleCards(b).map((c) => c.rows[0]).map((r) => [r?.title, r?.side.map((s) => s.text), r?.buttons.map((x) => x.label)])).toEqual([
      ["Ana (you)", ["Member"], ["Leave"]],
      ["leo@example.com", ["Member"], []],
    ]);
    const pcs = b[b.findIndex((x) => x.title === "PCs") + 1];
    expect(pcs?.rows.map((r) => [r.title, r.badges.map((x) => x.text)])).toEqual([
      ["desk", ["This PC"]],
      ["laptop", ["Online"]],
    ]);
    expect(pcs?.rows[0]?.line).toBe(`key ${"aaaa aaaa aaaa aaaa"} · added by Ana · Harbor 0.1.0 · checked in 2m ago`);
    expect(pcs?.rows[1]?.line).toBe("key bbbb bbbb bbbb bbbb · checked in 2h ago");
  });

  test("an_owner_invites_and_removes", () => {
    const f = signedIn("owner");
    const b = accountBlocks(host(f));
    const people = peopleCards(b).map((c) => c.rows[0]);
    expect(people[0]?.buttons.map((x) => x.label)).toEqual(["Leave"]);
    expect(people[1]?.buttons.map((x) => x.label)).toEqual(["Remove"]);
    const form = b.find((x) => x.kind === "form");
    expect(form?.fields.map((x) => x.hint)).toEqual(["name@example.com"]);
    expect(form?.submit.label).toBe("Invite");
    expect(b.find((x) => x.text.startsWith("Invited mia@example.com"))?.text).toBe("Invited mia@example.com · 1h ago");
    expect(buttonKeys(b)).toContain("cancel_invite:i1");
  });

  test("invites_nobody_can_accept_say_so", () => {
    const f = signedIn("owner");
    const inv = f.dir.workspaces[0]!.invites;
    inv[0] = { ...inv[0]!, email: "lee@example.com", no_account: true, near: "leo@example.com" };
    inv.push({ id: "i2", email: "zed@example.com", at: NOW - 60, no_account: true, near: "" });
    const texts = accountBlocks(host(f)).map((x) => x.text).filter((t) => t.startsWith("Invited "));
    expect(texts).toEqual([
      "Invited lee@example.com · 1h ago · no Harbor account uses this address: did you mean leo@example.com?",
      "Invited zed@example.com · 1m ago · no Harbor account uses this address yet",
    ]);
  });

  test("personal_workspaces_have_no_leave", () => {
    const f = signedIn("member");
    const b = accountBlocks(host(f));
    const others = b[b.findIndex((x) => x.title === "Your other workspaces") + 1];
    expect(others?.rows.map((r) => [r.title, r.line, r.buttons.map((x) => x.key)])).toEqual([
      ["Studio", "0 people · 0 PCs", ["leave:w2"]],
      ["Mine", "2 people · 2 PCs", []],
    ]);
  });

  test("the people come right under the workspace's name and your role: no explainer, no Take out", () => {
    const f = signedIn("owner");
    const b = accountBlocks(host(f));
    const at = b.findIndex((x) => x.title === "Home · Owner");
    expect(at).toBe(1);
    expect(b[at + 1]?.rows[0]?.title).toBe("Ana (you)");
    const all = b.flatMap((x) => x.rows.map((r) => r.title));
    expect(all).not.toContain("Take this PC out");
    expect(all).not.toContain("Everyone here shares their PCs");
    expect(buttonKeys(b)).not.toContain("leave_pc");
  });

  test("invitations_are_accepted_or_declined", () => {
    const f = signedIn("member");
    f.pending = [{ id: "p1", ws: "w9", ws_name: "", inviter_name: "Zed", email: "ana@example.com", at: NOW - 60 }];
    const b = accountBlocks(host(f));
    const inv = b[b.findIndex((x) => x.title === "Invitations") + 1];
    expect(inv?.rows[0]?.title).toBe("A workspace");
    expect(inv?.rows[0]?.line).toBe("Zed invited ana@example.com · 1m ago");
    const tab = accountTab(host(f));
    tab.pressed("accept:p1");
    tab.pressed("decline:p1");
    expect(f.calls).toEqual(["accept p1", "decline p1"]);
  });

  test("a_pc_in_no_workspace_picks_one", () => {
    const f = signedIn("owner");
    f.ws = "";
    f.st = { ...quiet(), pick: true };
    const b = accountBlocks(host(f));
    expect(titles(b)).toEqual(["This PC's workspace"]);
    expect(b.at(-1)?.rows.map((r) => [r.title, r.badges.map((x) => x.text), r.buttons.map((x) => x.key)])).toEqual([
      ["Home", ["Owner"], ["use:w1"]],
      ["Studio", ["Member"], ["use:w2"]],
      ["Mine", ["Owner"], ["use:w3"]],
    ]);
  });

  test("presses_do_what_the_buttons_say", () => {
    const f = signedIn("owner");
    const tab = accountTab(host(f));
    for (const k of ["signout", "move:w2", "remove:u2", "leave:w2", "cancel_invite:i1"]) tab.pressed(k);
    expect(f.calls).toEqual(["signOut", "choose w2", "remove w1 u2", "remove w2 u1", "cancelInvite w1 i1"]);
  });

  test("nothing_runs_while_an_action_is_busy", () => {
    const f = signedIn("owner");
    f.st = { ...quiet(), busy: true };
    const tab = accountTab(host(f));
    tab.pressed("remove:u2");
    expect(f.calls).toEqual([]);
    expect(buttonKeys(accountBlocks(host(f))).length).toBeGreaterThan(0);
  });

  test("invite_wants_an_address_and_lowercases_it", () => {
    const f = signedIn("owner");
    const tab = accountTab(host(f));
    expect(tab.submitted("invite", ["nobody"])).toBe("");
    expect(tab.submitted("invite", ["  Mia@Example.COM "])).toBe("");
    expect(f.calls).toEqual(["invite w1 mia@example.com"]);
  });
});

describe("one Workspace page: each person with their PCs and phones", () => {
  const pc = (fp: string, name: string, owner: string, owner_name: string, via: string[], seen = NOW - 60) => ({ fp, id: `pc:${name}`, name, addrs: [], owner, owner_name, seen, version: "0.131.0", via });
  function devicesOf(calls: string[]): DevicesHost {
    return {
      now: () => NOW,
      me: () => ({ id: "pc:a", name: "desk" }),
      myFp: () => MINE,
      versionLabel: () => "0.132.0",
      peers: () => [pc(OTHER, "laptop", "u2", "Leo", ["Home"]), pc("c".repeat(64), "render", "u9", "Kai", ["Studio"], NOW - 5)],
      meshPeers: () => [
        newPeer({ id: "pc:laptop", fp: OTHER, online: true, version: "0.109.0.ts", update: { build: "0.171.4+0d56ad0" }, devices: [{ id: "ssh:1", name: "Mac", os: "macOS" }, { id: "ssh:2", name: "render", os: "linux" }] }),
        newPeer({ id: "pc:render", fp: "c".repeat(64), devices: [{ id: "ssh:4", name: "nas", os: "linux" }] }),
      ],
      rename: (n) => calls.push(`rename ${n}`),
      copy: (t) => calls.push(`copy ${t.slice(0, 4)}`),
      phones: () => [
        { fp: "d".repeat(64), name: "Pixel", account: "u1", accountName: "Ana" },
        { fp: "e".repeat(64), name: "", account: "u2", accountName: "Leo" },
      ],
      signOutPhone: (fp) => calls.push(`signout ${fp.slice(0, 4)}`),
      ssh: { devices: () => [[newHost({ id: "ssh:1", name: "Build PC", host: "10.0.0.3" }), false]], remove: (id) => calls.push(`ssh ${id}`) },
    };
  }

  test("people cards list their PCs, each with the SSH devices it added (\"SSH\"), and phones; PCs shared through another workspace follow, as their owner's workspace", () => {
    const f = signedIn("member");
    const b = accountBlocks({ ...host(f), devices: devicesOf([]) });
    expect(titles(b)).toEqual(["Home · Member", "Through your other workspaces", "Your other workspaces"]);
    expect(peopleCards(b).map((c) => c.rows.map((r) => [r.title, r.badges.map((x) => x.text), r.line]))).toEqual([
      [
        ["Ana (you)", [], "ana@example.com"],
        ["desk", ["This PC"], "Harbor 0.132.0 · key aaaa aaaa aaaa aaaa"],
        ["Build PC", [], "SSH · offline"],
        // A phone reads by its device name, else just "Phone"; no key.
        ["Pixel", [], "Phone"],
      ],
      [
        ["leo@example.com", [], "leo@example.com"],
        // The Harbor it really runs (its update info's build), not the compat version it advertises.
        ["laptop", ["Online"], "Harbor 0.171.4+0d56ad0"],
        // A device that is itself one of the PCs ("render") isn't listed twice.
        ["Mac", [], "SSH"],
        ["Phone", [], "Phone"],
      ],
    ]);
    const icons = peopleCards(b).flatMap((c) => c.rows.filter((r) => r.line.startsWith("SSH")).map((r) => r.icon));
    expect(new Set(icons)).toEqual(new Set([ICONS.LAPTOP]));
    // Only this PC's own devices can be removed here.
    expect(peopleCards(b)[0]?.rows[2]?.buttons.map((x) => x.key)).toEqual(["ssh_remove:ssh:1"]);
    expect(peopleCards(b)[1]?.rows[2]?.buttons).toEqual([]);
    // A member signs out their own phone only; the owner any.
    expect(peopleCards(b).map((c) => c.rows.at(-1)?.buttons.map((x) => x.key))).toEqual([[`phone_signout:${"d".repeat(64)}`], []]);
    const shared = b[b.findIndex((x) => x.title === "Through your other workspaces") + 1];
    expect(shared?.rows.map((r) => [r.title, r.line])).toEqual([
      ["render", "Kai's Workspace · Harbor 0.131.0 · seen just now"],
      ["nas", "SSH"],
    ]);
    expect(titles(b)).not.toContain("PCs");
  });

  test("Rename opens its form under this PC's card; the device buttons reach the host", () => {
    const calls: string[] = [];
    const f = signedIn("owner");
    const tab = accountTab({ ...host(f), devices: devicesOf(calls) });
    tab.pressed("rename");
    const b = tab.blocks();
    const at = b.findIndex((x) => x.key === "rename");
    expect(b[at - 1]?.rows[1]?.title).toBe("desk");
    expect(b[at]?.fields[0]?.text).toBe("desk");
    tab.submitted("rename", ["Studio PC"]);
    expect(tab.blocks().some((x) => x.key === "rename")).toBe(false);
    tab.pressed("copy_key");
    tab.pressed(`phone_signout:${"e".repeat(64)}`);
    tab.pressed("ssh_remove:ssh:1");
    expect(calls).toEqual(["rename Studio PC", "copy aaaa", "signout eeee", "ssh ssh:1"]);
    // The owner may sign out anyone's phone.
    expect(peopleCards(tab.blocks()).map((c) => c.rows.at(-1)?.buttons.length)).toEqual([1, 1]);
  });

  test("signed out, this PC and the SSH devices still show", () => {
    const f = new Fake();
    const b = accountBlocks({ ...host(f), devices: devicesOf([]) });
    expect(titles(b)).toEqual(["This PC", "Other devices"]);
  });
});

test("a PC from someone else's workspace is named by their first name", () => {
  expect(ownersWorkspace("Kai Ono")).toBe("Kai's Workspace");
  expect(ownersWorkspace("  Leo ")).toBe("Leo's Workspace");
  expect(ownersWorkspace("")).toBe("Shared workspace");
});

describe("people's photos", () => {
  test("a member with a photo shows it in the icon's place; one without, or before it came, keeps the icon", () => {
    const f = signedIn("owner");
    const home = f.dir.workspaces[0]!;
    home.members[0] = { ...home.members[0]!, image: "https://img.example/ana.jpg" };
    const px = { width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) };
    const asked: string[] = [];
    const photo = (url: string) => {
      asked.push(url);
      return url === "https://img.example/ana.jpg" ? px : null;
    };
    const people = peopleCards(accountBlocks({ ...host(f), photo }));
    expect(people[0]?.rows[0]?.has_photo).toBe(true);
    expect(people[0]?.rows[0]?.photo).toBe(px);
    expect(people[1]?.rows[0]?.has_photo).toBe(false);
    expect(people[1]?.rows[0]?.icon).not.toBe("");
    expect(asked).toEqual(["https://img.example/ana.jpg", ""]);
    // No photo source (a bare rig): icons only.
    expect(peopleCards(accountBlocks(host(f)))[0]?.rows[0]?.has_photo).toBe(false);
  });
});
