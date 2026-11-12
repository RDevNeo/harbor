// The Windows modules, required on first use and only on Windows (like darwin.ts on macOS).
import { platform } from "../platform.ts";

type Win = typeof import("./index.ts");
let lib: Win | undefined;

export const win = (): Win | undefined => (platform() === "win32" ? (lib ??= require("./index.ts") as Win) : undefined);
