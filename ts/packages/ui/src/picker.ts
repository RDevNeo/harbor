import { type Account, type Kind, providers } from "@harbor/agents";
import type { Store } from "@harbor/store";
import { richTip } from "./logic/tips.ts";
import type { Pixels } from "./logos.ts";

export interface Row {
  account: string;
  kind: Kind;
  model: string;
  label: string;
  sub: string;
  enabled: boolean;
}

export interface PickerState {
  rail: string | null;
  search: string;
  more: boolean;
  hover: number;
}

export function parseFavorites(v: string): [string, string][] {
  return v
    .split(",")
    .map((x) => x.split("|"))
    .filter((p): p is [string, string] => p.length === 2 && p[0] !== undefined && p[1] !== undefined)
    .map(([a, m]) => [a, m]);
}

export function favoritesValue(f: readonly [string, string][]): string {
  return f.map(([a, m]) => `${a}|${m}`).join(",");
}

/** How the picker reads an account; another PC's (meshaccounts.ts) has its own name, models and whether it can be picked. */
export interface PickerLook {
  label(a: Account): string;
  models(a: Account): providers.Model[];
  ok(a: Account): boolean;
}

export const plainLook: PickerLook = { label: (a) => providers.short(a), models: (a) => providers.staticModels(a.kind), ok: () => true };

/** A model row's second line: whose workspace the account is ("Dana's Workspace"); null when nobody is known. The
 *  provider shows as the row's icon. */
export function workspaceLine(s: { shown: string; person: string } | undefined): string | null {
  const who = s === undefined ? "" : s.shown !== "" ? s.shown : s.person;
  return who === "" ? null : `${who}'s Workspace`;
}

/** The rows the picker shows, and the "More models" row's label and count when there is one. */
export function pickerRows(s: PickerState, accounts: readonly Account[], favorites: readonly [string, string][], locked: Kind | null, look: PickerLook = plainLook): { rows: Row[]; more: [string, number] | null } {
  const row = (a: Account, m: providers.Model): Row => ({ account: a.id, kind: a.kind, model: m.id, label: m.label, sub: look.label(a), enabled: (locked === null || locked === a.kind) && providers.installed(a) && look.ok(a) });
  const q = s.search.trim().toLowerCase();
  if (q !== "") {
    const v: Row[] = [];
    for (const a of accounts.filter(providers.installed)) {
      for (const m of look.models(a)) {
        if (m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || look.label(a).toLowerCase().includes(q)) v.push(row(a, m));
      }
    }
    return { rows: v, more: null };
  }
  if (s.rail === null) {
    const rows: Row[] = [];
    for (const [aid, mid] of favorites) {
      const a = accounts.find((x) => x.id === aid);
      if (!a) continue;
      rows.push(row(a, look.models(a).find((m) => m.id === mid) ?? { id: mid, label: mid, more: false }));
    }
    return { rows, more: null };
  }
  const a = accounts.find((x) => x.id === s.rail);
  if (!a) return { rows: [], more: null };
  const all = look.models(a);
  const more = all.filter((m) => m.more);
  if (s.more) return { rows: more.map((m) => row(a, m)), more: null };
  return { rows: all.filter((m) => !m.more).map((m) => row(a, m)), more: more.length > 0 ? [a.kind === "Codex" ? "Legacy models" : "More models", more.length] : null };
}

export function emptyText(s: PickerState): string {
  if (s.rail === null && s.search === "") return "Star a model to pin it here.";
  if (s.search !== "") return "No match — press Enter to use it as a model id.";
  return "No models.";
}

/** `mesh`: its name, its owner and where it runs (meshaccounts.ts `sharedTip`), and why it can't be picked, while the mesh has other PCs. */
export function railTip(a: Account, mesh: { title: string; owner: string; why: string } | null = null): string {
  return richTip({
    title: mesh?.title ?? providers.short(a),
    sub: mesh !== null && mesh.owner !== "" ? mesh.owner : a.email === "" ? a.name : a.email,
    body: mesh !== null && mesh.why !== "" ? mesh.why : a.loggedIn === false ? "Not signed in — Settings › Providers" : "",
    rows: [["Plan", a.plan], ...a.usage.map((w): [string, string] => [w.label, `${Math.round(w.percent * 100)}% used`])],
  });
}

/** The rail's next stop from `cur` (null: the favourites, first) by `dir` (1 down, -1 up), round. */
export function railStep(ids: readonly string[], cur: string | null, dir: 1 | -1): string | null {
  const stops: (string | null)[] = [null, ...ids];
  const at = Math.max(0, stops.indexOf(cur));
  return stops[(at + dir + stops.length) % stops.length] ?? null;
}

/** `Favorites.migrate`'s list, or null when nothing changes. */
export function migrateFavorites(list: readonly [string, string][], shared: readonly { id: string; kind: string; copies?: { pc: string; account: string }[] }[]): [string, string][] | null {
  // OpenCode is one entry on the whole mesh (meshaccounts.ts OPENCODE_IDENT): every id it had moves to that one's.
  const oc = shared.find((s) => s.kind === "opencode")?.id;
  let changed = false;
  const out: [string, string][] = [];
  for (const [a, m] of list) {
    const id = oc !== undefined && (a === "opencode" || /^opencode[@:]/.test(a)) ? oc : a;
    if (id !== a) changed = true;
    if (!out.some(([x, y]) => x === id && y === m)) out.push([id, m]);
    else changed = true;
  }
  return changed ? out : null;
}

export class Favorites {
  list: [string, string][];

  constructor(private store: Store) {
    this.list = parseFavorites(store.get("favorites") ?? "");
  }

  has(a: string, m: string): boolean {
    return this.list.some(([x, y]) => x === a && y === m);
  }

  /** Favorites starred on an OpenCode of a PC ("opencode@<pc>/<id>", "opencode:<owner hash>" of 0.171.3, this PC's
   *  "opencode"): moved to the mesh's one OpenCode entry. The rest stays. */
  migrate(shared: readonly { id: string; kind: string; copies?: { pc: string; account: string }[] }[]): void {
    const next = migrateFavorites(this.list, shared);
    if (next === null) return;
    this.list = next;
    this.store.set("favorites", favoritesValue(this.list));
  }

  toggle(a: string, m: string): void {
    this.list = this.has(a, m) ? this.list.filter(([x, y]) => !(x === a && y === m)) : [...this.list, [a, m]];
    this.store.set("favorites", favoritesValue(this.list));
  }
}

export type LogoOf = (kind: Kind) => Pixels;
