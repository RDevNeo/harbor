import { expect, test } from "bun:test";
import { providers, provupdate } from "@harbor/agents";
import { addClaudeAccount, firstModel, makeDefault, providersData } from "../src/logic/settings-providers.ts";

class Kv {
  readonly map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const logo = () => ({ width: 1, height: 1, data: new Uint8Array(4) });
const idle: provupdate.Status = { items: [], busy: false, updating: false, error: null, done: null };

const account = (over: Partial<providers.Account>): providers.Account => ({ id: "claude", kind: "Claude", name: "Claude", email: "", badge: "C1", plan: "", configDir: null, bin: "/bin/claude", loggedIn: true, usage: [], ...over });

test("providers shows a signed-out Claude account with its badge and a Sign in button", () => {
  const v = providersData([account({ loggedIn: false })], "claude", idle, logo);
  expect(v.rows[0]).toMatchObject({ name: "Claude", sub: "Claude \u{b7} C1", state: "signed-out", action: "Sign in", primary: true, installed: true, is_default: true });
  expect(v.update_show).toBe(false);
});

test("providers shows a missing CLI as Not installed with an Install button and no email", () => {
  const v = providersData([account({ id: "codex", kind: "Codex", name: "Codex", badge: "", bin: null, loggedIn: false, email: "a@b.test" })], "claude", idle, logo);
  expect(v.rows[0]).toMatchObject({ name: "Codex", sub: "", installed: false, action: "Install", primary: false, email: "", is_default: false });
});

test("providers calls a signed-in account Ready, and a CLI that can't say Installed", () => {
  const v = providersData([account({}), account({ id: "cursor", kind: "Cursor", name: "Cursor", loggedIn: null })], "cursor", idle, logo);
  expect(v.rows.map((r) => [r.state, r.action, r.primary, r.is_default])).toEqual([
    ["ready", "Re-auth", false, false],
    ["installed", "Re-auth", false, true],
  ]);
});

test("providers rounds each usage window to a whole percent", () => {
  const v = providersData([account({ usage: [{ label: "5h", percent: 0.424, resetsAt: null }, { label: "Week", percent: 0.735, resetsAt: null }] })], "claude", idle, logo);
  expect(v.rows[0]?.meters).toEqual([
    { label: "5h", frac: 0.424, pct: "42%" },
    { label: "Week", frac: 0.735, pct: "74%" },
  ]);
});

test("providers lists CLI updates, then the failure of the last one", () => {
  const items: provupdate.Pending[] = [
    { kind: "Codex", current: "1.0.0", latest: "1.1.0" },
    { kind: "Claude", current: "2.0.0", latest: "2.1.0" },
  ];
  const a = providersData([], "claude", { ...idle, items }, logo);
  expect([a.update_show, a.update_title, a.update_desc, a.update_enabled]).toEqual([true, "Updates available", "Codex 1.0.0 \u{2192} 1.1.0, Claude 2.0.0 \u{2192} 2.1.0", true]);
  const b = providersData([], "claude", { ...idle, items, updating: true, busy: true }, logo);
  expect([b.update_title, b.update_enabled]).toEqual(["Updating providers\u{2026}", false]);
  const c = providersData([], "claude", { ...idle, items, error: "npm failed" }, logo);
  expect(c.update_desc).toBe("The last update failed: npm failed");
});

test("providers adds Claude accounts from the first free ~/.claudeN", () => {
  const taken = new Set(["/h/.claude2", "/h/.claude3"]);
  const r = addClaudeAccount("/h", (p) => taken.has(p), false);
  expect(r.title).toBe("Claude account 4");
  expect(r.script).toBe("mkdir -p /h/.claude4 && CLAUDE_CONFIG_DIR=/h/.claude4 claude /login");
  expect(addClaudeAccount("/h", () => true, true).title).toBe("Claude account 9");
  expect(addClaudeAccount("/h", () => false, true).script).toBe("claude-profile --setup claude2 && CLAUDE_CONFIG_DIR=/h/.claude2 claude /login");
});

test("providers makes an account the default with its first model and its provider's defaults", () => {
  const kv = new Kv();
  const models = [
    { id: "legacy", label: "Legacy", more: true },
    { id: "main", label: "Main", more: false },
  ];
  expect(firstModel(models)).toBe("main");
  expect(firstModel([])).toBe("");
  makeDefault(kv, account({ id: "claude2" }), firstModel(models));
  expect([...kv.map]).toEqual([
    ["default_account", "claude2"],
    ["default_model", "main"],
    ["default_effort", "medium"],
    ["default_access", "full"],
  ]);
});
