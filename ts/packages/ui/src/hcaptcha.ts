// Discord's captcha (hCaptcha), solved by the person inside Hub's window. hCaptcha only takes Discord's sitekey on
// Discord's host and needs a real browser, which Slint isn't: a hidden (headless) Chromium build the PC already has
// (Chrome, Edge, Helium, Chromium, Brave) loads the page as https://discord.com/hub-captcha (DevTools' Fetch serves it;
// nothing goes to Discord's site), and the captcha overlay (captchapane.ts, captcha.slint) shows its frames and sends
// the person's pointer back, as it did for the old Discord page. The token goes back through `solved`; Hub never
// answers a captcha itself.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { browsers, paths } from "@harbor/os";
import type { CaptchaApi, CaptchaFrame } from "./captchapane.ts";

/** The page's size in CSS px: room for hCaptcha's challenge (about 400 × 600) under its checkbox. */
export const PAGE_W = 520;
export const PAGE_H = 760;
/** The page must be up (hCaptcha's widget drawn) by then, or the captcha can't be shown here. */
const LOAD_MS = 25_000;

/** A captcha to show: the page's HTML and address, and the overlay's words. */
export interface CaptchaJob {
  html: string;
  url: string;
  /** The overlay's line under its title ("To add Ana as a friend, Discord wants…"). */
  intro: string;
  /** Its give-up button ("Don't add"). */
  cancel: string;
  /** The pill's words while hidden. */
  pill: string;
}

export type CaptchaEnd = { token: string } | { cancelled: true } | { error: string };

/** A Chromium build to run hidden: Chrome, Edge, then the others (null: none on this PC). */
export function chromiumExe(): string | null {
  for (const p of [...browsers.chromePaths(), ...browsers.edgePaths()]) if (existsSync(p)) return p;
  return browsers.chromiumBuild()?.executable ?? null;
}

type Msg = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } };

/** A DevTools Protocol connection to one page. */
class Cdp {
  private n = 0;
  private readonly waiting = new Map<number, { ok: (r: Record<string, unknown>) => void; no: (e: Error) => void }>();
  private readonly handlers = new Map<string, (p: Record<string, unknown>) => void>();
  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (e) => {
      let m: Msg;
      try {
        m = JSON.parse(String(e.data)) as Msg;
      } catch {
        return;
      }
      if (m.id !== undefined) {
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (m.error) w?.no(new Error(m.error.message ?? "DevTools error"));
        else w?.ok(m.result ?? {});
      } else if (m.method) this.handlers.get(m.method)?.(m.params ?? {});
    };
    ws.onclose = () => {
      for (const w of this.waiting.values()) w.no(new Error("closed"));
      this.waiting.clear();
    };
  }

  static open(url: string): Promise<Cdp> {
    return new Promise((ok, no) => {
      const ws = new WebSocket(url);
      ws.onopen = () => ok(new Cdp(ws));
      ws.onerror = () => no(new Error("DevTools didn't answer"));
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.n;
    return new Promise((ok, no) => {
      this.waiting.set(id, { ok, no });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.waiting.delete(id);
        no(e as Error);
      }
    });
  }

  on(method: string, f: (p: Record<string, unknown>) => void): void {
    this.handlers.set(method, f);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // gone
    }
  }
}

/** What runs one captcha page: the hidden browser and its page (tests hand in a fake). */
export interface CaptchaPage {
  shot(): Promise<string>;
  mouse(type: "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel", x: number, y: number, dy?: number): Promise<void>;
  close(): void;
}

export type OpenPage = (job: CaptchaJob, ev: { solved(t: string): void; error(e: string): void; ready(): void }) => Promise<CaptchaPage>;

/** The hidden browser's profile: one folder, not in /tmp (a profile is ~100 MB), emptied before each captcha and
 * removed after it, so at most one is ever on disk even after a crash. */
export function profileDir(env: Record<string, string | undefined> = process.env): string {
  return join(paths.cacheHome(env), "hub", "captcha-browser");
}

