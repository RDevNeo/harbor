// Collector (the Lead Collector userscript, RDevNeo/spok-lead-collector, moved into Hub), engine side. Sweeps run here,
// in the engine, against the platforms' own public data (no browser): YouTube creators (lib/sweep.ts) and Discord server
// invites (lib/discord.ts, on Persons' Discord login). Data in <data dir>/collector/state.json; pictures cached in
// <data dir>/collector/avatars. The PC window (packages/ui/src/tabs/collector) and Hub for Android call the same routes:
//   GET  v1/collector                 the view (view.ts): settings, sources, run, log, rows
//   POST v1/collector/settings        {tab?, platform?, query?, gapDays?, serverMode?, serverQuery?, channel?, target?}
//   POST v1/collector/start           runs the current tab's source with the settings; answers like GET
//   POST v1/collector/stop            ends the run (what's collected stays)
//   POST v1/collector/clear           {tab}: empties that tab's results
//   POST v1/collector/clear-log
//   POST v1/collector/remove          {tab, id}: one record out
//   GET  v1/collector/export?tab=     {text, count}: JSONL for creators (SpokPayCRM → Creators → Import), URLs for servers
//   GET  v1/collector/avatar?id=      a cached picture (the phone's rows)
// HUB_COLLECTOR_DIR points it at another folder; HARBOR_OFFLINE=1 (the screenshot rig) never fetches anything and keeps a
// saved run's "running" as it was (so a shot can show one).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Call, type Reply } from "../../packages/net/src/index.ts";
import type { TabEngine, TabEngineCtx } from "../api.ts";
import { personsDiscord } from "../persons/engine.ts";
import { sniff } from "../../packages/persons/src/avatars.ts";
import { sweepDiscover, sweepReader } from "./lib/discord.ts";
import { sweepYouTube } from "./lib/sweep.ts";
import { CREATOR_SOURCES, defaultData, exportText, GAP_CHOICES, migrate, normalizeTarget, SERVER_MODES, type CollectorData, type CollectTab, type LogLine } from "./lib/types.ts";
import { YouTube } from "./lib/youtube.ts";
import { avatarKey } from "./avatar-key.ts";
import { buildView, type DiscordInfo } from "./view.ts";

const LOG_KEEP = 400;
const AVATAR_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";


export class Collector {
  data: CollectorData = defaultData();
  rev = 1;
  private stopFlag = false;
  private running: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly file: string;
  readonly avatars: string;
  private readonly picQueue: string[] = [];
  private picBusy = false;
  /** Pictures known to be on disk (the view is built every second during a run: no stat per row). */
  private readonly have = new Set<string>();

