export type BtnVariant = "primary" | "outline" | "ghost" | "destructive" | "muted";

export type BadgeTone = "gray" | "green" | "amber" | "red";

export interface BlockBtn {
  key: string;
  label: string;
  icon: string;
  variant: BtnVariant;
  enabled: boolean;
  tip: string;
  on: boolean;
}

export interface BlockBadge {
  text: string;
  tone: BadgeTone;
}

export interface BlockToggle {
  key: string;
  label: string;
  on: boolean;
  tip: string;
}

export interface BlockField {
  key: string;
  hint: string;
  text: string;
  mono: boolean;
  password: boolean;
  min: number;
  width: number;
  row: number;
}

export interface BlockEdit {
  kind: "field" | "icons" | "toggles" | "warn" | "buttons" | "replace";
  label: string;
  fields: BlockField[];
  buttons: BlockBtn[];
  toggles: BlockToggle[];
  text: string;
}

export interface BlockRow {
  key: string;
  icon: string;
  title: string;
  desc: string;
  line: string;
  note: string;
  note_tone: "" | BadgeTone;
  mono_title: boolean;
  badges: BlockBadge[];
  /** Badges on the right, before the buttons (list rows). */
  side: BlockBadge[];
  buttons: BlockBtn[];
  control: "" | "toggle" | "input";
  on: boolean;
  text: string;
  hint: string;
  mono: boolean;
  width: number;
  edit: BlockEdit[];
  /** The editor sits in a well (a device's); otherwise its lines are bare. */
  well: boolean;
  /** A list row's name line is at least this tall (a line with badges: 32), then 8 to the next. */
  lead: number;
  /** A big glyph in a 32px square before the lines (a device's). */
  mark: string;
}

export interface Block {
  kind: "title" | "copy" | "status" | "rows" | "list" | "form" | "buttons" | "qr" | "gap";
  key: string;
  before: number;
  title: string;
  desc: string;
  text: string;
  size: 12 | 13 | 14;
  tone: "" | "red" | "amber";
  badge: BlockBadge;
  rows: BlockRow[];
  empty: string;
  buttons: BlockBtn[];
  fields: BlockField[];
  submit: BlockBtn;
  cancel: BlockBtn;
  frame: "none" | "card" | "header";
  chips_title: string;
  chips: BlockBtn[];
  image: BlockImage;
  height: number;
}

/** What Slint takes for an `image`: RGBA pixels. */
export interface BlockImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A tab drawn from blocks, and what its controls do. `submit` returns an error to show under the form, or "". */
export interface BlockTab {
  blocks(): Block[];
  pressed(key: string): void;
  toggled(key: string, on: boolean): void;
  edited(key: string, text: string): void;
  submitted(key: string, values: readonly string[]): string;
}

const noImage = (): BlockImage => ({ width: 1, height: 1, data: new Uint8Array(4) });

export const btn = (key: string, label: string, p: Partial<BlockBtn> = {}): BlockBtn => ({ key, label, icon: "", variant: "outline", enabled: true, tip: "", on: false, ...p });

export const badge = (text: string, tone: BlockBadge["tone"] = "gray"): BlockBadge => ({ text, tone });

export const field = (key: string, hint: string, p: Partial<BlockField> = {}): BlockField => ({ key, hint, text: "", mono: false, password: false, min: 0, width: 0, row: 0, ...p });

export const row = (title: string, p: Partial<BlockRow> = {}): BlockRow => ({
  key: "",
  icon: "",
  title,
  desc: "",
  line: "",
  note: "",
  note_tone: "",
  mono_title: false,
  badges: [],
  side: [],
  buttons: [],
  control: "",
  on: false,
  text: "",
  hint: "",
  mono: false,
  width: 0,
  edit: [],
  well: false,
  lead: 0,
  mark: "",
  ...p,
});

const block = (kind: Block["kind"], p: Partial<Block>): Block => ({
  kind,
  key: "",
  before: 0,
  title: "",
  desc: "",
  text: "",
  size: 14,
  tone: "",
  badge: badge(""),
  rows: [],
  empty: "",
  buttons: [],
  fields: [],
  submit: btn("", ""),
  cancel: btn("", ""),
  frame: "none",
  chips_title: "",
  chips: [],
  image: noImage(),
  height: 0,
  ...p,
});

/** A section's heading (pages.rs `section`): `top` is the space above it, 11 under the page's description and 18 elsewhere. */
export const title = (text: string, top = 18): Block => block("title", { title: text, height: top });

export const copy = (text: string, size: Block["size"] = 14, p: Partial<Block> = {}): Block => block("copy", { text, size, ...p });

export const status = (b: BlockBadge, text: string, p: Partial<Block> = {}): Block => block("status", { badge: b, text, size: 13, ...p });

/** A card of setting rows; `empty` shows when there are none. */
export const rows = (list: BlockRow[], p: Partial<Block> = {}): Block => block("rows", { rows: list, ...p });

/** A card of list rows (an icon and name, small lines, buttons on the right). */
export const list = (rowsOf: BlockRow[], empty: string, p: Partial<Block> = {}): Block => block("list", { rows: rowsOf, empty, ...p });

export const buttons = (bs: BlockBtn[], p: Partial<Block> = {}): Block => block("buttons", { buttons: bs, ...p });

export const gap = (height: number): Block => block("gap", { height });

/** Inputs and a button; `key` comes back with the values when it's pressed. Fields with `row: 1` go on a second line with the button. */
export const form = (key: string, fields: BlockField[], submit: BlockBtn, p: Partial<Block> = {}): Block => block("form", { key, fields, submit, ...p });

export const qr = (text: string, image: BlockImage, bs: BlockBtn[], p: Partial<Block> = {}): Block => block("qr", { text, image, buttons: bs, ...p });
