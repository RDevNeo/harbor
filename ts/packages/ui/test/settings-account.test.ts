import { describe, expect, test } from "bun:test";
import type { AccountDir, AccountDirectory, AccountPendingInvite, AccountStatus, AccountUser } from "@harbor/net";
import { accountBlocks, accountTab, type AccountHost, type AccountPort } from "../src/logic/settings-account.ts";
import type { Block } from "../src/logic/settings-blocks.ts";

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
  dir: AccountDirectory = { at: 0, workspaces: [] };
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
  async leaveWorkspace() {
    this.calls.push("leave");
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
  f.dir = { at: 0, workspaces: [dirOf(role), { ...dirOf("member"), ...ws("w2", "Studio", "member"), members: [], pcs: [] }, { ...dirOf("owner"), ...ws("w3", "Mine", "owner", true) }] };
  return f;
}

const kinds = (b: Block[]) => b.map((x) => x.kind);
const titles = (b: Block[]) => b.filter((x) => x.kind === "title").map((x) => x.title);
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
    expect(titles(b)).toEqual(["This PC's workspace", "People", "PCs", "Your other workspaces"]);
    expect(b.some((x) => x.kind === "form")).toBe(false);
    const people = b[b.findIndex((x) => x.title === "People") + 1];
    expect(people?.rows.map((r) => [r.title, r.side.map((s) => s.text), r.buttons.map((x) => x.label)])).toEqual([
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
    const people = b[b.findIndex((x) => x.title === "People") + 1];
    expect(people?.rows[0]?.buttons.map((x) => x.label)).toEqual(["Leave"]);
    expect(people?.rows[1]?.buttons.map((x) => x.label)).toEqual(["Remove"]);
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

  test("moving_this_pc_lists_the_other_workspaces_right_to_left", () => {
    const f = signedIn("member");
    const b = accountBlocks(host(f));
    const move = b[b.findIndex((x) => x.title === "This PC's workspace") + 1]?.rows[1];
    expect(move?.title).toBe("Move this PC");
    expect(move?.buttons.map((x) => x.label)).toEqual(["Mine", "Studio"]);
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
    for (const k of ["signout", "leave_pc", "move:w2", "remove:u2", "leave:w2", "cancel_invite:i1"]) tab.pressed(k);
    expect(f.calls).toEqual(["signOut", "leave", "choose w2", "remove w1 u2", "remove w2 u1", "cancelInvite w1 i1"]);
  });

  test("nothing_runs_while_an_action_is_busy", () => {
    const f = signedIn("owner");
    f.st = { ...quiet(), busy: true };
    const tab = accountTab(host(f));
    tab.pressed("leave_pc");
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
