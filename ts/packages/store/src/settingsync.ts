import type { Store } from "./store.ts";

/** account: synced through the account service to the account's PCs; device: stays on this PC;
 *  workspace: the same on every PC of the workspace, passed between linked PCs (wssettings.ts). */
export type Class = "account" | "device" | "workspace";

const A: Class = "account";
const D: Class = "device";
const W: Class = "workspace";

/** Every kv key, and keys starting with each prefix (ending in `:` or `_`). */
export const KEYS: readonly (readonly [string, Class])[] = [
  ["theme", A],
  ["keybindings", A],
  ["default_account", A],
  ["default_model", A],
  ["default_effort", A],
  ["default_access", A],
  ["favorites", A],
  ["default_device", D],
  ["sidebar_workspace", D],
  ["order_by_activity", A],
  ["fast_mode", A],
  ["notify", A],
  ["recap_enabled", A],
  ["auto_fix", A],
  ["auto_merge", A],
  // Delete merged worktrees (wtclean.ts): the worktree, its local branch, its branch on the remote.
  ["wt_clean_merged", A],
  ["wt_clean_branch", A],
  ["wt_clean_remote", A],
  ["gh_agent_account", A],
  ["ctx_send", A],
  ["voice_input", D],
  // One value for the whole workspace (0.147): the newest change on any of its PCs wins.
  ["voice_cleanup", W],
  // When each workspace setting last changed (wssettings.ts): {key: ms}.
  ["ws_settings_at", D],
  // The PC that transcribes this one's dictations (mesh id, "" = automatic).
  ["voice_host", D],
  ["voice_model", A],
  ["voice_dict", A],
  ["limit_auto", A],
  ["limit_notify", A],
  ["limit_weekly", A],
  ["limit_wait_max", A],
  ["limit_switch", A],
  ["limit_switch_accounts", A],
  ["usage_caps", A],
  ["usage_warn", A],
  ["limits", D],
  ["recap_count", D],
  ["api_port", D],
  ["api_tokens", D],
  ["api_revoked", D],
  ["phones_seen", D],
  ["mesh_id", D],
  ["mesh_peers", D],
  ["net_forward", D],
  ["net_name", D],
  ["hooks_name", D],
  ["remote_devices", D],
  // Who you are and your GitHub login (meshctx who-is-who): yours wherever you sign in.
  ["owner_name", A],
  ["owner_github", A],
  ["owner_suggested", D],
  ["share_files", D],
  ["share_github", D],
  ["ctx_memory", D],
  ["ctx_guests", D],
  ["move_pc", D],
  ["project_moves_open", D],
  ["sidebar_open", D],
  ["sidebar_width", D],
  ["video_volume", A],
  ["ui_zoom", D],
  ["show_team", A],
  ["collapsed", D],
  ["agents_settled_open", D],
  ["last_chat", D],
  ["draft_repo", D],
  ["draft_main", D],
  ["snoozed", D],
  ["palette_recent", D],
  ["browser_last", D],
  // The built-in browser's recent pages, the video volume, the team view: preferences, not this PC's state.
  ["browser_recent", A],
  ["reload_state", D],
  ["bg_explained", D],
  ["bg_update_noticed", D],
  ["update_toast_dismissed", D],
  ["owner_toast_dismissed", D],
  ["agent_settle", D],
  ["chat_prs", D],
  ["effort_default_medium", D],
  ["secret_asks", D],
  ["secret_grants", D],
  ["auto_handled", D],
  ["account", D],
  ["account_ws", D],
  ["account_dir", D],
  ["account_keys", D],
  ["account_sync", D],
  ["account_sync_backup", D],
  ["worktree:", D],
  // A project's Move to PC… (projectmove*.ts): where it went, how its move went, where one came from.
  ["project_moved:", D],
  ["move_project:", D],
  ["moved_in:", D],
  // The chats a project's settle settled (store.ts settleProject), by this PC's ids.
  ["project_settled:", D],
  ["worktree_move:", D],
  ["worktree_named:", D],
  ["worktree_note:", D],
  // Why a chat's merged worktree stayed, said once (worktreeclean.ts).
  ["wt_clean_kept:", D],
  ["recap:", D],
  ["recap_users:", D],
  ["suggestion:", D],
  ["untrusted:", D],
  ["forks_of_", D],
];

const isPrefix = (k: string): boolean => k.endsWith(":") || k.endsWith("_");

export function listed(key: string): boolean {
  return KEYS.some(([k]) => k === key || (isPrefix(k) && key.startsWith(k)));
}

/** Which side a key is on; unknown keys stay on the PC. */
export function classOf(key: string): Class {
  return KEYS.find(([k]) => k === key || (isPrefix(k) && key.startsWith(k)))?.[1] ?? D;
}

/** The service's value of a key: the text and when it last changed (ms). */
export interface Remote {
  v?: unknown;
  at?: unknown;
}
export type RemoteSettings = Record<string, Remote>;

