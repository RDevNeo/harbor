import blender from "../../../../assets/logos/blender.a8" with { type: "file" };
import convex from "../../../../assets/logos/convex.a8" with { type: "file" };
import discord from "../../../../assets/logos/discord.a8" with { type: "file" };
import github from "../../../../assets/logos/github.a8" with { type: "file" };
import gmail from "../../../../assets/logos/gmail.a8" with { type: "file" };
import linear from "../../../../assets/logos/linear.a8" with { type: "file" };
import robloxstudio from "../../../../assets/logos/robloxstudio.a8" with { type: "file" };
import sentry from "../../../../assets/logos/sentry.a8" with { type: "file" };
import supabase from "../../../../assets/logos/supabase.a8" with { type: "file" };
import vercel from "../../../../assets/logos/vercel.a8" with { type: "file" };
import whatsapp from "../../../../assets/logos/whatsapp.a8" with { type: "file" };
import { ICONS } from "./icons.ts";
import { type Pixels, pixels } from "./logos.ts";
import { token } from "./theme.ts";

export interface Tile {
  kind: "image" | "glyph" | "initial";
  logo: Pixels;
  glyph: string;
  glyph_color: string;
  initial: string;
}

type Mark = { mask: string; brand: number } | { glyph: string; brand: number | null };

/** logos.rs `mark_for`: the first of these a name contains. */
const MARKS: [string, Mark][] = [
  ["github", { mask: github, brand: 0x181717 }],
  ["vercel", { mask: vercel, brand: 0x000000 }],
  ["linear", { mask: linear, brand: 0x5e6ad2 }],
  ["sentry", { mask: sentry, brand: 0x362d59 }],
  ["supabase", { mask: supabase, brand: 0x3fcf8e }],
  ["convex", { mask: convex, brand: 0xee342f }],
  ["discord", { mask: discord, brand: 0x5865f2 }],
  ["blender", { mask: blender, brand: 0xe87d0d }],
  ["roblox", { mask: robloxstudio, brand: 0x00a2ff }],
  ["gmail", { mask: gmail, brand: 0xea4335 }],
  ["whatsapp", { mask: whatsapp, brand: 0x25d366 }],
  ["playwright", { glyph: ICONS.DRAMA, brand: 0x2ead33 }],
  ["context7", { glyph: ICONS.LIBRARY, brand: null }],
  ["omarchy", { glyph: ICONS.MONITOR, brand: null }],
];

const rgb = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
const css = (c: [number, number, number]): string => `#${c.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
const blank: Pixels = { width: 1, height: 1, data: new Uint8ClampedArray(4) };

function hex(c: string): [number, number, number] {
  const n = Number.parseInt(c.slice(1, 7), 16);
  return rgb(n);
}

/** The brand colour, or the text colour when a dark brand wouldn't read on the dark theme (logos.rs `tint`). */
function tint(brand: number, dark: boolean): [number, number, number] {
  const c = rgb(brand);
  return dark && 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] < 70 ? hex(token("fg", dark)) : c;
}

/** Every app mark's alpha mask, read once. */
export async function appTiles(): Promise<(name: string, dark: boolean) => Tile> {
  const masks = new Map<string, Uint8Array>();
  for (const [, m] of MARKS) if ("mask" in m) masks.set(m.mask, await Bun.file(m.mask).bytes());
  return (name, dark) => {
    const n = name.toLowerCase();
    const found = MARKS.find(([k]) => n.includes(k))?.[1];
    if (found && "mask" in found) return { kind: "image", logo: pixels(masks.get(found.mask) ?? new Uint8Array(), tint(found.brand, dark)), glyph: "", glyph_color: "#000000", initial: "" };
    if (found) return { kind: "glyph", logo: blank, glyph: found.glyph, glyph_color: css(found.brand === null ? hex(token("fg", dark)) : tint(found.brand, dark)), initial: "" };
    return { kind: "initial", logo: blank, glyph: "", glyph_color: "#000000", initial: Array.from(name)[0]?.toUpperCase() ?? "" };
  };
}
