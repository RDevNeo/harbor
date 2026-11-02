import * as control from "./control.ts";

/** Where Tailscale Funnel sends /hooks, as `tailscale funnel status` last said (app.rs `check_funnel`). */
export class Funnel {
  base: string | null = null;
  stale: number | null = null;

  constructor(
    private readonly installed: () => boolean,
    private readonly port: () => number,
    private readonly probe: (port: number) => Promise<[string | undefined, number | undefined]> = control.funnel,
  ) {}

  /** Asks Tailscale again; nothing happens while it isn't installed. */
  async check(): Promise<void> {
    if (!this.installed()) return;
    const [base, stale] = await this.probe(this.port());
    this.base = base ?? null;
    this.stale = stale ?? null;
  }

  /** The Disable button: the page stops showing it before Tailscale has answered. */
  forget(): void {
    this.base = null;
  }
}
