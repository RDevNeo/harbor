// The Person AI's answer split into its markdown and the messages it drafted for the person, fenced as ```reply
// (ai.ts tells it to). Person Hub's personAi.ts `aiParts`, the same rule: an unclosed fence (a streaming answer)
// is a draft up to the end; other fences (```js…) stay markdown.
import { blocks, type Block } from "@harbor/net";

export type AiPart = { type: "text"; text: string } | { type: "draft"; text: string };

export function aiParts(text: string): AiPart[] {
  const out: AiPart[] = [];
  const re = /```reply[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(last, m.index).trim();
    if (before) out.push({ type: "text", text: before });
    out.push({ type: "draft", text: (m[1] ?? "").replace(/\n+$/, "") });
    last = m.index + m[0].length;
  }
  const rest = text.slice(last).trim();
  if (rest) out.push({ type: "text", text: rest });
  return out;
}

/** What a chat's `ai[].parts` carries: the text parts' markdown also as the phone's block model (PROTOCOL.md). */
export type AiPartJson = { type: "text"; text: string; blocks: Block[] } | { type: "draft"; text: string };

export function aiPartsJson(text: string): AiPartJson[] {
  return aiParts(text).map((p) => (p.type === "text" ? { ...p, blocks: blocks(p.text) } : p));
}
