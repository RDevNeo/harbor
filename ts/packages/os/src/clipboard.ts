// The system clipboard by MIME type, where Harbor talks to it directly (macOS, Windows). Linux's backends are
// still in media/src/clipboard.ts (wl-copy, xclip, the Wayland data-control Worker).
import { platform } from "./platform.ts";

type Lib = Pick<typeof import("./darwin-clipboard.ts"), "types" | "read" | "write" | "changeCount">;
let lib: Lib | null | undefined;
const mac = (): Lib | undefined => {
  if (lib === undefined) {
    const p = platform();
    lib =
      p === "darwin"
        ? (require("./darwin-clipboard.ts") as typeof import("./darwin-clipboard.ts"))
        : p === "win32"
          ? (require("./win32/clipboard.ts") as typeof import("./win32/clipboard.ts"))
          : null;
  }
  return lib ?? undefined;
};

/** One type of a copy. */
export interface Offer {
  mime: string;
  data: Uint8Array;
}

/** Whether this module handles the clipboard here. `name`: a private pasteboard (tests). */
export function available(): boolean {
  return mac() !== undefined;
}

export function types(name?: string): string[] | null {
  return mac()?.types(name) ?? null;
}

export function read(mime: string, name?: string): Uint8Array | null {
  return mac()?.read(mime, name) ?? null;
}

/** Puts every offer on the clipboard at once; a token that `stillOurs` recognises, or null when it failed. */
export function write(offers: readonly Offer[], name?: string): number | null {
  return mac()?.write(offers, name) ?? null;
}

/** Whether the clipboard still holds the copy `write` returned `token` for (no app copied since). */
export function stillOurs(token: number, name?: string): boolean {
  const m = mac();
  return m !== undefined && m.changeCount(name) === token;
}
