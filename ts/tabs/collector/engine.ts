// Collector (the Lead Collector userscript, RDevNeo/spok-lead-collector, moved into Hub), engine side. A run searches the
// term for VIDEOS on the platform (what the user sees searching there), goes from each video to its creator, keeps the
// active ones (an upload inside the window), and stores each lead once: picture, profile link, handle, an email when
// one can be found (bio, link-in-bio pages, their site; a typed one is never replaced), the 3 newest videos. YouTube:
// lib/sweep.ts; TikTok and Instagram: lib/social.ts. Never collected twice (any platform, nor anyone already in Persons ›
// Creators). The user can Restrict a lead (kept out of Available, still never collected again). Send message
// (persons-bridge.ts) writes to one through Persons › Creators' Gmail or WhatsApp and adds them there.
// Data in <data dir>/collector/: state.json, templates.json, sessions.json (0600: the Instagram session, never shown or
// logged), avatars/<key>.img (pictures and video thumbnails). The PC window (packages/ui/src/tabs/collector) and Hub for
// Android call the same routes:
//   GET  v1/collector                 the view (view.ts)
//   GET  v1/collector/creator?id=     one lead's detail (view.ts creatorDetail: stats, newest videos, bio, Reach, links)
//   POST v1/collector/fill {id}       the detail after filling what an older lead misses (bio, counts, the videos'
//                                     views and dates) from the platform: only on opening it, at most once a day
//   POST v1/collector/reach           {id, kind, value}: the one way to contact them ("" clears it); never auto-found
//   POST v1/collector/import-crm      {status?: "Has Contact"}: the SpokPay CRM's creators in that status (read-only, lib/crm.ts)
//                                     into Available, once each (idempotent), then their missing data read one at a time
//   POST v1/collector/edit            {id, name?, handle?, description?, links? (text, a link a line)}: typed by hand
//   POST v1/collector/settings        {platform?, query?, gapDays?, target?, approveTo?, sort?, platforms?}
//   POST v1/collector/start | stop    a run with the settings (start answers 409 with the reason it can't)
//   POST v1/collector/restrict        {id, restricted}: out of Available (or back)
//   POST v1/collector/approve         {id, approved, to?: "list" | "persons"}: the review bar's Approve (out of
//                                     Available into Approved; "persons" also adds them to Persons › Creators, no
//                                     message sent; the last "to" is remembered as settings.approveTo), or Unapprove
//   POST v1/collector/note {id, note} the detail's Quick note (private: never exported)
//   POST v1/collector/remove {id}     forget the row (still never collected again)
//   POST v1/collector/email           {id, email}: typed by hand ("" lets a found one take its place again)
//   GET  v1/collector/export?which=   {text, count}: the Available (or "approved") leads as JSONL for SpokPayCRM →
//                                     Creators → Import
//   GET  v1/collector/avatar?id=      a cached picture or thumbnail (the phone)
//   GET  v1/collector/templates       the Send menu's templates; POST template {id?, name, description, subject, body};
//                                     POST template-delete {id} (a built-in one is reset)
//   GET  v1/collector/compose?id=&template=&channel=&kind=&remember=1   the message for that lead (remember=1: the
//                                     template / channel was picked by the user, the next composer opens on it): channels (every Persons ›
//                                     Creators connection: Gmail, WhatsApp, Discord, Instagram, with who they are
//                                     there), to, subject (email), text, guard
//   POST v1/collector/send            {id, channel, to, subject, text}: a real send (only on the user's click)
//   POST v1/collector/session         {platform: "instagram", cookie}; POST session-clear {platform}
//   GET  v1/collector/unread          {rev, unread}: finished runs not looked at yet (the tab's count, as Persons'
//                                     v1/persons/unread); POST v1/collector/seen clears it (the tab was opened)
// A run that ends (done, stopped, an error, none found) counts one and notifies through Hub's notifications (kind
// "collector": this PC's popup when the window isn't in front, the phones' note), as other Hub events do.
// HUB_COLLECTOR_DIR points it at another folder; HARBOR_OFFLINE=1 / HUB_COLLECTOR_OFFLINE=1 (the screenshot rig) never
// fetches anything and keeps a saved run's "running" as it was; HUB_COLLECTOR_SEND=fake sends nothing (records it).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Call, type Reply } from "../../packages/net/src/index.ts";
import { sniff } from "../../packages/persons/src/avatars.ts";
import type { TabEngine, TabEngineCtx } from "../api.ts";
import { personsService } from "../persons/engine.ts";
import { avatarKey } from "./avatar-key.ts";
import { enrich } from "./lib/enrich.ts";
import { allKeys, linkedKeys, ownKeys, recordId } from "./lib/identity.ts";
import { Instagram } from "./lib/instagram.ts";
import { kindOf, mergeLinks, normalizeUrl, whatsappOf } from "./lib/links.ts";
import { crmCreators, crmRecord } from "./lib/crm.ts";
import { isReachKind, normalizeReach, parseLinks, reachDrafts, reachError, whatsappDigits } from "./lib/reach.ts";
import { sweepSocial, type SocialClient } from "./lib/social.ts";
import { sweepYouTube, type Stats } from "./lib/sweep.ts";
import { defaultTemplate, fillTemplate, loadTemplates, templatesToSave, type Template } from "./lib/templates.ts";
import { TikTok, TT_NOTE } from "./lib/tiktok.ts";
import { APPROVE_TO, normalizePlatforms, SORT_MODES, type SortMode, defaultData, exportText, GAP_CHOICES, listOf, type ApproveTo, migrate, normalizeTarget, PLATFORM_LABEL, PLATFORMS, type CollectorData, type CreatorPlatform, type CreatorRecord, type LogLine, type RecentVideo } from "./lib/types.ts";
import { YouTube } from "./lib/youtube.ts";
import { keepRun, runRecord, type RunOutcome } from "./lib/history.ts";
import { fakePersons, livePersons, SEND_APP, SEND_KINDS, SEND_LABEL, type PersonsBridge, type SendKind } from "./persons-bridge.ts";

/** Send message: why a channel has nobody to write to yet, and what Send asks for when To is empty. */
const NO_TO: Record<SendKind, string> = {
  gmail: "No email yet: type one.",
  whatsapp: "No WhatsApp number in their bio: type one.",
  discord: "No Discord user ID yet: type one (17-20 digits).",
  instagram: "No Instagram handle yet: type one.",
};
const TYPE_TO: Record<SendKind, string> = {
  gmail: "Type their email address.",
  whatsapp: "Type their WhatsApp number.",
  discord: "Type their Discord user ID.",
  instagram: "Type their Instagram handle.",
};
import { buildView, creatorDetail, type SessionInfo, type SourceInfo } from "./view.ts";

