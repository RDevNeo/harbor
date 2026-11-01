import "./globals.ts";
import * as slint from "slint-ui";
import * as native from "slint-ui/rust-module.cjs";
import { launch } from "./packages/update/src/launcher.ts";

Object.assign(globalThis.__harbor ?? {}, { slint, native });
process.exit(await launch(process.argv.slice(2), { embedded: await import("./app.ts") }));
