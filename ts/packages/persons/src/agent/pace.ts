// What Discord's spam filter watches, for the agents' Discord tools: new DMs, bursts of uploads, floods of messages
// and reactions. Each limit is a count in a window and a gap between two. Joining and leaving servers aren't paced:
// the user asked for that. The log (kind, unix seconds) is kept in a file so a Hub restart doesn't reset it.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

interface Limit {
  kind: string;
  label: string;
  gap: number;
  hour: number;
  day: number;
}

export const DAY = 24 * 3600;

const LIMITS: Limit[] = [
  { kind: "dm", label: "new DMs", gap: 120, hour: 4, day: 10 },
  { kind: "upload", label: "file uploads", gap: 20, hour: 15, day: 60 },
  { kind: "send", label: "messages", gap: 1, hour: 120, day: 600 },
  { kind: "react", label: "reactions", gap: 1, hour: 120, day: 600 },
];

/** Waits this short just happen; longer ones are the agent's to hear about. */
const WAIT_UP_TO = 5;

export type Pace = { go: true } | { wait: number } | { refuse: string };

/** What's allowed now for `kind`, given when it last happened (`log`: unix seconds, any order). */
export function pace(kind: string, log: [string, number][], at: number): Pace {
  const l = LIMITS.find((x) => x.kind === kind);
  if (l === undefined) return { go: true };
  const times = log
    .filter(([k]) => k === kind)
    .map(([, t]) => t)
    .filter((t) => at - t < DAY)
    .sort((a, b) => a - b);
  const hour = times.filter((t) => at - t < 3600).length;
  const refuse = (n: number, what: string, secs: number): Pace => ({
    refuse: `Paced: ${n} ${l.label} in the last ${what} is Hub's limit, because Discord's spam filter watches these. The next one can go in about ${Math.floor((secs + 59) / 60)} min. Tell the user instead of retrying.`,
  });
  if (times.length >= l.day) return refuse(times.length, "day", (times[times.length - l.day] ?? 0) + DAY - at);
  if (hour >= l.hour) return refuse(hour, "hour", (times[times.length - l.hour] ?? 0) + 3600 - at);
  const last = times.at(-1);
  const left = last === undefined ? 0 : last + l.gap - at;
  if (left <= 0) return { go: true };
  if (left <= WAIT_UP_TO) return { wait: left };
  return { refuse: `Paced: Hub spaces out ${l.label} because Discord's spam filter watches them. The next one can go in about ${left < 60 ? `${left} s` : `${Math.floor((left + 59) / 60)} min`}. Tell the user instead of retrying.` };
}

/** The pace log in a file (owner-only). */
export class PaceLog {
  constructor(
    private readonly path: string,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  read(): [string, number][] {
    let v: unknown;
    try {
      v = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return [];
    }
    const out: [string, number][] = [];
    for (const e of Array.isArray(v) ? v : []) if (Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number") out.push([e[0], e[1]]);
    return out;
  }

  check(kind: string): Pace {
    return pace(kind, this.read(), this.now());
  }

  note(kind: string): void {
    const at = this.now();
    const log = this.read().filter(([, t]) => at - t < DAY);
    log.push([kind, at]);
    try {
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(log), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch {
      // an unwritten note only makes the next call a little less paced
    }
  }
}
