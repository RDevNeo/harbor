import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { appId } from "../src/loop.ts";

test("Harbor's windows carry the desktop entry's id; a preview's is its own", () => {
  const entry = readFileSync(new URL("../../../../packaging/harbor.desktop", import.meta.url), "utf8");
  expect(entry).toContain(`StartupWMClass=${appId({})}`);
  expect(appId({})).toBe("harbor");
  expect(appId({ HARBOR_PREVIEW_APP: "/tmp/rig" })).toBe("harbor-preview");
});
