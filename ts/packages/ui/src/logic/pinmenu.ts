import type { pins } from "@harbor/store";
import type { PinRow } from "../window.ts";

/** What a pin row does when picked. */
export type PinAct = { kind: "pin"; account: string } | { kind: "unpin" } | { kind: "other" } | { kind: "none" };

export interface PinMenuInput {
  /** An open chat; false: the new-chat draft. */
  chat: boolean;
  /** The pin that governs it (pins.ts `Pins.of`), or null. */
  pinned: pins.Pinned | null;
  /** The pinned account's name ("Claude · IG"). */
  pinName: string;
  /** The account picked now and its name. */
  sel: { account: string; name: string };
  /** It waits at its pinned account's limit: the account "Use … this time" would take (its name), null when none can. */
  waiting: { other: string | null } | null;
  /** The project's name ("" none). */
  project: string;
}

/** The picker's pin rows under the models, and what each does (desktop; the phone's sheet says the same). */
export function pinRows(i: PinMenuInput): { rows: PinRow[]; acts: PinAct[] } {
  const rows: PinRow[] = [];
  const acts: PinAct[] = [];
  const add = (label: string, sub: string, act: PinAct, warn = false): void => {
    rows.push({ label, sub, warn, enabled: act.kind !== "none" });
    acts.push(act);
  };
  const p = i.pinned;
  if (!i.chat) {
    if (p !== null) add(`${i.project || "This project"} keeps its chats on ${i.pinName}`, p.why !== "" ? `${i.pinName} ${p.why}: unpin it in the project's menu` : "New chats here start there; Hub won't switch them", { kind: "none" }, p.why !== "");
    return { rows, acts };
  }
  if (p === null) {
    add(`Keep this chat on ${i.sel.name}`, "Hub won't switch its account by itself", { kind: "pin", account: i.sel.account });
    return { rows, acts };
  }
  if (p.why !== "") {
    add(`Pinned to ${i.pinName}, which ${p.why}`, p.scope === "project" ? "Pick another account above (it pins this chat to it)" : "Pick another account above, or unpin", { kind: "none" }, true);
    if (p.scope === "chat") add("Unpin", "Hub may switch its account again", { kind: "unpin" });
    return { rows, acts };
  }
  if (i.waiting !== null && i.waiting.other !== null) add(`Use ${i.waiting.other} this time`, `Otherwise it waits for ${i.pinName}'s reset; the pin stays`, { kind: "other" });
  if (p.scope === "project") {
    if (i.sel.account !== p.account) add(`Keep this chat on ${i.sel.name}`, `Its project keeps it on ${i.pinName}; this pins the chat itself`, { kind: "pin", account: i.sel.account });
    else add(`Kept on ${i.pinName} by its project`, "Hub won't switch it; unpin it in the project's menu", { kind: "none" });
    return { rows, acts };
  }
  add(`Unpin from ${i.pinName}`, "Pinned: Hub won't switch its account", { kind: "unpin" });
  return { rows, acts };
}

/** The composer chip's pin state and the line its tooltip adds. */
export function chipPin(p: pins.Pinned | null, name: string): { pin: "" | "ok" | "error"; tip: string } {
  if (p === null) return { pin: "", tip: "" };
  const whose = p.scope === "project" ? " (its project's pin)" : "";
  if (p.why !== "") return { pin: "error", tip: `Pinned to ${name}${whose}, which ${p.why}: pick another account or unpin` };
  return { pin: "ok", tip: `Pinned to ${name}${whose}: Hub won't switch it` };
}

/** The line over the composer of a pinned chat that can't run as it is: its account missing here, or waiting at its
 *  limit ("" none). The picker (the account chip) has the actions. */
export function pinNotice(p: pins.Pinned | null, name: string, waitsUntil: string | null): string {
  if (p === null) return "";
  if (p.why !== "") return `Pinned to ${name}, which ${p.why}. Messages wait: pick another account or unpin in the account menu below.`;
  if (waitsUntil !== null) return `Pinned to ${name}: waiting for its limit to reset (${waitsUntil}). The account menu below can use another account this time, or unpin.`;
  return "";
}
