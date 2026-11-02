import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as p from "../src/providers.ts";

const base = mkdtempSync(join(tmpdir(), "hts-prov-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

test("accounts from a home folder: one per Claude profile, then every other CLI", () => {
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
    expect(all.map((a) => a.id)).toEqual(["claude", "claude2", "claude10", "codex", "cursor", "grok", "gemini", "meta", "opencode"]);
    const [one, two, ten] = all;
    expect(one).toMatchObject({ name: "Claude", badge: "AB", configDir: null, loggedIn: true, bin: join(bin, "claude") });
    expect(two).toMatchObject({ name: "Work", badge: "C2", configDir: join(h, ".claude2"), loggedIn: true });
    expect(ten).toMatchObject({ name: "Claude 10", loggedIn: false });
    expect(all.find((a) => a.id === "codex")?.loggedIn).toBe(true);
    expect(all.find((a) => a.id === "cursor")?.loggedIn).toBeNull();
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

test("cursor models from its list, the first four up front", () => {
  const text = "Available models\n\nauto - Auto (current, default)\ngpt-5 - GPT-5\nsonnet-4 - Sonnet 4\nopus - Opus (current)\ngrok - Grok\nnot a model - x\n";
  const v = p.parseCursorModels(text);
  expect(v.map((m) => [m.id, m.label, m.more])).toEqual([
    ["auto", "Auto", false],
    ["gpt-5", "GPT-5", false],
    ["sonnet-4", "Sonnet 4", false],
    ["opus", "Opus", false],
    ["grok", "Grok", true],
  ]);
  expect(p.parseCursorModels("")).toEqual([{ id: "auto", label: "Auto", more: false }]);
});

test("efforts, access and their labels", () => {
  expect(p.defaultEffort("Claude")).toBe("medium");
  expect(p.effortLabel("Claude", "")).toBe("Medium");
  expect(p.effortLabel("Meta", "")).toBe("High");
  expect(p.effortLabel("Cursor", "")).toBe("Default");
  expect(p.accessLabel("OpenCode", "plan")).toBe("Full access");
  expect(p.access("Cursor").map((a) => a[0])).toEqual(["full", "ask"]);
  expect(p.hasFast("Codex") && !p.hasFast("Gemini")).toBe(true);
  expect(p.loginCmd("OpenCode")).toEqual(["auth", "login"]);
  expect(p.badgeFrom("9z@x", "C1")).toBe("C1");
});
