import { type Account, type Kind, providers } from "@harbor/agents";
import type { Store } from "@harbor/store";
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

/** The rows the picker shows, and the "More models" row's label and count when there is one. */
export function pickerRows(s: PickerState, accounts: readonly Account[], favorites: readonly [string, string][], locked: Kind | null): { rows: Row[]; more: [string, number] | null } {
  const row = (a: Account, m: providers.Model): Row => ({ account: a.id, kind: a.kind, model: m.id, label: m.label, sub: providers.short(a), enabled: (locked === null || locked === a.kind) && providers.installed(a) });
  const q = s.search.trim().toLowerCase();
  if (q !== "") {
    const v: Row[] = [];
    for (const a of accounts.filter(providers.installed)) {
      for (const m of providers.staticModels(a.kind)) {
        if (m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || providers.short(a).toLowerCase().includes(q)) v.push(row(a, m));
      }
    }
    return { rows: v, more: null };
  }
  if (s.rail === null) {
    const rows: Row[] = [];
    for (const [aid, mid] of favorites) {
      const a = accounts.find((x) => x.id === aid);
      if (!a) continue;
      rows.push(row(a, providers.staticModels(a.kind).find((m) => m.id === mid) ?? { id: mid, label: mid, more: false }));
    }
    return { rows, more: null };
  }
  const a = accounts.find((x) => x.id === s.rail);
  if (!a) return { rows: [], more: null };
  const all = providers.staticModels(a.kind);
  const more = all.filter((m) => m.more);
  if (s.more) return { rows: more.map((m) => row(a, m)), more: null };
  return { rows: all.filter((m) => !m.more).map((m) => row(a, m)), more: more.length > 0 ? [a.kind === "Codex" ? "Legacy models" : "More models", more.length] : null };
}

export function emptyText(s: PickerState): string {
  if (s.rail === null && s.search === "") return "Star a model to pin it here.";
  if (s.search !== "") return "No match — press Enter to use it as a model id.";
  return "No models.";
}

export function railTip(a: Account): string {
  const lines = [providers.short(a), a.email === "" ? a.name : a.email];
  if (a.plan !== "") lines.push(a.plan);
  for (const w of a.usage) lines.push(`${w.label}: ${Math.round(w.percent * 100)}% used`);
  if (a.loggedIn === false) lines.push("Not signed in — Settings › Providers");
  return lines.join("\n");
}

export class Favorites {
  list: [string, string][];

  constructor(private store: Store) {
    this.list = parseFavorites(store.get("favorites") ?? "");
  }

  has(a: string, m: string): boolean {
    return this.list.some(([x, y]) => x === a && y === m);
  }

  toggle(a: string, m: string): void {
    this.list = this.has(a, m) ? this.list.filter(([x, y]) => !(x === a && y === m)) : [...this.list, [a, m]];
    this.store.set("favorites", favoritesValue(this.list));
  }
}

export type LogoOf = (kind: Kind) => Pixels;
