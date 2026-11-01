// Claude Code continues a conversation only from its session file, so a Claude fork resumes a copy
// of it cut after the forked message.
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Item } from "@harbor/store";
import { arr, at, obj, parse, str } from "./json.ts";

export const preambleKey = (chat: number): string => `fork_preamble_${chat}`;
/** JSON [[item, fork chat id], …]. */
export const forksKey = (chat: number): string => `forks_of_${chat}`;

/** For each item, the end of its turn when it's the last reply of a finished turn; running turns can't be forked. */
export function forkable(items: readonly Item[]): (number | null)[] {
  const out: (number | null)[] = items.map(() => null);
  let last: number | null = null;
  items.forEach((it, i) => {
    if (it.kind === "text" && it.text.trim() !== "") last = i;
    else if (it.kind === "result") {
      if (last !== null) out[last] = i;
      last = null;
    } else if (it.kind === "user") last = null;
  });
  return out;
}

type Anchor = { kind: "user"; text: string } | { kind: "text"; text: string } | { kind: "tool"; id: string; result: boolean };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return arr(content)
    .filter((b) => at(b, "type") === "text")
    .flatMap((b) => (typeof at(b, "text") === "string" ? [at(b, "text") as string] : []))
    .join("\n");
}

function matches(line: unknown, a: Anchor): boolean {
  const kind = str(at(line, "type"));
  const content = at(line, "message", "content");
  const blocks = arr(content);
  if (a.kind === "user") return kind === "user" && textOf(content).includes(a.text);
  if (a.kind === "text") {
    const s = textOf(content).trim();
    return kind === "assistant" && s !== "" && (s === a.text || s.includes(a.text) || a.text.includes(s));
  }
  return a.result
    ? kind === "user" && blocks.some((b) => at(b, "type") === "tool_result" && at(b, "tool_use_id") === a.id)
    : kind === "assistant" && blocks.some((b) => at(b, "type") === "tool_use" && at(b, "id") === a.id);
}

/** Copies the session file `src` next to itself as `newId`, cut right after the line of the last item; throws when that item can't be found. */
export function forkJsonl(src: string, newId: string, items: readonly Item[]): void {
  const text = readFileSync(src, "utf8");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const anchors: Anchor[] = items.flatMap((it): Anchor[] => {
    if (it.kind === "user" && it.text.trim() !== "") return [{ kind: "user", text: it.text.trim() }];
    if (it.kind === "text" && it.text.trim() !== "") return [{ kind: "text", text: it.text.trim() }];
    if (it.kind === "tool" && it.id !== "") return [{ kind: "tool", id: it.id, result: it.result !== null }];
    return [];
  });
  // Anchors in order, each searched after the previous one; one that isn't found is skipped, but the last must be.
  const parsed = lines.map((l) => parse(l));
  let from = 0;
  let cut: number | null = null;
  anchors.forEach((a, n) => {
    let hit = -1;
    for (let i = from; i < parsed.length; i++) {
      if (parsed[i] !== undefined && matches(parsed[i], a)) {
        hit = i;
        break;
      }
    }
    if (hit >= 0) {
      from = hit + 1;
      cut = hit;
    } else if (n + 1 === anchors.length) throw new Error("the forked message isn't in the session");
  });
  if (cut === null) throw new Error("nothing to fork");
  let out = "";
  for (let i = 0; i <= cut; i++) {
    const o = obj(parsed[i]);
    out += `${o && "sessionId" in o ? JSON.stringify({ ...o, sessionId: newId }) : lines[i]}\n`;
  }
  const dst = join(dirname(src), `${newId}.jsonl`);
  writeFileSync(dst, out);
  // As private as the session it came from.
  try {
    chmodSync(dst, statSync(src).mode & 0o7777);
  } catch {}
}
