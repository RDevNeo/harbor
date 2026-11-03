import type { SentVia } from "@harbor/store";

/** The PCs and phones this PC knows by name, with their owners: what an old message's label is matched against. */
export interface KnownDevices {
  pcs(): Iterable<readonly [name: string, owner: string]>;
  phones(): Iterable<readonly [name: string, owner: string]>;
}

let known: KnownDevices | null = null;

/** The hub tells which devices it knows (once, at start). */
export function knowDevices(k: KnownDevices | null): void {
  known = k;
}

/** What a user bubble says about where its message was written: the person (else the device's name) and on what. */
export interface SenderLabel {
  who: string;
  via: SentVia | "";
}

const HOST = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * `who` and `via` as the message carries them (0.115 on), else read from its `sender` label, which
 * is "Device (Person)", "Device", "Phone" or "Phone via pc": the device is matched against the PCs
 * and phones known here (a match also gives its owner); an unknown one is a PC when it looks like a
 * host name, else a phone.
 */
export function sentBy(sender: string, who = "", via: SentVia | "" = ""): SenderLabel {
  if (sender === "") return { who: "", via: "" };
  let device = sender.trim();
  let person = "";
  const through = /^(.+?) via [^()\s]+$/.exec(device);
  if (through?.[1]) {
    device = through[1];
    if (via === "") via = "phone";
  }
  const named = /^(.*\S)\s*\(([^()]+)\)$/.exec(device);
  if (named?.[1] && named[2]) {
    device = named[1];
    person = named[2].trim();
  }
  if (who === "" || via === "") {
    const find = (list: Iterable<readonly [string, string]> | undefined) => {
      for (const [n, o] of list ?? []) if (n !== "" && n === device) return o;
      return null;
    };
    const pc = via !== "phone" ? find(known?.pcs()) : null;
    const phone = pc === null && via !== "pc" ? find(known?.phones()) : null;
    if (via === "") via = pc !== null ? "pc" : phone !== null ? "phone" : device !== "Phone" && HOST.test(device) ? "pc" : "phone";
    if (person === "") person = pc ?? phone ?? "";
  }
  return { who: who !== "" ? who : person !== "" ? person : device, via };
}

/**
 * Who looks at a chat, for the row over its user bubbles: every message shows who wrote it except
 * the ones written on the device looking. Null: the desktop of the chat's home PC (whose own
 * messages carry no sender).
 */
export interface Viewer {
  /** Its stable device id, as its messages' `dev` says it: "phone:<pairing>" or "pc:<id>". */
  dev: string;
  /** Its label, as its messages' `sender` says it ("Pixel 8 (Sam)", "work-pc (Sam)"): matched for messages from before `dev`. */
  label: string;
  /** The chat's home PC: a message typed there shows as its owner's (its name when it has none). */
  home: { name: string; owner: string };
}

/** What a user bubble shows for `viewer`: the sender label (empty: no row), the person and on what. */
export interface SenderRow {
  sender: string;
  who: string;
  via: SentVia | "";
}

const NONE: SenderRow = { sender: "", who: "", via: "" };

/** A stable device id for a phone paired as `group` (a signed-in phone's group is its key's fingerprint, the same on every PC). */
export const phoneDev = (group: string): string => (group === "" ? "" : `phone:${group}`);

/** The row over a user message for `viewer` (see Viewer). */
export function shownTo(it: { sender: string; who?: string | undefined; via?: SentVia | undefined; dev?: string | undefined }, viewer: Viewer | null): SenderRow {
  if (it.sender === "") {
    if (viewer === null) return NONE;
    const name = viewer.home.name || "PC";
    const owner = viewer.home.owner;
    return { sender: owner ? `${name} (${owner})` : name, who: owner || name, via: "pc" };
  }
  if (viewer !== null && (it.dev ? it.dev === viewer.dev : viewer.label !== "" && it.sender === viewer.label)) return NONE;
  return { sender: it.sender, ...sentBy(it.sender, it.who, it.via) };
}

/** The owner of a PC known here by name ("" when none is known). */
export function pcOwner(name: string): string {
  for (const [n, o] of known?.pcs() ?? []) if (n !== "" && n === name) return o;
  return "";
}