/** The hidden Chromium with the captcha page on https://discord.com/hub-captcha (`dir`: its profile). */
export const chromiumPageAt =
  (dir: string): OpenPage =>
  async (job, ev) => {
  const exe = chromiumExe();
  if (exe === null) throw new Error("no Chrome or Chromium on this PC");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const proc = Bun.spawn(
    [exe, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--mute-audio", "--hide-scrollbars", `--window-size=${PAGE_W},${PAGE_H}`, "about:blank"],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  let cdp: Cdp | null = null;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    cdp?.close();
    try {
      proc.kill();
    } catch {
      // gone
    }
    // Its profile goes once it quit (a stuck one is killed after 3 s).
    const hard = setTimeout(() => {
      try {
        proc.kill(9);
      } catch {
        // gone
      }
    }, 3000);
    void proc.exited.finally(() => {
      clearTimeout(hard);
      rmSync(dir, { recursive: true, force: true });
    });
  };
  try {
    // Chromium writes its DevTools port in the profile once it listens.
    let port = 0;
    for (let i = 0; i < 100 && port === 0; i++) {
      await Bun.sleep(100);
      if (proc.exitCode !== null) throw new Error("the browser quit at start");
      try {
        port = Number(readFileSync(join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]) || 0;
      } catch {
        // not yet
      }
    }
    if (port === 0) throw new Error("the browser didn't start");
    const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type?: string; webSocketDebuggerUrl?: string }[];
    const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!page?.webSocketDebuggerUrl) throw new Error("no page in the browser");
    const c = await Cdp.open(page.webSocketDebuggerUrl);
    cdp = c;
    const body = Buffer.from(job.html).toString("base64");
    c.on("Fetch.requestPaused", (p) => {
      const url = String(p.request && (p.request as { url?: unknown }).url);
      // Only the page itself is served from here; hCaptcha's own files load from hCaptcha.
      if (url.split("?")[0] === job.url) void c.send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }], body }).catch(() => {});
      else void c.send("Fetch.continueRequest", { requestId: p.requestId }).catch(() => {});
    });
    c.on("Runtime.bindingCalled", (p) => {
      if (p.name === "hubCaptchaSolved") ev.solved(String(p.payload ?? ""));
      else if (p.name === "hubCaptchaError") ev.error(String(p.payload ?? "error"));
      else if (p.name === "hubCaptchaReady") ev.ready();
    });
    const ua = String((await c.send("Browser.getVersion")).userAgent ?? "").replace("HeadlessChrome", "Chrome");
    if (ua) await c.send("Emulation.setUserAgentOverride", { userAgent: ua, acceptLanguage: "en-US,en" });
    await c.send("Emulation.setDeviceMetricsOverride", { width: PAGE_W, height: PAGE_H, deviceScaleFactor: 2, mobile: false });
    await c.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    await c.send("Runtime.enable");
    await c.send("Runtime.addBinding", { name: "hubCaptchaSolved" });
    await c.send("Runtime.addBinding", { name: "hubCaptchaError" });
    await c.send("Runtime.addBinding", { name: "hubCaptchaReady" });
    await c.send("Fetch.enable", { patterns: [{ urlPattern: `${job.url}*`, requestStage: "Request" }] });
    await c.send("Page.navigate", { url: job.url });
    return {
      async shot() {
        const r = await c.send("Page.captureScreenshot", { format: "jpeg", quality: 85 });
        return String(r.data ?? "");
      },
      async mouse(type, x, y, dy) {
        const p: Record<string, unknown> = { type, x, y };
        if (type === "mousePressed" || type === "mouseReleased") Object.assign(p, { button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
        if (type === "mouseWheel") Object.assign(p, { deltaX: 0, deltaY: dy ?? 0 });
        await c.send("Input.dispatchMouseEvent", p);
      },
      close,
    };
  } catch (e) {
    close();
    throw e;
  }
};

export const chromiumPage: OpenPage = (job, ev) => chromiumPageAt(profileDir())(job, ev);

/**
 * The captcha overlay's source while a Discord captcha waits: one page at a time. `show` opens it and resolves with
 * the person's token, a give-up, or why it couldn't be shown (no browser, hCaptcha didn't load): then the caller says
 * so in words instead.
 */
export class DiscordCaptchaSource implements CaptchaApi {
  private page: CaptchaPage | null = null;
  private job: CaptchaJob | null = null;
  private loaded = false;
  private done: ((e: CaptchaEnd) => void) | null = null;
  /** The overlay should look now (a captcha came, or went). */
  wake: () => void = () => {};

  constructor(private readonly open: OpenPage = chromiumPage) {}

  /** The overlay's words for the captcha on screen. */
  words(): CaptchaJob | null {
    return this.job;
  }

  show(job: CaptchaJob): Promise<CaptchaEnd> {
    this.finish({ cancelled: true });
    this.job = job;
    this.loaded = false;
    const end = new Promise<CaptchaEnd>((ok) => (this.done = ok));
    const timer = setTimeout(() => {
      if (!this.loaded && this.job === job) this.finish({ error: "the captcha didn't load" });
    }, LOAD_MS);
    void end.finally(() => clearTimeout(timer));
    this.open(job, {
      solved: (t) => {
        if (this.job === job && t) this.finish({ token: t });
      },
      error: (e) => {
        // hCaptcha's own errors after it showed (a network blip, "challenge-closed") leave it up to try again.
        if (this.job === job && !this.loaded) this.finish({ error: e });
      },
      ready: () => {
        if (this.job === job) this.loaded = true;
      },
    }).then(
      (p) => {
        if (this.job === job) this.page = p;
        else p.close();
      },
      (e: unknown) => {
        if (this.job === job) this.finish({ error: e instanceof Error ? e.message : String(e) });
      },
    );
    this.wake();
    return end;
  }

  private finish(e: CaptchaEnd): void {
    const d = this.done;
    this.done = null;
    this.page?.close();
    this.page = null;
    this.job = null;
    this.loaded = false;
    d?.(e);
    if (d) this.wake();
  }

  signedIn(): boolean {
    return this.job !== null;
  }

  async frame(): Promise<CaptchaFrame | undefined> {
    if (this.job === null) return undefined;
    const job = this.job;
    const rect = { x: 0, y: 0, width: PAGE_W, height: PAGE_H };
    const words = { guild: job.pill, intro: job.intro, cancel: job.cancel };
    if (this.page === null || !this.loaded) return { ...words, width: 0, height: 0, rect: null };
    const data = await this.page.shot().catch(() => "");
    if (this.job !== job) return undefined;
    return data ? { ...words, data, width: PAGE_W, height: PAGE_H, rect } : { ...words, width: 0, height: 0, rect: null };
  }

  async input(kind: "move" | "down" | "up" | "wheel", x: number, y: number, dy?: number): Promise<void> {
    const p = this.page;
    if (p === null || x < 0 || y < 0 || x > PAGE_W || y > PAGE_H) return;
    const type = kind === "move" ? "mouseMoved" : kind === "down" ? "mousePressed" : kind === "up" ? "mouseReleased" : "mouseWheel";
    await p.mouse(type, x, y, dy).catch(() => {});
  }

  async cancel(): Promise<void> {
    this.finish({ cancelled: true });
  }

  stop(): void {
    this.finish({ cancelled: true });
  }
}
