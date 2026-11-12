// The Slint window's properties and callbacks as TypeScript sees them (slint-ui turns `-` into
// `_`), and loading it from `assets.ts`'s folder.
import { dlopen, FFIType } from "bun:ffi";
import { join } from "node:path";
import * as slint from "slint-ui";
import { malloc } from "@harbor/store";
import type { TermKey } from "./logic/terminal.ts";
import type { PatchChipData } from "./logic/patchchips.ts";
import { type TipParts, tipParts } from "./logic/tips.ts";
import type { TermFrame } from "./terminal.ts";
import { uiDir } from "./assets.ts";
import { busOf } from "./pages/bus.ts";
import type { Pixels } from "./logos.ts";

export interface StatusData {
  kind: "working" | "done" | "failed" | "waiting" | "limited" | "busy" | "text";
  text: string;
  icon: string;
  color: string;
}

export interface SideRow {
  kind: "project" | "thread" | "loose" | "label" | "settled-project";
  id: number;
  title: string;
  active: boolean;
  status: StatusData;
  letter: string;
  avatar: Pixels;
  has_avatar: boolean;
  settled: boolean;
  snoozed: boolean;
  worktree: "" | "live" | "gone";
  worktree_tip: string;
  pr: "" | "open" | "draft" | "merged" | "closed";
  pr_tip: string;
  tip: string;
  /** A project row's hint after its name: the PC that holds its folder when it isn't here (projectplace.ts). */
  place: string;
  /** `place` names a PC (else this PC's folder). */
  place_pc: boolean;
  /** Share with workspace…: "" not shared, "shared", "here" (the filter shows it only because it's shared). */
  shared: "" | "shared" | "here";
  /** "Owned by X · shared with Y". */
  shared_tip: string;
  /** A project row's fold: "" no chats under it, "open", "folded" (the chevron before its icon). */
  fold: "" | "open" | "folded";
  /** A chat row's last activity, "13m ago" ("now"): on its right while nothing else is to say. */
  ago: string;
  /** The branch it works on (its worktree's, else its project's checkout's), without Harbor's "harbor/" ("" none):
   *  after its title. */
  branch: string;
  /** The last chat under its project: the guide line ends with it. */
  last: boolean;
  /** Someone else's chat: their initials ("" for yours), photo and name. */
  owner: string;
  owner_tip: string;
  owner_photo: Pixels;
  has_owner_photo: boolean;
  /** Open in a split pane; that pane has the keyboard. */
  pane: boolean;
  pane_focus: boolean;
}

/** A split pane's header and place (panes.slint PaneHead): x, y, w, h are shares of the centre. */
export interface PaneHead {
  chat: number;
  title: string;
  pill: string;
  tone: "" | "blue" | "amber" | "green" | "red" | "gray";
  focused: boolean;
  shown: boolean;
  maxed: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  running: boolean;
  live_seq: number;
  /** Its composer, drawn as the focused pane's is (the same Composer, fed with this chat's state). */
  draft: string;
  composer: ComposerState;
  logo: Pixels;
  badge_photo: Pixels;
  has_badge_photo: boolean;
  bar: WorkBarData;
  strip_title: string;
  strip_names: string;
  strip_header: boolean;
  strip_folded: boolean;
  strip_open: boolean;
}

/** A pane's transcript and its agents strip, set once per pane and filled in place. */
export interface PaneBody {
  cards: slint.Model<CardData>;
  live: slint.Model<MdBlockData>;
  strip: slint.Model<StripRow>;
}

export interface PaneDiv {
  path: string;
  dir: "h" | "v";
  at: number;
  ax: number;
  ay: number;
  aw: number;
  ah: number;
}

export interface PaneDrop {
  kind: "" | "none" | "split" | "replace" | "here" | "swap" | "move";
  pane: number;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  sub: string;
  cap: boolean;
}


export interface MdBlockData {
  kind: string;
  text: slint.StyledText;
  code: string;
  level: number;
  marker: string;
  depth: number;
  quote: number;
  cols: { cells: slint.StyledText[] }[];
  rows: number;
  gap: number;
  after: number;
  bar_top: number;
  bar_bottom: number;
  trim: number;
  plain: string;
  key: string;
}

export interface SurfaceTab {
  kind: "chooser" | "terminal" | "devices";
  title: string;
}

