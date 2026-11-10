// The new chat's project popover (the "No project" / project name under "What should we work on?"): a search field, then
// one row per project with its icon or tinted initials, then "Add project". The phone draws the same
// rows (ProjectPop.java): `initials` and `tintIndex` are mirrored there so a project keeps its badge on both.

/** The badge tints, muted to sit with Harbor's greys (dark theme); each project's is picked by its name (`tintIndex`).
 *  The badge is the tint at 14 % over the popover, its letters the tint itself. Mirrored in ProjectPop.java. */
export const TINTS: readonly string[] = ["#9d8fd4", "#6fb58a", "#d29a62", "#6f9fd8", "#cf8aa8", "#5fb3ad", "#c7b265", "#d47f7a"];

/** Two letters for a project's badge: the first of its first two words ("acme-web" AW, "assetLibrary" AL), else its first two ("harbor" HA). */
export function initials(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "");
  if (words.length === 0) return "?";
  const [a, b] = words;
  const s = b !== undefined ? [...a!][0]! + [...b][0]! : [...a!].slice(0, 2).join("");
  return s.toUpperCase();
}

/** Java's String.hashCode, so the phone picks the same tint for the same name. */
export function nameHash(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
  return h;
}

export function tintIndex(name: string): number {
  return ((nameHash(name) % TINTS.length) + TINTS.length) % TINTS.length;
}

export function tint(name: string): string {
  return TINTS[tintIndex(name)]!;
}

export interface PopProject {
  id: number;
  name: string;
}

/** A row: a project, "No project" (none) or "Add project" (add). */
export interface PopRow {
  kind: "project" | "none" | "add";
  id: number | null;
  label: string;
}

export const NO_PROJECT = "No project";
export const ADD_PROJECT = "Add project";

/** The rows for `query`: "No project" while it matches, the projects whose name has it, and "Add project" always last. */
export function popRows(projects: readonly PopProject[], query: string): PopRow[] {
  const q = query.trim().toLowerCase();
  const has = (s: string) => q === "" || s.toLowerCase().includes(q);
  const rows: PopRow[] = [];
  if (has(NO_PROJECT)) rows.push({ kind: "none", id: null, label: NO_PROJECT });
  for (const p of projects) if (has(p.name)) rows.push({ kind: "project", id: p.id, label: p.name });
  rows.push({ kind: "add", id: null, label: ADD_PROJECT });
  return rows;
}

/** The highlighted row: the current project's (null: "No project") when it's shown, else the first. */
export function popStart(rows: readonly PopRow[], current: number | null, query: string): number {
  if (query.trim() !== "") return 0;
  const i = rows.findIndex((r) => (current === null ? r.kind === "none" : r.kind === "project" && r.id === current));
  return Math.max(i, 0);
}

/** Up and Down move the highlight round the rows. */
export function popStep(hover: number, rows: number, down: boolean): number {
  if (rows <= 0) return 0;
  return (hover + (down ? 1 : rows - 1) + rows) % rows;
}
