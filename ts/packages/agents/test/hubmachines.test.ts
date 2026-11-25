import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entry, serverPath } from "../src/hubmachines.ts";

test("hub-machines: beside Hub's executable, run by node; none when missing", () => {
  const d = mkdtempSync(join(tmpdir(), "hubm-"));
  const exe = join(d, "hub");
  expect(serverPath({}, exe)).toBeNull();
  expect(entry({}, () => "/usr/bin/node", exe)).toBeNull();
  mkdirSync(join(d, "hub-machines"));
  writeFileSync(join(d, "hub-machines", "server.ts"), "");
  expect(entry({}, () => "/usr/bin/node", exe)).toEqual({ type: "stdio", command: "/usr/bin/node", args: [join(d, "hub-machines", "server.ts")] });
  expect(entry({}, () => null, exe)).toBeNull();
  const other = join(d, "x.ts");
  writeFileSync(other, "");
  expect(entry({ HUB_MACHINES_SERVER: other, HUB_MACHINES_CONFIG: "/c.json" }, () => "/n", exe)).toEqual({ type: "stdio", command: "/n", args: [other], env: { HUB_MACHINES_CONFIG: "/c.json" } });
});
