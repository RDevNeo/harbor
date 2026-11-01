import * as slint from "slint-ui";
import * as native from "slint-ui/rust-module.cjs";
import { launch } from "./packages/update/src/launcher.ts";

Object.assign(globalThis, { __harbor: { slint, native, sherpa: () => require("sherpa-onnx-node") as unknown, sharp: () => require("sharp") as unknown } });
process.exit(await launch(process.argv.slice(2)));
