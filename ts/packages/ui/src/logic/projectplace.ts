/**
 * Where a project's folder is, as the sidebar, the palette and the composer say it. A PC lists
 * its own projects and entries made from other PCs' chats; one whose folder isn't on this PC
 * names the PC that holds it, so two projects with one name are told apart, and a new chat in
 * it starts there. The phone shows the same from `/v1/state` (`here`, `pc`, `pc_name`).
 */
import { dirname } from "node:path";

/** A project's folder isn't on this PC: the PC that holds it (`pc` "" when none is known). */
export interface Place {
  pc: string;
  name: string;
  online: boolean;
}

/** The PC's name, or what to say when no PC is known. */
export function placeName(p: Place): string {
  return p.name !== "" ? p.name : "another PC";
}

/**
 * The small hint after a project's name: only when another project has its name, its folder's parent. Where the folder
 * is says nothing of whose the project is (a chat runs on the PC it's typed on): no PC is named there.
 */
export function placeHint(_place: Place | null, dir: string, clash: boolean): string {
  if (!clash) return "";
  const up = dirname(dir);
  return up !== "." && up !== dir && up !== "/" ? up : dir;
}

/** A project's tooltip or palette line: its folder, with where it is when it isn't here. */
export function placeLine(place: Place | null, dir: string): string {
  if (place === null) return dir;
  return place.name !== "" ? `On ${place.name}: ${dir}` : `Not on this PC: ${dir}`;
}

/** The names more than one project has. */
export function clashingNames(repos: readonly { name: string }[]): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const r of repos) (seen.has(r.name) ? twice : seen).add(r.name);
  return twice;
}

/**
 * The line over a new chat's composer in a project whose folder isn't here (null: it is, or a
 * device is picked, which the device chip already names): where the project lives and how to start there.
 * `target` is the PC the draft starts on (null: this PC).
 */
export function draftPlaceLine(project: string, place: Place | null, target: string | null): string | null {
  if (place === null) return null;
  if (target !== null) return null;
  if (place.pc === "") return `${project}'s folder isn't on this PC: pick the PC that has it under Runs on`;
  if (!place.online) return `${project}'s folder is on ${place.name}, which is off: the chat can start there once it's back`;
  return `${project}'s folder is on ${place.name}, not on this PC: pick ${place.name} under Runs on to start there`;
}
