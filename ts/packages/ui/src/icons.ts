// Lucide glyphs (icons.rs): codepoints in the embedded lucide.ttf subset; the table is net's glyphs.ts,
// which the hub uses for the phone too.
import { GLYPHS, type GlyphName } from "@harbor/net";

export const ICONS = GLYPHS;
export type IconName = GlyphName;
export function slintName(n: IconName): string {
  return n.toLowerCase().replaceAll("_", "-");
}

export function iconsSlint(): string {
  const lines = ["// Generated from src/icons.ts by `bun packages/ui/src/gen.ts`; a test keeps them equal.", "export global Icons {"];
  for (const [n, c] of Object.entries(ICONS)) {
    const hex = (c.codePointAt(0) ?? 0).toString(16);
    lines.push(`    out property <string> ${slintName(n as IconName)}: "\\u{${hex}}";`);
  }
  lines.push("}", "");
  return lines.join("\n");
}
