import { basename } from "node:path";
import type { Chat, Repo } from "@harbor/store";
import { clip } from "./team.ts";

/** A chat notice's detail that links to another chat by its gid. */
export const LINK = "harbor:gid/";
/** Who a message from another chat's agent is to, in its transcript. */
export const THIS_CHAT = "this chat";

export function quoted(title: string): string {
  return `“${clip(title.trim(), 60)}”`;
}

/** The note at the top of a chat an agent opened. */
export function openedBy(source: string): string {
  return `Opened by the agent of ${quoted(source)}`;
}

/** A project by its name or folder: exact path, then name, then folder name. */
export function findProject(repos: readonly Repo[], want: string): number | null {
  const w = want.trim().replace(/\/+$/, "");
  const lower = w.toLowerCase();
  const byPath = repos.find((r) => [r.path, r.local ?? r.path].some((p) => p.replace(/\/+$/, "") === w));
  const byName = repos.find((r) => r.name.toLowerCase() === lower);
  const byFolder = repos.find((r) => basename(r.path).toLowerCase() === lower);
  return (byPath ?? byName ?? byFolder)?.id ?? null;
}

/** The chat `r` names among `chats`: its id, its gid, or its title. */
export function findChat(chats: readonly Chat[], ref: string): Chat | undefined {
  const r = ref.trim().replace(/^#+/, "").replace(/^["“”]+|["“”]+$/g, "");
  return chats.find((c) => (/^[+-]?\d+$/.test(r) && Number(r) === c.id) || c.gid === r) ?? chats.find((c) => c.title.toLowerCase() === r.toLowerCase());
}

/** Chats whose title or agent name (a sub-agent's: with its lead's title) holds every word of `query`; most recent first, at most 25. */
export function matching(chats: readonly Chat[], query: string, visible: (c: Chat) => boolean): Chat[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  const parent = (c: Chat): string => (c.parent === null ? "" : (chats.find((x) => x.id === c.parent)?.title ?? ""));
  return chats
    .filter((c) => c.gid !== "" && visible(c))
    .filter((c) => {
      const hay = `${c.title} ${c.name} ${c.role === "sub" ? parent(c) : ""}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 25);
}

/** What an opened chat's agent reads before the prompt. */
export function preamble(source: Chat): string {
  return `[Harbor: the agent of the chat ${quoted(source.title)} (id ${source.id}) opened this chat for you with the request below. Work on it here: the user follows this chat in Harbor's sidebar. To report back to that chat, use harbor message_chat.]\n\n`;
}
