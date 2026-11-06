// The captcha notes and their roles in a transcript live in net (captchanote.ts): the hub's phone
// cards (look.ts) and the desktop's read them the same way.
export { captchaNote, captchaRoles, type CaptchaNote, type CaptchaRole } from "@harbor/net";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A point of the image, as fractions of its width and height (0..1), in the page's pixels: the image shows `crop`. */
export function toPage(fx: number, fy: number, crop: Box): [number, number] {
  return [crop.x + fx * crop.width, crop.y + fy * crop.height];
}

export function inBox(x: number, y: number, b: Box): boolean {
  return x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height;
}

/** The nearest point of `b` (a release outside the captcha still lets go of what the press held). */
export function clampTo(x: number, y: number, b: Box): [number, number] {
  return [Math.min(Math.max(x, b.x), b.x + Math.max(0, b.width - 1)), Math.min(Math.max(y, b.y), b.y + Math.max(0, b.height - 1))];
}

/** Where the captcha (`rect`, page px) is on the image of `crop`, as fractions of the image, kept inside it. */
export function rectOnImage(rect: Box, crop: Box): Box {
  const cw = Math.max(crop.width, 1);
  const ch = Math.max(crop.height, 1);
  const x0 = Math.min(Math.max((rect.x - crop.x) / cw, 0), 1);
  const y0 = Math.min(Math.max((rect.y - crop.y) / ch, 0), 1);
  const x1 = Math.min(Math.max((rect.x + rect.width - crop.x) / cw, 0), 1);
  const y1 = Math.min(Math.max((rect.y + rect.height - crop.y) / ch, 0), 1);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function box(v: unknown): Box | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const [x, y, width, height] = [num(o.x), num(o.y), num(o.width), num(o.height)];
  return x === null || y === null || width === null || height === null ? null : { x, y, width, height };
}

export interface Solver {
  who: string;
  label: string;
}

export function solver(v: unknown): Solver | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  return typeof o.who === "string" && o.who !== "" ? { who: o.who, label: typeof o.label === "string" && o.label !== "" ? o.label : o.who } : null;
}

/** A 200 answer to `{action:"frame"}`. */
export interface Frame {
  captcha: string;
  guild: string | null;
  data: string | null;
  width: number;
  height: number;
  crop: Box;
  rect: Box | null;
  solver: Solver | null;
  /** The host's count of the captcha's repaints: the next long-poll asks for one after it. */
  seq: number;
  /** Nothing repainted since `after`: no data, the image shown stays. */
  same: boolean;
}

export function frame(v: unknown): Frame | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.captcha !== "string" || o.captcha === "") return null;
  const width = num(o.width) ?? 0;
  const height = num(o.height) ?? 0;
  return {
    captcha: o.captcha,
    guild: typeof o.guild === "string" && o.guild !== "" ? o.guild : null,
    data: typeof o.data === "string" && o.data !== "" ? o.data : null,
    width,
    height,
    crop: box(o.crop) ?? { x: 0, y: 0, width, height },
    rect: box(o.rect),
    solver: solver(o.solver),
    seq: num(o.seq) ?? 0,
    same: o.same === true,
  };
}

/** The line under the card's text while another device holds the captcha ("": none, or this one). */
export function solvingLine(s: Solver | null, me: string): string {
  return s === null || s.who === me ? "" : `Being solved on ${s.label}`;
}

/** The card's text. */
export function captchaText(guild: string | null): string {
  return `To join ${guild ?? "a server"}. Only the captcha takes your clicks; Harbor never answers it for you.`;
}
