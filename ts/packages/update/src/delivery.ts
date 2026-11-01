import { join } from "node:path";
import type { UpdateConfig } from "./config.ts";
import { apk, browserUnsupported, engineStale, NO_BROWSER, pendingExtras, retryAfter, type ExtraWork } from "./extras.ts";
import { exists, read, readJson, remove } from "./files.ts";
import { current, hasPrevious, install, onDisk, rollback, rolledBack, skipped, type RolledBack } from "./install.ts";
import { parseManifest, type Manifest } from "./manifest.ts";
import { previewInfo } from "./preview.ts";
import { newer, tagged } from "./version.ts";

const POLL_TIMEOUT_MS = 75_000;
const FALLBACK_MS = 5 * 60 * 1000;
const BACKOFF_FIRST_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const START_DELAY_MS = 2_000;
const EXTRAS_DELAY_MS = 35_000;
const ANSWER_NOT_NEWER_MS = 5_000;

export type State =
  | { t: "idle" }
  | { t: "checking" }
  | { t: "upToDate" }
  | { t: "available"; v: string }
  | { t: "installing"; v: string }
  | { t: "installed"; v: string }
  | { t: "failed"; error: string };

export interface Deps {
  swap?: (version: string) => void | Promise<void>;
  changed?: () => void;
}

export interface UpdateInfo {
  version: string;
  runtime: string;
  managed: boolean;
  latest: string | null;
  ready: boolean;
  installing: boolean;
  checking: boolean;
  error: string | null;
  status: string;
  auto: true;
  skipped: string | null;
  rolled_back: RolledBack | null;
  preview_on: boolean;
  preview_kind: "bundle";
  preview: { id: string; note: string; from: string; at: number } | null;
}

export function backoffMs(n: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_FIRST_MS * 2 ** Math.min(Math.max(n - 1, 0), 10), BACKOFF_MAX_MS);
  return Math.round(base * (0.8 + 0.4 * random()));
}

export function news(update: unknown, current: string, heard: string | null): string | null {
  if (typeof update !== "object" || update === null) return null;
  const u = update as Record<string, unknown>;
  let best = heard ?? current;
  let found: string | null = null;
  for (const v of [u.version, u.latest]) {
    if (typeof v === "string" && newer(v, best) && newer(v, current)) {
      best = v;
      found = v;
    }
  }
  return found;
}

export function installDue(failed: { version: string; at: number } | null, version: string, now: number): boolean {
  return failed === null || failed.version !== version || now >= failed.at;
}

export class Updater {
  private st: State = { t: "idle" };
  private job: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private handled: string | null = null;
  private heard: string | null = null;
  private failed: { version: string; at: number; n: number } | null = null;
  private extraRetry = new Map<string, { n: number; at: number }>();
  private extraRunning = new Set<string>();
  private browserOutcome: { ok: true } | { ok: false; error: string } | null = null;
  private asking = false;

  constructor(
    private readonly cfg: UpdateConfig,
    private readonly deps: Deps = {},
  ) {}

  state(): State {
    return this.st;
  }

  managed(): boolean {
    return this.cfg.dir !== null;
  }

  current(): string {
    return current(this.cfg);
  }

  busy(): boolean {
    return this.job !== null;
  }

  private set(s: State): void {
    this.st = s;
    this.deps.changed?.();
  }

  start(): void {
    if (!this.managed() || this.abort !== null) return;
    const abort = new AbortController();
    this.abort = abort;
    void this.run(abort.signal);
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
  }

  private async run(signal: AbortSignal): Promise<void> {
    await this.cfg.sleep(START_DELAY_MS, signal);
    if (signal.aborted) return;
    await this.githubCheck().catch(() => undefined);
    const extras = this.cfg.sleep(EXTRAS_DELAY_MS, signal).then(() => (signal.aborted ? undefined : this.autoExtras()));
    const poll = this.cfg.worker === null ? Promise.resolve() : this.pollLoop(signal);
    await Promise.all([poll, extras]);
  }

  private have(): string {
    const cur = this.current();
    return this.handled !== null && newer(this.handled, cur) ? this.handled : cur;
  }

