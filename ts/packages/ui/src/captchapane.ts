import { discord } from "@harbor/mcp";
import type { Pixels } from "./logos.ts";
import { type CaptchaData, noPixels } from "./window.ts";

/** How often a captcha is looked for while none shows, and its frames while one does. */
export const LOOK_MS = 5000;
export const FRAME_MS = 250;

export interface CaptchaWindow {
  cap_open: boolean;
  cap_shown: boolean;
  cap_data: CaptchaData;
}

export interface CaptchaApi {
  signedIn(): boolean;
  frame(): Promise<discord.CaptchaFrame | undefined>;
  input(kind: "move" | "down" | "up" | "wheel", x: number, y: number, dy?: number): Promise<void>;
  cancel(): Promise<void>;
}

/** The host's status's captcha belongs to a chat: its card there is where it's solved, not this overlay.
 * A status from before captchas had chats (no `chat`) has none. */
export function inChat(status: unknown): boolean {
  const c = typeof status === "object" && status !== null ? (status as { captcha?: unknown }).captcha : undefined;
  return typeof c === "object" && c !== null && typeof (c as { chat?: unknown }).chat === "number";
}

const real: CaptchaApi = {
  // Nothing to look for unless the captcha view is on.
  signedIn: () => discord.captchaViewOn() && discord.signedIn(),
  // Only a captcha with no chat comes up over the window.
  frame: async () => (inChat(await discord.status()) ? undefined : discord.captchaFrame()),
  input: discord.captchaInput,
  cancel: discord.captchaCancel,
};

export const noCaptcha: CaptchaData = { image: noPixels, width: 0, height: 0, rect_x: 0, rect_y: 0, rect_w: 0, rect_h: 0, guild: "" };

/**
 * A Discord join waiting on a captcha: the hidden page's frames over the window, and the person's
 * pointer back to it. Opens by itself when one comes; Hide leaves a pill that brings it back. Only
 * pointer events a person makes go anywhere, and the shell drops those outside the captcha.
 */
export class CaptchaPane {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private move: [number, number] | null = null;
  private stopped = false;

  constructor(
    private readonly w: CaptchaWindow,
    private readonly decode: (jpeg: Uint8Array) => Promise<Pixels>,
    private readonly api: CaptchaApi = real,
  ) {}

  start(): void {
    this.stopped = false;
    this.later(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private later(ms: number): void {
    if (this.stopped) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.look(), ms);
  }

  /** One look: whether a captcha waits, and its newest frame while it's on screen. */
  async look(): Promise<void> {
    this.timer = null;
    try {
      const f = this.api.signedIn() ? await this.api.frame() : undefined;
      if (f === undefined) {
        this.w.cap_open = false;
        this.w.cap_data = noCaptcha;
      } else {
        // A new captcha comes up in front; one put away stays a pill.
        if (!this.w.cap_open) this.w.cap_shown = true;
        this.w.cap_open = true;
        const d: CaptchaData = { ...this.w.cap_data, guild: f.guild ?? "" };
        if (f.data !== undefined && this.w.cap_shown) {
          d.image = await this.decode(Buffer.from(f.data, "base64"));
          d.width = f.width;
          d.height = f.height;
        }
        if (f.rect !== null) Object.assign(d, { rect_x: f.rect.x, rect_y: f.rect.y, rect_w: f.rect.width, rect_h: f.rect.height });
        this.w.cap_data = d;
      }
    } catch {
      // the next look tries again
    }
    this.later(this.w.cap_open && this.w.cap_shown ? FRAME_MS : LOOK_MS);
  }

  show(shown: boolean): void {
    this.w.cap_shown = shown;
    if (shown) this.later(0);
  }

  /** The person's pointer, in the page's pixels. Moves only keep the newest; presses keep their order. */
  pointer(kind: string, x: number, y: number): void {
    if (!this.w.cap_open || !this.w.cap_shown) return;
    if (kind === "move") {
      const queued = this.move !== null;
      this.move = [x, y];
      if (queued) return;
      this.chain = this.chain.then(() => {
        const m = this.move;
        this.move = null;
        return m === null ? undefined : this.api.input("move", m[0], m[1]);
      });
      return;
    }
    if (kind !== "down" && kind !== "up") return;
    this.chain = this.chain.then(() => this.api.input(kind, x, y));
  }

  wheel(x: number, y: number, dy: number): void {
    if (!this.w.cap_open || !this.w.cap_shown) return;
    this.chain = this.chain.then(() => this.api.input("wheel", x, y, dy));
  }

  /** Don't join: Discord's dialog closes and the host reports the join as not made. */
  cancel(): void {
    this.w.cap_shown = false;
    void this.api.cancel().finally(() => this.later(0));
  }

  /** Waits for the pointer events sent so far (tests). */
  settled(): Promise<void> {
    return this.chain;
  }
}
