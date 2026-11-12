import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComposerMenus, type MenuContext } from "../src/composer.ts";

test("the @ menu's file list is read in the background and shown when it arrives", async () => {
  const d = mkdtempSync(join(tmpdir(), "harbor-menufiles-"));
  mkdirSync(join(d, "docs"));
  writeFileSync(join(d, "docs", "plan.md"), "x");
  const ctx: MenuContext = { key: 0, cwd: d, repo: null, home: d, modes: { efforts: [], access: [] }, access: "", personal: join(d, "none"), chat: null, chats: [] };
  const m = new ComposerMenus();
  let told = 0;
  m.onFiles = () => told++;
  // The first ask returns at once, without the files yet.
  const first = m.update("see @pla", 8, ctx);
  expect(first.some((r) => r.label.includes("plan.md"))).toBe(false);
  for (let i = 0; i < 100 && told === 0; i++) await Bun.sleep(10);
  expect(told).toBe(1);
  const again = m.update("see @pla", 8, ctx);
  expect(again.some((r) => r.label.includes("plan.md"))).toBe(true);
  rmSync(d, { recursive: true, force: true });
});
