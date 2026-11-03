import { ICONS } from "../icons.ts";
import { TAB_ORDER, TABS, type Tab } from "./pages.ts";
import { textScore } from "./tags.ts";

export const RECENT_MAX = 20;
export const RECENT_KEY = "palette_recent";

/** Where an item is listed, in this order among equally good matches. */
export const SECTIONS = ["recent", "actions", "projects", "chats", "agents", "devices", "pages"] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_TITLES: Record<Section, string> = { recent: "Recent", actions: "Actions", projects: "Projects", chats: "Chats", agents: "Agents", devices: "Devices", pages: "Pages" };

/** Rows a section shows at most, with nothing typed and with a query. */
function cap(s: Section, empty: boolean): number {
  if (s === "recent") return 6;
  if (s === "pages" && empty) return 12;
  return empty ? 5 : 8;
}

/** What picking an item does. */
export type Act =
  | { kind: "project"; id: number }
  | { kind: "chat"; id: number }
  | { kind: "new_chat"; repo: number | null }
  | { kind: "prs" }
  | { kind: "issues" }
  | { kind: "settings"; tab: Tab }
  | { kind: "settle"; id: number; on: boolean }
  | { kind: "fork"; id: number }
  | { kind: "fast"; on: boolean }
  | { kind: "check_updates" }
  | { kind: "toggle_sidebar" }
  | { kind: "toggle_terminal" }
  | { kind: "toggle_browser" };

export interface Item {
  /** Stable across lists ("chat:12"): what the recent picks remember. */
  id: string;
  section: Section;
  icon: string;
  /** The phone's name for the icon. */
  glyph: string;
  title: string;
  detail: string;
  keywords: string;
  act: Act;
  /** When it was last active (chats), for the empty query. */
  at: number;
}

export function paletteItem(id: string, section: Section, icon: string, glyph: string, title: string, detail: string, act: Act, keywords = "", at = 0): Item {
  return { id, section, icon, glyph, title, detail, keywords, act, at };
}

/** How the phone does it: opens a screen, or asks the PC (`action`); null: not on the phone. */
export function actWire(a: Act): Record<string, unknown> | null {
  switch (a.kind) {
    case "chat":
      return { kind: "chat", chat: a.id };
    case "project":
      return { kind: "new_chat", project: a.id, main: true };
    case "new_chat":
      return { kind: "new_chat", project: a.repo };
    case "prs":
      return { kind: "page", page: "prs" };
    case "issues":
      return { kind: "page", page: "issues" };
    case "settle":
    case "fork":
    case "fast":
      return { kind: "action" };
    default:
      return null;
  }
}

/** As the phone gets it; null for what it can't open or do. */
export function itemJson(it: Item): Record<string, unknown> | null {
  const v = actWire(it.act);
  return v === null ? null : { ...v, id: it.id, title: it.title, detail: it.detail, icon: it.glyph };
}

function keywordScore(keywords: string, word: string): number | null {
  let best: number | null = null;
  for (const k of keywords.split(/\s+/).filter((x) => x !== "")) {
    const s = textScore(k, word);
    if (s !== null && (best === null || s < best)) best = s;
  }
  return best;
}

/** How well `query` matches an item (lower is better): every word in its title, detail or keywords, the title counting most. */
export function score(it: Item, query: string): number | null {
  let total = 0;
  for (const word of query.split(/\s+/).filter((x) => x !== "")) {
    const t = textScore(it.title, word);
    const d = textScore(it.detail, word);
    const k = keywordScore(it.keywords, word);
    const options = [t, d === null ? null : d + 40, k === null ? null : k + 60].filter((x): x is number => x !== null);
    if (options.length === 0) return null;
    total += Math.min(...options);
  }
  return total;
}

/** The items for `query` in sections, best first; with nothing typed the recent picks (`recent`, newest first) lead. */
export function rank(items: readonly Item[], query: string, recent: readonly string[]): [Section, Item[]][] {
  const q = query.trim();
  const out: [Section, Item[]][] = [];
  if (q === "") {
    const recents = recent
      .map((id) => items.find((i) => i.id === id))
      .filter((i): i is Item => i !== undefined)
      .slice(0, cap("recent", true));
    for (const s of SECTIONS) {
      let v = s === "recent" ? [...recents] : items.filter((i) => i.section === s && !recents.some((r) => r.id === i.id));
      if (s === "chats" || s === "agents") v = [...v].sort((a, b) => b.at - a.at);
      v = v.slice(0, cap(s, true));
      if (v.length > 0) out.push([s, v]);
    }
    return out;
  }
  const rankOf = (i: Item) => {
    const p = recent.indexOf(i.id);
    return p < 0 ? Number.MAX_SAFE_INTEGER : p;
  };
  const scored: [Section, number, Item[]][] = [];
  for (const s of SECTIONS.filter((x) => x !== "recent")) {
    const v = items
      .filter((i) => i.section === s)
      .flatMap((i) => {
        const sc = score(i, q);
        return sc === null ? [] : [[sc, i] as const];
      })
      .sort((a, b) => a[0] - b[0] || rankOf(a[1]) - rankOf(b[1]) || b[1].at - a[1].at || a[1].title.length - b[1].title.length)
      .slice(0, cap(s, false));
    const first = v[0];
    if (first) scored.push([s, first[0], v.map((x) => x[1])]);
  }
  scored.sort((a, b) => a[1] - b[1] || SECTIONS.indexOf(a[0]) - SECTIONS.indexOf(b[0]));
  return scored.map(([s, , v]) => [s, v]);
}

/** A recent-picks list with `id` put first. */
export function remember(recent: readonly string[], id: string): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, RECENT_MAX);
}

