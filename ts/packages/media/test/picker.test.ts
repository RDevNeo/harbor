import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as p from "../src/picker.ts";

const path = process.env.PATH;
let dir = "";

afterEach(() => {
  process.env.PATH = path;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

test("picker args", () => {
  const o: p.Opts = { title: "Icon", multiple: false, filter: ["Images", ["*.png", "*.svg"]], dir: "/tmp/x" };
  expect(p.zenityArgs(o)).toEqual(["--file-selection", "--separator=\n", "--title=Icon", "--file-filter=Images | *.png *.svg", "--filename=/tmp/x/"]);
  expect(p.kdialogArgs(o)).toEqual(["--getopenfilename", "/tmp/x", "Images (*.png *.svg)", "--title", "Icon"]);
  const m: p.Opts = { title: "Attach", multiple: true };
  expect(p.kdialogArgs(m)).toEqual(["--getopenfilename", ".", "--multiple", "--separate-output", "--title", "Attach"]);
  expect(p.paths(Buffer.from("/a b\n\n/c\n"))).toEqual(["/a b", "/c"]);
});

test("a picker that answers gives its paths, a cancelled one none", async () => {
  dir = mkdtempSync(join(tmpdir(), "hpick-"));
  writeFileSync(join(dir, "zenity"), '#!/bin/bash\nif [ -f "${0%/*}/cancel" ]; then exit 1; fi\nprintf "/one\\n/two w\\n"\n');
  chmodSync(join(dir, "zenity"), 0o755);
  process.env.PATH = dir;
  expect(await p.pick({ title: "Attach", multiple: true })).toEqual(["/one", "/two w"]);
  writeFileSync(join(dir, "cancel"), "");
  expect(await p.pick({})).toEqual([]);
});

test("without a picker a toast says what to install, for a few seconds", async () => {
  dir = mkdtempSync(join(tmpdir(), "hpick-"));
  process.env.PATH = dir;
  const seen: number[] = [];
  const off = p.onToast(() => seen.push(1));
  expect(await p.pick({})).toEqual([]);
  off();
  expect(seen.length).toBe(1);
  const t = p.toast();
  expect(t?.msg).toBe(p.NO_PICKER);
  expect(p.toast(Date.now() + 9000)).toBeNull();
});