/** What a call to the settings service gives back. */
export interface SettingsReply {
  settings?: RemoteSettings;
}

/** One request to the account service: a GET without a body, a PUT with `{ set }`. */
export type SettingsCall = (token: string, body?: { set: Record<string, { v: string; at: number }> }) => Promise<SettingsReply>;

/** Keys changed on this PC since they were last sent: key → when (ms). */
const dirty = new Map<string, number>();
/** Per key: when this PC's value changed last, here or on another device (ms). */
let at = new Map<string, number>();
const MAX_VALUE = 16 << 10;
/** The mark in `at` that the first sync after signing in is done. */
const SYNCED = "~";

export const sync_state = {
  /** Settings came from the account: the desktop reads them again. */
  reload: false,
  /** Off under `bun test`, as the Rust tests did. */
  track: process.env.NODE_ENV !== "test",
};

let poke: () => void = () => {};

/** Called when an account setting changed here, so the account sync wakes up. */
export function onChanged(f: () => void): void {
  poke = f;
}

/** `Store.set` of any key: an account setting is marked to be sent. */
export function changed(key: string): void {
  if (classOf(key) === A && sync_state.track) {
    const t = Date.now();
    dirty.set(key, t);
    at.set(key, t);
    poke();
  }
}

export function load(s: Store): void {
  at = new Map(Object.entries(parseNumbers(s.get("account_sync"))));
}

function parseNumbers(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === "number"));
  } catch {
    return {};
  }
}

/** Someone just signed in: this PC takes the account's settings, then adds what it lacks. */
export function signedIn(s: Store): void {
  dirty.clear();
  at.clear();
  s.set("account_sync", "{}");
}

function saveAt(s: Store): void {
  s.set("account_sync", JSON.stringify(Object.fromEntries(at)));
}

/** Takes the account's values newer than this PC's, written without being sent back. True when something changed. */
export function apply(s: Store, remote: RemoteSettings): boolean {
  let any = false;
  const pending = new Map(dirty);
  for (const [k, e] of Object.entries(remote)) {
    if (classOf(k) !== A) continue; // never this PC's own keys, whatever the service holds
    const t = typeof e.at === "number" && Number.isInteger(e.at) ? e.at : 0;
    const d = pending.get(k);
    if (t <= (at.get(k) ?? 0) || (d !== undefined && d >= t)) continue;
    const v = typeof e.v === "string" ? e.v : "";
    const had = s.get(k) ?? "";
    if (Buffer.byteLength(v) <= MAX_VALUE && had !== v) {
      backup(s, k, had);
      s.setQuiet(k, v);
      any = true;
    }
    at.set(k, t);
  }
  if (any) sync_state.reload = true;
  return any;
}

/** Keeps what a key held before the account replaced it (kv `account_sync_backup`). */
function backup(s: Store, key: string, had: string): void {
  if (had === "") return;
  let b: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(s.get("account_sync_backup") ?? "{}");
    if (typeof v === "object" && v !== null && !Array.isArray(v)) b = v as Record<string, unknown>;
  } catch {
    // starts over
  }
  b[key] = had;
  s.setQuiet("account_sync_backup", JSON.stringify(b));
}

/** At the first sign-in: the account's values for the keys this PC never set. */
export function firstFill(own: readonly string[], remote: RemoteSettings): RemoteSettings {
  return Object.fromEntries(Object.entries(remote).filter(([k]) => !own.includes(k)));
}

/** One round with the service: a first sync after signing in, the keys changed here, and the account's (with `pull`, or when something was sent). */
export async function sync(s: Store, token: string, pull: boolean, call: SettingsCall): Promise<void> {
  const first = at.size === 0;
  if (first) {
    const v = await call(token);
    const t = Date.now();
    const own = KEYS.filter(([k, c]) => c === A && !isPrefix(k) && (s.get(k) ?? "") !== "").map(([k]) => k);
    apply(s, firstFill(own, v.settings ?? {}));
    for (const k of own) {
      dirty.set(k, t);
      at.set(k, t);
    }
    // Done once, also for an account with nothing and a PC with defaults only.
    at.set(SYNCED, t);
    saveAt(s);
  }
  const sent = new Map(dirty);
  if (sent.size > 0) {
    const set: Record<string, { v: string; at: number }> = {};
    for (const [k, t] of sent) set[k] = { v: [...(s.get(k) ?? "")].slice(0, MAX_VALUE).join(""), at: t };
    const v = await call(token, { set });
    // Sent: unless it changed again meanwhile.
    for (const [k, t] of sent) if (dirty.get(k) === t) dirty.delete(k);
    apply(s, v.settings ?? {});
    saveAt(s);
  } else if (pull && !first) {
    const v = await call(token);
    if (apply(s, v.settings ?? {})) saveAt(s);
  }
}

/** For tests: forget everything held in memory. */
export function reset(): void {
  dirty.clear();
  at = new Map();
  sync_state.reload = false;
}

export const internals = {
  dirty,
  get at(): Map<string, number> {
    return at;
  },
};