export interface TermScreen {
  lines: TermFrame["rows"];
  cursor_row: number;
  cursor_col: number;
  cursor_text: string;
  scrolled: string;
}

export interface CaptchaData {
  image: Pixels;
  width: number;
  height: number;
  rect_x: number;
  rect_y: number;
  rect_w: number;
  rect_h: number;
  guild: string;
}

/** The newest frame of a chat's captcha card (`detail` of its card is `id`): chatcaptcha.ts fills it. */
/** A chat's captcha card (`detail` of its card is `id`), as chatcaptcha.ts last set it: changes only when
 * its fields do. The frames themselves go to `chat_cap_frame`, so a new one swaps only the image. */
export interface ChatCaptchaData {
  id: string;
  has_frame: boolean;
  /** The first frame's size: the image's slot keeps this aspect. */
  width: number;
  height: number;
  /** The captcha on the image, as fractions of its width and height: outside it is dimmed and takes no clicks. */
  rx: number;
  ry: number;
  rw: number;
  rh: number;
  /** "Being solved on <PC>" while another device holds it, else "". */
  solving: string;
}

export interface LightboxData {
  image: Pixels;
  width: number;
  height: number;
  caption: string;
  loading: boolean;
  error: string;
  index: number;
  count: number;
  path: boolean;
}

export interface VideoData {
  has_frame: boolean;
  poster: Pixels;
  poster_w: number;
  poster_h: number;
  stage: string;
  why: string;
  can_open: boolean;
  started: boolean;
  paused: boolean;
  ended: boolean;
  silent: boolean;
  volume: number;
  at: number;
  has_dur: boolean;
  clock: string;
  show: boolean;
  full: boolean;
  path: boolean;
  name: string;
  index: number;
  count: number;
  rotate: number;
}

export interface MediaRow {
  image: Pixels;
  caption: string;
  large: boolean;
  w: number;
  h: number;
  path: string;
  video: boolean;
  name: string;
  /** A thumbnail's place among its card's thumbnails (-1: a large image or a video). */
  slot: number;
  /** How many thumbnails its card has. */
  thumbs: number;
}

export interface CardData {
  kind: "" | "user" | "text" | "thinking" | "tool" | "group" | "notice" | "message" | "error" | "divider" | "space" | "status" | "earlier" | "steering" | "queue-head" | "queued" | "queue-more" | "captcha";
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
  /** A user card that joins the user card above it: no sender row, a small gap (view.ts `markJoined`). */
  joined: boolean;
  /** A user card the next one joins: a small gap under it, its hover actions beside the bubble. */
  tight: boolean;
  files: string[];
  steer: boolean;
  url: string;
  actions: string[];
  time: string;
  media: MediaRow[];
  /** The messages a user card mentions (cards.ts `cites`). */
  cites: CiteData[];
}

/** chat.slint `Cite`: a message a user's message mentions, as its chip, and the note written about it. */
export interface CiteData {
  head: string;
  snippet: string;
  tip: string;
  note: string;
}

export interface MenuEntry {
  icon: string;
  tone: "" | "blue" | "amber" | "red" | "green";
  label: string;
  desc: string;
  section: string;
}

/** patchlist.slint `ListRow` / `ListData`: a patch's list panel. */
export interface ListRow {
  head: boolean;
  title: string;
  detail: string;
  trailing: string;
  link: boolean;
}

export interface ListData {
  title: string;
  note: string;
  source: string;
  loading: boolean;
  error: string;
}

export type { PatchChipData };

/** composer.slint `WorkChip` / `WorkBarData`: the footer under the composer. */
export interface WorkChip {
  shown: boolean;
  icon: string;
  text: string;
  tone: string;
  tip: string;
}

export interface WorkBarData {
  shown: boolean;
  /** The chips do something here (the PC's own git): they show their chevrons. */
  live: boolean;
  ws: WorkChip;
  branch: WorkChip;
  pr: WorkChip;
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
  /** The device chip's glyph; "" is the house. */
  device_icon: string;
  action: "send" | "stop" | "steer" | "queue" | "update" | "resume";
  action_tip: string;
  hint: string;
  typing: string;
  notice: string;
  /** "warn" amber with the alert glyph, "pc" the PC glyph, "" plain (composer.slint). */
  notice_tone: string;
  place: string;
  error: string;
}

