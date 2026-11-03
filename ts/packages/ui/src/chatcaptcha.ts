import { discord } from "@harbor/mcp";
import type { Chat } from "@harbor/store";
import type { Pixels } from "./logos.ts";
import { type Box, clampTo, type Frame, frame, inBox, rectOnImage, type Solver, solver, solvingLine, toPage } from "./logic/captchacard.ts";
import type { ChatCaptchaData } from "./window.ts";

/** Frames come by long-poll (`after`: the last seq; the host answers on the next repaint or after WAIT_MS):
 * a request starts at least GAP_MS after the one before (about 20 a second at most), and after a failure
 * or a 404 only IDLE_MS later. */
export const GAP_MS = 50;
export const WAIT_MS = 2000;
export const IDLE_MS = 2000;
/** The card's frame is at most this wide (logical px); its width until the card says. */
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
  /** A frame (JPEG) as the window draws it, decoded off the main loop; null while images can't be decoded yet. */
  decode(bytes: Uint8Array): Promise<Pixels | null>;
  /** This device for the host: who holds the captcha (`pc:<id>`) and its name. */
  me(): { who: string; label: string };
  /** The card's fields; called only when one changed. */
  show(d: ChatCaptchaData): void;
  /** A new frame: only the image changes. */
  image(p: Pixels): void;
  /** Which captchas are known to wait no more changed: the cards are built again. */
  changed(): void;
  /** Physical pixels per logical pixel: the frame asked for is the card's real pixel width. */
  scale(): number;
  /** Tests: the clock and the pauses. */
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export const noChatCaptcha: ChatCaptchaData = { id: "", has_frame: false, width: 0, height: 0, rx: 0, ry: 0, rw: 0, rh: 0, solving: "" };

const sameData = (a: ChatCaptchaData, b: ChatCaptchaData): boolean => (Object.keys(a) as (keyof ChatCaptchaData)[]).every((k) => a[k] === b[k]);

/**
 * The open chat's Discord captcha card: its frames while it is on screen, by long-poll (one request in
 * flight, the next as soon as one answers), and the person's pointer on it back to the PC running Discord,
 * on its own path: frames never wait for input, nor input for frames. Only points inside the captcha go;
 * presses keep their order, moves only the newest. Nothing is kept once the card leaves.
 */
export class ChatCaptcha {
  private chatId: number | null = null;
  /** The open chat's live captcha cards, by captcha id; and those on screen now. */
  private live: string[] = [];
  private readonly onScreen = new Set<string>();
  private readonly ended = new Set<string>();
  /** The frame loop runs (a request in flight, or a pause before the next); which one, and the epoch it serves. */
  private running = false;
  private loopId = 0;
  private loopEpoch = -1;
  private stopped = false;
  /** Bumped when what's shown starts over: an answer or a decode from before is dropped. */
  private epoch = 0;
  /** The repaint of the newest image this card has or decodes (0: none: the next answer has data). A `same`
   * answer doesn't move it; a decode that fails puts it back to 0. */
  private seq = 0;
  private lastStart = -Infinity;
  /** The card's frame width, logical px. */
  private width = FRAME_W;
  private data: ChatCaptchaData = noChatCaptcha;
  /** The newest frame waiting for its decode, while one decodes. */
  private next: Frame | null = null;
  private decoding = false;
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

  /** A card came on screen or left it; `width`: its frame's width (logical px). */
  seen(id: string, on: boolean, width = this.width): void {
    // Kept even before the cards' ids come (`cards`): only live ones count.
    if (on) this.onScreen.add(id);
    else this.onScreen.delete(id);
    if (width > 0) this.width = width;
    this.wake();
  }

  /** Starts the frame loop when it can: a card on screen in the open chat, the window shown. */
  wake(): void {
    // A loop still waiting on an answer for what was shown before (another chat) is left to drop it.
    if (this.stopped || (this.running && this.loopEpoch === this.epoch) || !this.watching()) return;
    const id = ++this.loopId;
    this.running = true;
    this.loopEpoch = this.epoch;
    void this.loop(id).finally(() => {
      if (this.loopId === id) this.running = false;
    });
  }

  stop(): void {
    this.stopped = true;
    this.epoch++;
  }

  /** The loop runs (tests). */
  get looping(): boolean {
    return this.running;
  }

  private watching(): boolean {
    return !this.stopped && this.live.some((id) => this.onScreen.has(id)) && this.chatId !== null && this.d.chat()?.id === this.chatId && this.d.looking();
  }

