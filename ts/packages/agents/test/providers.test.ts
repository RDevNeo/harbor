import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as p from "../src/providers.ts";

const base = mkdtempSync(join(tmpdir(), "hts-prov-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

test("accounts from a home folder: one per Claude profile, then Codex and OpenCode", () => {
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
  // OpenCode's installer puts it in ~/.opencode/bin.
  mkdirSync(join(h, ".opencode/bin"), { recursive: true });
  writeFileSync(join(h, ".opencode/bin/opencode"), "#!/bin/sh\n");
  chmodSync(join(h, ".opencode/bin/opencode"), 0o755);
  const was = { HOME: process.env.HOME, PATH: process.env.PATH };
  process.env.HOME = h;
  process.env.PATH = "/nonexistent";
  try {
    const all = p.discover();
    expect(all.map((a) => a.id)).toEqual(["claude", "claude2", "claude10", "codex", "opencode"]);
    expect(all.find((a) => a.id === "opencode")).toMatchObject({ kind: "OpenCode", loggedIn: null, bin: join(h, ".opencode/bin/opencode") });
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
  expect(["claude", "claude2", "claude+3", "codex", "opencode"].every(p.knownAccount)).toBe(true);
  expect(["cursor", "grok", "gemini", "meta", ""].some(p.knownAccount)).toBe(false);
  expect(p.access("OpenCode").map((a) => a[0])).toEqual(["full"]);
  expect(p.accessLabel("OpenCode", "plan")).toBe("Full access");
  expect(p.efforts("OpenCode")).toEqual([]);
  expect(p.effortLabel("OpenCode", "")).toBe("Default");
  expect(p.hasFast("OpenCode")).toBe(false);
  expect(p.loginCmd("OpenCode")).toEqual(["auth", "login"]);
  expect(p.installHint("OpenCode")).toBe("curl -fsSL https://opencode.ai/install | bash");
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
    // An older monitor still says "Max 20x": the plan is called Ultra since 2026-10-30.
    expect(a.plan).toBe("Ultra");
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

test("a removed profile folder is gone on the next read; one never signed in reads as signed out", () => {
  const h = join(base, "gone-home");
  mkdirSync(join(h, ".claude"), { recursive: true });
  mkdirSync(join(h, ".claude3"), { recursive: true });
  mkdirSync(join(h, ".claude4"), { recursive: true });
  writeFileSync(join(h, ".claude3/.credentials.json"), JSON.stringify({ claudeAiOauth: { rateLimitTier: "default_claude_max_5x", subscriptionType: "max" } }));
  writeFileSync(join(h, ".claude4/.claude.json"), JSON.stringify({ numStartups: 1 }));
  const was = { HOME: process.env.HOME, PATH: process.env.PATH };
  process.env.HOME = h;
  process.env.PATH = "/nonexistent";
  try {
    const before = p.discover();
    expect(before.map((a) => a.id)).toEqual(["claude", "claude3", "claude4", "codex", "opencode"]);
    const four = before.find((a) => a.id === "claude4") as p.Account;
    expect(four).toMatchObject({ badge: "C4", loggedIn: false });
    expect(p.usable({ ...four, bin: "/bin/claude" })).toBe(false);
    expect(p.usable({ ...four, bin: "/bin/claude", loggedIn: null })).toBe(true);
    expect(before.find((a) => a.id === "claude3")?.plan).toBe("Max");
    rmSync(join(h, ".claude4"), { recursive: true });
    expect(p.discover().map((a) => a.id)).toEqual(["claude", "claude3", "codex", "opencode"]);
  } finally {
    process.env.HOME = was.HOME;
    process.env.PATH = was.PATH;
  }
});

test("plan names: Max 20x is Ultra, Max 5x is Max, from the monitor or from the login's tier", () => {
  expect(["Max 20x", "max_20x", "default_claude_max_20x", "Max 5x", "default_claude_max_5x", "Pro", "Plus", ""].map(p.planName)).toEqual(["Ultra", "Ultra", "Ultra", "Max", "Max", "Pro", "Plus", ""]);
  expect(p.claudePlan({ rateLimitTier: "default_claude_max_20x", subscriptionType: "max" })).toBe("Ultra");
  expect(p.claudePlan({ rateLimitTier: "default_claude_max_5x", subscriptionType: "max" })).toBe("Max");
  expect(p.claudePlan({ subscriptionType: "pro" })).toBe("Pro");
  // A bare "max" could be either plan.
  expect(p.claudePlan({ subscriptionType: "max" })).toBe("");
  expect(p.claudePlan(undefined)).toBe("");
});

test("an Ultra account's monitor entry has no 5-hour window, and none is made up", () => {
  const h = join(base, "ultra-home");
  const dir = join(h, ".local/state/omarchy/agents-usage-monitor");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "usage.json"),
    JSON.stringify({
      providers: [
        { id: "claude", plan: "Ultra", windows: [{ label: "Weekly", percent: 1, resetsAt: "2026-11-07T02:00:00+00:00" }, { label: "Fable Weekly", percent: 0.12, resetsAt: "2026-11-07T02:00:00+00:00" }] },
        { id: "claude3", plan: "Max", windows: [{ label: "5-hour", percent: 0, resetsAt: "" }, { label: "Weekly", percent: 0.01, resetsAt: "2026-11-08T06:00:00+00:00" }] },
      ],
    }),
  );
  const was = process.env.HOME;
  process.env.HOME = h;
  try {
    const mk = (id: string): p.Account => ({ id, kind: "Claude", name: id, email: "", badge: "AB", plan: "Ultra", configDir: null, bin: null, loggedIn: true, usage: [] });
    const [ultra, max] = [mk("claude"), mk("claude3")];
    p.applyUsage([ultra, max]);
    expect([ultra.plan, ultra.usage.map((w) => w.label)]).toEqual(["Ultra", ["Weekly", "Fable Weekly"]]);
    expect([max.plan, max.usage.map((w) => w.label)]).toEqual(["Max", ["5-hour", "Weekly"]]);
  } finally {
    process.env.HOME = was;
  }
});

test("an account turned off on this PC is listed but not usable, and Remove moves its folder out of discovery", () => {
  const h = join(base, "off-home");
  mkdirSync(join(h, ".claude"), { recursive: true });
  mkdirSync(join(h, ".claude2"), { recursive: true });
  mkdirSync(join(h, ".claude4/sub"), { recursive: true });
  writeFileSync(join(h, ".claude2/.credentials.json"), "{}");
  writeFileSync(join(h, ".claude4/sub/x"), "kept");
  const was = { HOME: process.env.HOME, PATH: process.env.PATH, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
  process.env.HOME = h;
  process.env.PATH = "/nonexistent";
  delete process.env.XDG_DATA_HOME;
  try {
    expect(p.offIds()).toEqual([]);
    p.setOff("claude2", true);
    expect(p.offIds()).toEqual(["claude2"]);
    const two = p.discover().find((a) => a.id === "claude2") as p.Account;
    expect(two.off).toBe(true);
    expect(p.usable({ ...two, bin: "/bin/claude" })).toBe(false);
    expect(p.signedIn({ ...two, bin: "/bin/claude" })).toBe(false);
    expect(p.fallback(p.discover().map((a) => ({ ...a, bin: "/bin/claude", loggedIn: true })), "Claude")?.id).toBe("claude");
    p.setOff("claude2", false);
    expect(p.discover().find((a) => a.id === "claude2")?.off).toBeUndefined();

    const main = p.discover().find((a) => a.id === "claude") as p.Account;
    expect(p.removable(main)).toBe(false);
    expect(() => p.removeAccount(main)).toThrow();
    const four = p.discover().find((a) => a.id === "claude4") as p.Account;
    expect(p.removable(four)).toBe(true);
    p.setOff("claude4", true);
    const to = p.removeAccount(four);
    expect(to.startsWith(join(h, ".local/share/harbor/removed-accounts/claude4-"))).toBe(true);
    expect(readFileSync(join(to, "sub/x"), "utf8")).toBe("kept");
    expect(p.discover().map((a) => a.id)).toEqual(["claude", "claude2", "codex", "opencode"]);
    expect(p.offIds()).toEqual([]);
  } finally {
    process.env.HOME = was.HOME;
    process.env.PATH = was.PATH;
    if (was.XDG_DATA_HOME !== undefined) process.env.XDG_DATA_HOME = was.XDG_DATA_HOME;
  }
});

test("OpenCode's models: `opencode models` run without blocking, the config's up front, kept for the next start", async () => {
  const text = "opencode/big-pickle\nnvidia/z-ai/glm-5.3-flash\nnvidia/moonshotai/kimi-k3.1-pro\nnot a model\n\nnvidia/z-ai/glm-5.3-flash\n";
  expect(p.parseOpencodeModels(text)).toEqual(["opencode/big-pickle", "nvidia/z-ai/glm-5.3-flash", "nvidia/moonshotai/kimi-k3.1-pro"]);
  const config = { model: "opencode/big-pickle", provider: { nvidia: { models: { "z-ai/glm-5.3-flash": { name: "GLM" } } } } };
  expect(p.opencodeConfigured(config)).toEqual(["opencode/big-pickle", "nvidia/z-ai/glm-5.3-flash"]);
  expect(p.opencodeConfigured(undefined)).toEqual([]);
  const ids = p.parseOpencodeModels(text);
  expect(p.opencodeModelList(ids, p.opencodeConfigured(config)).map((m) => [m.id, m.more])).toEqual([
    ["", false],
    ["opencode/big-pickle", false],
    ["nvidia/z-ai/glm-5.3-flash", false],
    ["nvidia/moonshotai/kimi-k3.1-pro", true],
  ]);
  // A config naming none: the first ones up front.
  expect(p.opencodeModelList(ids, []).every((m) => !m.more)).toBe(true);
  // A fake `opencode`: its list lands in the data folder, and the picker's list has it.
  const fake = join(base, "opencode");
  writeFileSync(fake, `#!/bin/sh\n[ "$1" = models ] && printf '${text.replaceAll("\n", "\\n")}'\n`);
  chmodSync(fake, 0o755);
  await p.refreshOpencodeModels(fake);
  expect(JSON.parse(readFileSync(p.opencodeCachePath(), "utf8"))).toEqual(ids);
  const listed = p.opencodeModels(false);
  expect(listed[0]).toEqual({ id: "", label: "Default", more: false });
  expect(listed.map((m) => m.id).slice(1).sort()).toEqual([...ids].sort());
  expect(p.staticModels("OpenCode").length).toBe(listed.length);
  // A run that fails keeps the list.
  await p.refreshOpencodeModels(join(base, "missing-opencode"));
  expect(p.opencodeModels(false).length).toBe(listed.length);
});
