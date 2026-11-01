import { expect, test } from "bun:test";
import { providers } from "@harbor/agents";
import { blankChat, type Chat } from "@harbor/store";
import { allowedAccounts, checkRun, isRunError } from "../src/runsettings.ts";

const account = (id: string, kind: providers.Kind): providers.Account => ({ id, kind, name: id, email: "", badge: "", plan: "", configDir: null, bin: `/bin/${id}`, loggedIn: true, usage: [] });
const chat = (acc: string, started: boolean, role: Chat["role"]): Chat => ({ ...blankChat(), id: 1, title: "t", sessionId: "s", started, account: acc, model: "claude-opus-5-5", effort: "high", access: "full", role, name: "lead" });

test("run_settings_follow_the_desktop_rules", () => {
  const accounts = [account("claude", "Claude"), account("claude2", "Claude"), account("codex", "Codex")];
  const all = accounts.map((a) => a.id);
  const claude = ["claude", "claude2"];
  const run = (c: Chat, allowed: readonly string[], b: Record<string, unknown>) => checkRun(c, b, accounts, allowed, providers.staticModels, ["ts:laptop"]);
  const status = (f: () => unknown): number => {
    try {
      f();
    } catch (e) {
      if (isRunError(e)) return e.status;
      throw e;
    }
    return 0;
  };
  const lead = chat("claude", false, "lead");
  // Nothing asked.
  expect(run(lead, claude, { title: "x" })).toBeNull();
  // Another Claude account: fine; another provider: 409 (a lead runs on Claude).
  expect(run(lead, claude, { account: "claude2" })?.chat).toMatchObject({ account: "claude2", model: "claude-opus-5-5" });
  expect(status(() => run(lead, claude, { account: "codex" }))).toBe(409);
  expect(status(() => run(lead, claude, { account: "nope" }))).toBe(400);
  // A sub that hasn't started may change provider: its model, effort and access follow.
  const sub = { ...chat("claude", false, "sub"), effort: "ultracode", access: "plan" as const };
  const n = run(sub, all, { account: "codex" })?.chat as Chat;
  expect(n.account).toBe("codex");
  expect(providers.staticModels("Codex").some((m) => m.id === n.model)).toBe(true);
  expect(providers.efforts("Codex").some((e) => e[0] === n.effort)).toBe(true);
  expect(n.access).toBe("plan");
  // Values are checked against the provider's lists.
  expect(status(() => run(lead, claude, { model: "gpt-9" }))).toBe(400);
  expect(status(() => run(lead, claude, { effort: "warp" }))).toBe(400);
  expect(status(() => run(lead, claude, { access: "root" }))).toBe(400);
  expect(status(() => run(lead, claude, { effort: 3 }))).toBe(400);
  const r = run(lead, claude, { effort: "max", access: "edits", fast: true });
  expect([r?.chat.effort, r?.chat.access, r?.fast]).toEqual(["max", "edits", true]);
  // Devices: before the first turn only, Claude only, known ones only.
  expect(run(lead, claude, { device: "ts:laptop" })?.chat.device).toBe("ts:laptop");
  expect(status(() => run(lead, claude, { device: "ts:gone" }))).toBe(400);
  const started = chat("claude", true, "lead");
  expect(status(() => run(started, claude, { device: "ts:laptop" }))).toBe(409);
  // Its own device again is no change.
  expect(status(() => run(started, claude, { device: "" }))).toBe(0);
  expect(status(() => run(chat("codex", false, "sub"), all, { device: "ts:laptop" }))).toBe(400);
  // One bad field and nothing is applied: the error comes before any change.
  expect(status(() => run(lead, claude, { effort: "max", access: "root" }))).toBe(400);
  expect(lead.effort).toBe("high");
});

test("a lead may switch only among Claude accounts, a started chat stays on its provider", () => {
  const accounts = [account("claude", "Claude"), account("claude2", "Claude"), account("codex", "Codex")];
  expect(allowedAccounts(chat("claude", false, "lead"), accounts)).toEqual(["claude", "claude2"]);
  expect(allowedAccounts(chat("codex", true, "sub"), accounts)).toEqual(["codex"]);
  expect(allowedAccounts(chat("codex", false, "sub"), accounts)).toEqual(["claude", "claude2", "codex"]);
});
