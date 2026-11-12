import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mc from "../src/movechat.ts";

const base = mkdtempSync(join(tmpdir(), "hts-move-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

test("folders_map_like_claude_code", () => {
  expect(mc.projectSlug("/nonexistent/u/Projects/harbor")).toBe("-nonexistent-u-Projects-harbor");
  expect(mc.projectSlug("/nonexistent/a.b/my work_1")).toBe("-nonexistent-a-b-my-work-1");
  expect(mc.sessionDir("/x/.claude2", "/nonexistent/p")).toBe(join("/x/.claude2", "projects", "-nonexistent-p"));
  // A symlinked folder is its real path, as `pwd -P`.
  const real = join(base, "real");
  mkdirSync(real);
  symlinkSync(real, join(base, "ln"));
  expect(mc.projectSlug(join(base, "ln"))).toBe(mc.projectSlug(real));
});

test("sessions_follow_the_chat_and_stay_behind", async () => {
  const cfg = join(base, "cfg");
  const home = join(base, "home");
  const work = join(base, "my work");
  mkdirSync(home);
  mkdirSync(work);
  // No session yet.
  expect(mc.ensureSession(cfg, "abc", work)).toBe(false);
  const old = mc.sessionDir(cfg, home);
  mkdirSync(join(old, "abc/subagents"), { recursive: true });
  writeFileSync(join(old, "abc.jsonl"), "one\n");
  writeFileSync(join(old, "abc/subagents/x.jsonl"), "s\n");
  expect(mc.ensureSession(cfg, "abc", work)).toBe(true);
  const fresh = mc.sessionDir(cfg, work);
  expect(readFileSync(join(fresh, "abc.jsonl"), "utf8")).toBe("one\n");
  expect(existsSync(join(fresh, "abc/subagents/x.jsonl"))).toBe(true);
  // The old copy stays.
  expect(existsSync(join(old, "abc.jsonl"))).toBe(true);
  // The old copy written later (a turn still running there) comes over on the next one.
  await Bun.sleep(20);
  writeFileSync(join(old, "abc.jsonl"), "one\ntwo\n");
  expect(mc.sessionCopies(cfg, "abc")[0]).toBe(join(old, "abc.jsonl"));
  mc.ensureSession(cfg, "abc", work);
  expect(readFileSync(join(fresh, "abc.jsonl"), "utf8")).toBe("one\ntwo\n");
  // Once the new one is the newest it's left alone.
  await Bun.sleep(20);
  writeFileSync(join(fresh, "abc.jsonl"), "one\ntwo\nthree\n");
  mc.ensureSession(cfg, "abc", work);
  expect(readFileSync(join(fresh, "abc.jsonl"), "utf8")).toBe("one\ntwo\nthree\n");
  expect(readFileSync(join(old, "abc.jsonl"), "utf8")).toBe("one\ntwo\n");
});
