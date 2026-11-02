import { dirname, join } from "node:path";
import * as slint from "slint-ui";
import * as native from "slint-ui/rust-module.cjs";

Object.assign(globalThis, { __harbor: { slint, native } });
await import(process.env.HTS_BUNDLE ?? join(dirname(process.execPath), "harbor-app.js"));