export interface PaletteChat {
  id: number;
  title: string;
  role: "lead" | "sub" | "chat";
  parent: number | null;
  name: string;
  repoId: number | null;
  settled: boolean;
  updated: number;
}

export interface PaletteInput {
  repos: { id: number; name: string; dir: string }[];
  chats: PaletteChat[];
  devices: { id: string; name: string }[];
  /** The open chat, for its actions. */
  current: number | null;
  /** The draft's project, when no chat is open. */
  draftRepo: number | null;
  fast: boolean;
  /** The open chat's last reply that can be forked from. */
  forkable: boolean;
}

/** Everything the palette offers (palette.rs `palette_items`). */
export function paletteItems(p: PaletteInput): Item[] {
  const v: Item[] = [];
  const projectName = (r: number | null) => p.repos.find((x) => x.id === r)?.name ?? "No project";
  const cur = p.current === null ? null : (p.chats.find((c) => c.id === p.current) ?? null);
  if (cur) {
    const title = cur.title === "" ? "this chat" : cur.title;
    if (cur.settled) v.push(paletteItem(`act:unsettle:${cur.id}`, "actions", ICONS.UNARCHIVE, "unarchive", "Unsettle this chat", title, { kind: "settle", id: cur.id, on: false }, "unarchive reopen"));
    else v.push(paletteItem(`act:settle:${cur.id}`, "actions", ICONS.ARCHIVE, "archive", "Settle this chat", title, { kind: "settle", id: cur.id, on: true }, "done archive finish"));
    if (p.forkable) v.push(paletteItem(`act:fork:${cur.id}`, "actions", ICONS.FORK, "fork", "Fork this chat", title, { kind: "fork", id: cur.id }, "branch copy"));
  }
  const repo = cur ? cur.repoId : p.draftRepo;
  v.push(paletteItem("act:new", "actions", ICONS.COMPOSE, "compose", "New chat", projectName(repo), { kind: "new_chat", repo }, "thread start create"));
  v.push(
    p.fast
      ? paletteItem("act:fast:off", "actions", ICONS.GAUGE, "gauge", "Turn fast mode off", "Fast mode for every chat on this PC", { kind: "fast", on: false }, "speed toggle setting")
      : paletteItem("act:fast:on", "actions", ICONS.GAUGE, "gauge", "Turn fast mode on", "Fast mode for every chat on this PC", { kind: "fast", on: true }, "speed toggle setting"),
  );
  v.push(paletteItem("act:updates", "actions", ICONS.REFRESH, "refresh", "Check for updates", "Harbor's latest release", { kind: "check_updates" }, "upgrade version release"));
  v.push(paletteItem("act:sidebar", "actions", ICONS.PANEL_LEFT, "panel", "Show or hide the sidebar", "", { kind: "toggle_sidebar" }, "toggle"));
  v.push(paletteItem("act:terminal", "actions", ICONS.TERMINAL, "terminal", "Open or close the terminal", "", { kind: "toggle_terminal" }, "toggle shell console"));
  v.push(paletteItem("act:browser", "actions", ICONS.GLOBE, "globe", "Open or close the browser", "", { kind: "toggle_browser" }, "toggle web"));
  for (const r of p.repos) v.push(paletteItem(`new:${r.id}`, "actions", ICONS.COMPOSE, "compose", `New chat in ${r.name}`, r.dir, { kind: "new_chat", repo: r.id }, "thread start create"));
  for (const r of p.repos) v.push(paletteItem(`project:${r.id}`, "projects", ICONS.FOLDER, "folder", r.name, r.dir, { kind: "project", id: r.id }, "project folder repo"));
  for (const c of p.chats) {
    const title = c.title === "" ? "New chat" : c.title;
    if (c.role === "sub") {
      const lead = p.chats.find((x) => x.id === c.parent)?.title ?? "";
      const detail = lead === "" ? projectName(c.repoId) : `${projectName(c.repoId)} · ${lead}`;
      v.push(paletteItem(`chat:${c.id}`, "agents", ICONS.BOT, "bot", c.name === "" ? title : c.name, detail, { kind: "chat", id: c.id }, title, c.updated));
    } else {
      const detail = c.settled ? `${projectName(c.repoId)} · settled` : projectName(c.repoId);
      v.push(paletteItem(`chat:${c.id}`, "chats", ICONS.MESSAGE, "message", title, detail, { kind: "chat", id: c.id }, "", c.updated));
    }
  }
  for (const d of p.devices) v.push(paletteItem(`device:${d.id}`, "devices", ICONS.MONITOR, "monitor", d.name, "Settings › Workspace", { kind: "settings", tab: "account" }, "device pc host"));
  v.push(paletteItem("page:prs", "pages", ICONS.PR_OPEN, "pr", "Pull requests", "GitHub", { kind: "prs" }, "prs review"));
  v.push(paletteItem("page:issues", "pages", ICONS.CIRCLE_DOT, "issue", "Issues", "GitHub", { kind: "issues" }, "bugs"));
  for (const t of TAB_ORDER) v.push(paletteItem(`settings:${t}`, "pages", TABS[t].icon, "settings", TABS[t].label, "Settings", { kind: "settings", tab: t }, `settings preferences ${TABS[t].keywords}`));
  return v;
}

/** `GET /v1/palette` (palette.rs `api_palette`): the ranked sections, only what the phone can open or do. */
export function paletteJson(items: readonly Item[], query: string, recent: readonly string[]): { sections: Record<string, unknown>[] } {
  const sections: Record<string, unknown>[] = [];
  for (const [s, v] of rank(items, query, recent)) {
    const rows = v.map(itemJson).filter((x): x is Record<string, unknown> => x !== null);
    if (rows.length > 0) sections.push({ key: s, title: SECTION_TITLES[s], items: rows });
  }
  return { sections };
}
