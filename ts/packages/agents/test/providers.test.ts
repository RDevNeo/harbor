import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as p from "../src/providers.ts";

const base = mkdtempSync(join(tmpdir(), "hts-prov-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

test("accounts from a home folder: one per Claude profile, then Codex", () => {
  const h = join(base, "home");
  const bin = join(h, ".local/bin");
  mkdirSync(join(h, ".claude"), { recursive: true });
  mkdirSync(join(h, ".claude2"), { recursive: true });
  mkdirSync(join(h, ".claude10"), { recursive: true });
  mkdirSync(join(h, ".codex"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(h, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "ab.cd@example.com", displayName: "" } }));
  writeFileSync(join(h, ".claude2/.claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "x1@example.com", displayName: "Work" } }));
  writeFileSync(join(h, ".claude2/.credentials.json"), "{}");
  writeFileSync(join(h, ".codex/auth.json"), "{}");
  writeFileSync(join(bin, "claude"), "#!/bin/sh\n");
  chmodSync(join(bin, "claude"), 0o755);
  const was = { HOME: process.env.HOME, PATH: process.env.PATH };
  process.env.HOME = h;
  process.env.PATH = "/nonexistent";
  try {
    const all = p.discover();
    expect(all.map((a) => a.id)).toEqual(["claude", "claude2", "claude10", "codex"]);
    const [one, two, ten] = all;
    expect(one).toMatchObject({ name: "Claude", badge: "AB", configDir: null, loggedIn: true, bin: join(bin, "claude") });
    expect(two).toMatchObject({ name: "Work", badge: "C2", configDir: join(h, ".claude2"), loggedIn: true });
    expect(ten).toMatchObject({ name: "Claude 10", loggedIn: false });
    expect(all.find((a) => a.id === "codex")?.loggedIn).toBe(true);
    expect(p.short(two as p.Account)).toBe("Claude · C2");
    expect(p.accountEnv(two as p.Account)).toEqual([
      ["PATH", p.childPath()],
      ["CLAUDE_CONFIG_DIR", join(h, ".claude2")],
    ]);
    expect(p.childPath().split(":").slice(0, 2)).toEqual(["/nonexistent", join(h, ".local/bin")]);
  } finally {
    process.env.HOME = was.HOME;
    process.env.PATH = was.PATH;
  }
});

test("codex lists the newest of each family from the newest generation", () => {
  const cache = {
    models: [
      { slug: "gpt-5.5-sol", display_name: "Sol 5.5", priority: 1, visibility: "list" },
      { slug: "gpt-5.4-sol", display_name: "Sol 5.4", priority: 2, visibility: "list" },
      { slug: "gpt-5.5-luna", display_name: "Luna", priority: 3, visibility: "list" },
      { slug: "gpt-4.9-astra", display_name: "Astra", priority: 4, visibility: "list" },
      { slug: "hidden", display_name: "H", priority: 0, visibility: "hide" },
    ],
  };
  expect(p.codexModels(cache).map((m) => [m.id, m.more])).toEqual([
    ["gpt-5.5-sol", false],
    ["gpt-5.4-sol", true],
    ["gpt-5.5-luna", false],
    ["gpt-4.9-astra", true],
  ]);
  expect(p.codexModels(undefined)).toEqual([{ id: "", label: "Default", more: false }]);
});

test("efforts, access and their labels", () => {
  expect(p.defaultEffort("Claude")).toBe("medium");
  expect(p.effortLabel("Claude", "")).toBe("Medium");
  expect(p.effortLabel("Claude", "nope")).toBe("Default");
  expect(p.accessLabel("Codex", "plan")).toBe("Read only");
  expect(p.accessLabel("Codex", "ask")).toBe("Full access");
  expect(p.access("Codex").map((a) => a[0])).toEqual(["full", "edits", "plan"]);
  expect(p.hasFast("Codex") && p.hasFast("Claude")).toBe(true);
  expect(p.loginCmd("Codex")).toEqual(["login"]);
  expect(p.badgeFrom("9z@x", "C1")).toBe("C1");
  expect(["claude", "claude2", "claude+3", "codex"].every(p.knownAccount)).toBe(true);
  expect(["cursor", "grok", "gemini", "meta", "opencode", ""].some(p.knownAccount)).toBe(false);
});

test("the usage monitor's file: read again on each call, an empty reset is unknown, and its time is kept", () => {
  const h = join(base, "usage-home");
  const dir = join(h, ".local/state/omarchy/agents-usage-monitor");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "usage.json");
  const write = (percent: number, mtime: number): void => {
    const windows = [
      { label: "5-hour", percent: 0, resetsAt: "" },
      { label: "Weekly", percent, resetsAt: "2026-11-03T03:00:00.051695+00:00" },
    ];
    writeFileSync(file, JSON.stringify({ providers: [{ id: "claude", plan: "Max 20x", windows }] }));
    utimesSync(file, mtime, mtime);
  };
  const was = process.env.HOME;
  process.env.HOME = h;
  try {
    const a: p.Account = { id: "claude", kind: "Claude", name: "Claude", email: "", badge: "AB", plan: "", configDir: null, bin: null, loggedIn: true, usage: [] };
    write(0.94, 1_800_000_000);
    p.applyUsage([a]);
    expect(a.plan).toBe("Max 20x");
    expect(a.usageAt).toBe(1_800_000_000);
    expect(a.usage).toEqual([
      { label: "5-hour", percent: 0, resetsAt: null },
      { label: "Weekly", percent: 0.94, resetsAt: 1_793_674_800 },
    ]);
    write(0.95, 1_800_000_300);
    p.applyUsage([a]);
    expect([a.usage[1]?.percent, a.usageAt]).toEqual([0.95, 1_800_000_300]);
  } finally {
    process.env.HOME = was;
  }
});
