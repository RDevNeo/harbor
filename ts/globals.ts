import { files } from "harbor:native";
import { type Addon, loadAddon } from "./packages/update/src/native.ts";

Object.assign(globalThis, { __harbor: { addon: (name: Addon) => loadAddon(files, name) } });
