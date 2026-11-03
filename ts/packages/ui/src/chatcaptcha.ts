import { discord } from "@harbor/mcp";
import type { Chat } from "@harbor/store";
import type { Pixels } from "./logos.ts";
import { type Box, clampTo, type Frame, frame, inBox, rectOnImage, type Solver, solver, solvingLine, toPage } from "./logic/captchacard.ts";
import { type ChatCaptchaData, noPixels } from "./window.ts";

/** How often a captcha card on screen asks for a frame; and while there's none to show (or the call failed). */
export const FRAME_MS = 400;
export const IDLE_MS = 2000;
/** The card's frame is at most this wide (logical px). */
export const FRAME_W = 460;

/** One call for a chat's captcha, here or at the chat's home PC: `{action: "frame" | "input" | "cancel", ...}`. */
export type CaptchaCall = (c: Chat, body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>;

/** This PC's own chat: the Discord host here answers. */
export const hereCaptcha = (chatId: number, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> => discord.chatCaptcha(chatId, body);

export interface ChatCaptchaDeps {
  call: CaptchaCall;
  /** The chat on screen (undefined: none). */
  chat(): Chat | undefined;
  /** The window is shown: frames flow only while someone can see them. */
  looking(): boolean;
  /** A frame (JPEG) as the window draws it; null while images can't be decoded yet. */
  decode(bytes: Uint8Array): Promise<Pixels | null>;
  /** This device for the host: who holds the captcha (`pc:<id>`) and its name. */
  me(): { who: string; label: string };
  show(d: ChatCaptchaData): void;
  /** Which captchas are known to wait no more changed: the cards are built again. */
  changed(): void;
  /** The frame's width to ask for, in image px. */
  max(): number;
}

export const noChatCaptcha: ChatCaptchaData = { id: "", has_frame: false, image: noPixels, width: 0, height: 0, rx: 0, ry: 0, rw: 0, rh: 0, solving: "" };

/**
 * The open chat's Discord captcha card: its frames while it is on screen (one call in flight, about every
 * FRAME_MS), and the person's pointer on it back to the PC running Discord. Only points inside the captcha
 * go; presses keep their order, moves only the newest. Nothing is kept once the card leaves.
 */
export class ChatCaptcha {
  private chatId: number | null = null;
  /** The open chat's live captcha cards, by captcha id; and those on screen now. */
  private live: string[] = [];
  private readonly onScreen = new Set<string>();
  private readonly ended = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private stopped = false;
  private data: ChatCaptchaData = noChatCaptcha;
  /** What the image shown covers of the page, and where the captcha is (page px). */
  private crop: Box | null = null;
  private rect: Box | null = null;
  private solver: Solver | null = null;
  private chain: Promise<void> = Promise.resolve();
  private move: [number, number] | null = null;
  private pressed = false;

  constructor(private readonly d: ChatCaptchaDeps) {}

  /** The host has no such captcha waiting: its card is one muted line. */
  gone(id: string): boolean {
    return this.ended.has(id);
  }

  /** After each build of the cards: the chat shown (null: none) and its captcha cards' ids. */
  cards(chatId: number | null, ids: readonly string[]): void {
    if (chatId !== this.chatId) {
      this.chatId = chatId;
      this.onScreen.clear();
      this.reset();
    }
    this.live = [...ids];
    if (this.data.id !== "" && !ids.includes(this.data.id)) this.reset();
    this.wake();
  }

  /** A card came on screen or left it. */
  seen(id: string, on: boolean): void {
    // Kept even before the cards' ids come (`cards`): only live ones count.
    if (on) this.onScreen.add(id);
    else this.onScreen.delete(id);
    this.wake();
  }

  /** Looks again when it can: a card on screen in the open chat, the window shown. */
  wake(): void {
    if (this.stopped || this.busy || this.timer !== null || !this.watching()) return;
    this.later(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private watching(): boolean {
    return this.live.some((id) => this.onScreen.has(id)) && this.chatId !== null && this.d.chat()?.id === this.chatId && this.d.looking();
  }

  private later(ms: number): void {
    if (this.stopped) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.look();
    }, ms);
  }

  private reset(): void {
    this.crop = null;
    this.rect = null;
    this.solver = null;
    this.pressed = false;
    this.move = null;
    if (this.data !== noChatCaptcha) {
      this.data = noChatCaptcha;
      this.d.show(this.data);
    }
  }

  private mark(ids: readonly string[], on: boolean): void {
    let changed = false;
    for (const id of ids) {
      if (on === this.ended.has(id)) continue;
      if (on) this.ended.add(id);
      else this.ended.delete(id);
      changed = true;
    }
    if (changed) this.d.changed();
  }

  /** One frame: stops (until `wake`) once nobody looks. */
  async look(): Promise<void> {
    const c = this.d.chat();
    if (this.stopped || this.busy || c === undefined || !this.watching()) return;
    this.busy = true;
    let next = FRAME_MS;
    try {
      const r = await this.d.call(c, { action: "frame", max: this.d.max() });
      if (c.id !== this.chatId) return;
      const f = r.status === 200 ? frame(r.body) : null;
      if (r.status === 404) {
        this.mark(this.live, true);
        if (this.data.id !== "") this.reset();
        next = IDLE_MS;
      } else if (f === null) next = IDLE_MS;
      else {
        // The chat's captcha is f's: any other card of it waits no more.
        this.mark(
          this.live.filter((id) => id !== f.captcha),
          true,
        );
        this.mark([f.captcha], false);
        if (this.live.includes(f.captcha)) await this.frame(f);
        else next = IDLE_MS;
      }
    } catch {
      next = IDLE_MS;
    } finally {
      this.busy = false;
    }
    if (this.watching()) this.later(next);
  }

  private async frame(f: Frame): Promise<void> {
    this.solver = f.solver;
    const d: ChatCaptchaData = { ...(this.data.id === f.captcha ? this.data : noChatCaptcha), id: f.captcha, solving: solvingLine(f.solver, this.d.me().who) };
    if (f.data !== null && f.width > 0 && f.height > 0) {
      const image = await this.d.decode(Buffer.from(f.data, "base64"));
      if (image !== null) {
        Object.assign(d, { image, has_frame: true, width: f.width, height: f.height });
        this.crop = f.crop;
      }
    }
    this.rect = f.rect;
    if (this.crop !== null) {
      const r = this.rect === null ? { x: 0, y: 0, width: 0, height: 0 } : rectOnImage(this.rect, this.crop);
      Object.assign(d, { rx: r.x, ry: r.y, rw: r.width, rh: r.height });
    }
    this.data = d;
    this.d.show(d);
  }

  /** The person's pointer on card `id`'s frame, as fractions of the image. */
  pointer(id: string, kind: string, fx: number, fy: number): void {
    const c = this.d.chat();
    if (c === undefined || id !== this.data.id || !this.data.has_frame || this.crop === null || this.rect === null) return;
    const rect = this.rect;
    const [x, y] = toPage(fx, fy, this.crop);
    const inside = inBox(x, y, rect);
    if (kind === "move") {
      if (!inside && !this.pressed) return;
      const queued = this.move !== null;
      this.move = inside ? [x, y] : clampTo(x, y, rect);
      if (queued) return;
      this.chain = this.chain.then(() => {
        const m = this.move;
        this.move = null;
        return m === null ? undefined : this.send(c, "move", m[0], m[1]);
      });
      return;
    }
    if (kind === "down") {
      if (!inside) return;
      this.pressed = true;
    } else if (kind === "up") {
      // A release outside still lets go of what the press inside held.
      if (!this.pressed) return;
      this.pressed = false;
    } else return;
    const [px, py] = clampTo(x, y, rect);
    this.chain = this.chain.then(() => this.send(c, kind, px, py));
  }

  private async send(c: Chat, kind: string, x: number, y: number): Promise<void> {
    const me = this.d.me();
    try {
      const r = await this.d.call(c, { action: "input", kind, x: Math.round(x), y: Math.round(y), who: me.who, label: me.label });
      const b = r.body as { taken?: unknown; solver?: unknown } | null;
      if (r.status !== 200 || typeof b !== "object" || b === null) return;
      const s = solver(b.solver);
      this.solver = s ?? (b.taken === true ? { who: me.who, label: me.label } : this.solver);
      const solving = solvingLine(this.solver, me.who);
      if (solving !== this.data.solving && this.data.id !== "") {
        this.data = { ...this.data, solving };
        this.d.show(this.data);
      }
    } catch {
      // the next frame says who holds it
    }
  }

  /** Don't join: Discord's dialog closes and the agent hears the join wasn't made. */
  cancel(id: string): void {
    const c = this.d.chat();
    if (c === undefined || c.id !== this.chatId || !this.live.includes(id)) return;
    void this.d
      .call(c, { action: "cancel", who: this.d.me().who })
      .catch(() => undefined)
      .finally(() => {
        if (!this.busy) this.later(0);
      });
  }

  /** Waits for the pointer events sent so far (tests). */
  settled(): Promise<void> {
    return this.chain;
  }
}
