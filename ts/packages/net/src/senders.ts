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
