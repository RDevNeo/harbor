// The Slint window's properties and callbacks as TypeScript sees them (slint-ui turns `-` into
// `_`), and loading it from `assets.ts`'s folder.
import { join } from "node:path";
import * as slint from "slint-ui";
import { uiDir } from "./assets.ts";
import type { Pixels } from "./logos.ts";

export interface StatusData {
  kind: "working" | "done" | "failed" | "text";
  text: string;
  icon: string;
  color: string;
}

export interface SideRow {
  kind: "project" | "thread" | "loose" | "label";
  id: number;
  title: string;
  active: boolean;
  status: StatusData;
  letter: string;
  avatar: Pixels;
  has_avatar: boolean;
  settled: boolean;
  snoozed: boolean;
  worktree: number;
  tip: string;
}

export interface MdBlockData {
  kind: string;
  text: slint.StyledText;
  code: string;
  level: number;
  marker: string;
  depth: number;
  quote: number;
  cells: slint.StyledText[];
  header: boolean;
  gap: number;
}

export interface MediaRow {
  image: Pixels;
  caption: string;
  large: boolean;
  w: number;
  h: number;
  path: string;
}

export interface CardData {
  kind: "" | "user" | "text" | "thinking" | "tool" | "group" | "notice" | "message" | "error" | "divider" | "space" | "status" | "earlier" | "steering" | "queue-head" | "queued" | "queue-more";
  seq: number;
  blocks: MdBlockData[];
  text: string;
  label: string;
  icon: string;
  tone: string;
  detail: string;
  result: string;
  open: boolean;
  pending: boolean;
  expandable: boolean;
  sender: string;
  files: string[];
  steer: boolean;
  url: string;
  actions: string[];
  time: string;
  media: MediaRow[];
}

export interface MenuEntry {
  icon: string;
  label: string;
  desc: string;
  section: string;
}

export interface ComposerState {
  model: string;
  model_tip: string;
  badge: string;
  has_effort: boolean;
  effort: string;
  access: string;
  access_icon: string;
  device: string;
  action: "send" | "stop" | "steer" | "queue" | "update" | "resume";
  action_tip: string;
  hint: string;
  typing: string;
  notice: string;
}

export interface PopItem {
  kind: "item" | "label" | "separator" | "header" | "gap" | "choice" | "input";
  icon: string;
  label: string;
  desc: string;
  checked: boolean;
  enabled: boolean;
  badge: string;
}

export interface Crumbs {
  icon: string;
  project: string;
  parent: string;
  title: string;
  branch: string;
  changed: number;
}

export interface AgentRow {
  id: number;
  name: string;
  model: string;
  task: string;
  status: string;
  status_icon: string;
  status_color: string;
  running: boolean;
  settled: boolean;
  logo: Pixels;
  badge: string;
}

export interface WakeRow {
  id: number;
  time: string;
  tip: string;
  reason: string;
}

export interface HookRow {
  id: number;
  name: string;
  public: boolean;
  calls: string;
  description: string;
  url: string;
}

export interface RailItem {
  id: string;
  logo: Pixels;
  badge: string;
  active: boolean;
  dim: boolean;
  tip: string;
}

export interface ModelRow {
  label: string;
  sub: string;
  logo: Pixels;
  enabled: boolean;
  current: boolean;
  favorite: boolean;
}

export interface StripRow {
  id: number;
  name: string;
  logo: Pixels;
  badge: string;
  tip: string;
}

export interface ProcItem {
  id: number;
  name: string;
  url: string;
  cmd: string;
  open: boolean;
  output: string;
}

export interface KeyEvent {
  text: string;
  modifiers: { alt: boolean; control: boolean; shift: boolean; meta: boolean };
  repeat: boolean;
}

export interface AppWindow extends slint.ComponentHandle {
  dark: boolean;
  compact: boolean;
  view: string;
  sidebar_open: boolean;
  readonly narrow: boolean;

  side_rows: slint.Model<SideRow>;
  side_settled: slint.Model<SideRow>;
  settled_count: number;
  settled_open: boolean;
  search: string;
  running: number;
  side_empty: string;
  open_chat: (id: number) => void;
  open_project: (id: number) => void;
  new_chat: (repo: number) => void;
  new_thread: () => void;
  add_project: () => void;
  settle: (id: number, on: boolean) => void;
  snooze: (key: string, x: number, y: number) => void;
  chat_menu: (id: number, x: number, y: number) => void;
  project_menu: (id: number, x: number, y: number) => void;
  searched: (q: string) => void;
  palette: () => void;
  filter: (x: number, y: number) => void;
  settings: () => void;
  prs: () => void;
  issues: () => void;
  refresh: () => void;

