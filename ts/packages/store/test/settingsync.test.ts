import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Store, settingsync as ss } from "../src/index.ts";

const stores: Store[] = [];
const open = (): Store => {
  const s = Store.openTemp();
  stores.push(s);
  return s;
};

beforeEach(() => ss.reset());
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  ss.reset();
});

test("classes", () => {
  expect(ss.classOf("theme")).toBe("account");
  expect(ss.classOf("api_tokens")).toBe("device");
  expect(ss.classOf("worktree:12")).toBe("device");
  expect(ss.classOf("forks_of_3")).toBe("device");
  expect(ss.classOf("something_new")).toBe("device");
  const names = ss.KEYS.map(([k]) => k);
  expect(new Set(names).size).toBe(names.length);
});

test("every_kv_key_is_classified", () => {
  const root = join(import.meta.dir, "..", "..", "..", "..");
  const rustDir = join(root, "src");
  const tsDir = join(root, "ts", "packages");
  const files: [string, string][] = [];
  // Rust's sources are gone from main; an old checkout still checks them.
  if (existsSync(rustDir)) for (const f of readdirSync(rustDir)) if (f.endsWith(".rs") && f !== "settingsync.rs") files.push([f, readFileSync(join(rustDir, f), "utf8")]);
  for (const pkg of readdirSync(tsDir)) {
    const src = join(tsDir, pkg, "src");
    try {
      for (const f of readdirSync(src)) if (f.endsWith(".ts") && f !== "settingsync.ts") files.push([`${pkg}/${f}`, readFileSync(join(src, f), "utf8")]);
    } catch {
      // a package without sources yet
    }
  }
  const consts = new Map<string, string>();
  for (const [f, src] of files) {
    if (!f.endsWith(".rs")) continue;
    for (const line of src.split("\n")) {
      const m = line.trim().match(/^(?:pub )?const ([A-Z0-9_]+): &str = "([^"]*)";/);
      if (m?.[1] !== undefined && m[2] !== undefined) consts.set(m[1], m[2]);
    }
  }
  const NOT_KV = new Set(["id", "text", "state", "error", "url", "time", "files", "commit", "repo", "result", "update", "chats", "status"]);
  const missing = new Set<string>();
  let found = 0;
  const rustRecv = /(?<![A-Za-z0-9_])(?:store|s|st)\.(?:get|set|set_quiet)\(\s*&?(?:"([^"]*)"|format!\("([^{"]*)|([A-Z][A-Z0-9_]*))/g;
  const tsRecv = /(?<![A-Za-z0-9_])(?:store|s|st)\.(?:get|set|setQuiet|withPrefix)\(\s*(?:"([^"]*)"|`([^$`]*))/g;
  for (const [file, src] of files) {
    const rust = file.endsWith(".rs");
    for (const m of src.matchAll(rust ? rustRecv : tsRecv)) {
      const key = m[1] ?? m[2] ?? (m[3] ? consts.get(m[3]) : undefined);
      if (!key || !/^[a-z0-9_:]+$/.test(key)) continue;
      found++;
      if (!ss.listed(key) && !NOT_KV.has(key)) missing.add(`${file}: ${key}`);
    }
  }
  expect(found).toBeGreaterThan(30);
  expect([...missing].sort()).toEqual([]);
});

test("first_sign_in_keeps_this_pcs_settings", () => {
  const fill = ss.firstFill(["theme"], { theme: { v: "light", at: 9 }, density: { v: "compact", at: 9 } });
  expect("theme" in fill).toBe(false);
  expect("density" in fill).toBe(true);
});

test("replaced_values_are_backed_up", () => {
  const s = open();
  s.setQuiet("voice_model", "small");
  ss.apply(s, { voice_model: { v: "tiny", at: Number.MAX_SAFE_INTEGER - 1 } });
  expect(s.get("voice_model")).toBe("tiny");
  const b = JSON.parse(s.get("account_sync_backup") ?? "{}") as Record<string, string>;
  expect(b.voice_model).toBe("small");
});

test("newest_wins", () => {
  const s = open();
  s.setQuiet("theme", "dark");
  ss.internals.at.set("theme", 100);
  expect(ss.apply(s, { theme: { v: "light", at: 50 }, density: { v: "compact", at: 200 }, api_tokens: { v: "[]", at: 999 } })).toBe(true);
  expect(s.get("theme")).toBe("dark");
  expect(s.get("density")).toBe("compact");
  expect(s.get("api_tokens")).toBeNull();
  ss.internals.dirty.set("theme", 160);
  ss.apply(s, { theme: { v: "light", at: 150 } });
  expect(s.get("theme")).toBe("dark");
});

test("a sync sends this PC's changes and takes the account's", async () => {
  const s = open();
  ss.sync_state.track = true;
  try {
    s.set("theme", "dark");
    ss.internals.at.set("~", 1);
    const sent: unknown[] = [];
    await ss.sync(s, "tok", false, async (_t, body) => {
      sent.push(body);
      return { settings: { density: { v: "compact", at: Date.now() + 5 } } };
    });
    expect(Object.keys((sent[0] as { set: object }).set)).toEqual(["theme"]);
    expect(s.get("density")).toBe("compact");
    expect(ss.internals.dirty.size).toBe(0);
    expect(s.get("account_sync")).toContain("theme");
  } finally {
    ss.sync_state.track = false;
  }
});
