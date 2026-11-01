// Provider and app logos (logos.rs): 48×48 alpha masks (.a8) drawn white and tinted by Slint's
// `colorize`, or full-colour RGBA (.rgba).
import claudeColor from "../../../../assets/logos/p-claude-color.rgba" with { type: "file" };
import cursor from "../../../../assets/logos/p-cursor.a8" with { type: "file" };
import geminiColor from "../../../../assets/logos/p-gemini-color.rgba" with { type: "file" };
import grok from "../../../../assets/logos/p-grok.a8" with { type: "file" };
import metaColor from "../../../../assets/logos/p-meta-color.rgba" with { type: "file" };
import openai from "../../../../assets/logos/p-openai.a8" with { type: "file" };
import opencode from "../../../../assets/logos/p-opencode.a8" with { type: "file" };

export type ProviderKind = "Claude" | "Codex" | "Cursor" | "Grok" | "Gemini" | "Meta" | "OpenCode";

export interface Pixels {
  width: number;
  height: number;
  data: Uint8Array;
}

const SIZE = 48;

/** A mask's or an RGBA file's pixels, a mask as white with its alpha (`tint` colours it). */
export function pixels(bytes: Uint8Array, tint: [number, number, number] = [255, 255, 255]): Pixels {
  if (bytes.length === SIZE * SIZE * 4) return { width: SIZE, height: SIZE, data: bytes };
  if (bytes.length !== SIZE * SIZE) throw new Error(`a logo is ${SIZE}×${SIZE}: got ${bytes.length} bytes`);
  const data = new Uint8Array(SIZE * SIZE * 4);
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
  Cursor: [cursor, true],
  Grok: [grok, true],
  Gemini: [geminiColor, false],
  Meta: [metaColor, false],
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
  if (s.startsWith("cursor")) return "Cursor";
  if (s.startsWith("grok")) return "Grok";
  if (s.startsWith("gemini")) return "Gemini";
  if (s.startsWith("meta")) return "Meta";
  if (s.startsWith("opencode")) return "OpenCode";
  return "Claude";
}
