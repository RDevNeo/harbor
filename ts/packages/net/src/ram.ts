import { newPeer, type Peer } from "./shared.ts";
import { sys } from "@harbor/os";

/** The composer's "Auto" pick of where a new chat runs: resolved to a PC at its first message. */
export const AUTO_DEVICE = "auto";
/** How far back the free-memory average looks. */
export const RAM_WINDOW_MS = 10 * 60_000;
/** How often each PC reads its free memory. */
export const RAM_SAMPLE_MS = 30_000;

/** Free memory in MB (MemAvailable); null when it can't be read. `HARBOR_TEST_MEMAVAIL_MB` for rigs. */
export const memAvailableMb = (): number | null => sys.memAvailableMb();

/** This PC's free memory, sampled every 30 s: the average over the last 10 minutes, or the current value while there are no samples yet. */
export class RamMeter {
  private samples: [number, number][] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly read: () => number | null = memAvailableMb,
    private readonly now: () => number = Date.now,
  ) {}

  start(every = RAM_SAMPLE_MS): void {
    if (this.timer !== null) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), every);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  sample(): void {
    const v = this.read();
    const t = this.now();
    this.samples = this.samples.filter(([at]) => t - at < RAM_WINDOW_MS);
    if (v !== null) this.samples.push([t, v]);
  }

  /** MB, rounded; null when memory can't be read here. */
  mb(): number | null {
    return averageMb(this.samples, this.now(), this.read);
  }
}

/** The average of the samples of the last 10 minutes; with none, the current value. */
export function averageMb(samples: readonly (readonly [number, number])[], now: number, current: () => number | null): number | null {
  const recent = samples.filter(([at]) => now - at < RAM_WINDOW_MS && at <= now);
  if (recent.length === 0) return current();
  return Math.round(recent.reduce((s, [, v]) => s + v, 0) / recent.length);
}

/** A peer's figure as it came in a mesh answer (`ram`, MB). */
export function ramOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

/** One PC Auto could pick: `id` "" is this PC. Only PCs that can take the chat now. */
export interface AutoCandidate {
  id: string;
  name: string;
  /** Free memory, MB; null: not known (older Harbor), so not a choice. */
  ram: number | null;
}

/** Auto's pick: the PC with the most free memory. Ties go to the name, then the id, first in order, so every PC picks the same. */
export function pickAuto(candidates: readonly AutoCandidate[]): AutoCandidate | null {
  let best: AutoCandidate | null = null;
  for (const c of candidates) {
    if (c.ram === null) continue;
    if (best === null || best.ram === null || c.ram > best.ram || (c.ram === best.ram && (c.name < best.name || (c.name === best.name && c.id < best.id)))) best = c;
  }
  return best;
}

/** "12.3 GB free" for the menus. */
export function ramText(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB free` : `${mb} MB free`;
}

/** kv key of a chat Auto placed: its value is the place it landed on ("" this PC, else the PC's id). */
export const autoKey = (gid: string): string => `auto_pc:${gid}`;

/** HARBOR_FAKE_PEERS=[id=]name:MB[@Owner_Name][+kind.kind][!off],… (screenshots only, `scripts/shot --env`): PCs that are on
 * (off with `!off`), with a Claude account (or the kinds after `+`, each its PC's own CLI), that much free memory and that owner (`_` for a space), in the
 * Runs on menu, Auto's pick and the model picker's accounts. `id=` stands in for a PC the data already knows (a device of
 * Settings › Workspace with its own name). Nothing else knows of them; unset, there are none. */
export function fakePeers(spec: string | undefined): Peer[] {
  const out: Peer[] = [];
  for (const part of (spec ?? "").split(",")) {
    const m = /^(?:([a-z]+:[A-Za-z0-9._-]+)=)?([A-Za-z0-9 ._-]+):(\d+)(?:@([A-Za-z_.'-]+))?(?:\+([a-z.]+))?(!off)?$/.exec(part.trim());
    if (!m) continue;
    const kinds = (m[5] ?? "claude").split(".").filter((k) => k !== "");
    const accounts = kinds.map((k): [string, string, string] => [k, k === "claude" ? "Claude" : k, k]);
    out.push(newPeer({ id: m[1] ?? `pc:fake-${m[2]}`, name: m[2] ?? "", online: m[6] === undefined, moves: true, accountMoves: true, accounts, owner: (m[4] ?? "").replace(/_/g, " "), ram: Number(m[3]) }));
  }
  return out;
}
