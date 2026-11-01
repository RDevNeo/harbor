import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, itemJson, parseItem } from "../src/index.ts";

const SOURCE = join(process.env.HOME ?? "", ".cache/hts/tmp/harbor-copy.db");

test.skipIf(!existsSync(SOURCE))("opens a copy of a real harbor.db and reads every table", () => {
  const dir = mkdtempSync(join(tmpdir(), "hstore-real-"));
  const path = join(dir, "harbor.db");
  copyFileSync(SOURCE, path);
  const s = Store.openAt(path);
  const repos = s.repos();
  const chats = s.chats();
  expect(repos.length).toBeGreaterThan(0);
  expect(chats.length).toBeGreaterThan(0);
  let items = 0;
  for (const c of chats) items += s.items(c.id).length;
  const rows = (s.db.query("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
  console.log({ repos: repos.length, chats: chats.length, items, rows, results: s.results().length });
  expect(items).toBeLessThanOrEqual(rows);
  s.timers();
  s.limitTimers();
  s.procs();
  s.webhooks();
  s.mainChats();
  s.withPrefix("");
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test.skipIf(!existsSync(SOURCE))("every stored item serialises back to the same bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "hstore-real-"));
  const path = join(dir, "harbor.db");
  copyFileSync(SOURCE, path);
  const s = Store.openAt(path);
  const rows = s.db.query("SELECT body FROM items").all() as { body: string }[];
  const bad: string[] = [];
  for (const r of rows) {
    const it = parseItem(r.body);
    // Results saved before 0.39 have no "cached": Rust writes the field when it saves them again.
    if (!it || (itemJson(it) !== r.body && !(it.kind === "result" && !r.body.includes('"cached"')))) bad.push(r.body.slice(0, 200));
  }
  expect(bad.slice(0, 5)).toEqual([]);
  s.close();
  rmSync(dir, { recursive: true, force: true });
});
