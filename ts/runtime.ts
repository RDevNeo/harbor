import "./globals.ts";
import { launch } from "./packages/update/src/launcher.ts";

// Slint loads on first use: `harbor mcp` and `harbor turn` never open a window.
Object.defineProperties(globalThis.__harbor ?? {}, {
  slint: { enumerable: true, get: () => require("slint-ui") },
  native: { enumerable: true, get: () => require("slint-ui/rust-module.cjs") },
});
process.exit(await launch(process.argv.slice(2)));
