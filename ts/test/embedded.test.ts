import { expect, test } from "bun:test";
import { isEmbedded, isOffline } from "../hub.ts";

// Person Hub runs Harbor as its engine with HARBOR_EMBEDDED=1 (hub.ts isEmbedded): only "1" turns it on.
test("HARBOR_EMBEDDED=1 is the embedded engine, nothing else is", () => {
  expect(isEmbedded({ HARBOR_EMBEDDED: "1" })).toBe(true);
  expect(isEmbedded({})).toBe(false);
  expect(isEmbedded({ HARBOR_EMBEDDED: "0" })).toBe(false);
  expect(isEmbedded({ HARBOR_EMBEDDED: "" })).toBe(false);
  // Embedded is not offline: the mesh, phones and agents run.
  expect(isOffline({ HARBOR_EMBEDDED: "1" })).toBe(false);
});
