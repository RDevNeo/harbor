import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handle } from "../src/discordrepair.ts";
import * as setup from "../src/discordsetup.ts";
import { type Started, fakeLog, mcpClient, plan, repoDiscord, rig, startHost, toolText, until } from "./discordkit.ts";

let r: ReturnType<typeof rig>;
let h: Started | undefined;
let claudeDir = "";

beforeEach(() => {
  r = rig();
  claudeDir = join(r.box.dir, "claude");
  mkdirSync(claudeDir, { recursive: true });
  const bin = join(claudeDir, "claude");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(repoDiscord, "test/fake-claude.mjs")}" "$@"\n`);
  chmodSync(bin, 0o755);
  plan(r.root, { breakable: true });
  setup.configure({
    claude: () => ({ bin, env: [["HARBOR_DISCORD_FAKE_DIR", claudeDir]] }),
    selfCommand: () => [process.execPath, join(import.meta.dir, "fakeharbor.ts")],
  });
});
afterEach(async () => {
  await h?.running.close();
  h = undefined;
  setup.configure({ claude: () => undefined, selfCommand: () => undefined });
  r.box.restore();
});

const notices = (): string => (existsSync(join(r.root, "notices.jsonl")) ? readFileSync(join(r.root, "notices.jsonl"), "utf8") : "");
const claudeLog = (): Record<string, unknown>[] => (existsSync(join(claudeDir, "claude.log")) ? readFileSync(join(claudeDir, "claude.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);

test("a new Discord breaks a lookup and the agent fixes it on the scratch page", async () => {
  writeFileSync(join(claudeDir, "claude.plan"), "fix");
  h = await startHost();
  const client = mcpClient();
  const first = toolText(await client.rpc("tools/call", { name: "discord_view", arguments: {} }));
  expect(JSON.parse(first).ran).toBe("discord_view");
  await until(() => notices().includes("Discord tools repaired"), 60_000);

  const note = notices()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { title: string; body: string })
    .find((n) => n.title === "Discord tools repaired");
  expect(note?.body).toBe("Discord renamed editMessage to updateMessage.");
  const override = JSON.parse(readFileSync(join(r.root, "override.json"), "utf8")) as { edits: { old: string; new: string; why: string }[] };
  expect(override.edits).toEqual([{ old: 'MessageActions: { props: [["sendMessage", "editMessage"]] }', new: 'MessageActions: { props: [["sendMessage", "updateMessage"]] }', why: "editMessage is updateMessage now" }]);
  expect(readFileSync(join(r.root, "page.js"), "utf8")).toContain('"sendMessage", "updateMessage"');

  const log = claudeLog();
  const argv = log[0]?.argv as string[];
  expect(argv).toContain("--strict-mcp-config");
  expect(argv[argv.indexOf("--tools") + 1]).toBe("");
  expect(argv[argv.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
  const config = JSON.parse(readFileSync(argv[argv.indexOf("--mcp-config") + 1] ?? "", "utf8")) as { mcpServers: Record<string, { command: string; args: string[] }> };
  expect(config.mcpServers.discord_repair?.args.slice(-2)).toEqual(["app", "discord-repair"]);
  const patches = log.filter((l) => l.tool === "patch");
  expect(patches.map((p) => p.isError)).toEqual([true, false]);
  expect(String(patches[0]?.text)).toContain("Edits can't add");
  // The scratch page got the low-level tools; the signed-in page only the script and the self-test.
  expect(fakeLog(r.root).filter((l) => l.op === "eval").length).toBeGreaterThan(0);
  expect(fakeLog(r.root).filter((l) => l.started === "scratch").length).toBe(1);
  expect(fakeLog(r.root).filter((l) => l.started === "run").length).toBe(1);
  await until(() => !h?.host.isRepairing());
  expect(h?.host.saved().attention).toBe("");
  expect(h?.host.saved().failing).toEqual([]);
  expect(((h?.host.status() ?? {}) as Record<string, unknown>).repairing).toBe(false);
  client.close();
}, 90_000);

test("an agent that cannot fix it is tried three times, then the user is told", async () => {
  writeFileSync(join(claudeDir, "claude.plan"), "useless");
  h = await startHost();
  await h.host.handle({ op: "call", name: "discord_view", args: {} });
  await until(() => notices().includes("Discord tools need attention"), 60_000);
  expect(claudeLog().filter((l) => l.argv).length).toBe(3);
  expect(h.host.saved().attention).toBe("Discord tools need attention");
  expect([...h.host.saved().attempts.values()]).toEqual([3]);
  expect(notices()).toContain("Harbor's repair couldn't fix the tools for Discord's new build.");
  expect(h.host.isRepairing()).toBe(false);
  expect(existsSync(join(r.root, "scratch"))).toBe(false);
});

test("without a Claude account the notice says so", async () => {
  setup.configure({ claude: () => undefined });
  h = await startHost();
  await h.host.handle({ op: "call", name: "discord_view", args: {} });
  await until(() => notices().includes("no Claude account here can repair the tools"), 30_000);
  expect(h.host.saved().attention).toBe("Discord tools need attention");
});

test("repair's requests only work while a repair runs, and only reach the scratch page", async () => {
  h = await startHost();
  await expect(handle(h.host, "repair_selftest", {})).rejects.toThrow("No repair is running.");
  h.host.setRepairing(true);
  await expect(handle(h.host, "repair_scratch", { what: "fetch", args: {} })).rejects.toThrow("No such tool.");
  await expect(handle(h.host, "repair_patch", { old: "", new: "x", why: "" })).rejects.toThrow("`old` is required.");
  await expect(handle(h.host, "repair_nothing", {})).rejects.toThrow("no such op");
  const script = (await handle(h.host, "repair_script", { around: "MessageActions", lines: 10 })) as string;
  expect(script).toContain("MessageActions");
  expect(script).toMatch(/^Lines \d+–\d+ of \d+:/);
  await handle(h.host, "repair_done", { summary: "x".repeat(300) });
  await handle(h.host, "repair_give_up", { why: "because" });
  h.host.setRepairing(false);
});