  constructor(
    readonly dir: string,
    private readonly o: {
      offline: boolean;
      changed: () => void;
      log: (line: string) => void;
      discord: () => DiscordInfo & { api?: <T = unknown>(method: string, path: string) => Promise<T> };
      youtube?: YouTube;
      fetch?: (url: string, init?: RequestInit) => Promise<Response>;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {
    this.file = join(dir, "state.json");
    this.avatars = join(dir, "avatars");
    try {
      mkdirSync(this.avatars, { recursive: true });
    } catch {
      // read-only data (a rig)
    }
    try {
      this.data = migrate(JSON.parse(readFileSync(this.file, "utf8")));
    } catch {
      // first run
    }
    // A run can't outlive the engine: one saved as running was cut by a restart (the rig keeps it, to show one).
    if (this.data.run?.running && !o.offline) {
      this.data.run = { ...this.data.run, running: false, endedAt: Date.now(), status: "Interrupted: Hub restarted." };
      this.save();
    }
  }

  private touch(): void {
    this.rev++;
    this.save();
    this.o.changed();
  }

  private save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, 400);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(this.data), { mode: 0o600 });
      await rename(tmp, this.file);
    } catch (e) {
      this.o.log(`collector: couldn't save: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private logLine(text: string, tone = "info"): void {
    const l: LogLine = { at: Date.now(), text, tone };
    this.data.log.push(l);
    if (this.data.log.length > LOG_KEEP) this.data.log.splice(0, this.data.log.length - LOG_KEEP);
    this.touch();
  }

  view(): unknown {
    return buildView(this.data, this.rev, this.o.discord(), (url) => this.avatarPath(url));
  }

  /** The cached file of a picture, null until it's fetched (a fetch is queued). */
  avatarPath(url: string | null): string | null {
    if (!url) return null;
    const f = join(this.avatars, `${avatarKey(url)}.img`);
    if (this.have.has(f)) return f;
    if (existsSync(f)) {
      this.have.add(f);
      return f;
    }
    if (!this.o.offline && !this.picQueue.includes(url)) {
      this.picQueue.push(url);
      void this.pump();
    }
    return null;
  }

  private async pump(): Promise<void> {
    if (this.picBusy) return;
    this.picBusy = true;
    let got = 0;
    try {
      while (this.picQueue.length) {
        const url = this.picQueue.shift()!;
        try {
          const r = await (this.o.fetch ?? fetch)(url, { headers: { "User-Agent": AVATAR_UA }, signal: AbortSignal.timeout(15_000) });
          if (r.ok) {
            const b = new Uint8Array(await r.arrayBuffer());
            if (b.length > 0 && b.length < 4_000_000) {
              const f = join(this.avatars, `${avatarKey(url)}.img`);
              writeFileSync(`${f}.tmp`, b);
              renameSync(`${f}.tmp`, f);
              got++;
            }
          }
        } catch {
          // shown with initials
        }
        if (got % 8 === 0 && got > 0) this.touch();
        await (this.o.sleep ?? Bun.sleep)(120);
      }
    } finally {
      this.picBusy = false;
      if (got) this.touch();
    }
  }

  setSettings(b: Record<string, unknown>): void {
    const s = this.data.settings;
    if (b.tab === "creators" || b.tab === "servers") s.tab = b.tab;
    if (typeof b.platform === "string" && CREATOR_SOURCES.some((x) => x.value === b.platform)) s.platform = b.platform as typeof s.platform;
    if (typeof b.query === "string") s.query = b.query.slice(0, 200);
    if (typeof b.gapDays === "number" && GAP_CHOICES.some((c) => c.value === b.gapDays)) s.gapDays = b.gapDays;
    if (typeof b.serverMode === "string" && SERVER_MODES.some((x) => x.value === b.serverMode)) s.serverMode = b.serverMode as typeof s.serverMode;
    if (typeof b.serverQuery === "string") s.serverQuery = b.serverQuery.slice(0, 200);
    if (typeof b.channel === "string") s.channel = b.channel.slice(0, 300);
    if (b.target !== undefined) s.targets[s.tab] = normalizeTarget(b.target);
    if (b.creatorsTarget !== undefined) s.targets.creators = normalizeTarget(b.creatorsTarget);
    if (b.serversTarget !== undefined) s.targets.servers = normalizeTarget(b.serversTarget);
    this.touch();
  }

  isRunning(): boolean {
    return this.running !== null;
  }

  /** Starts the current tab's source; a reason (and nothing runs) when it can't. */
  start(): string | null {
    if (this.running) return "A run is already going.";
    if (this.o.offline) return "Collector is offline here.";
    const s = this.data.settings;
    const tab = s.tab;
    const tone = (t?: string): string => t ?? "info";
    const stopped = (): boolean => this.stopFlag;
    const sleep = async (ms: number): Promise<void> => {
      const end = Date.now() + ms;
      while (!this.stopFlag && Date.now() < end) await (this.o.sleep ?? Bun.sleep)(Math.min(200, end - Date.now()));
    };
    const target = s.targets[tab];
    let job: () => Promise<void>;
    let label: string;
    let query: string;
    if (tab === "creators") {
      const src = CREATOR_SOURCES.find((x) => x.value === s.platform);
      if (!src?.available) return src?.why ?? "That source isn't available.";
      query = s.query.trim();
      if (!query) return "Type a search term first.";
      label = src.label;
      const known = new Set(this.data.creators.map((c) => `${c.platform}:${c.platform_id}`));
      const ytKnown = new Set(this.data.creators.filter((c) => c.platform === "youtube").map((c) => c.platform_id));
      job = async () => {
        await sweepYouTube({
          yt: this.o.youtube ?? new YouTube(this.o.fetch),
          query,
          target,
          gapDays: s.gapDays,
          known: ytKnown,
          count: () => this.data.creators.length,
          add: (rec) => {
            const k = `${rec.platform}:${rec.platform_id}`;
            if (known.has(k)) return;
            known.add(k);
            this.data.creators.push(rec);
            this.avatarPath(rec.avatar_url);
            this.progress({ found: this.data.creators.length });
          },
          stopped,
          log: (t, k) => this.logLine(t, tone(k)),
          progress: (st) => this.progress({ considered: st.considered, dropped: st.dropped }),
          sleep,
        });
      };
    } else {
      const mode = SERVER_MODES.find((x) => x.value === s.serverMode);
      if (!mode?.available) return mode?.why ?? "That mode isn't available.";
      const d = this.o.discord();
      if (!d.connected || !d.api) return "Servers needs Discord: sign in to the Stores Discord account in Persons first.";
      query = s.serverMode === "discover" ? s.serverQuery.trim() : s.channel.trim();
      if (!query) return s.serverMode === "discover" ? "Type a search term first." : "Paste a channel link first.";
      label = mode.label;
      const ctx = {
        api: d.api,
        fetch: this.o.fetch ?? fetch,
        target,
        knownCodes: new Set(this.data.servers.map((x) => x.invite.split("/").pop()!.toLowerCase())),
        knownGuilds: new Set(this.data.servers.flatMap((x) => (x.guild_id ? [x.guild_id] : []))),
        count: () => this.data.servers.length,
        add: (rec: CollectorData["servers"][number]) => {
          this.data.servers.push(rec);
          this.avatarPath(rec.icon_url);
          this.progress({ found: this.data.servers.length });
        },
        stopped,
        log: (t: string, k?: string) => this.logLine(t, tone(k)),
        progress: (p: { considered: number; dropped: number }) => this.progress(p),
        sleep,
      };
      job = () => (s.serverMode === "discover" ? sweepDiscover(ctx, query) : sweepReader(ctx, query));
    }
    this.stopFlag = false;
    const now = Date.now();
    this.data.run = { running: true, tab, label, query, startedAt: now, endedAt: 0, status: "Running…", found: tab === "creators" ? this.data.creators.length : this.data.servers.length, target, considered: 0, dropped: 0 };
    const before = this.data.run.found;
    this.touch();
    this.running = (async () => {
      try {
        await job();
      } catch (e) {
        this.logLine(`Stopped on an error: ${e instanceof Error ? e.message : String(e)}`, "error");
      } finally {
        const r = this.data.run;
        if (r) {
          const n = (tab === "creators" ? this.data.creators.length : this.data.servers.length) - before;
          const what = tab === "creators" ? "creator(s)" : "invite(s)";
          r.running = false;
          r.endedAt = Date.now();
          r.status = this.stopFlag ? `Stopped. ${n} new ${what}.` : target > 0 && r.found >= target ? `Target reached: ${n} new ${what}.` : `Done. ${n} new ${what}.`;
        }
        this.running = null;
        this.touch();
        void this.flush();
      }
    })();
    return null;
  }

  private progress(p: { found?: number; considered?: number; dropped?: number }): void {
    const r = this.data.run;
    if (!r) return;
    if (p.found !== undefined) r.found = p.found;
    if (p.considered !== undefined) r.considered = p.considered;
    if (p.dropped !== undefined) r.dropped = p.dropped;
    this.touch();
  }

  /** Until the run (if any) ends by itself. */
  async settled(): Promise<void> {
    await this.running;
  }

  async stop(): Promise<void> {
    this.stopFlag = true;
    await this.running;
  }

  clear(tab: CollectTab): void {
    if (tab === "creators") this.data.creators = [];
    else this.data.servers = [];
    if (this.data.run && !this.data.run.running && this.data.run.tab === tab) this.data.run = null;
    this.touch();
  }

  remove(tab: CollectTab, id: string): void {
    if (tab === "creators") this.data.creators = this.data.creators.filter((c) => `${c.platform}:${c.platform_id}` !== id);
    else this.data.servers = this.data.servers.filter((s) => s.invite !== id);
    this.touch();
  }

  clearLog(): void {
    this.data.log = [];
    this.touch();
  }
}

let collector: Collector | null = null;

const bodyOf = (call: Call): Record<string, unknown> => (typeof call.body === "object" && call.body !== null && !Array.isArray(call.body) ? (call.body as Record<string, unknown>) : {});
const queryOf = (call: Call, k: string): string => call.query.find(([key]) => key === k)?.[1] ?? "";

/** Persons' Discord account, as Collector shows it. */
function discordInfo(): DiscordInfo & { api?: <T = unknown>(method: string, path: string) => Promise<T> } {
  const d = personsDiscord();
  if (!d) return { connected: false, account: null };
  return { connected: d.connected, account: d.info.account ? (d.info.account.name || d.info.account.username) : null, api: d.api };
}

export async function collectorRoute(c: Collector, call: Call): Promise<Reply | null> {
  const at = `${call.method} ${call.path.slice(2).join("/")}`;
  switch (at) {
    case "GET ":
      return ok(c.view() as never);
    case "POST settings":
      c.setSettings(bodyOf(call));
      return ok(c.view() as never);
    case "POST start": {
      const b = bodyOf(call);
      if (Object.keys(b).length) c.setSettings(b);
      const why = c.start();
      if (why) return err(409, why);
      return ok(c.view() as never);
    }
    case "POST stop":
      await c.stop();
      return ok(c.view() as never);
    case "POST clear":
      c.clear(bodyOf(call).tab === "servers" ? "servers" : "creators");
      return ok(c.view() as never);
    case "POST clear-log":
      c.clearLog();
      return ok(c.view() as never);
    case "POST remove": {
      const b = bodyOf(call);
      c.remove(b.tab === "servers" ? "servers" : "creators", String(b.id ?? ""));
      return ok(c.view() as never);
    }
    case "GET export": {
      const tab = queryOf(call, "tab") === "servers" ? "servers" : "creators";
      const text = exportText(c.data, tab);
      return ok({ text, count: tab === "creators" ? c.data.creators.length : c.data.servers.length });
    }
    case "GET avatar": {
      const id = queryOf(call, "id");
      if (!/^[0-9a-f]{20}$/.test(id)) return err(400, "bad id");
      try {
        const bytes = await readFile(join(c.avatars, `${id}.img`));
        return ok({ type: sniff(bytes), data: bytes.toString("base64") });
      } catch {
        return err(404, "no picture");
      }
    }
  }
  return err(404, "No such Collector route");
}

export const collectorEngine: TabEngine = {
  id: "collector",
  start(ctx: TabEngineCtx) {
    const offline = ctx.env.HARBOR_OFFLINE === "1" || ctx.env.HUB_COLLECTOR_OFFLINE === "1";
    const dir = ctx.env.HUB_COLLECTOR_DIR || ctx.dir;
    collector = new Collector(dir, { offline, changed: () => ctx.changed(), log: (l) => ctx.log(l), discord: discordInfo });
  },
  async route(call: Call): Promise<Reply | null> {
    if (call.path[0] !== "v1" || call.path[1] !== "collector") return null;
    if (!collector) return err(503, "Collector is starting");
    return collectorRoute(collector, call);
  },
  async stop() {
    await collector?.stop();
    await collector?.flush();
  },
};
