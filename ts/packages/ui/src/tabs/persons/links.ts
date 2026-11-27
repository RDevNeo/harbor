// Web addresses in a person chat's messages, made clickable: found in the text as drawn, handed to the bubble as
// link words (markdown.slint `LinkLayer`, as Projects' answers) and as inline markdown for its link colour.
import { escape, linkWords, type Link, type MdLinkData } from "../../markdown.ts";

/** Characters that end a sentence after an address rather than belong to it. */
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", '"', "*", "_", "~"]);
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function count(s: string, c: string): number {
  let n = 0;
  for (const x of s) if (x === c) n++;
  return n;
}

/** An address as matched, without what follows it in the sentence: "https://a.b/c)." from "(see https://a.b/c)." is
 *  "https://a.b/c"; a closing bracket that has its opening one in the address stays ("…/Foo_(bar)"). */
export function trimUrl(url: string): string {
  let u = url;
  for (;;) {
    const last = u.slice(-1);
    if (TRAILING.has(last)) u = u.slice(0, -1);
    else if (last in CLOSERS && count(u, last) > count(u, CLOSERS[last] as string)) u = u.slice(0, -1);
    else return u;
  }
}

/** The http(s) addresses in `text`, by UTF-8 byte offsets in it (what Slint's text reports), the whole address with
 *  its query; one with nothing after "://" isn't one. */
export function urlLinks(text: string): Link[] {
  const out: Link[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const url = trimUrl(m[0]);
    if (!/^https?:\/\/[^/?#\s]/i.test(url)) continue;
    const from = Buffer.byteLength(text.slice(0, m.index));
    out.push({ from, to: from + Buffer.byteLength(url), url });
  }
  return out;
}

/** `text` as inline markdown for StyledText that draws it as it is (every character literal, its line breaks kept)
 *  with `links` (byte offsets in it, in order) as links. */
export function linkedMarkdown(text: string, links: readonly Link[]): string {
  const bytes = Buffer.from(text);
  const lit = (s: string): string => escape(s).replace(/&/g, "\\&").replace(/\r?\n/g, "\\\n");
  let out = "";
  let at = 0;
  for (const l of links) {
    out += lit(bytes.subarray(at, l.from).toString());
    out += `[${lit(bytes.subarray(l.from, l.to).toString())}](<${l.url}>)`;
    at = l.to;
  }
  return out + lit(bytes.subarray(at).toString());
}

/** A message's text as its bubble draws it: its link words (none without an address) and the markdown with them. */
export function messageLinks(text: string): { links: MdLinkData[]; markdown: string } {
  const links = urlLinks(text);
  if (links.length === 0) return { links: [], markdown: "" };
  return { links: linkWords({ plain: text, links }), markdown: linkedMarkdown(text, links) };
}