export interface DeviceRow {
  key: string;
  name: string;
  phone: boolean;
  online: boolean;
  can_send: boolean;
  /** This PC itself: Terminal and Files, no Send. */
  here: boolean;
  /** The owner's workspace and photo from the account directory. */
  workspace: string;
  photo: Pixels;
  has_photo: boolean;
}

export interface TransferRow {
  label: string;
  state: "run" | "wait" | "done" | "error";
  line: string;
  frac: number;
}

export interface FilesData {
  path: string;
  loading: boolean;
  error: string;
  can_back: boolean;
  can_up: boolean;
  hidden: boolean;
}

/** composer.slint `FileItem`: an attachment over the composer's text. */
export interface FileItem {
  name: string;
  image: boolean;
  tile: boolean;
  thumb: Pixels;
  number: number;
  /** Its place among the tiles, or among the chips. */
  slot: number;
}

export interface FileRow {
  name: string;
  dir: boolean;
  image: boolean;
  meta: string;
  thumb: Pixels;
  has_thumb: boolean;
}

export interface PopItem {
  kind: "item" | "label" | "caption" | "separator" | "rule" | "header" | "gap" | "choice" | "input" | "textbox" | "native" | "usage-account" | "usage-window" | "usage-note" | "mem-row" | "mem-ram" | "mem-warn" | "mem-pc";
  icon: string;
  label: string;
  desc: string;
  checked: boolean;
  enabled: boolean;
  badge: string;
  /** A usage window's fraction used, for its bar. */
  value: number;
}

export interface Crumbs {
  icon: string;
  project: string;
  parent: string;
  title: string;
  branch: string;
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
  /** Its owner's workspace photo (round), shown in place of `badge` when `has_photo`. */
  photo: Pixels;
  has_photo: boolean;
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

/** A row of the new chat's project popover (picker.slint `ProjectPopRow`, logic/projectpop.ts). */
export interface ProjectPopRow {
  kind: string;
  label: string;
  hint: string;
  initials: string;
  tint: string;
  logo: Pixels;
  has_logo: boolean;
  current: boolean;
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
  view: string;
  palette_open: boolean;
  add_project_open: boolean;
  sidebar_open: boolean;
  readonly narrow: boolean;
  side_w: number;
  side_resized: (w: number) => void;

  side_rows: slint.Model<SideRow>;
  side_settled: slint.Model<SideRow>;
  settled_count: number;
  settled_open: boolean;
  search: string;
  side_empty: string;
  side_empty_desc: string;
  side_ws: boolean;
  side_ws_on: boolean;
  side_ws_tip: string;
  side_drag: boolean;
  open_chat: (id: number) => void;
  open_project: (id: number) => void;
  fold_project: (id: number) => void;
  new_chat: (repo: number) => void;
  new_thread: () => void;
  add_project: () => void;
  settle: (id: number, on: boolean) => void;
  settle_project: (id: number, on: boolean) => void;
  snooze: (key: string, x: number, y: number) => void;
  usage: (x: number, y: number) => void;
  mem_pop: (id: string, x: number, y: number) => void;
  /** A PC card's "Default" pill: row i's PC becomes the sidebar gauge's. */
  mem_default: (i: number) => void;
  chat_mem: string;
  pc_mem: string;
  pc_mem_frac: number;
  pc_mem_low: boolean;
  pc_mem_tip: string;
  me_photo: Pixels;
  me_has_photo: boolean;
  me_letter: string;
  chat_menu: (id: number, x: number, y: number) => void;
  project_menu: (id: number, x: number, y: number) => void;
  searched: (q: string) => void;
  palette: () => void;
  toggle_theme: () => void;
  filter: (x: number, y: number) => void;
  ws_filter: (x: number, y: number) => void;
  ws_all: () => void;
  reorder: (id: number, target: number, above: boolean) => void;
  sel_shown: boolean;
  sel_x: number;
  sel_y: number;
  sel_mention: () => void;
  sel_hover: (on: boolean) => void;
  settings: () => void;
  leave_page: () => void;
  refresh: () => void;

