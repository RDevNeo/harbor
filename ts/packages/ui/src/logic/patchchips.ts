// The shelf of patch buttons over the composer (agents/src/patches.ts): one chip per action and panel of
// the chat's trusted patches, then "N patches to trust" and "N patch problems".
import type { patches } from "@harbor/agents";
import { ICONS, type IconName } from "../icons.ts";

type PatchFile = patches.PatchFile;

/** composer.slint `PatchChip`. */
export interface PatchChipData {
  icon: string;
  text: string;
  tip: string;
  /** "", "trust", "error" or "more". */
  tone: string;
}

export type ChipAct =
  | { kind: "action"; action: patches.PatchAction; root: string }
  | { kind: "panel"; panel: patches.PatchPanel; root: string }
  | { kind: "trust"; files: PatchFile[] }
  | { kind: "problems"; files: PatchFile[] }
  | { kind: "more"; acts: ChipAct[]; chips: PatchChipData[] };

/** Chips shown before the rest go under "+N". */
export const SHOWN = 6;

/** A patch's `icon` ("flask", "git-branch", "LIST_CHECKS") as a glyph; `fallback` when Harbor hasn't that one. */
export function glyphOf(name: string, fallback: IconName): string {
  const k = name.trim().toUpperCase().replace(/[-\s]+/g, "_") as IconName;
  return ICONS[k] ?? ICONS[fallback];
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function patchChips(files: readonly PatchFile[], max = SHOWN): { chips: PatchChipData[]; acts: ChipAct[] } {
  const chips: PatchChipData[] = [];
  const acts: ChipAct[] = [];
  for (const f of files) {
    for (const a of f.actions) {
      const fallback: IconName = a.kind === "run" ? "TERMINAL" : a.kind === "prompt" ? "SEND" : "EXTERNAL";
      const what = a.kind === "run" ? `Runs ${a.value}` : a.kind === "prompt" ? `Sends: ${a.value}` : `Opens ${a.value}`;
      chips.push({ icon: glyphOf(a.icon, fallback), text: a.title, tip: `${what}\n${f.name} patch`, tone: "" });
      acts.push({ kind: "action", action: a, root: f.root });
    }
    for (const p of f.panels) {
      chips.push({ icon: glyphOf(p.icon, p.url ? "GLOBE" : "LIST_CHECKS"), text: p.title, tip: `${p.url ? `Shows ${p.url}` : "Opens a list"} in a side panel${p.note ? `\n${p.note}` : ""}\n${f.name} patch`, tone: "" });
      acts.push({ kind: "panel", panel: p, root: f.root });
    }
  }
  if (chips.length > max) {
    const rest = chips.splice(max - 1);
    const restActs = acts.splice(max - 1);
    chips.push({ icon: "", text: `+${rest.length}`, tip: rest.map((c) => c.text).join(", "), tone: "more" });
    acts.push({ kind: "more", acts: restActs, chips: rest });
  }
  const waiting = files.filter((f) => f.state === "untrusted");
  if (waiting.length > 0) {
    chips.push({ icon: ICONS.LOCK, text: waiting.length === 1 ? "Patch to trust" : plural(waiting.length, "patch to trust", "patches to trust"), tip: waiting.map((f) => f.path).join("\n"), tone: "trust" });
    acts.push({ kind: "trust", files: waiting });
  }
  const bad = files.filter((f) => f.state === "blocked" || f.state === "error");
  if (bad.length > 0) {
    chips.push({ icon: ICONS.ALERT, text: bad.length === 1 ? `${bad[0]?.name} patch: problem` : plural(bad.length, "patch problem", "patch problems"), tip: bad.map((f) => `${f.name}: ${f.error}`).join("\n"), tone: "error" });
    acts.push({ kind: "problems", files: bad });
  }
  return { chips, acts };
}

/** What changed enough to redraw the shelf or say so: each file's path, hash, state, error and buttons. */
export function signature(files: readonly PatchFile[]): string {
  return JSON.stringify(files.map((f) => [f.path, f.hash, f.state, f.error, f.actions.map((a) => [a.title, a.kind, a.value, a.icon]), f.panels.map((p) => [p.title, p.url ?? "", p.icon])]));
}
