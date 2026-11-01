import { expect, test } from "bun:test";
import { providerUpdates } from "../hub.ts";

test("provider_updates_is_null_until_a_cli_is_behind", () => {
  expect(providerUpdates({ items: [], busy: false, updating: false, error: null, done: null })).toBeNull();
  expect(
    providerUpdates({ items: [{ kind: "Codex", current: "1.0.0", latest: "1.1.0" }, { kind: "Claude", current: "2.0.0", latest: "2.1.0" }], busy: false, updating: true, error: null, done: null }),
  ).toEqual({
    items: [
      { kind: "codex", label: "Codex", logo: "p-openai.a8", current: "1.0.0", latest: "1.1.0" },
      { kind: "claude", label: "Claude", logo: "p-claude-color.rgba", current: "2.0.0", latest: "2.1.0" },
    ],
    names: "Codex and Claude",
    key: "codex=1.1.0,claude=2.1.0",
    updating: true,
    error: null,
  });
});
