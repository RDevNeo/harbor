// Provider and app logos (logos.rs): 48×48 alpha masks (.a8) drawn white and tinted by Slint's
// `colorize`, or full-colour RGBA (.rgba).
import claudeColor from "../../../../assets/logos/p-claude-color.rgba" with { type: "file" };
import github from "../../../../assets/logos/github.a8" with { type: "file" };
import openai from "../../../../assets/logos/p-openai.a8" with { type: "file" };
import opencode from "../../../../assets/logos/p-opencode.a8" with { type: "file" };

export type ProviderKind = "Claude" | "Codex" | "OpenCode";

export interface Pixels {
  width: number;
  height: number;
  /** Clamped: slint-ui reads a plain Uint8Array through a failed Uint8ClampedArray conversion that leaves an N-API
   * reference on the array behind, one per read (a protected object that never goes). See `clamped`. */
  data: Uint8ClampedArray;
}

const SIZE = 48;

/** A mask's or an RGBA file's pixels, a mask as white with its alpha (`tint` colours it). */
export function pixels(bytes: Uint8Array, tint: [number, number, number] = [255, 255, 255]): Pixels {
  if (bytes.length === SIZE * SIZE * 4) return { width: SIZE, height: SIZE, data: new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  if (bytes.length !== SIZE * SIZE) throw new Error(`a logo is ${SIZE}×${SIZE}: got ${bytes.length} bytes`);
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let i = 0; i < bytes.length; i++) {
    data[i * 4] = tint[0];
    data[i * 4 + 1] = tint[1];
    data[i * 4 + 2] = tint[2];
    data[i * 4 + 3] = bytes[i] ?? 0;
  }
  return { width: SIZE, height: SIZE, data };
}

const FILES: Record<ProviderKind, [string, boolean]> = {
  Claude: [claudeColor, false],
  Codex: [openai, true],
  OpenCode: [opencode, true],
};

const cache = new Map<string, Pixels>();

function hex(c: string): [number, number, number] {
  const n = Number.parseInt(c.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A provider's mark: monochrome ones in `fg` (the text colour), the others in their colours. */
export async function providerLogo(kind: ProviderKind, fg: string): Promise<Pixels> {
  const [path, mono] = FILES[kind];
  const key = `${kind}:${mono ? fg : ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = pixels(await Bun.file(path).bytes(), mono ? hex(fg) : [255, 255, 255]);
  cache.set(key, p);
  return p;
}

/** The provider of an account id as the Rust app names accounts ("claude2" is Claude). */
export function kindOfAccount(id: string): ProviderKind {
  const s = id.toLowerCase();
  if (s.startsWith("codex")) return "Codex";
  if (s.startsWith("opencode")) return "OpenCode";
  return "Claude";
}

const MARKS = { github: [github, "#181717"] } as const;
export type MarkName = keyof typeof MARKS;

/** An app's mark in its brand colour; a dark one is drawn in `fg` on the dark theme (logos.rs `tint`). */
export async function appMark(name: MarkName, fg: string, dark: boolean): Promise<Pixels> {
  const [path, brand] = MARKS[name];
  const c = hex(brand);
  const tint = dark && 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] < 70 ? hex(fg) : c;
  const key = `${name}:${tint.join(",")}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = pixels(await Bun.file(path).bytes(), tint);
  cache.set(key, p);
  return p;
}
