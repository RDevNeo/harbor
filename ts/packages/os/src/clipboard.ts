// The system clipboard by MIME type, where Harbor talks to it directly (macOS). Linux's backends are
// still in media/src/clipboard.ts (wl-copy, xclip, the Wayland data-control Worker).
import { platform } from "./platform.ts";

let darwinLib: typeof import("./darwin-clipboard.ts") | undefined;
const mac = (): typeof import("./darwin-clipboard.ts") | undefined =>
  platform() === "darwin" ? (darwinLib ??= require("./darwin-clipboard.ts") as typeof import("./darwin-clipboard.ts")) : undefined;

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
