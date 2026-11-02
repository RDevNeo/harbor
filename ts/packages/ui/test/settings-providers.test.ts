import { expect, test } from "bun:test";
import { providers } from "@harbor/agents";
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

const account = (over: Partial<providers.Account>): providers.Account => ({ id: "claude", kind: "Claude", name: "Claude", email: "", badge: "C1", plan: "", configDir: null, bin: "/bin/claude", loggedIn: true, usage: [], ...over });

test("providers shows a signed-out Claude account with its badge and a Sign in button", () => {
  const v = providersData([account({ loggedIn: false })], "claude", logo);
  expect(v.rows[0]).toMatchObject({ name: "Claude", sub: "Claude \u{b7} C1", state: "signed-out", action: "Sign in", primary: true, installed: true, is_default: true });
});

test("providers shows a missing CLI as Not installed with an Install button and no email", () => {
  const v = providersData([account({ id: "codex", kind: "Codex", name: "Codex", badge: "", bin: null, loggedIn: false, email: "a@b.test" })], "claude", logo);
  expect(v.rows[0]).toMatchObject({ name: "Codex", sub: "", installed: false, action: "Install", primary: false, email: "", is_default: false });
});

test("providers calls a signed-in account Ready, and a CLI that can't say Installed", () => {
  const v = providersData([account({}), account({ id: "codex", kind: "Codex", name: "Codex", loggedIn: null })], "codex", logo);
  expect(v.rows.map((r) => [r.state, r.action, r.primary, r.is_default])).toEqual([
    ["ready", "Re-auth", false, false],
    ["installed", "Re-auth", false, true],
  ]);
});

test("providers rounds each usage window to a whole percent", () => {
  const v = providersData([account({ usage: [{ label: "5h", percent: 0.424, resetsAt: null }, { label: "Week", percent: 0.735, resetsAt: null }] })], "claude", logo);
  expect(v.rows[0]?.meters).toEqual([
    { label: "5h", frac: 0.424, pct: "42%" },
    { label: "Week", frac: 0.735, pct: "74%" },
  ]);
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