  crumbs: Crumbs;
  split_count: number;
  /** A split pane is maximized: the window is the usual single-chat view, with a button to show every pane. */
  split_maxed: boolean;
  split_heads: slint.Model<PaneHead>;
  split_bodies: slint.Model<PaneBody>;
  split_divs: slint.Model<PaneDiv>;
  split_fx: number;
  split_fy: number;
  split_fw: number;
  split_fh: number;
  split_drop: PaneDrop;
  split_focus: (i: number, composer: boolean, fromEnd: number, follow: boolean) => void;
  split_close: (i: number) => void;
  split_solo: (i: number) => void;
  split_resize: (path: string, at: number) => void;
  split_drag: (chat: number, u: number, v: number, bu: number, bv: number) => void;
  split_dropped: (chat: number, u: number, v: number, bu: number, bv: number) => void;
  split_move: (pane: number, u: number, v: number, bu: number, bv: number) => void;
  split_moved: (pane: number, u: number, v: number, bu: number, bv: number) => void;
  split_drag_end: () => void;
  split_toggle: (i: number, seq: number) => void;
  split_act: (i: number, seq: number, action: string) => void;
  drag_chat: number;
  readonly keys_plain: boolean;
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
  team_chat_title: string;
  team_settled_open: boolean;
  team: () => void;
  open_agent: (id: number) => void;
  settle_agent: (id: number, on: boolean) => void;
  stop_agent: (id: number) => void;
  agent_account: (id: number, x: number, y: number) => void;
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
  live_blocks: slint.Model<MdBlockData>;
  live_seq: number;
  chat_running: boolean;
  read_only: boolean;
  read_only_text: string;
  read_only_action: string;
  read_only_act: () => void;
  toggle: (seq: number) => void;
  /** The transcript was scrolled near the top of the cards built. */
  transcript_near_top: () => void;
  link: (url: string) => void;
  open_url: (url: string) => void;
  card_act: (seq: number, action: string) => void;
  queue_menu: (id: number, x: number, y: number) => void;
  right_open: boolean;
  bottom_open: boolean;
  pane_max: "" | "right" | "bottom";
  right_tabs: slint.Model<SurfaceTab>;
  bottom_tabs: slint.Model<SurfaceTab>;
  right_active: number;
  bottom_active: number;
  right_screen: TermScreen;
  bottom_screen: TermScreen;
  pane_toggle: (d: string) => void;
  pane_add: (d: string) => void;
  pane_open: (d: string, i: number) => void;
  pane_close: (d: string, i: number) => void;
  pane_max_toggle: (d: string) => void;
  pane_hide: (d: string) => void;
  pane_pick: (d: string, key: string) => void;
  term_key: (d: string, k: TermKey | "none", text: string, ctrl: boolean, alt: boolean, shift: boolean) => void;
  term_paste: (d: string) => void;
  term_wheel: (d: string, lines: number) => void;
  term_resized: (d: string, w: number, h: number, cw: number, rh: number) => void;
  focus_pane: (d: string, terminal: boolean) => void;
  devices: slint.Model<DeviceRow>;
  devices_summary: string;
  transfers: slint.Model<TransferRow>;
  transfers_clearable: boolean;
  device_send: (key: string, x: number, y: number) => void;
  device_files: (d: string, key: string) => void;
  device_terminal: (d: string, key: string) => void;
  device_settings: () => void;
  transfers_clear: () => void;
  right_files: FilesData;
  right_file_rows: slint.Model<FileRow>;
  right_file_transfers: slint.Model<TransferRow>;
  right_file_clearable: boolean;
  bottom_files: FilesData;
  bottom_file_rows: slint.Model<FileRow>;
  bottom_file_transfers: slint.Model<TransferRow>;
  bottom_file_clearable: boolean;
  files_act: (d: string, action: string, i: number) => void;
  files_go: (d: string, path: string) => void;
  right_list: ListData;
  right_list_rows: slint.Model<ListRow>;
  bottom_list: ListData;
  bottom_list_rows: slint.Model<ListRow>;
  list_act: (d: string, action: string, i: number) => void;
  open_media: (path: string) => void;