const LOG_KEEP = 400;
const AVATAR_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type InstagramClient = SocialClient & { whoami(): Promise<{ username: string } | null> };

interface Sessions {
  instagram?: { cookie: string; savedAt: number; account: string | null };
}

export interface CollectorDeps {
  offline: boolean;
  changed: () => void;
  log: (line: string) => void;
  /** Hub's notification (this PC's popup, the phones' note), as a Persons event would get: a run that ended. */
  notify?: (key: string, title: string, body: string) => void;
  persons: PersonsBridge;
  youtube?: Pick<YouTube, "search" | "continuation" | "feed" | "about">;
  tiktok?: SocialClient;
  instagram?: (session: { cookie: string } | null) => InstagramClient;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class Collector {
  data: CollectorData = defaultData();
  rev = 1;
  templates: Template[] = loadTemplates([]);
  private sessions: Sessions = {};
  private stopFlag = false;
  /** Hub is closing: the run it cuts is no news (no notification, no count). */
  private disposing = false;
  private running: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly file: string;
  readonly avatars: string;
  private readonly picQueue: string[] = [];
  private picBusy = false;
  /** Pictures known to be on disk (the view is built every second during a run: no stat per row). */
  private readonly have = new Set<string>();
  /** Every key ever collected (data.seen, plus the current records' own). */
  private seen = new Set<string>();
  /** People in Persons › Creators, as keys (read when a run starts). */
  private personsKeys = new Set<string>();
  private yt: CollectorDeps["youtube"] | null = null;
  private tt: SocialClient | null = null;
  /** How many creators the list had when the run started (the target counts new ones). */
  private runBefore = 0;

  constructor(
    readonly dir: string,
    private readonly o: CollectorDeps,
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
    try {
      this.templates = loadTemplates(JSON.parse(readFileSync(join(dir, "templates.json"), "utf8")));
    } catch {
      // the built-ins
    }
    try {
      this.sessions = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8")) as Sessions;
    } catch {
      // none
    }
    this.seen = new Set(this.data.seen);
    for (const c of this.data.creators) for (const k of allKeys(c)) this.seen.add(k);
    // A run can't outlive the engine: one saved as running was cut by a restart (the rig keeps it, to show one).
    if (this.data.run?.running && !o.offline) {
      this.data.run = { ...this.data.run, running: false, endedAt: Date.now(), line: "", status: "Interrupted: Hub restarted." };
      this.data.runs = keepRun(this.data.runs, runRecord(this.data.run, "interrupted"));
      this.save();
    }
  }

  // ---------- storage ----------

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
    this.data.seen = [...this.seen];
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(this.data), { mode: 0o600 });
      await rename(tmp, this.file);
    } catch (e) {
      this.o.log(`collector: couldn't save: ${errText(e)}`);
    }
  }

  private writeSide(name: string, value: unknown): void {
    const f = join(this.dir, name);
    try {
      writeFileSync(`${f}.tmp`, JSON.stringify(value, null, 1), { mode: 0o600 });
      renameSync(`${f}.tmp`, f);
      chmodSync(f, 0o600);
    } catch (e) {
      this.o.log(`collector: couldn't save ${name}: ${errText(e)}`);
    }
  }

  private logLine(text: string, tone = "info"): void {
    const l: LogLine = { at: Date.now(), text, tone };
    this.data.log.push(l);
    if (this.data.log.length > LOG_KEEP) this.data.log.splice(0, this.data.log.length - LOG_KEEP);
    if (this.data.run?.running) this.data.run.line = text;
    this.touch();
  }

  // ---------- view ----------

  sources(): SourceInfo[] {
    const ig = !!this.sessions.instagram;
    return PLATFORMS.map((p): SourceInfo => {
      if (p === "instagram")
        return {
          value: p,
          label: "Instagram",
          available: ig,
          why: ig ? "" : "Instagram's search only answers a signed-in account. Add your Instagram session below (it stays on this PC).",
          note: "Searches the term for reels and posts, as Instagram's own search shows them, then opens each one's creator. On your Instagram session, gently (a read every 2.5 s).",
        };
      if (p === "tiktok")
        return {
          value: p,
          label: "TikTok",
          available: true,
          why: "",
          note: TT_NOTE,
        };
      return { value: p, label: "YouTube", available: true, why: "", note: "Searches the term for videos, as YouTube's own search shows them, then opens each video's channel. No login needed." };
    });
  }

  sessionInfo(): SessionInfo[] {
    const s = this.sessions.instagram;
    return [
      {
        platform: "instagram",
        label: "Instagram",
        connected: !!s,
        account: s?.account ?? null,
        savedAt: s?.savedAt ?? 0,
        help: "In a browser signed in to Instagram: DevTools (F12) › Application › Cookies › instagram.com, copy sessionid and ds_user_id (mid too, if there), paste them here as sessionid=…; ds_user_id=…. Kept only on this PC, never shown again.",
      },
    ];
  }

  view(): unknown {
    const canSend = this.o.persons.channels().some((c) => c.connected);
    return buildView(this.data, this.rev, { sources: this.sources(), sessions: this.sessionInfo(), canSend }, (url) => this.avatarPath(url));
  }

  detail(id: string): unknown | null {
    const c = this.find(id);
    return c ? creatorDetail(c, (url) => this.avatarPath(url)) : null;
  }

  /** What an older lead misses that a read of their profile gives (the detail shows it). */
  static missing(c: CreatorRecord): boolean {
    const v = c.recent_videos;
    return !c.description || (c.subscriber_count === null && c.video_count === null) || !v?.length || v.some((x) => !x.published_at || x.view_count === null || x.view_count === undefined || !x.title);
  }

  private filling = new Set<string>();

  /**
   * Fills what a lead misses (bio, counts, links, the newest videos with their views and dates) with one read of its
   * profile: only when the detail opens, at most once a day per lead, never during a run on that platform (Instagram's
   * pace). Typed things stay: the email, the Reach, a typed WhatsApp, and every field changed in Edit. True when it read.
   */
  async fill(id: string): Promise<boolean> {
    const c = this.find(id);
    if (!c || this.o.offline || !Collector.missing(c) || this.filling.has(id)) return false;
    if (c.filled_at && Date.now() - Date.parse(c.filled_at) < 86_400_000) return false;
    if (this.running && this.data.run?.platform === c.platform) return false;
    if (c.platform === "instagram" && !this.sessions.instagram) return false;
    this.filling.add(id);
    try {
      let fresh: Partial<CreatorRecord> & { recent_videos?: RecentVideo[] };
      if (c.platform === "youtube") {
        const yt = this.youtube();
        const f = await yt.feed(c.platform_id).catch(() => null);
        const d = await yt.about(c.platform_id);
        fresh = {
          name: d.name || c.name,
          handle: d.handle || c.handle,
          avatar_url: d.avatarUrl || c.avatar_url,
          subscriber_count: d.subscribers ?? null,
          video_count: d.videos,
          view_count: d.views,
          description: d.description || null,
          links: d.links,
          ...(f?.videos.length ? { recent_videos: f.videos } : {}),
        };
      } else if (c.platform === "tiktok" || c.platform === "instagram") {
        const client = c.platform === "tiktok" ? this.tiktok() : this.instagram();
        const p = await client.profile((c.handle ?? "").replace(/^@/, "") || c.platform_id);
        fresh = {
          name: p.name || c.name,
          handle: p.handle || c.handle,
          avatar_url: p.avatar_url || c.avatar_url,
          subscriber_count: p.followers,
          video_count: p.posts,
          view_count: p.platform === "tiktok" ? p.likes : null,
          description: p.bio,
          links: p.links.map((l) => ({ label: l.label, url: l.url })),
          ...(p.recent.length ? { recent_videos: p.recent } : {}),
        };
      } else return false;
      const cur = this.find(id);
      if (!cur) return false;
      const typed = new Set(cur.edited ?? []);
      if (!typed.has("name") && !cur.name && fresh.name) cur.name = fresh.name;
      if (!typed.has("handle") && !cur.handle && fresh.handle) cur.handle = fresh.handle;
      if (!typed.has("description") && !cur.description && fresh.description) cur.description = fresh.description;
      if (!typed.has("links") && fresh.links?.length) cur.links = mergeLinks(cur.links, fresh.links);
      if (!cur.avatar_url && fresh.avatar_url) cur.avatar_url = fresh.avatar_url;
      for (const k of ["subscriber_count", "video_count", "view_count"] as const) if (fresh[k] !== null && fresh[k] !== undefined) cur[k] = fresh[k];
      if (fresh.recent_videos?.length) {
        cur.recent_videos = fresh.recent_videos;
        cur.last_upload_at = fresh.recent_videos[0]?.published_at ?? cur.last_upload_at ?? null;
        for (const v of fresh.recent_videos) this.avatarPath(v.thumbnail_url);
      }
      this.avatarPath(cur.avatar_url);
      cur.filled_at = new Date().toISOString();
      this.touch();
      return true;
    } catch (e) {
      const cur = this.find(id);
      if (cur) cur.filled_at = new Date().toISOString();
      this.o.log(`collector: couldn't fill ${id}: ${errText(e)}`);
      this.save();
      return false;
    } finally {
      this.filling.delete(id);
    }
  }

  private find(id: string): CreatorRecord | undefined {
    return this.data.creators.find((c) => recordId(c) === id);
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

  /** One picture into the cache; true when it was stored. */
  private async fetchPic(url: string): Promise<boolean> {
    try {
      const r = await (this.o.fetch ?? fetch)(url, { headers: { "User-Agent": AVATAR_UA }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return false;
      const b = new Uint8Array(await r.arrayBuffer());
      if (b.length === 0 || b.length >= 4_000_000) return false;
      const f = join(this.avatars, `${avatarKey(url)}.img`);
      const tmp = `${f}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tmp, b);
      renameSync(tmp, f);
      this.have.add(f);
      return true;
    } catch {
      return false; // shown with initials / an empty tile
    }
  }

  private async pump(): Promise<void> {
    if (this.picBusy) return;
    this.picBusy = true;
    let got = 0;
    try {
      while (this.picQueue.length) {
        const url = this.picQueue.shift()!;
        if (await this.fetchPic(url)) got++;
        if (got % 8 === 0 && got > 0) this.touch();
        await (this.o.sleep ?? Bun.sleep)(120);
      }
    } finally {
      this.picBusy = false;
      if (got) this.touch();
    }
  }

  /**
   * A lead's picture and newest thumbnails, fetched now (ahead of the queue) so the detail that's opening shows them:
   * a CRM import or a fill queues hundreds behind them, and the detail is only drawn from what's cached when it's read.
   * At most `ms`; whatever isn't there by then stays queued.
   */
  async picsNow(id: string, ms = 8_000): Promise<void> {
    const c = this.find(id);
    if (!c || this.o.offline) return;
    const urls = [c.avatar_url, ...(c.recent_videos ?? []).slice(0, 3).map((v) => v.thumbnail_url)].filter(
      (u): u is string => !!u && !existsSync(join(this.avatars, `${avatarKey(u)}.img`)),
    );
    if (!urls.length) return;
    for (const u of urls) {
      const i = this.picQueue.indexOf(u);
      if (i >= 0) this.picQueue.splice(i, 1);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const all = Promise.all(urls.map((u) => this.fetchPic(u)));
    await Promise.race([all, new Promise((res) => (timer = setTimeout(res, ms)))]);
    clearTimeout(timer);
    // Still missing (failed or slow): back in the queue.
    for (const u of urls) this.avatarPath(u);
  }

  // ---------- settings ----------

  setSettings(b: Record<string, unknown>): void {
    const s = this.data.settings;
    if (typeof b.platform === "string" && PLATFORMS.includes(b.platform as CreatorPlatform)) s.platform = b.platform as CreatorPlatform;
    if (typeof b.query === "string") s.query = b.query.slice(0, 200);
    if (typeof b.gapDays === "number" && GAP_CHOICES.some((c) => c.value === b.gapDays)) s.gapDays = b.gapDays;
    if (b.target !== undefined) s.target = normalizeTarget(b.target);
    if (typeof b.approveTo === "string" && APPROVE_TO.includes(b.approveTo as ApproveTo)) s.approveTo = b.approveTo as ApproveTo;
    if (typeof b.sort === "string" && SORT_MODES.includes(b.sort as SortMode)) s.sort = b.sort as SortMode;
    if (b.platforms !== undefined) s.platforms = normalizePlatforms(b.platforms);
    this.touch();
  }

  isRunning(): boolean {
    return this.running !== null;
  }

  // ---------- never twice ----------

  /** Collected before (any platform), or in Persons › Creators. */
  isKnown(keys: string[]): boolean {
    return keys.some((k) => this.seen.has(k) || this.personsKeys.has(k));
  }

  /** Keeps a creator; or why not (the same person is there already: then it's linked to them instead). */
  add(rec: CreatorRecord): string | null {
    const keys = [...ownKeys(rec), ...linkedKeys(rec), ...(rec.email ? [`email:${rec.email.toLowerCase()}`] : [])];
    const hit = keys.find((k) => this.seen.has(k) || this.personsKeys.has(k));
    if (hit) {
      const other = this.data.creators.find((c) => allKeys(c).includes(hit));
      if (other) {
        if (rec.profile_url && !other.links.some((l) => normalizeUrl(l.url) === normalizeUrl(rec.profile_url!))) {
          other.links = mergeLinks(other.links, [{ url: rec.profile_url, label: PLATFORM_LABEL[rec.platform as CreatorPlatform], source: "same person" }]);
        }
        for (const k of ownKeys(rec)) this.seen.add(k);
        this.touch();
        return `same person as ${other.name} (${PLATFORM_LABEL[other.platform as CreatorPlatform] ?? other.platform}) - linked there.`;
      }
      for (const k of ownKeys(rec)) this.seen.add(k);
      return this.personsKeys.has(hit) ? "already in Persons › Creators." : "collected before.";
    }
    this.data.creators.push(rec);
    for (const k of allKeys(rec)) this.seen.add(k);
    this.avatarPath(rec.avatar_url);
    for (const v of rec.recent_videos ?? []) this.avatarPath(v.thumbnail_url);
    if (this.data.run?.running) this.data.run.ids.push(recordId(rec));
    this.progress({ found: this.data.creators.length });
    return null;
  }

  /** Links (bio, link-in-bio pages), the email and its source, a WhatsApp number. A typed email stays. */
  private async enrichRec(rec: CreatorRecord, bioSource: string, stopped: () => boolean): Promise<CreatorRecord> {
    if (this.o.offline) return rec;
    const sleep = async (ms: number): Promise<void> => {
      for (let left = ms; left > 0 && !stopped(); left -= 200) await (this.o.sleep ?? Bun.sleep)(Math.min(200, left));
    };
    const platformEmail = rec.email && !rec.email_manual ? { email: rec.email, source: rec.email_source ?? `${bioSource}` } : null;
    const e = await enrich({ fetch: this.o.fetch ?? fetch, sleep, stopped }, { links: rec.links, bio: rec.description, bioSource });
    const out: CreatorRecord = { ...rec, links: e.links, whatsapp: rec.whatsapp_manual ? (rec.whatsapp ?? null) : (whatsappOf(e.links.map((l) => l.url), rec.description ?? "") ?? rec.whatsapp ?? null) };
    if (!rec.email_manual) {
      const found = platformEmail ?? e.email;
      out.email = found?.email ?? rec.email ?? null;
      out.email_source = found?.source ?? rec.email_source ?? null;
    }
    return out;
  }

  // ---------- runs ----------

  private youtube(): NonNullable<CollectorDeps["youtube"]> {
    return (this.yt ??= this.o.youtube ?? new YouTube(this.o.fetch));
  }

  private tiktok(): SocialClient {
    return (this.tt ??= this.o.tiktok ?? new TikTok(this.o.fetch));
  }

  private instagram(): InstagramClient {
    const s = this.sessions.instagram ? { cookie: this.sessions.instagram.cookie } : null;
    return this.o.instagram ? this.o.instagram(s) : (new Instagram(this.o.fetch, s) as unknown as InstagramClient);
  }

  /** Starts a run; a reason (and nothing runs) when it can't. */
  start(): string | null {
    if (this.running) return "A run is already going.";
    if (this.o.offline) return "Collector is offline here.";
    const s = this.data.settings;
    const src = this.sources().find((x) => x.value === s.platform);
    if (!src?.available) return src?.why ?? "That source isn't available.";
    const query = s.query.trim();
    if (!query) return "Type a search term first.";
    const target = s.target;
    const stopped = (): boolean => this.stopFlag;
    const sleep = async (ms: number): Promise<void> => {
      for (let left = ms; left > 0 && !this.stopFlag; left -= 200) await (this.o.sleep ?? Bun.sleep)(Math.min(200, left));
    };
    this.personsKeys = new Set(this.o.persons.creatorKeys());
    const before = this.data.creators.length;
    this.runBefore = before;
    const common = {
      query,
      target,
      gapDays: s.gapDays,
      isKnown: (keys: string[]) => this.isKnown(keys),
      enrich: (rec: CreatorRecord, bio: string) => this.enrichRec(rec, bio, stopped),
      add: (rec: CreatorRecord) => this.add(rec),
      count: () => this.data.creators.length - before,
      stopped,
      log: (t: string, k?: string) => this.logLine(t, k ?? "info"),
      progress: (st: Stats) => this.progress({ considered: st.considered, dropped: st.dropped, known: st.known }),
      sleep,
    };
    const platform = s.platform;
    const job =
      platform === "youtube"
        ? () => sweepYouTube({ ...common, yt: this.youtube() })
        : () => sweepSocial({ ...common, platform, client: platform === "tiktok" ? this.tiktok() : this.instagram() });
    this.stopFlag = false;
    const now = Date.now();
    this.data.run = { running: true, label: src.label, platform, query, startedAt: now, endedAt: 0, status: "Running…", found: 0, target, considered: 0, dropped: 0, known: 0, ids: [], gapDays: s.gapDays, line: `Searching ${src.label} for videos of “${query}”…` };
    this.touch();
    let failed = "";
    this.running = (async () => {
      try {
        await job();
      } catch (e) {
        failed = errText(e);
        this.logLine(`Stopped on an error: ${failed}`, "error");
      } finally {
        const r = this.data.run;
        if (r) {
          const n = this.data.creators.length - before;
          r.found = n;
          r.running = false;
          r.endedAt = Date.now();
          r.line = "";
          const leads = `${n} new lead${n === 1 ? "" : "s"}`;
          const known = r.known ? ` · ${r.known} already collected, passed over` : "";
          // History: how it ended. A run cut by Hub closing is "interrupted" (the next start says so too).
          const outcome: RunOutcome = this.disposing ? "interrupted" : failed ? "failed" : this.stopFlag ? "stopped" : n === 0 ? "none" : target > 0 && n >= target ? "done" : "exhausted";
          this.data.runs = keepRun(this.data.runs, runRecord(r, outcome, failed));
          r.status = (this.stopFlag ? `Stopped: ${leads}` : target > 0 && n >= target ? `Done: ${leads}` : n === 0 ? `No new leads for “${query}”. Try another term or a wider Last upload.` : `Done: ${leads} (no more for this term)`) + (n === 0 && !this.stopFlag ? "" : known);
          if (!this.disposing) {
            // The Collector tab's count (until the user opens it) and Hub's notification, as a Persons message gets.
            this.data.unseen++;
            const note = runNote({ n, query, label: src.label, stopped: this.stopFlag, failed, target, known: r.known });
            try {
              this.o.notify?.("run", note.title, note.body);
            } catch (e) {
              this.o.log(`collector: couldn't notify: ${errText(e)}`);
            }
          }
        }
        this.running = null;
        this.touch();
        void this.flush();
      }
    })();
    return null;
  }

  private progress(p: { found?: number; considered?: number; dropped?: number; known?: number }): void {
    const r = this.data.run;
    if (!r || !r.running) return;
    if (p.found !== undefined) r.found = p.found - this.runBefore;
    if (p.considered !== undefined) r.considered = p.considered;
    if (p.dropped !== undefined) r.dropped = p.dropped;
    if (p.known !== undefined) r.known = p.known;
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

  /** The user looked at the Collector tab (PC or phone): the finished runs' count goes. True when there was one. */
  markSeen(): boolean {
    if (this.data.unseen === 0) return false;
    this.data.unseen = 0;
    this.touch();
    return true;
  }

  /** Out of Available (or back in). A restricted lead stays remembered: no run collects it again. Restricting an
   *  approved lead takes it out of Approved. */
  restrict(id: string, on: boolean): string | null {
    const c = this.find(id);
    if (!c) return "No such lead.";
    if (on) {
      c.restricted = true;
      delete c.approved;
    } else delete c.restricted;
    this.touch();
    return null;
  }

  /** The review bar's Approve (or Unapprove: back to Available). "list" keeps it in Approved; "persons" also adds them
   *  to Persons › Creators the way Send message does, without sending anything. Still never collected again. */
  approve(id: string, on: boolean, to?: string): { error?: string; person?: string } {
    const c = this.find(id);
    if (!c) return { error: "No such lead." };
    if (!on) {
      delete c.approved;
      this.touch();
      return {};
    }
    const where: ApproveTo = APPROVE_TO.includes(to as ApproveTo) ? (to as ApproveTo) : this.data.settings.approveTo;
    let person: string | null = null;
    if (where === "persons") {
      const r = this.o.persons.add(c);
      if (!r.ok) return { error: r.error ?? "Couldn't add them to Persons › Creators." };
      person = r.person ?? null;
    }
    const cur = this.find(id);
    if (!cur) return { error: "No such lead." };
    delete cur.restricted;
    cur.approved = { at: new Date().toISOString(), to: where, person };
    this.data.settings.approveTo = where;
    this.logLine(`APPROVED ${cur.name}${where === "persons" ? "; they're in Persons › Creators" : ""}.`, "ok");
    this.touch();
    return person ? { person } : {};
  }

  /** The detail's Quick note: private (never exported), "" clears it. */
  setNote(id: string, note: string): string | null {
    const c = this.find(id);
    if (!c) return "No such lead.";
    const n = note.replace(/\r\n?/g, "\n").slice(0, 2000);
    if (n.trim()) c.note = n;
    else delete c.note;
    this.touch();
    return null;
  }

  remove(id: string): void {
    this.data.creators = this.data.creators.filter((c) => recordId(c) !== id);
    this.touch();
  }

  // ---------- email ----------

  setEmail(id: string, email: string): string | null {
    const c = this.find(id);
    if (!c) return "No such creator.";
    const e = email.trim().toLowerCase();
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return "That isn't an email address.";
    if (e) {
      c.email = e;
      c.email_source = "typed";
      c.email_manual = true;
      this.seen.add(`email:${e}`);
      if (c.reach?.kind === "email") c.reach = { kind: "email", value: e };
    } else {
      c.email = null;
      c.email_source = null;
      c.email_manual = false;
      if (c.reach?.kind === "email") delete c.reach;
    }
    this.touch();
    return null;
  }

  // ---------- the SpokPay CRM ----------

  private importing: Promise<void> | null = null;

  /**
   * The SpokPay CRM's creators in `status` ("Has Contact"), into Available: each once (a lead already here by its id is
   * only completed: empty fields filled, nothing typed replaced, a Restricted one stays Restricted; one matching another
   * lead's keys is left out), every key into the never-twice ledger. Then, in the background, their missing data (bio,
   * counts, the newest videos with views and dates) read one at a time through the usual fill. Read-only on the CRM.
   */
  async importCrm(status = "Has Contact"): Promise<{ total: number; added: number; updated: number; skipped: string[]; byPlatform: Record<string, number> }> {
    if (this.o.offline) throw new Error("Collector is offline here.");
    if (this.importing) throw new Error("An import is already going.");
    const rows = await crmCreators(this.o.fetch ?? fetch, status);
    const out = { total: rows.length, added: 0, updated: 0, skipped: [] as string[], byPlatform: {} as Record<string, number> };
    const toFill: string[] = [];
    for (const row of rows) {
      const rec = crmRecord(row, status);
      if (!PLATFORMS.includes(rec.platform as CreatorPlatform)) {
        out.skipped.push(`${rec.name} (${rec.platform}): not a platform Collector knows`);
        continue;
      }
      const id = recordId(rec);
      const cur = this.find(id);
      if (cur) {
        const typed = new Set(cur.edited ?? []);
        for (const k of ["profile_url", "avatar_url", "subscriber_count", "video_count", "view_count", "country"] as const) if ((cur[k] === null || cur[k] === undefined) && rec[k] !== null && rec[k] !== undefined) (cur as unknown as Record<string, unknown>)[k] = rec[k];
        if (!typed.has("description") && !cur.description && rec.description) cur.description = rec.description;
        if (!typed.has("handle") && !cur.handle && rec.handle) cur.handle = rec.handle;
        if (!typed.has("links") && rec.links.length) cur.links = mergeLinks(cur.links, rec.links);
        if (!cur.discovered_via && rec.discovered_via) cur.discovered_via = rec.discovered_via;
        if (!cur.reach && rec.reach) cur.reach = rec.reach;
        if (!cur.email && rec.email) Object.assign(cur, { email: rec.email, email_source: rec.email_source, email_manual: true });
        if (!cur.whatsapp && rec.whatsapp) Object.assign(cur, { whatsapp: rec.whatsapp, whatsapp_manual: true });
        if (!cur.imported_from && rec.imported_from) cur.imported_from = rec.imported_from;
        for (const k of allKeys(cur)) this.seen.add(k);
        out.updated++;
        toFill.push(id);
        continue;
      }
      // Only its own keys (id, handle): CRM cards share agency emails and link friends' channels.
      const keys = ownKeys(rec);
      const other = this.data.creators.find((c) => allKeys(c).some((k) => keys.includes(k)));
      if (other) {
        for (const k of ownKeys(rec)) this.seen.add(k);
        out.skipped.push(`${rec.name} (${PLATFORM_LABEL[rec.platform as CreatorPlatform]}): same person as ${other.name} here`);
        continue;
      }
      this.data.creators.push(rec);
      for (const k of allKeys(rec)) this.seen.add(k);
      this.avatarPath(rec.avatar_url);
      out.added++;
      out.byPlatform[rec.platform] = (out.byPlatform[rec.platform] ?? 0) + 1;
      toFill.push(id);
    }
    this.logLine(`SpokPay CRM “${status}”: ${out.total} creator(s), ${out.added} added, ${out.updated} already here (completed), ${out.skipped.length} left out.`, "ok");
    this.touch();
    void this.flush();
    this.importing = this.fillAll(toFill).finally(() => {
      this.importing = null;
    });
    return out;
  }

  /** Each lead's missing data, one read at a time (TikTok's and YouTube's pace; Instagram keeps its own 2.5 s). */
  private async fillAll(ids: string[]): Promise<void> {
    let done = 0;
    let failed = 0;
    for (const id of ids) {
      const c = this.find(id);
      if (!c || !Collector.missing(c)) continue;
      const ok = await this.fill(id).catch(() => false);
      if (ok) done++;
      else if (this.find(id)?.filled_at) failed++;
      await (this.o.sleep ?? Bun.sleep)(c.platform === "instagram" ? 2500 : 1200);
    }
    this.logLine(`SpokPay CRM import: profile data read for ${done} lead(s)${failed ? `, ${failed} couldn't be read` : ""}.`, failed ? "info" : "ok");
    void this.flush();
  }

  /** Until a CRM import's background reads end. */
  async imported(): Promise<void> {
    await this.importing;
  }

  // ---------- Reach and Edit (the lead's detail) ----------

  /** The one way to contact them (the CRM's Reach). An email or WhatsApp Reach is also what Send message writes to,
   *  typed: never replaced by one found later. "" clears the Reach (the email and number stay). */
  setReach(id: string, kind: string, value: string): string | null {
    const c = this.find(id);
    if (!c) return "No such lead.";
    if (!isReachKind(kind)) return "Pick Email, Discord, WhatsApp or Instagram.";
    if (!value.trim()) {
      delete c.reach;
      this.touch();
      return null;
    }
    const why = reachError(kind, value);
    if (why) return why;
    const v = normalizeReach(kind, value);
    c.reach = { kind, value: v };
    if (kind === "email") {
      c.email = v;
      c.email_source = "typed";
      c.email_manual = true;
      this.seen.add(`email:${v}`);
    }
    if (kind === "whatsapp") {
      c.whatsapp = v.replace(/\D/g, "");
      c.whatsapp_manual = true;
    }
    this.touch();
    return null;
  }

  /** Edit: name, handle, bio and links typed by hand (kept over anything read later). */
  editLead(id: string, b: Record<string, unknown>): string | null {
    const c = this.find(id);
    if (!c) return "No such lead.";
    const typed = new Set(c.edited ?? []);
    if (typeof b.name === "string") {
      const n = b.name.trim();
      if (!n) return "The name can't be empty.";
      if (n !== c.name) {
        c.name = n.slice(0, 200);
        typed.add("name");
      }
    }
    if (typeof b.handle === "string") {
      const h = b.handle.trim().replace(/^@+/, "");
      const next = h ? `@${h}`.slice(0, 100) : null;
      if ((next ?? "").replace(/^@/, "") !== (c.handle ?? "").replace(/^@/, "")) {
        c.handle = next;
        typed.add("handle");
      }
    }
    if (typeof b.description === "string") {
      const d = b.description.trim() || null;
      if (d !== (c.description ?? null)) {
        c.description = d ? d.slice(0, 5000) : null;
        typed.add("description");
      }
    }
    if (typeof b.links === "string") {
      const ls = parseLinks(b.links);
      const same = ls.length === c.links.length && ls.every((l, i) => l.url === c.links[i]!.url && (l.label ?? null) === (c.links[i]!.label ?? null));
      if (!same) {
        c.links = ls.slice(0, 50);
        typed.add("links");
      }
    }
    if (typed.size) c.edited = [...typed];
    this.touch();
    return null;
  }

  // ---------- templates and Send message ----------

  saveTemplate(b: Record<string, unknown>): Template {
    const id = typeof b.id === "string" && b.id ? b.id : `t_${Date.now().toString(36)}`;
    const t: Template = { id, name: String(b.name ?? "").trim() || "Untitled", description: String(b.description ?? ""), subject: String(b.subject ?? ""), body: String(b.body ?? "") };
    const i = this.templates.findIndex((x) => x.id === id);
    if (i >= 0) this.templates[i] = { ...this.templates[i]!, ...t };
    else this.templates.splice(Math.max(0, this.templates.length - 1), 0, t);
    this.templates = loadTemplates(templatesToSave(this.templates));
    this.writeSide("templates.json", templatesToSave(this.templates));
    this.touch();
    return this.templates.find((x) => x.id === id)!;
  }

  deleteTemplate(id: string): void {
    this.templates = loadTemplates(templatesToSave(this.templates.filter((t) => t.id !== id)));
    this.writeSide("templates.json", templatesToSave(this.templates));
    this.touch();
  }

  /** The message for a creator: the channels it can go on (and to whom), the template filled, the CRM's guards. */
  compose(id: string, templateId: string, channelId: string, kind = "", remember = false): unknown | null {
    const c = this.find(id);
    if (!c) return null;
    // a template or channel the user picked in the composer is where the next one opens (kept in state.json: PC and phone)
    if (remember) {
      let moved = false;
      if (templateId && this.templates.some((x) => x.id === templateId) && this.data.settings.lastTemplate !== templateId) {
        this.data.settings.lastTemplate = templateId;
        moved = true;
      }
      if (channelId && this.o.persons.channels().some((x) => x.id === channelId) && this.data.settings.lastChannel !== channelId) {
        this.data.settings.lastChannel = channelId;
        moved = true;
      }
      if (moved) this.save();
    }
    const t = this.templates.find((x) => x.id === templateId) ?? this.templates.find((x) => x.id === this.data.settings.lastTemplate) ?? defaultTemplate(this.templates)!;
    // Every way Persons › Creators can write to them: its connections (Gmail, WhatsApp, Discord, Instagram), each with
    // who they are there (the email, the number, the Reach's Discord ID or Instagram handle); a kind Creators has no
    // connection for is still listed, with why it can't send.
    const drafts = reachDrafts(c);
    const toOf = (k: SendKind): string => (k === "gmail" ? (c.email ?? "") : k === "whatsapp" ? (c.whatsapp ?? "") : k === "discord" ? drafts.discord : drafts.instagram);
    const live = this.o.persons.channels();
    const chans = [
      ...live,
      ...SEND_KINDS.filter((k) => !live.some((x) => x.kind === k)).map((k) => ({ id: `none-${k}`, kind: k, label: SEND_LABEL[k], account: null, connected: false, missing: true })),
    ]
      .sort((a, b) => SEND_KINDS.indexOf(a.kind) - SEND_KINDS.indexOf(b.kind))
      .map((ch) => {
        const to = toOf(ch.kind);
        const why =
          "missing" in ch
            ? `Persons › Creators has no ${SEND_APP[ch.kind]}: add one there (Creators › Connections).`
            : !ch.connected
              ? `The Creators ${SEND_APP[ch.kind]} isn't signed in (Persons › Creators).`
              : !to
                ? NO_TO[ch.kind]
                : "";
        return { id: ch.id, kind: ch.kind, label: ch.label, account: ch.account, connected: ch.connected, to, why };
      });
    const want: SendKind | "" = kind === "email" || kind === "gmail" ? "gmail" : (SEND_KINDS as readonly string[]).includes(kind) ? (kind as SendKind) : "";
    const reachKind: SendKind | "" = c.reach ? (c.reach.kind === "email" ? "gmail" : c.reach.kind) : "";
    const byKind = (k: SendKind | ""): (typeof chans)[number] | undefined => (k ? (chans.find((x) => x.kind === k && x.connected) ?? chans.find((x) => x.kind === k)) : undefined);
    // the channel picked last, when it can send and the lead has someone valid there (an email, a number…)
    const lastCh = this.data.settings.lastChannel;
    const valid = (x: (typeof chans)[number]): boolean => x.connected && !!x.to && !reachError(x.kind === "gmail" ? "email" : x.kind, x.to);
    const last = lastCh ? (chans.find((x) => x.id === lastCh && valid(x)) ?? chans.find((x) => x.kind === chans.find((y) => y.id === lastCh)?.kind && valid(x))) : undefined;
    const pick = chans.find((x) => x.id === channelId) ?? byKind(want) ?? last ?? (reachKind ? chans.find((x) => x.kind === reachKind && x.connected && x.to) : undefined) ?? chans.find((x) => x.connected && x.to) ?? chans.find((x) => x.connected) ?? chans[0] ?? null;
    const who = { name: c.name, handle: (c.handle ?? "").replace(/^@/, "") };
    return {
      id,
      name: c.name,
      templates: this.templates.map((x) => ({ id: x.id, name: x.name, description: x.description, builtin: !!x.builtin })),
      template: t.id,
      channels: chans,
      channel: pick?.id ?? "",
      kind: pick?.kind ?? "gmail",
      to: pick?.to ?? "",
      subject: pick && pick.kind !== "gmail" ? "" : fillTemplate(t.subject, who),
      text: fillTemplate(t.body, who),
      guard: pick && pick.connected ? this.o.persons.guard(pick.id, pick.to) : null,
      contacted: c.contacted ?? null,
    };
  }

  /** A real send, on the user's click: through Persons (the creator becomes a person in Creators, the message is in their chat). */
  async send(b: Record<string, unknown>): Promise<{ ok: boolean; error?: string; person?: string }> {
    const c = this.find(String(b.id ?? ""));
    if (!c) return { ok: false, error: "No such creator." };
    const channel = String(b.channel ?? "");
    const ch = this.o.persons.channels().find((x) => x.id === channel);
    if (!ch) {
      const k = channel.replace(/^none-/, "");
      return { ok: false, error: (SEND_KINDS as readonly string[]).includes(k) ? `Persons › Creators has no ${SEND_APP[k as SendKind]}: add one there (Creators › Connections).` : "Pick where it goes." };
    }
    const to = String(b.to ?? "").trim();
    const text = String(b.text ?? "").trim();
    const subject = String(b.subject ?? "").trim();
    if (!to) return { ok: false, error: TYPE_TO[ch.kind] };
    const bad = reachError(ch.kind === "gmail" ? "email" : ch.kind, to);
    if (bad) return { ok: false, error: bad };
    if (!text) return { ok: false, error: "The message is empty." };
    if (ch.kind === "gmail" && !subject) return { ok: false, error: "Add a subject." };
    const g = this.o.persons.guard(ch.id, to);
    if (g.justSent) return { ok: false, error: "Just sent to them: wait a couple of minutes before another." };
    if (g.limit && g.sentToday >= g.limit) return { ok: false, error: `${g.limit} new emails in the last 24 h already (Gmail flags bursts of cold mail). Try again later.` };
    const r = await this.o.persons.send({ rec: c, channel: ch.id, to, subject, text });
    if (!r.ok) return { ok: false, error: r.error ?? "Not sent." };
    const cur = this.find(String(b.id));
    if (cur) {
      cur.contacted = { at: new Date().toISOString(), via: ch.kind, to, person: r.person ?? null };
      if (ch.kind === "gmail" && !cur.email) {
        cur.email = to.toLowerCase();
        cur.email_source = "typed";
        cur.email_manual = true;
      }
      if (ch.kind === "whatsapp" && !cur.whatsapp) {
        cur.whatsapp = whatsappDigits(to);
        cur.whatsapp_manual = true;
      }
      // a Discord ID or Instagram handle typed here is kept as their Reach when they have none
      if ((ch.kind === "discord" || ch.kind === "instagram") && !cur.reach) cur.reach = { kind: ch.kind, value: normalizeReach(ch.kind, to) };
    }
    if (typeof b.template === "string" && b.template) this.data.settings.lastTemplate = b.template;
    this.data.settings.lastChannel = ch.id;
    this.logLine(`SENT ${ch.kind === "gmail" ? "email" : SEND_APP[ch.kind]} to ${c.name} (${to}); they're in Persons › Creators.`, "ok");
    return { ok: true, ...(r.person ? { person: r.person } : {}) };
  }

  // ---------- sessions ----------

  async setSession(platform: string, cookie: string): Promise<string | null> {
    if (platform !== "instagram") return "Only Instagram takes a session.";
    const c = cookie.trim().replace(/^cookie:\s*/i, "");
    const parts = c.includes("=") ? c : `sessionid=${c}`;
    if (!/(^|;\s*)sessionid=[^;]{10,}/.test(parts)) return "That has no sessionid: paste sessionid=…; ds_user_id=… from instagram.com's cookies.";
    let account: string | null = null;
    if (!this.o.offline) {
      try {
        const ig = this.o.instagram ? this.o.instagram({ cookie: parts }) : (new Instagram(this.o.fetch, { cookie: parts }) as unknown as InstagramClient);
        account = (await ig.whoami())?.username ?? null;
      } catch {
        account = null;
      }
      if (!account) return "Instagram didn't accept that session (signed out or expired). Copy fresh cookies and try again.";
    }
    this.sessions.instagram = { cookie: parts, savedAt: Date.now(), account };
    this.writeSide("sessions.json", this.sessions);
    this.logLine(`Instagram session saved${account ? ` (@${account})` : ""}.`, "ok");
    return null;
  }

  clearSession(platform: string): void {
    if (platform === "instagram") delete this.sessions.instagram;
    this.writeSide("sessions.json", this.sessions);
    this.touch();
  }

  dispose(): void {
    this.disposing = true;
    this.stopFlag = true;
  }
}

let collector: Collector | null = null;

/** What a finished run's notification says: "Collector: done — 7 new leads for “term”", then how it ended. */
export function runNote(r: { n: number; query: string; label: string; stopped: boolean; failed: string; target: number; known: number }): { title: string; body: string } {
  const leads = r.n === 0 ? "no new leads" : `${r.n} new lead${r.n === 1 ? "" : "s"}`;
  const how = r.failed ? "stopped on an error" : r.stopped ? "stopped" : "done";
  const title = `Collector: ${how} — ${leads} for “${r.query}”`;
  const known = r.known ? ` ${r.known} already collected, passed over.` : "";
  const body = r.failed
    ? `${r.label}: ${r.failed}`
    : r.stopped
      ? `${r.label}: stopped before the target (${r.target}).${known}`
      : r.n === 0
        ? `${r.label}: try another term or a wider Last upload.${known}`
        : r.target > 0 && r.n >= r.target
          ? `${r.label}: the target (${r.target}) is in.${known}`
          : `${r.label}: no more for this term.${known}`;
  return { title, body };
}

const bodyOf = (call: Call): Record<string, unknown> => (typeof call.body === "object" && call.body !== null && !Array.isArray(call.body) ? (call.body as Record<string, unknown>) : {});
const queryOf = (call: Call, k: string): string => call.query.find(([key]) => key === k)?.[1] ?? "";

export async function collectorRoute(c: Collector, call: Call): Promise<Reply | null> {
  const at = `${call.method} ${call.path.slice(2).join("/")}`;
  switch (at) {
    case "GET ":
      return ok(c.view() as never);
    case "GET unread":
      // The tab's count (finished runs not looked at yet), read every few seconds by the window: no view built.
      return ok({ rev: c.rev, unread: c.data.unseen });
    case "POST seen":
      c.markSeen();
      return ok({ rev: c.rev, unread: 0 });
    case "GET creator": {
      const d = c.detail(queryOf(call, "id"));
      return d ? ok(d as never) : err(404, "No such creator");
    }
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
    case "POST restrict": {
      const b = bodyOf(call);
      const why = c.restrict(String(b.id ?? ""), b.restricted !== false);
      if (why) return err(404, why);
      return ok(c.view() as never);
    }
    case "POST approve": {
      const b = bodyOf(call);
      const r = c.approve(String(b.id ?? ""), b.approved !== false, typeof b.to === "string" ? b.to : undefined);
      if (r.error) return err(r.error === "No such lead." ? 404 : 409, r.error);
      return ok(c.view() as never);
    }
    case "POST note": {
      const b = bodyOf(call);
      const why = c.setNote(String(b.id ?? ""), String(b.note ?? ""));
      if (why) return err(404, why);
      return ok({ ok: true });
    }
    case "POST remove":
      c.remove(String(bodyOf(call).id ?? ""));
      return ok(c.view() as never);
    case "POST email": {
      const b = bodyOf(call);
      const why = c.setEmail(String(b.id ?? ""), String(b.email ?? ""));
      if (why) return err(400, why);
      return ok((c.detail(String(b.id)) ?? {}) as never);
    }
    case "POST fill": {
      const id = String(bodyOf(call).id ?? "");
      await c.fill(id);
      await c.picsNow(id);
      const d = c.detail(id);
      return d ? ok(d as never) : err(404, "No such creator");
    }
    case "POST reach": {
      const b = bodyOf(call);
      const why = c.setReach(String(b.id ?? ""), String(b.kind ?? ""), String(b.value ?? ""));
      if (why) return err(400, why);
      return ok((c.detail(String(b.id)) ?? {}) as never);
    }
    case "POST import-crm": {
      const b = bodyOf(call);
      try {
        return ok((await c.importCrm(typeof b.status === "string" && b.status.trim() ? b.status : "Has Contact")) as never);
      } catch (e) {
        return err(409, errText(e));
      }
    }
    case "POST edit": {
      const b = bodyOf(call);
      const why = c.editLead(String(b.id ?? ""), b);
      if (why) return err(400, why);
      return ok((c.detail(String(b.id)) ?? {}) as never);
    }
    case "GET export": {
      const which = queryOf(call, "which") === "approved" ? "approved" : "available";
      return ok({ text: exportText(c.data, which), count: c.data.creators.filter((x) => listOf(x) === which).length });
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
    case "GET templates":
      return ok({ templates: c.templates, last: c.data.settings.lastTemplate } as never);
    case "POST template":
      return ok({ template: c.saveTemplate(bodyOf(call)), templates: c.templates } as never);
    case "POST template-delete":
      c.deleteTemplate(String(bodyOf(call).id ?? ""));
      return ok({ templates: c.templates } as never);
    case "GET compose": {
      const d = c.compose(queryOf(call, "id"), queryOf(call, "template"), queryOf(call, "channel"), queryOf(call, "kind"), queryOf(call, "remember") === "1");
      return d ? ok(d as never) : err(404, "No such creator");
    }
    case "POST send": {
      const r = await c.send(bodyOf(call));
      if (!r.ok) return err(409, r.error ?? "Not sent");
      return ok(r as never);
    }
    case "POST session": {
      const b = bodyOf(call);
      const why = await c.setSession(String(b.platform ?? ""), String(b.cookie ?? ""));
      if (why) return err(400, why);
      return ok(c.view() as never);
    }
    case "POST session-clear":
      c.clearSession(String(bodyOf(call).platform ?? ""));
      return ok(c.view() as never);
  }
  return err(404, "No such Collector route");
}

export const collectorEngine: TabEngine = {
  id: "collector",
  start(ctx: TabEngineCtx) {
    const offline = ctx.env.HARBOR_OFFLINE === "1" || ctx.env.HUB_COLLECTOR_OFFLINE === "1";
    const dir = ctx.env.HUB_COLLECTOR_DIR || ctx.dir;
    const persons = ctx.env.HUB_COLLECTOR_SEND === "fake" ? fakePersons() : livePersons(personsService);
    collector = new Collector(dir, { offline, changed: () => ctx.changed(), log: (l) => ctx.log(l), notify: (key, title, body) => ctx.notify?.(key, title, body), persons });
  },
  async route(call: Call): Promise<Reply | null> {
    if (call.path[0] !== "v1" || call.path[1] !== "collector") return null;
    if (!collector) return err(503, "Collector is starting");
    return collectorRoute(collector, call);
  },
  async stop() {
    collector?.dispose();
    await collector?.stop();
    await collector?.flush();
  },
};
