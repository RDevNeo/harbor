// The PC's Persons sidebar folds (sections folded shut, stores unfolded, Settled folds open, "sr" = SpokPay › Site
// requests folded), kept in <persons>/folds.json so the sidebar comes back as it was left: after switching tabs, a
// reopen or a restart. The phone keeps its own (SharedPreferences "persons": closed, stores, settled_open).
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Folds {
  closed: string[];
  stores: string[];
  settledOpen: string[];
}

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 120))].slice(0, 500) : [];

/** Anything read or sent, as folds (unknown fields dropped, odd values left out). */
export function normFolds(v: unknown): Folds {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return { closed: ids(o.closed), stores: ids(o.stores), settledOpen: ids(o.settledOpen) };
}

export const foldsFile = (dir: string): string => join(dir, "folds.json");

export function readFolds(dir: string): Folds {
  try {
    return normFolds(JSON.parse(readFileSync(foldsFile(dir), "utf8")));
  } catch {
    return normFolds(null);
  }
}

let chain: Promise<void> = Promise.resolve();

/** Written off the main thread's way (async, in order, atomically). */
export function writeFolds(dir: string, f: Folds): Promise<void> {
  const file = foldsFile(dir);
  const text = JSON.stringify(normFolds(f));
  chain = chain.then(async () => {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, file);
  }).catch(() => {});
  return chain;
}