  draft: string;
  composer: ComposerState;
  work_bar: WorkBarData;
  model_logo: Pixels;
  model_badge_photo: Pixels;
  model_has_badge_photo: boolean;
  image_scratch: Pixels;
  files: slint.Model<FileItem>;
  /** How many of `files` are tiles. */
  file_tiles: number;
  menu: slint.Model<MenuEntry>;
  menu_selected: number;
  readonly cursor: number;
  readonly cursor_anchor: number;
  edited: (text: string) => void;
  key: (e: KeyEvent) => boolean;
  send: () => void;
  stop: () => void;
  attach: () => void;
  mic: () => void;
  remove_file: (i: number) => void;
  open_file: (i: number) => void;
  menu_pick: (i: number) => void;
  menu_hover: (i: number) => void;
  popup: (id: string, x: number, y: number) => void;
  untrusted: boolean;
  trust: () => void;
  patch_chips: slint.Model<PatchChipData>;
  patch_chip: (i: number, x: number, y: number) => void;
  mentions: slint.Model<{ head: string; snippet: string; tip: string; note: string; hint: string; focus: boolean }>;
  note_edited: (i: number, text: string) => void;
  remove_mention: (i: number) => void;
  strip_rows: slint.Model<StripRow>;
  strip_title: string;
  strip_names: string;
  strip_header: boolean;
  strip_folded: boolean;
  strip_open: boolean;
  strip_open_agent: (id: number) => void;
  strip_head: () => void;
  strip_stop_all: () => void;

  pop_id: string;
  pop_items: slint.Model<PopItem>;
  pop_x: number;
  pop_y: number;
  pop_w: number;
  pop_above: boolean;
  pop_native: boolean;
  voice: "" | "rec" | "busy";
  voice_level: number;
  voice_time: string;
  voice_note: string;
  mic_tip: string;
  toast: string;
  inv_open: boolean;
  inv_title: string;
  inv_body: string;
  inv_busy: boolean;
  inv_accept: () => void;
  inv_decline: () => void;
  inv_close: () => void;
  cap_open: boolean;
  cap_shown: boolean;
  cap_data: CaptchaData;
  cap_pointer: (kind: string, x: number, y: number) => void;
  cap_wheel: (x: number, y: number, dy: number) => void;
  cap_show: (shown: boolean) => void;
  cap_cancel: () => void;
  chat_cap: ChatCaptchaData;
  chat_cap_frame: Pixels;
  /** A captcha card came on screen or left it (its captcha id), and its frame's width (logical px). */
  chat_cap_seen: (id: string, on: boolean, width: number) => void;
  /** The pointer on a card's frame: kind ("move", "down", "up"), then fractions of the image. */
  chat_cap_pointer: (id: string, kind: string, fx: number, fy: number) => void;
  chat_cap_cancel: (id: string) => void;
  /** Esc, ← and → for the image viewer, before any widget sees them; true = taken. */
  viewer_key: (e: KeyEvent) => boolean;
  lb_open: boolean;
  lb_data: LightboxData;
  lb_close: () => void;
  lb_go: (i: number) => void;
  lb_copy_image: () => void;
  lb_copy_path: () => void;
  vid_open: boolean;
  vid_data: VideoData;
  vid_frame: Pixels;
  vid_toggle: () => void;
  vid_fullscreen: () => void;
  vid_mute: () => void;
  vid_volume: (v: number) => void;
  vid_seek: (v: number) => void;
  vid_release_seek: () => void;
  vid_moved: () => void;
  vid_over_bar: (over: boolean) => void;
  vid_open_external: () => void;
  pop_spacing: number;
  pop_pick: (id: string, i: number) => void;
  pop_close: () => void;
  /** A native popup row under the pointer (`y`: its top in the window). */
  pop_hover: (i: number, y: number) => void;
  /** The open cascading submenu: the parent row it belongs to (-1: none), that row's top, its rows and content width. */
  sub_row: number;
  sub_row_y: number;
  sub_items: slint.Model<PopItem>;
  sub_w: number;
  sub_spacing: number;
  sub_enter: () => void;
  sub_pick: (i: number) => void;
  pop_input: string;
  pop_input_note: string;
  pop_input_ok: boolean;
  pop_input_edited: (t: string) => void;
  pop_input_accept: () => void;

  picker_rail: slint.Model<RailItem>;
  /** Index in `picker_rail` the rail scrolls into view (-1: the favourites, at the top): at open and when it changes. */
  picker_rail_reveal: number;
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
  proj_rows: slint.Model<ProjectPopRow>;
  proj_hover: number;
  proj_search: string;
  proj_pick: (i: number) => void;
  proj_searched: (t: string) => void;
  proj_key: (e: KeyEvent) => boolean;

