import { expect, test } from "bun:test";
import * as mcp from "../src/mcp.ts";
import { serve } from "../src/serve.ts";

test("an unknown app is refused", async () => {
  const lines: string[] = [];
  const err = console.error;
  console.error = (m: string) => lines.push(m);
  try {
    expect(await serve(["nope"])).toBe(2);
    expect(await serve([])).toBe(2);
  } finally {
    console.error = err;
  }
  expect(lines).toEqual(["harbor app: unknown app", "harbor app: unknown app"]);
  expect(mcp.app("gmail")?.mcp).toEqual({ kind: "harbor", name: "gmail" });
});

test("the apps agents get from Harbor are the ones serve starts", async () => {
  const names = mcp.APPS.flatMap((a) => (a.mcp.kind === "harbor" ? [a.mcp.name] : []));
  expect(names).toEqual(["gmail", "discord"]);
});
