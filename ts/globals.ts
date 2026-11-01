import { files } from "harbor:native";
import { loadAddon } from "./packages/update/src/native.ts";

Object.assign(globalThis, { __harbor: { addon: (name: "sharp" | "sherpa") => loadAddon(files, name) } });
