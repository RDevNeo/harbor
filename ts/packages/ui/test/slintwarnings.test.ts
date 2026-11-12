import { expect, test } from "bun:test";
import { uiDir } from "../src/assets.ts";

// Harbor's windows load their .slint files quietly (slint-ui printed each warning as "[object Object]").
// The warnings are kept here instead, readable, and may only go down: they're deprecations to clear.
const MAX_WARNINGS = 115;

test("app.slint's compile warnings are listed here and don't grow", async () => {
  const { ComponentCompiler } = require("slint-ui/rust-module.cjs") as {
    ComponentCompiler: new () => { style: string; buildFromPath(p: string): unknown; diagnostics: { level: number; message: string; fileName: string; lineNumber: number }[] };
  };
  const c = new ComponentCompiler();
  c.style = "fluent";
  c.buildFromPath(`${await uiDir()}/app.slint`);
  const warnings = c.diagnostics.filter((d) => d.level === 1).map((d) => `${d.fileName.split("/").pop()}:${d.lineNumber}: ${d.message}`);
  const errors = c.diagnostics.filter((d) => d.level === 0);
  expect(errors).toEqual([]);
  if (warnings.length > MAX_WARNINGS) throw new Error(`new Slint warnings (${warnings.length} > ${MAX_WARNINGS}):\n${warnings.join("\n")}`);
  expect(warnings.length).toBeLessThanOrEqual(MAX_WARNINGS);
}, 30_000);
