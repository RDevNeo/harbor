import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secrets, Store } from "@harbor/store";
import { secretsBlocks, secretsLeft, secretsTab, type SecretsHost } from "../src/logic/settings-secrets.ts";

const NOW = 5_000;
const dirs: string[] = [];

function setup(): SecretsHost {
  const dir = mkdtempSync(join(tmpdir(), "hui-secrets-"));
  dirs.push(dir);
  return { store: Store.openTemp(), path: join(dir, "secrets.json"), chatLabel: (c) => (c === 7 || c === 8 ? "Fix the build" : ""), told: () => {}, now: () => NOW };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("secretsui.rs secrets_tab", () => {
  test("an_empty_tab_has_the_form_and_the_notes", () => {
    const h = setup();
    const b = secretsBlocks(h, null);
    expect(b.map((x) => x.kind)).toEqual(["title", "form", "title", "list", "copy", "copy"]);
    expect(b[0]?.title).toBe("Add a secret");
    expect(b[1]?.fields.map((f) => [f.hint, f.mono, f.password, f.row])).toEqual([
      ["Name", true, false, 0],
      ["Value", false, true, 0],
      ["What it's for", false, false, 0],
    ]);
    expect(b[1]?.submit.label).toBe("Save");
    expect(b[3]?.empty).toBe("None yet. Add one above, or an agent asks for one when it needs it.");
    expect(b[5]?.text).toBe(`Kept in ${h.path} (only you can read it), on this PC only: never synced to your other PCs or phones.`);
  });

  test("saving_adds_a_row_with_dots_and_how_long_ago", () => {
    const h = setup();
    const tab = secretsTab(h);
    expect(tab.submitted("add", ["boat-api-key", " s3cret-value ", "the boat"])).toBe("");
    const list = tab.blocks().find((x) => x.kind === "list");
    expect(list?.rows.map((r) => [r.title, r.mono_title, r.buttons.map((x) => x.label)])).toEqual([["BOAT_API_KEY", true, ["Replace", "Delete"]]]);
    expect(list?.rows[0]?.desc.startsWith("••••••••  ·  the boat  ·  ")).toBe(true);
    expect(secrets.load(h.path).map((s) => [s.name, s.value])).toEqual([["BOAT_API_KEY", "s3cret-value"]]);
  });

  test("a_bad_name_or_short_value_comes_back_as_the_error", () => {
    const tab = secretsTab(setup());
    expect(tab.submitted("add", ["bad name!", "longenough", ""])).toBe("A name has letters, digits and _ only, like BOAT_API_KEY.");
    expect(tab.submitted("add", ["OK_NAME", "abc", ""])).toBe("The value needs at least 4 characters.");
  });

  test("replace_opens_a_password_line_and_cancel_closes_it", () => {
    const h = setup();
    secrets.save("KEY_A", "first-value", "", h.path);
    const tab = secretsTab(h);
    tab.pressed("replace:KEY_A");
    const row = tab.blocks().find((x) => x.kind === "list")?.rows[0];
    expect(row?.buttons.map((x) => x.label)).toEqual(["Delete"]);
    expect(row?.edit[0]).toMatchObject({ kind: "replace" });
    expect(row?.edit[0]?.fields[0]).toMatchObject({ hint: "New value", password: true, min: 4 });
    expect(row?.edit[0]?.buttons.map((x) => x.label)).toEqual(["Save", "Cancel"]);
    tab.pressed("cancel");
    expect(tab.blocks().find((x) => x.kind === "list")?.rows[0]?.edit).toEqual([]);
  });

  test("replacing_keeps_the_description_and_closes", () => {
    const h = setup();
    secrets.save("KEY_A", "first-value", "kept", h.path);
    const tab = secretsTab(h);
    tab.pressed("replace:KEY_A");
    expect(tab.submitted("save:KEY_A", ["abc"])).toBe("The value needs at least 4 characters.");
    expect(tab.submitted("save:KEY_A", ["second-value"])).toBe("");
    expect(secrets.load(h.path).map((s) => [s.value, s.description])).toEqual([["second-value", "kept"]]);
    expect(tab.blocks().find((x) => x.kind === "list")?.rows[0]?.edit).toEqual([]);
  });

  test("deleting_drops_the_key_and_its_grants", () => {
    const h = setup();
    secrets.save("KEY_A", "first-value", "", h.path);
    secrets.save("KEY_B", "second-value", "", h.path);
    secrets.saveGrants(h.store, [
      { chat: 7, name: "KEY_A", until: NOW + 100 },
      { chat: 7, name: "KEY_B", until: NOW + 100 },
    ]);
    const tab = secretsTab(h);
    tab.pressed("delete:KEY_A");
    expect(secrets.names(h.path).map((s) => s.name)).toEqual(["KEY_B"]);
    expect(secrets.loadGrants(h.store).map((g) => g.name)).toEqual(["KEY_B"]);
  });

  test("allowed_now_lists_live_grants_with_what_is_left", () => {
    const h = setup();
    secrets.saveGrants(h.store, [
      { chat: 7, name: "KEY_A", until: NOW + 90 * 60 },
      { chat: 8, name: "KEY_B", until: NOW - 1 },
    ]);
    const b = secretsBlocks(h, null);
    const i = b.findIndex((x) => x.title === "Allowed now");
    expect(b[i + 1]?.rows.map((r) => [r.title, r.desc, r.buttons.map((x) => [x.key, x.tip])])).toEqual([["KEY_A", "Fix the build  ·  1h30m left", [["revoke:7:KEY_A", "It can't use the key from now on"]]]]);
  });

  test("revoking_removes_the_grant_and_tells_a_chat_that_exists", () => {
    const h = setup();
    secrets.saveGrants(h.store, [
      { chat: 7, name: "KEY_A", until: NOW + 100 },
      { chat: 9, name: "KEY_A", until: NOW + 100 },
    ]);
    const told: [number, string][] = [];
    const tab = secretsTab({ ...h, told: (c, n) => told.push([c, n]) });
    tab.pressed("revoke:7:KEY_A");
    tab.pressed("revoke:9:KEY_A");
    expect(secrets.loadGrants(h.store)).toEqual([]);
    expect(told).toEqual([[7, "KEY_A"]]);
  });

  test("what_is_left_reads_like_the_rust_one", () => {
    expect(secretsLeft(NOW + 10, NOW)).toBe("<1m");
    expect(secretsLeft(NOW + 600, NOW)).toBe("10m");
    expect(secretsLeft(NOW + 3 * 3600 + 5 * 60, NOW)).toBe("3h05m");
    expect(secretsLeft(NOW - 5, NOW)).toBe("<1m");
  });
});