  private now(): number {
    return this.d.now?.() ?? performance.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.d.sleep?.(ms) ?? Bun.sleep(ms);
  }

  /** The image's width to ask for: the card's real pixels. */
  max(): number {
    return Math.max(1, Math.round(this.width * this.d.scale()));
  }

  private reset(): void {
    this.epoch++;
    this.seq = 0;
    this.next = null;
    this.crop = null;
    this.rect = null;
    this.solver = null;
    this.pressed = false;
    this.move = null;
    this.set(noChatCaptcha);
  }

  private set(d: ChatCaptchaData): void {
    if (sameData(d, this.data)) return;
    this.data = d;
    this.d.show(d);
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

  /** Long-polls frames until nobody looks; a request that comes back after that is dropped. */
  private async loop(id: number): Promise<void> {
    while (id === this.loopId && this.watching()) {
      const wait = this.lastStart + GAP_MS - this.now();
      if (wait > 0) {
        await this.sleep(wait);
        continue;
      }
      const c = this.d.chat();
      if (c === undefined) return;
      const epoch = this.epoch;
      this.lastStart = this.now();
      let r: { status: number; body: unknown } | null = null;
      try {
        r = await this.d.call(c, { action: "frame", max: this.max(), after: this.seq, wait: WAIT_MS });
      } catch {
        // backs off below
      }
      if (id !== this.loopId) return;
      if (epoch !== this.epoch || c.id !== this.chatId) {
        this.loopEpoch = this.epoch;
        continue;
      }
      if (!this.watching()) return;
      const fine = this.answer(r);
      this.loopEpoch = this.epoch;
      if (!fine) await this.sleep(IDLE_MS);
    }
  }

  /** One answer; false: wait IDLE_MS before the next. */
  private answer(r: { status: number; body: unknown } | null): boolean {
    if (r === null) return false;
    if (r.status === 404) {
      this.mark(this.live, true);
      if (this.data.id !== "") this.reset();
      return false;
    }
    const b = r.body as { same?: unknown; captcha?: unknown } | null;
    const f = r.status === 200 ? frame(b !== null && typeof b === "object" && b.same === true && b.captcha === undefined ? { ...b, captcha: this.data.id } : b) : null;
    if (f === null) return false;
    // The chat's captcha is f's: any other card of it waits no more.
    this.mark(
      this.live.filter((id) => id !== f.captcha),
      true,
    );
    this.mark([f.captcha], false);
    if (!this.live.includes(f.captcha)) return false;
    if (f.captcha !== this.data.id) {
      this.reset();
      this.set({ ...noChatCaptcha, id: f.captcha });
    }
    this.meta(f);
    if (!f.same && f.data !== null && f.width > 0 && f.height > 0) {
      this.seq = f.seq;
      // Decoded off the loop: a newer frame while one decodes takes the older one's place.
      this.next = f;
      if (!this.decoding) void this.drain();
    }
    return true;
  }

  /** Who holds it and where the captcha is: they come with every answer, the image only with some. */
  private meta(f: Frame): void {
    this.solver = f.solver;
    if (f.rect !== null) this.rect = f.rect;
    const d = { ...this.data, solving: solvingLine(this.solver, this.d.me().who) };
    if (this.crop !== null && this.rect !== null) {
      const r = rectOnImage(this.rect, this.crop);
      Object.assign(d, { rx: r.x, ry: r.y, rw: r.width, rh: r.height });
    }
    this.set(d);
  }

  private async drain(): Promise<void> {
    this.decoding = true;
    try {
      while (this.next !== null) {
        const f = this.next;
        this.next = null;
        const epoch = this.epoch;
        let image: Pixels | null = null;
        try {
          image = await this.d.decode(Buffer.from(f.data ?? "", "base64"));
        } catch {
          // the next frame tries again
        }
        if (epoch !== this.epoch || f.captcha !== this.data.id) continue;
        if (image === null) {
          // Not drawn (images not loaded yet, a bad frame): the next answer brings one again.
          if (this.next === null) this.seq = 0;
          continue;
        }
        this.crop = f.crop;
        this.d.image(image);
        // The slot keeps the first frame's aspect: later frames only swap the image.
        const first = !this.data.has_frame;
        this.set({ ...this.data, has_frame: true, width: first ? f.width : this.data.width, height: first ? f.height : this.data.height });
        this.meta(f);
      }
    } finally {
      this.decoding = false;
    }
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
      .finally(() => this.wake());
  }

  /** Waits for the pointer events sent so far (tests). */
  settled(): Promise<void> {
    return this.chain;
  }
}
