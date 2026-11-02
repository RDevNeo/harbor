import "./globals.ts";
import { launch } from "./packages/update/src/launcher.ts";

Object.defineProperties(globalThis.__harbor ?? {}, {
  slint: { enumerable: true, get: () => require("slint-ui") },
  native: { enumerable: true, get: () => require("slint-ui/rust-module.cjs") },
});
process.exit(await launch(process.argv.slice(2), { embedded: await import("./app.ts") }));
