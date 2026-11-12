import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type NativeFiles = Readonly<Record<string, string>>;

export function nativeBase(env: Record<string, string | undefined> = process.env): string {
  return join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache"), "harbor");
}

// Executable files the compiled runtime carries (key: where it goes), written once next to each other so their $ORIGIN rpaths find the libraries.
export function extractNative(files: NativeFiles, base: string): string {
  const names = Object.keys(files).sort();
  const sizes = names.map((n) => `${n}:${statSync(files[n] ?? "").size}`);
  const dir = join(base, `native-${createHash("sha256").update(sizes.join("\n")).digest("hex").slice(0, 16)}`);
  if (existsSync(join(dir, ".complete"))) return dir;
  const tmp = `${dir}.${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  for (const n of names) {
    const to = join(tmp, n);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    writeFileSync(to, readFileSync(files[n] ?? ""));
  }
  writeFileSync(join(tmp, ".complete"), "");
  try {
    renameSync(tmp, dir);
  } catch {
    rmSync(tmp, { recursive: true, force: true });
    if (!existsSync(join(dir, ".complete"))) throw new Error(`could not write ${dir}`);
  }
  for (const d of readdirSync(base)) {
    if (d.startsWith("native-") && join(base, d) !== dir && !/\.\d+$/.test(d)) rmSync(join(base, d), { recursive: true, force: true });
  }
  return dir;
}

export type Addon = "sharp" | "sherpa" | "slint";

const ADDONS: Record<Addon, RegExp> = {
  sharp: /^sharp\/@img\/sharp-(linux|darwin)[^/]*\/lib\/[^/]+\.node$/,
  sherpa: /^sherpa\/sherpa-onnx\.node$/,
  slint: /^slint\/slint-ui\.(linux|darwin)-[^/]+\.node$/,
};

export function addonPath(files: NativeFiles, addon: Addon): string | null {
  const want = ADDONS[addon];
  return Object.keys(files).find((n) => want.test(n)) ?? null;
}

export function loadAddon(files: NativeFiles, addon: Addon, base: string = nativeBase()): unknown {
  const name = addonPath(files, addon);
  if (name === null) throw new Error(`this runtime carries no ${addon} for ${process.arch}`);
  const dir = extractNative(files, base);
  const m: { exports: unknown } = { exports: {} };
  process.dlopen(m, join(dir, name));
  return m.exports;
}
