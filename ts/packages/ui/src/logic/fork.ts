import type { Item } from "./item.ts";

/** For each item: the index of the turn end it can be forked at (a reply that ended its turn), else null. */
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
