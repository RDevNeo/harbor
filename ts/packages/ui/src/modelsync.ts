/** What `syncRows` changes: slint-ui's ArrayModel. */
export interface Rows<T> {
  readonly length: number;
  rowData(i: number): T | undefined;
  setRowData(i: number, v: T): void;
  remove(i: number, n: number): void;
  splice(i: number, del: number, ...add: T[]): void;
}

/**
 * Keeps a model's rows equal to `next`, touching only what changed: the rows both start with and end with stay as
 * they are, and only the ones between are set, put in or taken out. Rows that come in above the others (a page of
 * earlier cards, the rest of a chat's page after its first frame, a chat new in the sidebar) are put in, so the
 * window keeps the rows below as they are drawn instead of filling each of them anew.
 */
export function syncRows<T>(model: Rows<T>, next: readonly T[], same: (a: T, b: T) => boolean = (a, b) => a === b): void {
  const old = model.length;
  const n = next.length;
  const eq = (i: number, j: number): boolean => {
    const a = model.rowData(i);
    return a !== undefined && same(a, next[j] as T);
  };
  let pre = 0;
  while (pre < old && pre < n && eq(pre, pre)) pre++;
  let suf = 0;
  while (suf < old - pre && suf < n - pre && eq(old - 1 - suf, n - 1 - suf)) suf++;
  const from = old - pre - suf;
  const to = n - pre - suf;
  const both = Math.min(from, to);
  for (let i = pre; i < pre + both; i++) if (!eq(i, i)) model.setRowData(i, next[i] as T);
  if (from > to) model.remove(pre + both, from - to);
  else if (to > from) model.splice(pre + both, 0, ...next.slice(pre + both, pre + to));
}
