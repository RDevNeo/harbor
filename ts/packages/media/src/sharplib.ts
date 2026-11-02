type Sharp = typeof import("sharp").default;

let lib: Promise<Sharp> | undefined;

export function sharpLib(): Promise<Sharp> {
  lib ??= import("sharp").then((m) => m.default);
  return lib;
}
