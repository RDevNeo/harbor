// Processes, as detach.rs and agent.rs read them: @harbor/os's (from /proc on Linux).
import { proc } from "@harbor/os";

export const pids = proc.pids;
export const procStart = proc.procStart;
export const parentOf = proc.parentOf;
export const alive = proc.alive;
export const startedAt = proc.startedAt;
export const cmdline = proc.cmdline;
export const ownerOf = proc.ownerOf;
export const myUid = proc.myUid;
export const descendants = proc.descendants;
/** By parent pid, not process group: agents run Bash commands in their own sessions, which a group kill would miss. */
export const killTree = proc.killTree;
