// What a suite left running: every process of this user whose command line names the suite's temp
// folder (detached runners, the fake CLIs they start). A run that died mid-test left two fake CLIs
// spinning for hours, so suites that start turns call this in afterAll.
import { cmdline, killTree, myUid, ownerOf, pids } from "../src/procfs.ts";

export function reap(base: string): number {
  const me = myUid();
  let n = 0;
  for (const pid of pids()) {
    if (pid === process.pid || ownerOf(pid) !== me) continue;
    if (!(cmdline(pid) ?? []).some((a) => a.includes(base))) continue;
    killTree(pid);
    n++;
  }
  return n;
}

/** Put first in a fake CLI's script: it exits once the process that started it is gone, and after
 *  `maxMs` all the same, so a test run that dies can't leave it running. */
export const GUARD = (maxMs = 120_000): string =>
  `{ const parent = process.ppid; const born = Date.now(); setInterval(() => { if (process.ppid !== parent || Date.now() - born > ${maxMs}) process.exit(3); }, 250).unref(); }\n`;
