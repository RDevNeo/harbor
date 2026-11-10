/**
 * Screens the phone draws from the PC's JSON (PROTOCOL.md "Screens from the PC", `/v1/ui/…`): a
 * small, fixed set of native primitives (sections of card rows, and what a tap does: a checklist,
 * a pick list, an act with an optional confirmation, a link, or one of the app's own screens).
 * The PC decides the rows, words, glyphs and order, so a new setting or a reworded row is a PC
 * release, not a new APK. Not a UI framework: anything that needs Android itself (the camera, a
 * QR scan, the update install, notifications) stays native and is reached with `native`.
 *
 * Versioning: the phone sends the names it can draw (`prims`, Prims.KNOWN in the app, and
 * `native:<screen>` for its own screens); `fit` leaves out (or swaps for the row's `alt`) whatever
 * it doesn't know, so an older phone gets a screen it can draw. Phones without `/v1/ui` at all
 * keep their own screens and the routes those call.
 */

/** What the first phones that draw screens know (Prims.java KNOWN: a test keeps them equal). */
export const PRIMS_V1 = ["section", "row", "multi", "pick", "do", "url", "native"] as const;

/** The title's colour: "" the normal one, or the desktop's tones. */
export type Tone = "" | "muted" | "red" | "amber" | "blue";

export interface Choice {
  id: string;
  label: string;
  sub?: string;
  enabled?: boolean;
}

export interface Check {
  key: string;
  label: string;
  on: boolean;
}

/** What a tap does. Answers to `do` (and a checklist's or pick's OK) are the screen again. */
export type Tap =
  /** A checklist: OK posts `{act, values: {key: on}}`. */
  | { kind: "multi"; act: string; title: string; items: Check[] }
  /** One of a list: posts `{act, value: id}`. */
  | { kind: "pick"; act: string; title: string; note?: string; options: Choice[]; selected: string }
  /** Runs `act` on the PC (`value` with it), after `confirm` when there is one. */
  | { kind: "do"; act: string; value?: string | number | boolean; confirm?: { title: string; text: string; ok: string } }
  /** Opens an address. */
  | { kind: "url"; url: string }
  /** One of the app's own screens (`native:<screen>` in `prims`): the dictionary, the update… */
  | { kind: "native"; screen: string };

export interface Row {
  id: string;
  /** "row" is the only kind v1 phones draw; later kinds come with an `alt` for them. */
  kind: string;
  /** A Lucide glyph of the shared font (net's GLYPHS), "" for none. */
  glyph: string;
  title: string;
  sub: string;
  /** How many lines `sub` may wrap to (1: it ends in "…"). */
  lines: number;
  tone: Tone;
  /** A chevron on the right: the tap opens something. */
  chevron: boolean;
  /** A small tag on the right ("Owner"). */
  tag?: string;
  tap: Tap | null;
  /** What to draw instead for a phone that doesn't know this row's kind or tap. */
  alt?: Row;
}

export interface Section {
  id: string;
  title: string;
  rows: Row[];
}

export interface Screen {
  /** The protocol's version: a change that old phones would draw wrong gets a new one. */
  v: 1;
  sections: Section[];
  /** A line the phone shows as a toast (after an act). */
  say?: string;
}

export const row = (r: Partial<Row> & Pick<Row, "id" | "title">): Row => ({ kind: "row", glyph: "", sub: "", lines: 1, tone: "", chevron: false, tap: null, ...r });

/** The names a phone sent (`prims`), as a set; none (or junk) means the v1 set. */
export function known(prims: unknown): Set<string> {
  if (!Array.isArray(prims)) return new Set(PRIMS_V1);
  return new Set(prims.filter((p): p is string => typeof p === "string"));
}

function tapKnown(t: Tap | null, k: ReadonlySet<string>): boolean {
  if (t === null) return true;
  if (t.kind === "native") return k.has(`native:${t.screen}`);
  return k.has(t.kind);
}

function fitRow(r: Row, k: ReadonlySet<string>): Row | null {
  if (k.has(r.kind) && tapKnown(r.tap, k)) return r;
  return r.alt === undefined ? null : fitRow(r.alt, k);
}

/** The screen as a phone that knows `k` can draw it: rows it can't draw take their `alt` or go, and sections left empty go. */
export function fit(s: Screen, k: ReadonlySet<string>): Screen {
  if (!k.has("section") || !k.has("row")) return { ...s, sections: [] };
  const sections = s.sections
    .map((x) => ({ ...x, rows: x.rows.map((r) => fitRow(r, k)).filter((r): r is Row => r !== null).map(({ alt: _alt, ...r }) => r) }))
    .filter((x) => x.rows.length > 0);
  return { ...s, sections };
}
