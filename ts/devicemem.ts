import { spawn } from "node:child_process";
import { memory } from "./packages/agents/src/index.ts";
import { hostLabel, type RemoteHost, shellFamily } from "./packages/net/src/index.ts";

export interface DeviceMemDeps {
  /** The devices of Settings › Devices, with whether each is online (null: never tested). */
  devices(): [RemoteHost, boolean | null][];
  /** This PC's and the mesh's PCs' ids and names: those aren't asked over SSH. */
  harbors(): { ids: string[]; names: string[] };
  /** Prints the device's RAM (memory.DEVICE_RAM_SH over ssh); null when it didn't answer. */
  read(h: RemoteHost): Promise<string | null>;
  /** This PC's chats with a turn running on the device. */
  running(device: string): number;
  now?: () => number;
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

const label = (s: string): string => s.trim().toLowerCase().split(".")[0] ?? "";

/** The devices to list: shown in Runs on, and not a Harbor PC listed already (by id, or by the name it goes by). */
export function sshDevices(devices: readonly [RemoteHost, boolean | null][], harbors: { ids: string[]; names: string[] }): [RemoteHost, boolean | null][] {
  const names = new Set(harbors.names.map(label).filter((n) => n !== ""));
  return devices.filter(([h]) => !h.hidden && !harbors.ids.includes(h.id) && ![h.name, h.host, hostLabel(h)].some((n) => names.has(label(n))));
}

export class DeviceMemory {
  private readonly got = new Map<string, { at: number; ram: memory.Ram | null }>();
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
      const running = this.d.running(h.id);
      if (online === false && !got?.ram) return { name, online: false, mem: null, asking: false, note: "", ssh: true };
      const ram = got?.ram ?? null;
      const mem = ram ? { ram: { total: ram.total, used: ram.used, swap_total: ram.swapTotal, swap_used: ram.swapUsed }, running, top: [] } : null;
      return { name, online: true, mem, asking: !got, note: got && !ram ? "No numbers: it didn't answer over SSH." : "", ssh: true };
    });
  }

  private ask(h: RemoteHost): void {
    if (this.asking.has(h.id)) return;
    this.asking.add(h.id);
    void this.d
      .read(h)
      .catch(() => null)
      .then((out) => {
        this.got.set(h.id, { at: this.now(), ram: out === null ? null : memory.parseDeviceRam(out) });
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
