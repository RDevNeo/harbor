import { expect, test } from "bun:test";
import * as slint from "slint-ui";
import source from "../proto/app.slint" with { type: "text" };

test("app.slint compiles and exports the window", () => {
  const ui = slint.loadSource(source, "app.slint") as { AppWindow?: unknown };
  expect(typeof ui.AppWindow).toBe("function");
});