  private async waitOnce(signal: AbortSignal): Promise<string | null> {
    const url = `${this.cfg.worker}/v1/release/wait?have=${encodeURIComponent(this.have())}`;
    const res = await this.cfg.fetch(url, { headers: { "user-agent": `harbor/${this.cfg.version}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(POLL_TIMEOUT_MS)]) });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`release wait: HTTP ${res.status}`);
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version.replace(/^v/, "") : null;
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let failures = 0;
    let lastFallback = 0;
    while (!signal.aborted) {
      try {
        const v = await this.waitOnce(signal);
        failures = 0;
        if (v === null) continue;
        if (!newer(v, this.have())) {
          await this.cfg.sleep(ANSWER_NOT_NEWER_MS, signal);
          continue;
        }
        await this.onRelease(v);
      } catch (e) {
        if (signal.aborted) return;
        if (e instanceof DOMException && e.name === "TimeoutError") continue;
        failures++;
        if (this.cfg.now() - lastFallback >= FALLBACK_MS) {
          lastFallback = this.cfg.now();
          await this.githubCheck().catch(() => undefined);
        }
        await this.cfg.sleep(backoffMs(failures, this.cfg.random), signal);
      }
    }
  }

  async latest(): Promise<string> {
    const res = await this.cfg.fetch(`${this.cfg.github}/${this.cfg.repo}/releases/latest`, {
      method: "HEAD",
      redirect: "manual",
      headers: { "user-agent": `harbor/${this.cfg.version}` },
      signal: AbortSignal.timeout(30_000),
    });
    return tagged(res.headers.get("location") ?? "");
  }

  async githubCheck(): Promise<void> {
    if (!this.managed()) return;
    const before = this.st;
    if (before.t !== "available" && before.t !== "failed") this.set({ t: "checking" });
    try {
      await this.onRelease(await this.latest());
    } catch (e) {
      this.set(before.t === "idle" || before.t === "checking" ? { t: "failed", error: e instanceof Error ? e.message : String(e) } : before);
      throw e;
    }
  }

  async check(): Promise<void> {
    await this.githubCheck().catch(() => undefined);
  }

  async onRelease(version: string): Promise<void> {
    if (this.handled === null || newer(version, this.handled)) this.handled = version;
    if (!newer(version, this.current())) {
      if (this.st.t !== "installing" && this.st.t !== "installed") this.set({ t: "upToDate" });
      return;
    }
    if (skipped(this.cfg, version)) {
      this.set({ t: "available", v: version });
      return;
    }
    if (onDisk(this.cfg) === version) {
      this.set({ t: "installed", v: version });
      await this.swap(version);
      return;
    }
    if (!installDue(this.failed, version, this.cfg.now())) return;
    await this.runInstall(version);
  }

  async installNow(version?: string): Promise<void> {
    const v = version ?? (this.st.t === "available" ? this.st.v : null);
    if (v === null || !newer(v, this.current())) return;
    this.asking = true;
    try {
      await this.runInstall(v);
    } finally {
      this.asking = false;
    }
  }

  async checkAndInstall(): Promise<void> {
    if (!this.managed()) throw new Error("this Harbor was built from source, so it doesn't update itself");
    this.asking = true;
    this.set({ t: "checking" });
    try {
      const v = await this.latest();
      if (newer(v, this.current())) await this.runInstall(v);
      else this.set({ t: "upToDate" });
    } catch (e) {
      this.set({ t: "failed", error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.asking = false;
    }
  }

  private runInstall(version: string): Promise<void> {
    if (this.job !== null) return this.job;
    const job = (async () => {
      this.set({ t: "installing", v: version });
      try {
        await install(this.cfg, version);
      } catch (e) {
        const n = (this.failed?.version === version ? this.failed.n : 0) + 1;
        this.failed = { version, at: this.cfg.now() + retryAfter(n), n };
        const error = e instanceof Error ? e.message : String(e);
        this.cfg.log(`update to ${version} failed: ${error}`);
        this.set({ t: "failed", error });
        this.retryLater(version, retryAfter(n));
        return;
      }
      this.failed = null;
      this.set({ t: "installed", v: version });
      await this.swap(version);
    })().finally(() => {
      this.job = null;
    });
    this.job = job;
    return job;
  }

  private retryLater(version: string, ms: number): void {
    const signal = this.abort?.signal;
    if (signal === undefined) return;
    void this.cfg.sleep(ms, signal).then(() => (signal.aborted ? undefined : this.onRelease(version).catch(() => undefined)));
  }

  private async swap(version: string): Promise<void> {
    try {
      await this.deps.swap?.(version);
    } catch (e) {
      this.cfg.log(`restart into ${version} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // A peer's word is only a reason to ask GitHub: what installs comes from there, signed.
  peerNews(update: unknown): void {
    const v = news(update, this.current(), this.heard);
    if (v === null || !this.managed()) return;
    this.heard = v;
    void this.githubCheck().catch(() => undefined);
  }

  async restorePrevious(): Promise<string> {
    const r = rollback(this.cfg);
    this.set({ t: "installed", v: r.restored });
    await this.swap(r.restored);
    return r.restored;
  }

  info(): UpdateInfo {
    const managed = this.managed();
    const cur = this.current();
    const s = this.st;
    const disk = onDisk(this.cfg);
    const ready = disk !== null && newer(disk, cur) ? disk : null;
    const known = s.t === "available" || s.t === "installing" || s.t === "installed" ? s.v : null;
    const latest = [ready, known].find((v): v is string => v !== null && newer(v, cur)) ?? null;
    let status = "";
    if (!managed) status = "built from source, doesn't update itself";
    else if (s.t === "installing") status = `updating to ${s.v}…`;
    else if (ready !== null) status = `${ready} installed, restarts into it`;
    else if (s.t === "checking") status = "checking for updates…";
    else if (s.t === "available") status = `${s.v} available`;
    else if (s.t === "upToDate") status = "up to date";
    else if (s.t === "failed") status = `update failed: ${s.error}`;
    return {
      version: cur,
      runtime: this.cfg.runtime,
      managed,
      latest,
      ready: ready !== null,
      installing: s.t === "installing",
      checking: s.t === "checking",
      error: s.t === "failed" ? s.error : null,
      status,
      auto: true,
      skipped: this.cfg.dir === null ? null : readSkip(this.cfg.dir),
      rolled_back: rolledBack(this.cfg),
      ...previewInfo(this.cfg),
    };
  }

  hasPrevious(): boolean {
    return hasPrevious(this.cfg);
  }

  browserInstalling(): boolean {
    return this.extraRunning.has("browser");
  }

  browserResult(): { ok: true } | { ok: false; error: string } | null {
    return this.browserOutcome;
  }

  asked(): boolean {
    return this.asking;
  }

  async installBrowser(): Promise<void> {
    if (this.cfg.dir !== null) remove(join(this.cfg.dir, NO_BROWSER));
    this.browserOutcome = null;
    this.extraRetry.delete("browser");
    await this.autoExtras("browser", true);
  }

  async autoExtras(only?: ExtraWork["name"], asked = false): Promise<void> {
    const dir = this.cfg.dir;
    if (dir === null || this.job !== null) return;
    const m = readJson<unknown>(join(dir, "manifest.json"));
    if (m === null) return;
    let manifest: Manifest;
    try {
      manifest = parseManifest(JSON.stringify(m));
    } catch {
      return;
    }
    for (const w of pendingExtras(this.cfg, dir, manifest)) {
      if ((only !== undefined && w.name !== only) || this.extraRunning.has(w.name)) continue;
      const r = this.extraRetry.get(w.name);
      const due = r === undefined || (asked ? r.n === 0 : this.cfg.now() >= r.at);
      if (!due) continue;
      this.extraRunning.add(w.name);
      try {
        await w.run();
        this.extraRetry.delete(w.name);
        if (w.name === "browser") this.browserOutcome = { ok: true };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        const n = (r?.n ?? 0) + 1;
        this.extraRetry.set(w.name, { n, at: this.cfg.now() + retryAfter(n) });
        this.cfg.log(`${w.name} download failed: ${error}`);
        if (w.name === "browser") this.browserOutcome = { ok: false, error };
      } finally {
        this.extraRunning.delete(w.name);
        this.deps.changed?.();
      }
    }
  }

  browserNeeded(): "ok" | "off" | "unsupported" | "missing" {
    const dir = this.cfg.dir;
    if (dir === null) return "unsupported";
    if (exists(join(dir, NO_BROWSER))) return "off";
    if (browserUnsupported(this.cfg) !== null) return "unsupported";
    return engineStale(this.cfg, dir, "") ? "missing" : "ok";
  }

  apk(): { path: string; code: number } | null {
    return this.cfg.dir === null ? null : apk(this.cfg.dir);
  }
}

const readSkip = (dir: string): string | null => read(join(dir, ".skip")) || null;
