import { afterAll, beforeAll, expect, test } from "bun:test";
import { command, detect, ProviderUpdates, updatedText, type Io } from "../src/provupdate.ts";
// Automatic updates are what's under test: a PC or rig that turns them off (HARBOR_OFFLINE,
// HARBOR_NO_PROVIDER_UPDATES) doesn't turn them off here.
const OFF = ["HARBOR_OFFLINE", "HARBOR_NO_PROVIDER_UPDATES"] as const;
const saved = new Map<string, string | undefined>();
beforeAll(() => {
  for (const k of OFF) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
});
afterAll(() => {
  for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
});
function fake(path: string, real = path) {
  let installed = "2.1.1";
  const calls: string[][] = [];
  const io: Io = {
    which: (n) => n === "claude" ? path : n === "codex" ? null : `/usr/bin/${n}`,
    real: (p) => p === path ? real : p,
    latest: async () => "2.1.9",
    run: async (a) => {
      calls.push(a);
      if (a.includes("--version")) return `${installed} (Claude Code)`;
      if (a[1] === "which") return "/home/user/.local/share/mise/installs/claude/2.1.1/bin/claude";
      if (a[1] === "root") return "/usr/lib/node_modules";
      installed = "2.1.9";
      return "";
    },
  };
  return { io, calls };
}
test("mise installs exact npm latest without changing latest config", async () => {
  const f = fake("/home/user/.local/share/mise/shims/claude");
  const u = new ProviderUpdates(f.io);
  await u.check("claude");
  expect(u.list()[0]).toMatchObject({ current: "2.1.1", latest: "2.1.9", available: true, method: "mise" });
  await u.update("claude");
  expect(f.calls).toContainEqual(["/usr/bin/mise", "install", "claude@2.1.9"]);
  expect(u.list()[0]).toMatchObject({ current: "2.1.9", available: false });
});
test("native updates active executable", async () => {
  const f = fake("/home/user/.local/bin/claude", "/home/user/.local/share/claude/versions/2.1.1");
  expect(command(await detect("claude", f.io), "2.1.9")).toEqual([f.io.which("claude")!, "update"]);
});
test("brew upgrades owning formula rather than npm", async () => {
  const f = fake("/usr/bin/claude", "/usr/Cellar/claude-code/2.1.1/bin/claude");
  expect(command(await detect("claude", f.io), "2.1.9")).toEqual(["/usr/bin/brew", "upgrade", "claude-code"]);
});
test("npm requires its global root to own active CLI", async () => {
  const f = fake("/usr/bin/claude", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js");
  expect(command(await detect("claude", f.io), "2.1.9")).toEqual(["/usr/bin/npm", "install", "--global", "@anthropic-ai/claude-code@2.1.9"]);
  const wrong = fake("/opt/bin/claude", "/opt/lib/node_modules/@anthropic-ai/claude-code/cli.js");
  expect((await detect("claude", wrong.io)).method).toBe("other");
});
test("unknown install gives guidance without running installer", async () => {
  const f = fake("/usr/bin/claude");
  const u = new ProviderUpdates(f.io);
  await u.update("claude");
  expect(f.calls).toEqual([]);
  expect(u.list()[0]?.status).toContain("installer that owns");
});
test("running turn blocks mutation", async () => {
  const f = fake("/home/user/.local/share/mise/shims/claude");
  const u = new ProviderUpdates(f.io, () => {}, () => false);
  await u.update("claude");
  expect(f.calls).toEqual([]);
  expect(u.list()[0]?.status).toContain("queued until");
});
test("failed install preserves update offer and error", async () => {
  const f = fake("/home/user/.local/share/mise/shims/claude");
  const run = f.io.run;
  f.io.run = async (a) => { if (a[1] === "install") throw new Error("Permission denied"); return run(a); };
  const u = new ProviderUpdates(f.io);
  await u.check("claude");
  await u.update("claude");
  expect(u.list()[0]).toMatchObject({ available: true, busy: false, status: "Error: Permission denied" });
});
test("pins or lagging brew remain visible after unsuccessful activation", async () => {
  const f = fake("/usr/bin/claude", "/usr/Cellar/claude-code/2.1.1/bin/claude");
  const run = f.io.run;
  f.io.run = async (a) => a[1] === "upgrade" ? "" : run(a);
  const u = new ProviderUpdates(f.io);
  await u.update("claude");
  expect(u.list()[0]?.status).toContain("did not activate");
  expect(u.list()[0]?.available).toBe(true);
});
test("queued updates run once the PC becomes idle", async () => {
  let idle = false;
  const f = fake("/home/user/.local/share/mise/shims/claude");
  const u = new ProviderUpdates(f.io, () => {}, () => idle);
  await u.update("claude");
  idle = true;
  u.tick();
  await u.pending();
  expect(f.calls.filter((a) => a[1] === "install")).toHaveLength(1);
});
test("concurrent update requests share one install", async () => {
  const f = fake("/home/user/.local/share/mise/shims/claude");
  const u = new ProviderUpdates(f.io);
  await Promise.all([u.update("claude"), u.update("claude"), u.check("claude")]);
  expect(f.calls.filter((a) => a[1] === "install")).toHaveLength(1);
});
test("automatic updates do not retry a pinned version every tick", async () => {
  const f = fake("/home/user/.local/share/mise/shims/claude");
  const run = f.io.run;
  f.io.run = async (a) => a[1] === "install" ? (f.calls.push(a), "") : run(a);
  const u = new ProviderUpdates(f.io);
  await u.check("claude");
  u.tick();
  await u.pending();
  u.tick();
  expect(u.pending()).toBeNull();
  expect(f.calls.filter((a) => a[1] === "install")).toHaveLength(1);
});
test("Codex uses its own npm package and rejects invalid target versions", async () => {
  const f = fake("/usr/bin/claude");
  f.io.which = (n) => `/usr/bin/${n}`;
  f.io.real = (p) => p === "/usr/bin/codex" ? "/usr/lib/node_modules/@openai/codex/bin/codex.js" : p;
  const i = await detect("codex", f.io);
  expect(command(i, "0.99.1")).toEqual(["/usr/bin/npm", "install", "--global", "@openai/codex@0.99.1"]);
  expect(() => command(i, "latest;bad")).toThrow();
});
test("updates are told once, together, after nothing else is left to update", async () => {
  let claude = "2.1.1", codex = "0.1.0";
  const told: string[] = [];
  const io: Io = {
    which: (n) => `/home/user/.local/share/mise/shims/${n}`,
    real: (p) => p,
    latest: async (t) => t === "claude" ? "2.1.9" : "0.2.0",
    run: async (a) => {
      if (a.includes("--version")) return a[0]!.endsWith("claude") ? `${claude} (Claude Code)` : `codex-cli ${codex}`;
      if (a[1] === "which") return `/home/user/.local/share/mise/installs/${a[2]}/x/bin/${a[2]}`;
      if (a[1] === "install") { if (a[2]!.startsWith("claude@")) claude = "2.1.9"; else codex = "0.2.0"; }
      return "";
    },
  };
  const u = new ProviderUpdates(io, () => {}, () => true, (d) => told.push(updatedText(d, "pc1")));
  await Promise.all([u.check("claude"), u.check("codex")]);
  u.tick();
  await u.pending();
  expect(told).toEqual([]);
  u.tick();
  await u.pending();
  expect(told).toEqual([]);
  u.tick();
  expect(told).toEqual(["Claude Code updated to 2.1.9 and Codex to 0.2.0 on pc1"]);
  u.tick();
  expect(told.length).toBe(1);
});
test("Codex's standalone installer updates itself", async () => {
  const io: Io = {
    which: (n) => n === "codex" ? "/home/user/.local/bin/codex" : null,
    real: (p) => p === "/home/user/.local/bin/codex" ? "/home/user/.codex/packages/standalone/releases/0.161.0-x86_64-unknown-linux-musl/bin/codex" : p,
    latest: async () => "0.167.0",
    run: async () => "",
  };
  expect(command(await detect("codex", io), "0.167.0")).toEqual(["/home/user/.local/bin/codex", "update"]);
});
test("a running Claude turn doesn't hold Codex's update back", async () => {
  let codex = "0.1.0";
  const io: Io = {
    which: (n) => `/home/user/.local/share/mise/shims/${n}`,
    real: (p) => p,
    latest: async (t) => t === "claude" ? "2.1.9" : "0.2.0",
    run: async (a) => {
      if (a.includes("--version")) return a[0]!.endsWith("claude") ? "2.1.1 (Claude Code)" : `codex-cli ${codex}`;
      if (a[1] === "which") return `/home/user/.local/share/mise/installs/${a[2]}/x/bin/${a[2]}`;
      if (a[1] === "install" && a[2]!.startsWith("codex@")) codex = "0.2.0";
      return "";
    },
  };
  const u = new ProviderUpdates(io, () => {}, (t) => t !== "claude");
  await Promise.all([u.check("claude"), u.check("codex")]);
  u.tick();
  expect(u.pending("claude")).toBeNull();
  await u.pending("codex");
  expect(u.list().map((s) => s.current)).toEqual(["2.1.1", "0.2.0"]);
});

test("an offline run or a test session never updates the CLIs by itself", async () => {
  const { autoUpdates } = await import("../src/provupdate.ts");
  expect(autoUpdates({})).toBe(true);
  expect(autoUpdates({ HARBOR_OFFLINE: "1" })).toBe(false);
  expect(autoUpdates({ HARBOR_NO_PROVIDER_UPDATES: "1" })).toBe(false);
});
test("on Windows: Claude's own claude.exe updates itself, an npm shim is npm's", async () => {
  const native = fake("C:\\Users\\sam\\.local\\bin\\claude.exe");
  expect(command(await detect("claude", native.io), "2.1.9")).toEqual(["C:\\Users\\sam\\.local\\bin\\claude.exe", "update"]);
  const shim = "C:\\Users\\sam\\AppData\\Roaming\\npm\\claude.cmd";
  const io: Io = { ...fake(shim).io, which: (n) => (n === "claude" ? shim : n === "npm" ? "C:\\Program Files\\nodejs\\npm.cmd" : null), run: async (a) => (a[1] === "root" ? "C:\\Users\\sam\\AppData\\Roaming\\npm\\node_modules" : "") };
  expect(command(await detect("claude", io), "2.1.9")).toEqual(["C:\\Program Files\\nodejs\\npm.cmd", "install", "--global", "@anthropic-ai/claude-code@2.1.9"]);
  // A shim of another npm prefix isn't this one's to update.
  const other: Io = { ...io, run: async (a) => (a[1] === "root" ? "D:\\npm\\node_modules" : "") };
  expect(command(await detect("claude", other), "2.1.9")).toBeNull();
});
