// The Person AI's answer for its bubble (persons.slint `PPart`): its markdown as the blocks Projects' chat draws
// (cards.ts `mdBlocks`, markdown.slint; bold drawn bold), its ```reply drafts as cards. The engine splits them (persons aiparts.ts).
import * as slint from "slint-ui";
import { mdBlocks } from "../../cards.ts";
import type { MdBlockData } from "../../window.ts";
import type { AiPartJson } from "./view.ts";

export interface PPartData {
  draft: boolean;
  text: string;
  block: MdBlockData;
  gap: number;
}

/** Projects' spacing is a blank 21px row of its 16px text; a bubble's 14px text gets half of it. */
const SCALE = 0.5;
/** Between a draft card and the text around it. */
export const DRAFT_GAP = 8;

const blank = (): MdBlockData => ({
  kind: "",
  text: slint.StyledText.fromPlainText(""),
  code: "",
  level: 0,
  marker: "",
  depth: 0,
  quote: 0,
  table: [],
  gap: 0,
  after: 0,
  bar_top: 0,
  bar_bottom: 0,
  trim: 0,
  plain: "",
  links: [],
  key: "",
});

/** `owner`: whose markdown blocks these are (markdown.ts `registerBlock`), released by the caller when they go. */
export function aiSlintParts(parts: readonly AiPartJson[], owner: string | null = null): PPartData[] {
  const out: PPartData[] = [];
  for (const p of parts) {
    if (p.type === "draft") {
      out.push({ draft: true, text: p.text, block: blank(), gap: out.length ? DRAFT_GAP : 0 });
      continue;
    }
    mdBlocks(p.text, -1, owner, true).forEach((b, i) => {
      const block = { ...b, gap: Math.round(b.gap * SCALE), after: Math.round(b.after * SCALE), bar_top: Math.round(b.bar_top * SCALE), bar_bottom: Math.round(b.bar_bottom * SCALE) };
      out.push({ draft: false, text: "", block, gap: i === 0 && out.length ? DRAFT_GAP : 0 });
    });
  }
  return out;
}
