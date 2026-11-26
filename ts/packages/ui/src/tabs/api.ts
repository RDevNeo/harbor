// Hub's top-level tabs, window side. Each tab besides Projects has a TabUi: mounted the first time it's opened, it
// drives its Slint global (`busOf(ctx.win, "<Name>Bus")`, slint/<id>.slint) and reads and changes its data through
// `ctx.call` — the same `v1/<id>/…` routes Hub for Android calls over the phone API (ts/tabs/<id>/engine.ts).
export interface TabReply {
  status: number;
  body: unknown;
}

export interface TabCtx {
  /** The window: `busOf(ctx.win, "RoutineBus")`. */
  win: object;
  /** A hub route, in-process (`v1/routine/…`): {status, body}. Throws only when there's no hub. */
  call(method: string, path: string, query?: Record<string, string>, body?: unknown): Promise<TabReply>;
  dark(): boolean;
  toast(text: string): void;
  openExternal(url: string): void;
  /** Shows a picture on this PC in Hub's lightbox (Esc closes it), browsing `group` (the pictures it came with). */
  openImage?(path: string, group?: string[]): void;
  /** Whether the tab is the one on screen. */
  shown(): boolean;
  /** Called every 3 s while a tab besides Projects is on screen (a phone may have changed something): re-read. */
  onChanged(f: () => void): void;
  /** Shows a Hub chat in Projects (a Person AI's, a SpokPay agent's). */
  openChat?(id: string): void;
}

export interface TabUi {
  id: "persons" | "routine";
  mount(ctx: TabCtx): void | Promise<void>;
  /** The tab came on screen (true) or left it. */
  shown?(on: boolean): void;
}
