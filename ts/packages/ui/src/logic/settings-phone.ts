import { ICONS } from "../icons.ts";
import { type Kv, setGeneral, worktreesSection } from "./settings.ts";
import { type Row, row, type Screen, type Section } from "./phoneui.ts";

/**
 * The phone's Settings sections that live on the PC (`POST /v1/ui/settings`, phoneui.ts): drawn
 * by the app where its own Voice and Worktrees sections were, in the same words and looks. The
 * rows come from the desktop's own sections (settings.ts), so a setting added there reaches the
 * phone with the PC's next release.
 */

export interface PhoneSettingsFacts {
  /** The PC's dictionary's terms (dictate.ts), null on a PC without dictation. */
  dictionary: string[] | null;
}

/** Voice: the dictionary, kept on the PC; the phone edits it on its own screen (`native:dictionary`). */
function voiceSection(terms: string[] | null): Section | null {
  if (terms === null) return null;
  const n = terms.length;
  let preview = "";
  for (const t of terms) {
    if (preview.length >= 60) break;
    preview += (preview === "" ? "" : ", ") + t;
  }
  const sub = n === 0 ? "Names and terms to spell exactly, like SpokPay" : `${n} ${n === 1 ? "word" : "words"} · ${preview}`;
  return { id: "voice", title: "Voice", rows: [row({ id: "dictionary", glyph: ICONS.FILE_TEXT, title: "Dictionary", sub, lines: 2, chevron: true, tap: { kind: "native", screen: "dictionary" } })] };
}

/** Worktrees: the desktop's General › Worktrees toggles, as one row saying what goes and a checklist. */
function worktreesRow(kv: Kv): Row {
  const s = worktreesSection(kv);
  const [on, branch, remote] = s.rows.map((r) => r.on);
  const sub = !on ? "Off: merged worktrees stay" : `Once a chat's PR is merged${branch ? (remote ? " · branches too, here and on GitHub" : " · their branches too") : ""}`;
  return row({
    id: "worktrees",
    glyph: ICONS.FOLDER_GIT,
    title: s.rows[0]?.title ?? "Delete merged worktrees",
    sub,
    lines: 2,
    chevron: true,
    tap: { kind: "multi", act: "worktrees", title: "Merged worktrees", items: s.rows.map((r) => ({ key: r.key, label: r.title, on: r.on })) },
  });
}

export function phoneSettings(kv: Kv, f: PhoneSettingsFacts): Screen {
  const sections: Section[] = [];
  const voice = voiceSection(f.dictionary);
  if (voice !== null) sections.push(voice);
  sections.push({ id: "worktrees", title: "Worktrees", rows: [worktreesRow(kv)] });
  return { v: 1, sections };
}

/**
 * One of the screen's acts (`POST /v1/ui/settings/do`): what to toast, or null for an act it
 * doesn't have (an error for the phone). Only the checklist's own keys are written.
 */
export function phoneSettingsDo(kv: Kv, act: string, b: { values?: unknown; value?: unknown }): string | null {
  if (act === "worktrees") {
    const keys = new Set(worktreesSection(kv).rows.map((r) => r.key));
    const v = b.values;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    for (const [k, on] of Object.entries(v)) if (keys.has(k) && typeof on === "boolean") setGeneral(kv, k, on);
    return "";
  }
  return null;
}
