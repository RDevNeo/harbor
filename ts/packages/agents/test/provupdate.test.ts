import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pu from "../src/provupdate.ts";
import type { Account } from "../src/providers.ts";

const base = mkdtempSync(join(tmpdir(), "hts-provupd-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

test("versions from CLI output", () => {
  expect(pu.parseVersion("2.0.14 (Claude Code)\n")).toBe("2.0.14");
  expect(pu.parseVersion("codex-cli 0.46.0")).toBe("0.46.0");
  expect(pu.parseVersion("v1.2.3-beta.1")).toBe("1.2.3-beta.1");
  expect(pu.parseVersion("opencode 0.15")).toBeNull();
  expect(pu.parseVersion("")).toBeNull();
});

test("names and keys", () => {
  const p = (kind: pu.Pending["kind"], latest: string): pu.Pending => ({ kind, current: "0.1.0", latest });
  expect(pu.names([p("Codex", "1.0.0")])).toBe("Codex");
  expect(pu.names([p("Codex", "1.0.0"), p("Claude", "2.0.0")])).toBe("Codex and Claude");
  expect(pu.names([p("Codex", "1.0.0"), p("Gemini", "1.0.0"), p("Claude", "2.0.0")])).toBe("Codex, Gemini and Claude");
  expect(pu.key([p("Codex", "1.0.0"), p("Claude", "2.0.0")])).toBe("codex=1.0.0,claude=2.0.0");
});

test("newer compares like update.rs", () => {
  expect(pu.newer("0.2.0", "0.2.0-rc.1")).toBe(true);
  expect(pu.newer("0.2.0-rc.1", "0.1.9")).toBe(true);
  expect(pu.newer("0.2.0", "0.2.0")).toBe(false);
  expect(pu.newer("1.10.0", "1.9.9")).toBe(true);
  expect(pu.newer("x", "1.0.0")).toBe(false);
});

test("a check finds what's behind, the Update button runs each updater and looks again", async () => {
  // A fake `claude`: its version until `update` runs, then the latest.
  const bin = join(base, "claude");
  const flag = join(base, "updated");
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = update ]; then touch '${flag}'; exit 0; fi\nif [ -e '${flag}' ]; then echo "2.1.0 (Claude Code)"; else echo "2.0.0 (Claude Code)"; fi\n`);
  chmodSync(bin, 0o755);
  const acct: Account = { id: "claude", kind: "Claude", name: "Claude", email: "", badge: "", plan: "", configDir: null, bin, loggedIn: true, usage: [] };
  const lookup = async (pkg: string): Promise<string | null> => (pkg === "@anthropic-ai/claude-code" ? "2.1.0" : null);
  expect(pu.installed([acct, { ...acct, id: "claude2" }, { ...acct, id: "cursor", kind: "Cursor" }])).toEqual([["Claude", bin]]);
  await pu.check(pu.installed([acct]), lookup);
  expect(pu.status().items).toEqual([{ kind: "Claude", current: "2.0.0", latest: "2.1.0" }]);
  const run = pu.updateAll([acct], lookup);
  expect(run).not.toBe(false);
  expect(pu.status().updating).toBe(true);
  await run;
  const st = pu.status();
  expect(st.items).toEqual([]);
  expect(st.done?.[0]).toBe("Claude is up to date");
  expect(st.busy || st.updating).toBe(false);
  pu.clearOutcome();
  expect(pu.status().done).toBeNull();
  expect(pu.updateAll([acct], lookup)).toBe(false);
  expect(pu.updateCmd("Codex", "/x/codex")).toEqual(["npm", "i", "-g", "@openai/codex@latest"]);
});
