import { dirname } from "node:path";
import { defaultConfig } from "../src/config.ts";
import { launch } from "../src/launcher.ts";

const exe = process.env.FAKE_EXE ?? "";
const cfg = { ...defaultConfig(), exe, dir: exe === "" ? null : dirname(exe), runtime: process.env.FAKE_RUNTIME_VERSION ?? "0.0.0", worker: null };
process.exit(await launch(process.argv.slice(2), { cfg }));
