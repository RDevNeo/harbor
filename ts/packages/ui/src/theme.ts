// rengaf design tokens (theme.rs). `slint/theme.slint` is generated from them; a test keeps both equal.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Scale = readonly [string, string, string, string, string, string, string, string, string, string];

export interface Tokens {
  dark: boolean;
  bg100: string;
  bg200: string;
  gray: Scale;
  blue: Scale;
  red: Scale;
  amber: Scale;
  green: Scale;
}

export const LIGHT: Tokens = {
  dark: false,
  bg100: "#ffffff",
  bg200: "#f5f5f5",
  gray: ["#f2f2f2", "#ebebeb", "#e6e6e6", "#eaeaea", "#c9c9c9", "#a8a8a8", "#8f8f8f", "#7d7d7d", "#4d4d4d", "#171717"],
  blue: ["#f0f7ff", "#eaf4ff", "#e0efff", "#cce7ff", "#97ccff", "#51aeff", "#0070f7", "#005edc", "#0064e2", "#002453"],
  red: ["#ffeef0", "#ffe9ea", "#ffe4e5", "#ffd8d7", "#ffb5b6", "#ff6a6e", "#fc0035", "#e70022", "#d60020", "#46000c"],
  amber: ["#fff6e1", "#fff4d4", "#fff1c8", "#ffdd84", "#ffc85e", "#ffaa00", "#ffb200", "#ff9900", "#a64f00", "#541c00"],
  green: ["#ecfdec", "#e5fce7", "#d3fad1", "#b9f5bc", "#82eb8d", "#4ce15e", "#28a948", "#279141", "#107d32", "#00370d"],
};

export const DARK: Tokens = {
  dark: true,
  bg100: "#0a0a0a",
  bg200: "#111111",
  gray: ["#1a1a1a", "#1f1f1f", "#292929", "#2e2e2e", "#454545", "#878787", "#8f8f8f", "#7d7d7d", "#a0a0a0", "#ededed"],
  blue: ["#06193a", "#022248", "#002f62", "#003771", "#004287", "#0091ff", "#0070f7", "#005edc", "#52a8ff", "#ebf6ff"],
  red: ["#2a1314", "#3c1618", "#561a1e", "#671e22", "#832126", "#e5484d", "#e5484d", "#da3036", "#ff6166", "#feecee"],
  amber: ["#291800", "#331b00", "#4d2900", "#573200", "#6b4105", "#e79c13", "#ffb224", "#ff990a", "#f2a20d", "#fef3dd"],
  green: ["#0b2211", "#0f2e15", "#113619", "#0c451b", "#126428", "#1a9338", "#46a758", "#398e4a", "#5fc26a", "#e8fdea"],
};

/** Step `n` (100–1000) of a scale; out-of-range steps clamp like theme.rs. */
export function step(s: Scale, n: number): string {
  const i = Math.min(10, Math.max(1, Math.floor(n / 100))) - 1;
  return s[i] ?? s[0];
}

export const RADIUS_MD = 6;
export const RADIUS_LG = 8;
export const RADIUS_XL = 12;

/** A preset's line height (px) and tracking (px), as `widgets::rich` applies them. */
export function presetMetrics(name: string): [number | null, number] {
  const table: Record<string, [number, number]> = {
    "heading-32": [40, -0.04],
    "heading-24": [32, -0.04],
    "heading-20": [26, -0.02],
    "heading-16": [24, -0.02],
    "heading-14": [20, -0.02],
    "copy-16": [24, 0],
    "copy-14": [20, 0],
    "label-14": [20, 0],
    "strong-14": [20, 0],
    "button-14": [20, 0],
    "copy-13": [18, 0],
    "copy-13-mono": [18, 0],
    "label-13": [16, 0],
    "label-12": [16, 0],
    "label-12-mono": [16, 0],
    "button-12": [16, 0],
    "label-16": [20, 0],
  };
  const m = table[name];
  if (!m) return [null, 0];
  const size = name
    .split("-")
    .reverse()
    .map(Number)
    .find((n) => Number.isFinite(n));
  return [m[0], m[1] * (size ?? 14)];
}

