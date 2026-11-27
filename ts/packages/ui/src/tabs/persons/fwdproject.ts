// Forward to Projects' dialog, window side: the project picker's rows (a search over names and paths, Recent: the
// projects with the newest chats, then All projects) and the quote's line. The projects come from the engine's
// `GET v1/persons/projects` (persons/src/projects.ts). Pure, so it is unit tested.

export interface FwdProject {
  id: string;
  name: string;
  path: string;
  /** The path as shown ("creators-hub/tabs/Persons"). */
  short: string;
  /** Its newest chat's last change (ms), 0 with none. */
  last: number;
  working: boolean;
  settled?: boolean;
}

/** One row of the picker: a group's heading, a project, or the note that nothing matches. */
export interface FwdRow {
  kind: "head" | "item" | "empty";
  id: string;
  name: string;
  path: string;
  /** The project picked now: ticked. */
  on: boolean;
  /** A chat of it is working: the green dot. */
  dot: boolean;
}

/** How many projects Recent shows. */
export const RECENT = 3;

/** Every word of the query is in the project's name or path (any case). */
export function projectMatches(p: Pick<FwdProject, "name" | "path">, query: string): boolean {
  const hay = `${p.name}\n${p.path}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

/**
 * The picker's rows for `query`: RECENT (the RECENT projects with the newest chats among the matches), then ALL
 * PROJECTS (the other matches by name, settled ones last). The picked one is ticked; a working one has the dot.
 */
export function pickerRows(list: readonly FwdProject[], query: string, selected: string | null): FwdRow[] {
  const hits = list.filter((p) => projectMatches(p, query));
  if (!hits.length) return [{ kind: "empty", id: "", name: list.length ? "No project matches." : "No projects in Hub yet.", path: "", on: false, dot: false }];
  const recent = hits
    .filter((p) => p.last > 0)
    .sort((a, b) => b.last - a.last)
    .slice(0, RECENT);
  const inRecent = new Set(recent.map((p) => p.id));
  const rest = hits.filter((p) => !inRecent.has(p.id)).sort((a, b) => Number(!!a.settled) - Number(!!b.settled) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const row = (p: FwdProject): FwdRow => ({ kind: "item", id: p.id, name: p.name, path: p.short, on: p.id === selected, dot: p.working });
  const head = (name: string): FwdRow => ({ kind: "head", id: `h:${name}`, name, path: "", on: false, dot: false });
  return [...(recent.length ? [head("Recent"), ...recent.map(row)] : []), ...(rest.length ? [head(recent.length ? "All projects" : "Projects"), ...rest.map(row)] : [])];
}

/** The project rows alone (what Up / Down / Enter move through). */
export const pickable = (rows: readonly FwdRow[]): FwdRow[] => rows.filter((r) => r.kind === "item");

/** Up / Down in the picker: the next pickable row's id from `current` (wrapping), the first one when none is highlighted. */
export function stepPick(rows: readonly FwdRow[], current: string, by: 1 | -1): string {
  const ids = pickable(rows).map((r) => r.id);
  if (!ids.length) return "";
  const i = ids.indexOf(current);
  if (i < 0) return by > 0 ? ids[0]! : ids[ids.length - 1]!;
  return ids[(i + by + ids.length) % ids.length]!;
}

/** The quote's first line: "zeus.exxe · 21:41 · SpokPay" (author, then the rest muted). */
export function quoteMeta(o: { author: string; time: string; section: string }): { author: string; rest: string } {
  return { author: o.author, rest: [o.time, o.section].filter(Boolean).map((x) => ` · ${x}`).join("") };
}

/** The dialog's line under its title. */
export const fwdSubtitle = (project: string): string => `Starts a new chat in ${project || "a project"} with this message and your prompt.`;