  crumbs: Crumbs;
  team_enabled: boolean;
  team_on: boolean;
  team_agents: slint.Model<AgentRow>;
  team_settled: slint.Model<AgentRow>;
  team_wakeups: slint.Model<WakeRow>;
  team_hooks: slint.Model<HookRow>;
  team_procs: slint.Model<ProcItem>;
  team_earlier: slint.Model<{ id: number; title: string; ago: string }>;
  proc_stop: (id: number) => void;
  proc_toggle: (id: number) => void;
  proc_open: (url: string) => void;
  team_has_project: boolean;
  team_settled_open: boolean;
  team: () => void;
  open_agent: (id: number) => void;
  settle_agent: (id: number, on: boolean) => void;
  stop_agent: (id: number) => void;
  cancel_wakeup: (id: number) => void;
  wake_now: (id: number) => void;
  copy_hook: (url: string) => void;
  delete_hook: (id: number) => void;
  team_settled_toggled: (on: boolean) => void;
  project_clicked: (x: number, y: number) => void;
  parent_clicked: () => void;
  close_window: () => void;

  hero_subtitle: string;
  hero_link: boolean;
  hero_note: string;
  hero: boolean;
  cards: slint.Model<CardData>;
  chat_running: boolean;
  read_only: boolean;
  read_only_text: string;
  read_only_action: string;
  read_only_act: () => void;
  toggle: (seq: number) => void;
  link: (url: string) => void;
  open_url: (url: string) => void;
  card_act: (seq: number, action: string) => void;
  queue_menu: (id: number, x: number, y: number) => void;
  open_media: (path: string) => void;

  draft: string;
  composer: ComposerState;
  model_logo: Pixels;
  files: slint.Model<{ name: string; image: boolean }>;
  menu: slint.Model<MenuEntry>;
  menu_selected: number;
  readonly cursor: number;
  edited: (text: string) => void;
  key: (e: KeyEvent) => boolean;
  send: () => void;
  stop: () => void;
  attach: () => void;
  mic: () => void;
  remove_file: (i: number) => void;
  menu_pick: (i: number) => void;
  menu_hover: (i: number) => void;
  popup: (id: string, x: number, y: number) => void;
  untrusted: boolean;
  trust: () => void;
  mentions: slint.Model<{ head: string; snippet: string; tip: string }>;
  remove_mention: (i: number) => void;
  strip_rows: slint.Model<StripRow>;
  strip_title: string;
  strip_names: string;
  strip_header: boolean;
  strip_folded: boolean;
  strip_open: boolean;
  strip_asking: number;
  strip_open_agent: (id: number) => void;
  strip_ask_stop: (id: number) => void;
  strip_stop: (id: number) => void;
  strip_cancel: () => void;
  strip_head: () => void;
  strip_stop_all: () => void;

  pop_id: string;
  pop_items: slint.Model<PopItem>;
  pop_x: number;
  pop_y: number;
  pop_w: number;
  pop_above: boolean;
  pop_pick: (id: string, i: number) => void;
  pop_close: () => void;
  pop_input: string;
  pop_input_note: string;
  pop_input_ok: boolean;
  pop_input_edited: (t: string) => void;
  pop_input_accept: () => void;

  picker_rail: slint.Model<RailItem>;
  picker_favorites: boolean;
  picker_rows: slint.Model<ModelRow>;
  picker_hover: number;
  picker_more_label: string;
  picker_more_count: number;
  picker_in_more: boolean;
  picker_empty: string;
  picker_search: string;
  picker_rail_pick: (id: string) => void;
  picker_pick: (i: number) => void;
  picker_star: (i: number) => void;
  picker_more: () => void;
  picker_back: () => void;
  picker_searched: (t: string) => void;
  picker_key: (e: KeyEvent) => boolean;

  dialog_id: string;
  dialog_title: string;
  dialog_text: string;
  dialog_input: string;
  dialog_has_input: boolean;
  dialog_ok: string;
  dialog_danger: boolean;
  dialog_done: (id: string, ok: boolean) => void;

  global_key: (e: KeyEvent) => boolean;
  readonly at_end: boolean;
  focus_composer(): void;
  set_cursor(at: number): void;
  scroll_to_end(): void;
  copy_text(t: string): void;
}

function isCtor(v: unknown): v is new () => AppWindow {
  return typeof v === "function";
}

export async function loadWindow(): Promise<AppWindow> {
  const ui = slint.loadFile(join(await uiDir(), "app.slint"), { style: "fluent" });
  const ctor = Reflect.get(ui, "AppWindow");
  if (!isCtor(ctor)) throw new Error("app.slint has no AppWindow");
  return new ctor();
}

export const blankStatus = (): StatusData => ({ kind: "text", text: "", icon: "", color: "#00000000" });

export const noPixels: Pixels = { width: 1, height: 1, data: new Uint8Array(4) };
