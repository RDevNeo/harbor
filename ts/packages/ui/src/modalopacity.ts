/** Hyprland's window alpha also affects opaque modal surfaces. The override belongs to
 * this window only: closing it (including a crash/restart) discards it in the compositor. */
type Run = (args: string[]) => Promise<string>;

async function hyprctl(args: string[]): Promise<string> {
  const p = Bun.spawn(["hyprctl", ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 1000 });
  const text = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error("hyprctl failed");
  return text.trim();
}

export class ModalOpacity {
  private pending: Promise<void> = Promise.resolve();
  private desired = false;
  private saved: { address: string; opaque: string } | null = null;

  constructor(
    private readonly run: Run = hyprctl,
    private readonly pid = process.pid,
    private readonly enabled = process.platform === "linux" && !!process.env.HYPRLAND_INSTANCE_SIGNATURE,
  ) {}

  update(open: boolean): Promise<void> {
    this.desired = open;
    if (!this.enabled) return Promise.resolve();
    this.pending = this.pending.then(() => this.sync()).catch(() => {});
    return this.pending;
  }

  private async set(address: string, value: string): Promise<void> {
    // Both values come from validated compositor output, never from user text.
    const result = await this.run(["dispatch", `hl.dsp.window.set_prop({window="address:${address}",prop="opaque",value="${value}"})`]);
    if (result !== "ok") throw new Error("opacity override unavailable");
  }

  private async sync(): Promise<void> {
    if (this.desired && !this.saved) {
      const clients = JSON.parse(await this.run(["clients", "-j"])) as { pid: number; address: string; class: string }[];
      const own = clients.find((c) => c.pid === this.pid && c.class === "harbor" && /^0x[\da-f]+$/i.test(c.address));
      if (!own) return;
      const opaque = await this.run(["getprop", `address:${own.address}`, "opaque"]);
      if (!this.desired || (opaque !== "true" && opaque !== "false")) return;
      await this.set(own.address, "true");
      this.saved = { address: own.address, opaque };
    }
    if (!this.desired && this.saved) {
      await this.set(this.saved.address, this.saved.opaque);
      this.saved = null;
    }
  }
}