  dialog_id: string;
  dialog_title: string;
  dialog_text: string;
  dialog_input: string;
  dialog_has_input: boolean;
  /** A left-aligned extra button ("Switch branch…"); "" for none. */
  dialog_extra: string;
  dialog_extra_clicked: () => void;
  dialog_stop: boolean;
  dialog_ok: string;
  dialog_danger: boolean;
  dialog_done: (id: string, ok: boolean) => void;
  modal_visibility: (open: boolean) => void;

  global_key: (e: KeyEvent) => boolean;
  /** Alt+Up / Alt+Down (previous / next chat), before any widget sees the key; true = taken. */
  nav_key: (e: KeyEvent) => boolean;
  /** Ctrl+C, before any widget sees it (it goes on to them). */
  copy_key: () => void;
  /** The sidebar row Alt+Up / Alt+Down last opened ("kind:id"): the sidebar scrolls it into view. */
  side_reveal: string;
  readonly at_end: boolean;
  /** The transcript's content height (px), for `transcript_grew_above`. */
  readonly transcript_height: number;
  readonly transcript_view: number;
  readonly transcript_follow: boolean;
  /** Physical pixels per logical pixel. */
  readonly scale_factor: number;
  /** Browser-style zoom: the level (1 = 100%). */
  zoom_level: number;
  /** A zoom key: 1 in, -1 out, 0 back to 100%. */
  zoom: (step: number) => void;
  /** The window's scale changed: Harbor's own zoom, or the display's (another screen, a new setting). */
  scale_changed: (scale: number) => void;
  /** Cards were added above: keeps the view on what it showed when the content was `before` px tall. */
  transcript_grew_above(before: number): void;
  /** The view goes back to keeping its distance from the top while content changes. */
  transcript_anchor_off(): void;
  /** From the transcript view's top to its content's end (px): a restart keeps it. */
  readonly transcript_from_end: number;
  /** Shows the transcript `d` px from its view's top to its content's end, kept while cards come in above. */
  transcript_keep(d: number): void;
  /** The sidebar list's scroll (px, negative down). */
  side_scroll: number;
  focus_composer(): void;
  set_cursor(at: number): void;
  scroll_to_end(): void;
  transcript_key(k: "up" | "down" | "home" | "end"): void;
  copy_text(t: string): void;
  /** The title the compositor shows ("Harbor"; HARBOR_WINDOW_TITLE when set). */
  window_title: string;
}

function isCtor(v: unknown): v is new () => AppWindow {
  return typeof v === "function";
}

// Slint reads these from the C environment, which Bun's process.env doesn't reach. Held to winit, a start with no
// display fails instead of falling back to the console's screen (linuxkms) with no window.
function slintEnv(): void {
  if (process.platform !== "linux") return;
  const libc = dlopen("libc.so.6", { setenv: { args: [FFIType.cstring, FFIType.cstring, FFIType.i32], returns: FFIType.i32 } });
  for (const [k, v] of [["SLINT_SKIA_PARTIAL_RENDERING", "1"], ["SLINT_BACKEND", "winit"]] as const) {
    if (process.env[k] === undefined) libc.symbols.setenv(Buffer.from(`${k}\0`), Buffer.from(`${v}\0`), 0);
  }
  libc.close();
}

export async function loadWindow(): Promise<AppWindow> {
  slintEnv();
  const ui = slint.loadFile(join(await uiDir(), "app.slint"), { style: "fluent" });
  // Harbor's Slint addon (slint/) frees the compiler's state as the compile ends, ~100 MB in the
  // middle of glibc's heap: given back now, not at the first periodic trim minutes later.
  malloc.trim();
  const ctor = Reflect.get(ui, "AppWindow");
  if (!isCtor(ctor)) throw new Error("app.slint has no AppWindow");
  const win = new ctor();
  busOf<{ tip_parts: (tip: string) => TipParts }>(win, "Ui").tip_parts = tipParts;
  const title = process.env.HARBOR_WINDOW_TITLE;
  if (title) win.window_title = title;
  return win;
}

export const blankStatus = (): StatusData => ({ kind: "text", text: "", icon: "", color: "transparent" });

export const noPixels: Pixels = { width: 1, height: 1, data: new Uint8Array(4) };
