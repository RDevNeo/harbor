import { spawn } from "node:child_process";
import { memory } from "./packages/agents/src/index.ts";
import { hostLabel, type RemoteHost, shellFamily } from "./packages/net/src/index.ts";

export interface DeviceMemDeps {
  /** The devices of Settings › Workspace, with whether each is online (null: never tested). */
  devices(): [RemoteHost, boolean | null][];
  /** This PC's and the mesh's PCs' ids and names: those aren't asked over SSH. */
  harbors(): { ids: string[]; names: string[] };
  /** Runs `command` on the device over ssh (`deviceMemSh`: its RAM and its turns' processes); its output, null when it didn't answer. */
  read(h: RemoteHost, command: string): Promise<string | null>;
  /** This PC's chats with a turn running on the device: each one's mark (memory.turnMark) and title. */
  turns(device: string): { mark: string; title: string }[];
  now?: () => number;
}

/** What's asked of a device in one ssh call: its RAM, then what each of the turns `marks` holds there. */
export function deviceMemSh(marks: readonly string[]): string {
  return marks.length === 0 ? memory.DEVICE_RAM_SH : `{ ${memory.DEVICE_RAM_SH}; }; echo; ${memory.deviceProcsSh(marks)}`;
}

export interface DeviceMem {
  name: string;
  online: boolean;
  /** `GET /mesh/v1/memory`'s shape (RAM and the chats running there); null until read, or when it didn't answer. */
  mem: Record<string, unknown> | null;
  /** First read still on its way. */
  asking: boolean;
  /** Why there are no numbers, when there's a reason to say. */
  note: string;
  ssh: true;
}

/** Numbers this old are read again (an ssh connection each time: not as often as the mesh's PCs). */
const FRESH_MS = 15_000;
/** A turn the last read didn't ask about (it just started) is read sooner, but not more often than this. */
const NEW_TURN_MS = 3_000;

const label = (s: string): string => s.trim().toLowerCase().split(".")[0] ?? "";

/** The devices to list: shown in Runs on, and not a Harbor PC listed already (by id, or by the name it goes by). */
export function sshDevices(devices: readonly [RemoteHost, boolean | null][], harbors: { ids: string[]; names: string[] }): [RemoteHost, boolean | null][] {
  const names = new Set(harbors.names.map(label).filter((n) => n !== ""));
  return devices.filter(([h]) => !h.hidden && !harbors.ids.includes(h.id) && ![h.name, h.host, hostLabel(h)].some((n) => names.has(label(n))));
}

interface Reading {
  at: number;
  ram: memory.Ram | null;
  /** The turns asked about, and what each held (missing: its processes weren't found). */
  asked: Set<string>;
  procs: Map<string, number>;
  /** It answered. */
  ok: boolean;
}

export class DeviceMemory {
  private readonly got = new Map<string, Reading>();
  private readonly asking = new Set<string>();

  constructor(private readonly d: DeviceMemDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  /** What's known now; devices whose numbers are old are read again in the background (the popover asks every few seconds). */
  list(): DeviceMem[] {
    return sshDevices(this.d.devices(), this.d.harbors()).map(([h, online]) => {
      const name = hostLabel(h);
      if (shellFamily(h.os) !== "posix") return { name, online: online !== false, mem: null, asking: false, note: "No numbers from Windows yet.", ssh: true };
      const got = this.got.get(h.id);
      if (online !== false && (!got || this.now() - got.at >= FRESH_MS)) this.ask(h);
      const turns = this.d.turns(h.id);
      if (online === false && !got?.ram) return { name, online: false, mem: null, asking: false, note: "", ssh: true };
      const ram = got?.ram ?? null;
      // This PC's chats running there, the most first, as far as the last read found them.
      const top = turns.flatMap((t) => (got?.procs.has(t.mark) ? [{ title: t.title, bytes: got.procs.get(t.mark) ?? 0 }] : [])).sort((a, b) => b.bytes - a.bytes);
      const mem = ram ? { ram: { total: ram.total, used: ram.used, swap_total: ram.swapTotal, swap_used: ram.swapUsed }, running: turns.length, top } : null;
      return { name, online: true, mem, asking: !got, note: got && !ram ? "No numbers: it didn't answer over SSH." : "", ssh: true };
    });
  }

  /**
   * A chat running on the device `device` (Runs on): its name, its RAM and, while its turn `mark` runs, what the turn
   * holds there. Read in the background as `list` does, and sooner when the turn is new to the last read.
   */
  chat(device: string, mark: string, running: boolean): memory.DeviceInfo | null {
    const h = this.d.devices().find(([x]) => x.id === device);
    if (!h) return null;
    const [host, online] = h;
    const name = hostLabel(host);
    if (shellFamily(host.os) !== "posix") return { name, ram: null, bytes: null, asking: false };
    const got = this.got.get(device);
    const age = got ? this.now() - got.at : Infinity;
    if (online !== false && (age >= FRESH_MS || (running && !got?.asked.has(mark) && age >= NEW_TURN_MS))) this.ask(host);
    const asked = got?.asked.has(mark) === true;
    const bytes = running && asked && got?.ok ? (got.procs.get(mark) ?? null) : null;
    return { name, ram: got?.ram ?? null, bytes, asking: this.asking.has(device) && (!got || (running && !asked)) };
  }

  private ask(h: RemoteHost): void {
    if (this.asking.has(h.id)) return;
    this.asking.add(h.id);
    const marks = this.d.turns(h.id).map((t) => t.mark);
    void this.d
      .read(h, deviceMemSh(marks))
      .catch(() => null)
      .then((out) => {
        this.got.set(h.id, { at: this.now(), ram: out === null ? null : memory.parseDeviceRam(out), asked: new Set(marks), procs: out === null ? new Map() : memory.parseDeviceProcs(out), ok: out !== null });
        this.asking.delete(h.id);
      });
  }
}

/** Runs ssh with `argv` (options, host, command); its output, or null when it failed or took over `wait` ms. */
export function sshOutput(argv: string[], wait = 12_000): Promise<string | null> {
  return new Promise((resolve) => {
    const c = spawn("ssh", argv, { stdio: ["ignore", "pipe", "ignore"] });
    const out: Buffer[] = [];
    const timer = setTimeout(() => c.kill("SIGKILL"), wait);
    c.stdout.on("data", (b: Buffer) => out.push(b));
    c.once("error", () => (clearTimeout(timer), resolve(null)));
    c.once("close", (code) => (clearTimeout(timer), resolve(code === 0 ? Buffer.concat(out).toString("utf8") : null)));
  });
}
