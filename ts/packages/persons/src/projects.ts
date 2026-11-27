// Forward to Projects (a message's menu): the projects a forwarded message can start a chat in, read from Hub's
// `/v1/state` (its projects and chats). Each with the time of its newest chat (the picker's Recent) and whether a chat
// of it is working now (the green dot). Pure, so it is unit tested; routes.ts answers it as `GET projects`.
import { AI_PROJECT_PATH } from "./ai.ts";

export interface ProjectChoice {
  id: string;
  name: string;
  /** Its folder on this PC (or the PC it's on). */
  path: string;
  /** The path as the picker shows it: the last three folders at most ("creators-hub/tabs/Persons"). */
  short: string;
  /** Its newest chat's last change (ms), 0 with none. */
  last: number;
  /** A chat of it is working now. */
  working: boolean;
  /** Settled (done) in Projects: listed last. */
  settled: boolean;
}

interface StateProject {
  id: string | number;
  name?: string;
  path?: string;
  settled?: boolean;
}
interface StateChat {
  project_id?: string | number | null;
  updated_ms?: number;
  running?: boolean;
  working?: boolean;
  retired?: boolean;
  role?: string;
}

/** "creators-hub/tabs/Persons" for ~/Documents/harbor-projects/creators-hub/tabs/Persons, "harbor-projects/spokpay" for ~/Documents/harbor-projects/spokpay; home alone is "~". */
export function shortPath(path: string, home = ""): string {
  const p = path.replace(/\/+$/, "");
  const h = home.replace(/\/+$/, "");
  // under home (and its Documents, where projects usually live): the rest of the path
  const rel = h && (p === h || p.startsWith(`${h}/`)) ? p.slice(h.length + 1).replace(/^Documents(\/|$)/, "") : p.replace(/^\/+/, "");
  if (!rel) return p === h ? "~" : "Documents";
  const parts = rel.split("/").filter(Boolean);
  return parts.slice(-3).join("/");
}

/** Hub's projects as the picker lists them (in Hub's order), from `/v1/state`'s body. */
export function projectChoices(state: unknown, home = ""): ProjectChoice[] {
  const s = (state ?? {}) as { projects?: StateProject[]; chats?: StateChat[] };
  const chats = Array.isArray(s.chats) ? s.chats : [];
  const byProject = new Map<string, { last: number; working: boolean }>();
  for (const c of chats) {
    if (c.project_id == null || c.retired) continue;
    const k = String(c.project_id);
    const e = byProject.get(k) ?? { last: 0, working: false };
    e.last = Math.max(e.last, c.updated_ms ?? 0);
    if (c.running || c.working) e.working = true;
    byProject.set(k, e);
  }
  return (Array.isArray(s.projects) ? s.projects : []).map((p) => {
    const path = p.path ?? "";
    const e = byProject.get(String(p.id));
    const name = (p.name ?? "").trim() || path.split("/").filter(Boolean).pop() || String(p.id);
    return { id: String(p.id), name, path, short: shortPath(path, home), last: e?.last ?? 0, working: e?.working ?? false, settled: p.settled === true };
  });
}

/** The project picked first: the one used last when it's still there, else Persons' own (creators-hub/tabs/Persons), else the newest. */
export function defaultProject(list: readonly ProjectChoice[], last: string | null): string | null {
  if (last && list.some((p) => p.id === last)) return last;
  const persons = list.find((p) => p.path.replace(/\/+$/, "").endsWith(`/${AI_PROJECT_PATH}`));
  if (persons) return persons.id;
  return [...list].sort((a, b) => b.last - a.last)[0]?.id ?? null;
}