export type Mode = "light" | "dark";

/** kv `theme`: "light" or "dark" (the sidebar's sun/moon, Settings › Appearance); anything else is dark, Harbor's own. */
export function parseMode(s: string): Mode {
  return s === "light" ? "light" : "dark";
}

/** The mode to keep when kv `theme` holds no explicit one: up to 0.149, "system" (or nothing) followed Omarchy's theme
 *  file, which Harbor no longer watches; such a PC keeps what that file says once (Harbor's dark without it); null:
 *  nothing to write. */
export function pinnedMode(stored: string | null, home: string): Mode | null {
  if (stored === "light" || stored === "dark") return null;
  const p = join(home, ".local/state/omarchy/current/theme/colors.toml");
  const file = existsSync(p) ? readFileSync(p, "utf8") : null;
  // Nothing stored and no Omarchy: nothing to keep (dark, unless the account's synced choice comes in).
  if (stored === null && file === null) return null;
  return omarchyIsDark(file) ? "dark" : "light";
}

/** Omarchy's theme file: dark unless its `mode` line says light; dark when unreadable. */
export function omarchyIsDark(text: string | null): boolean {
  if (text === null) return true;
  for (const l of text.split("\n")) {
    const eq = l.indexOf("=");
    if (eq < 0) continue;
    if (l.slice(0, eq).trim() === "mode") return !l.slice(eq + 1).includes("light");
  }
  return true;
}

const SCALES = ["gray", "blue", "red", "amber", "green"] as const;

export function themeSlint(): string {
  const lines = [
    "// Generated from src/theme.ts by `bun packages/ui/src/gen.ts`; a test keeps them equal.",
    "export global Theme {",
    "    in-out property <bool> dark: true;",
    `    out property <color> bg100: dark ? ${DARK.bg100} : ${LIGHT.bg100};`,
    `    out property <color> bg200: dark ? ${DARK.bg200} : ${LIGHT.bg200};`,
  ];
  for (const s of SCALES) {
    for (let i = 0; i < 10; i++) {
      lines.push(`    out property <color> ${s}-${(i + 1) * 100}: dark ? ${DARK[s][i]} : ${LIGHT[s][i]};`);
    }
  }
  lines.push(
    "    out property <color> fg: gray-1000;",
    "    out property <color> subtle: gray-900;",
    "    out property <color> border: gray-400;",
    "    out property <color> primary: gray-1000;",
    "    out property <color> on-primary: bg100;",
    "    out property <color> accent: gray-200;",
    "    out property <color> destructive: red-800;",
    "    out property <length> row-h: 32px;",
    "    out property <length> radius-md: 6px;",
    "    out property <length> radius-lg: 8px;",
    "    out property <length> radius-xl: 12px;",
    "}",
    "",
  );
  return lines.join("\n");
}

/** A token by its name ("blue-900", "fg", "subtle", "bg100"…) in light or dark. */
export function token(name: string, dark: boolean): string {
  const t = dark ? DARK : LIGHT;
  const alias: Record<string, string> = { fg: "gray-1000", subtle: "gray-900", border: "gray-400", primary: "gray-1000", accent: "gray-200", destructive: "red-800" };
  const n = alias[name] ?? name;
  if (n === "bg100" || n === "on-primary") return t.bg100;
  if (n === "bg200") return t.bg200;
  const m = /^(gray|blue|red|amber|green)-(\d{3,4})$/.exec(n);
  if (!m) return t.gray[9];
  const scale = m[1] === "gray" ? t.gray : m[1] === "blue" ? t.blue : m[1] === "red" ? t.red : m[1] === "amber" ? t.amber : t.green;
  return step(scale, Number(m[2]));
}
