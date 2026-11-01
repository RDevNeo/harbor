import { appendFileSync, existsSync, realpathSync } from "node:fs";
import type { Store } from "@harbor/store";
import type { Fetch, VideoHooks } from "./images.ts";
import {
  END_FILE_ERROR,
  FORMAT_DOUBLE,
  FORMAT_FLAG,
  FORMAT_INT64,
  FORMAT_STRING,
  FrameTarget,
  globalLibrary,
  hasSymbol,
  LibmpvUnavailable,
  loadMpv,
  type MpvEvent,
  type MpvLib,
  Mpv,
  type PropertyValue,
  pipewireVersion,
  SwRenderer,
} from "./libmpv.ts";
import { check as mediaCheck, located, saveRemote } from "./media.ts";

export { LibmpvUnavailable };

export const HIDDEN_MS = 1500;
export const CONTROLS_FOR_MS = 2500;
export const NUDGE = 5;
export const VOLUME_STEP = 5;
export const STOP_WAIT_MS = 1000;
export const WAIT_FOR_PLAYER_MS = 300_000;
export const WARN_NO_MPV = "Harbor's video player isn't here yet, so this opened in your video player";

export const PIPEWIRE_MIN: Version = [0, 3, 65];

export type Version = readonly [number, number, number];

export function versionOf(text: string): Version | null {
  const parts = text.trim().split(".").slice(0, 3);
  if (parts.length < 3) return null;
  const nums = parts.map((p) => (/^\+?\d+$/.test(p) && Number(p) <= 0xffff_ffff ? Number(p) : null));
  const [a, b, c] = nums;
  return a == null || b == null || c == null ? null : [a, b, c];
}

export function versionAtLeast(v: Version, min: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i]! !== min[i]!) return v[i]! > min[i]!;
  }
  return true;
}

export function audioOutputs(pipewire: boolean, pulse: boolean, alsa: boolean): string {
  return [
    [pipewire, "pipewire"],
    [pulse, "pulse"],
    [alsa, "alsa"],
    [true, "null"],
  ]
    .filter(([on]) => on)
    .map(([, name]) => name)
    .join(",");
}

export interface Optional {
  ao: string;
  va: boolean;
}

function pipewireNewEnough(): boolean {
  const v = pipewireVersion();
  const parsed = v === null ? null : versionOf(v);
  return parsed !== null && versionAtLeast(parsed, PIPEWIRE_MIN);
}

function optional(): Optional {
  const va = globalLibrary("libva.so.2") && globalLibrary("libva-drm.so.2") && globalLibrary("libEGL.so.1") && hasSymbol("vaSyncBuffer");
  const pipewire = globalLibrary("libpipewire-0.3.so.0") && pipewireNewEnough();
  const pulse = globalLibrary("libpulse.so.0");
  const alsa = globalLibrary("libasound.so.2");
  return { ao: audioOutputs(pipewire, pulse, alsa), va };
}

export interface Engine {
  lib: MpvLib;
  path: string;
  own: Optional | null;
}

let engine: Engine | null = null;

export function engineLoaded(): boolean {
  return engine !== null;
}

/** Cached once found; a failed probe is tried again on the next call. */
export function loadEngine(own: string | null): Engine {
  if (engine) return engine;
  if (own !== null) {
    const found = optional();
    try {
      const { lib, path } = loadMpv([own]);
      engine = { lib, path, own: found };
      return engine;
    } catch {
      // the system's is the fallback
    }
  }
  const { lib, path } = loadMpv(["libmpv.so.2", "libmpv.so.1"]);
  engine = { lib, path, own: null };
  return engine;
}

export const OPTIONS: readonly (readonly [string, string])[] = [
  ["config", "no"],
  ["load-scripts", "no"],
  ["ytdl", "no"],
  ["osc", "no"],
  ["load-stats-overlay", "no"],
  ["load-console", "no"],
  ["load-auto-profiles", "no"],
  ["load-select", "no"],
  ["load-context-menu", "no"],
  ["load-positioning", "no"],
  ["load-commands", "no"],
  ["terminal", "no"],
  ["input-default-bindings", "no"],
  ["input-builtin-bindings", "no"],
  ["input-vo-keyboard", "no"],
  ["resume-playback", "no"],
  ["access-references", "no"],
  ["ordered-chapters", "no"],
  ["load-unsafe-playlists", "no"],
  ["autoload-files", "no"],
  ["sub-auto", "no"],
  ["audio-file-auto", "no"],
  ["cover-art-auto", "no"],
  ["sid", "no"],
  ["vo", "libmpv"],
  ["video-timing-offset", "0"],
  ["profile", "fast"],
  ["osd-level", "0"],
  ["osd-bar", "no"],
  // Frames are drawn into CPU memory, so a hardware decoder has to copy them back.
  ["hwdec", "auto-copy-safe"],
  ["idle", "yes"],
  ["keep-open", "yes"],
  ["hr-seek", "yes"],
  ["volume-max", "100"],
  ["audio-client-name", "Harbor"],
];

export function optionValue(name: string): string | undefined {
  return OPTIONS.findLast(([n]) => n === name)?.[1];
}

export const WATCH: readonly (readonly [string, number])[] = [
  ["time-pos", FORMAT_DOUBLE],
  ["duration", FORMAT_DOUBLE],
  ["pause", FORMAT_FLAG],
  ["eof-reached", FORMAT_FLAG],
  ["dwidth", FORMAT_INT64],
  ["idle-active", FORMAT_FLAG],
];

const ID_POS = 0;
const ID_DURATION = 1;
const ID_PAUSE = 2;
const ID_EOF = 3;
const ID_WIDTH = 4;
const ID_IDLE = 5;
const ID_STATS = 100;

const STATS = ["hwdec-current", "video-codec", "frame-drop-count", "decoder-frame-drop-count", "vo-delayed-frame-count", "avsync", "estimated-vf-fps"] as const;

function logFile(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.HARBOR_VIDEO_LOG || null;
}

function note(line: string): void {
  const path = logFile();
  if (path === null) return;
  try {
    appendFileSync(path, `${line}\n`);
  } catch {
    // a log that can't be written is not worth a failed video
  }
}

export function coreOptions(o: { paused: boolean; volume: number; blind: boolean; own: Optional | null; log: string | null }): [string, string][] {
  const list: [string, string][] = OPTIONS.map(([n, v]) => [n, v]);
  list.push(["volume", String(o.volume)], ["pause", o.paused ? "yes" : "no"]);
  if (o.own) {
    list.push(["ao", o.own.ao]);
    // Hardware decoding needs a render node from the window's GL context, which a software render has none of.
    list.push(["hwdec", "no"]);
  }
  if (o.blind) list.push(["vo", "null"], ["ao", "null"], ["hwdec", "no"], ["keep-open", "no"], ["untimed", "yes"]);
  if (o.log !== null) list.push(["log-file", `${o.log}.mpv`]);
  return list;
}

export type Cmd =
  | { kind: "load" }
  | { kind: "pause"; on: boolean }
  /** `exact` for the exact frame, otherwise the nearest keyframe (dragging). */
  | { kind: "seek"; to: number; exact: boolean }
  | { kind: "nudge"; by: number }
  | { kind: "volume"; percent: number }
  | { kind: "mute"; on: boolean }
  | { kind: "stop" }
  | { kind: "quit" };

export function push(queue: Cmd[], c: Cmd): void {
  // Of a dragged seek bar only its last place matters.
  if (c.kind === "seek") {
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.kind === "seek") queue.splice(i, 1);
  }
  queue.push(c);
}

export type Stage = { kind: "starting" } | { kind: "preparing" } | { kind: "playing" } | { kind: "failed"; why: string } | { kind: "noMpv"; file: string };

export interface State {
  stage: Stage;
  pos: number;
  dur: number;
  paused: boolean;
  ended: boolean;
  /** A first frame is out (or the file has no picture). */
  started: boolean;
  /** mpv has no video open, so ending the renderer won't wait for it. */
  stopped: boolean;
  hasVideo: boolean;
  stats: string[];
}

export function freshState(paused: boolean): State {
  return { stage: { kind: "starting" }, pos: 0, dur: 0, paused, ended: false, started: false, stopped: false, hasVideo: false, stats: STATS.map(() => "") };
}

/** A window out of sight gets no frames, so a playing video notices by itself. */
export function outOfSight(playing: boolean, unseenMs: number): boolean {
  return playing && unseenMs > HIDDEN_MS;
}

/** Takes in a watched property. True when the viewer must draw for it: the position alone isn't. */
export function changed(st: State, id: number, p: { format: number; value: PropertyValue }): boolean {
  if (p.format === 0 || p.value === null) {
    if (id !== ID_WIDTH) return false;
    st.hasVideo = false;
    return true;
  }
  const v = p.value;
  switch (id) {
    case ID_POS:
      if (typeof v === "number") st.pos = v;
      break;
    case ID_DURATION:
      if (typeof v === "number") st.dur = v;
      break;
    case ID_PAUSE:
      st.paused = v === true;
      break;
    case ID_EOF:
      st.ended = v === true;
      break;
    case ID_WIDTH:
      st.hasVideo = typeof v === "number" && v > 0;
      break;
    case ID_IDLE:
      st.stopped = v === true;
      break;
    default:
      if (p.format === FORMAT_STRING && typeof v === "string" && id >= ID_STATS && id - ID_STATS < st.stats.length) st.stats[id - ID_STATS] = v;
  }
  return id > 0 && id < ID_STATS;
}

export function clock(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.floor(Math.max(seconds, 0)) : 0;
  const two = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

export type Playable = { ok: true; file: string } | { ok: false; error: string };

const fail = (error: string): Playable => ({ ok: false, error });

export function playable(path: string): Playable {
  const c = mediaCheck(path);
  if (!c.ok) return fail(c.error);
  if (!c.video) return fail("not a video");
  let file: string;
  try {
    file = realpathSync(located(path));
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  return file.startsWith("/") ? { ok: true, file } : fail("not a file Harbor shows");
}

export async function fileOf(key: string, fetch?: Fetch): Promise<Playable> {
  if (fetch && !existsSync(located(key))) {
    const bytes = await fetch(key);
    const saved = bytes ? saveRemote(key, bytes) : null;
    return saved === null ? fail("the PC this chat runs on is off or doesn't have it") : playable(saved);
  }
  return playable(key);
}

/** RGBA, straight alpha, `width` x `height`: what a Slint image takes. Valid until the next frame. */
export interface Frame {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface Host {
  /** Something the controls show changed. */
  repaint(): void;
  /** A new picture. Letterbox bars are transparent: draw black behind. */
  frame(frame: Frame): void;
  fullscreen(): boolean;
  setFullscreen(on: boolean): void;
  openExternally(file: string): void;
  toast(message: string): void;
  shut(): void;
}

/** What `update.rs` knows of Harbor's own player; without it only the system's libmpv is used. */
export interface PlayerSource {
  library(): string | null;
  coming(): boolean;
  ask(): void;
}

export interface ViewerOptions {
  host: Host;
  source?: PlayerSource;
  /** Milliseconds, steady. */
  now?: () => number;
  loadEngine?: (own: string | null) => Engine;
}

export type Key = "space" | "left" | "right" | "up" | "down" | "m" | "f" | "escape" | "pageUp" | "pageDown";

export interface KeyResult {
  previous: boolean;
  next: boolean;
  close: boolean;
}

export interface Snapshot {
  key: string;
  stage: Stage;
  pos: number;
  dur: number;
  paused: boolean;
  ended: boolean;
  started: boolean;
  hasVideo: boolean;
  muted: boolean;
  volume: number;
  drag: number | null;
  closing: boolean;
  picture: boolean;
}

interface Env {
  host: Host;
  source: PlayerSource | undefined;
  now: () => number;
  load: (own: string | null) => Engine;
  volume: () => number;
  noMpv: (p: Player, file: string) => void;
  reap: (p: Player) => void;
}

class Player {
  readonly state: State;
  readonly cmds: Cmd[] = [];
  muted = false;
  drag: number | null = null;
  moved: number;
  closing = false;
  closedAt = 0;
  drawn = false;
  size: readonly [number, number] = [0, 0];
  private mpv: Mpv | null = null;
  private renderer: SwRenderer | null = null;
  private target: FrameTarget | null = null;
  private finished = false;
  private seenAt: number;
  private pending = false;
  private rendering = false;
  private forceRender = false;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private loadPath = "";
  private frames = 0;
  private renderMs = 0;
  private renderMax = 0;

  constructor(
    readonly key: string,
    private readonly env: Env,
    fetch: Fetch | undefined,
    play: boolean,
  ) {
    this.state = freshState(!play);
    this.moved = env.now();
    this.seenAt = this.moved;
    void this.control(fetch, !play);
  }

  send(c: Cmd): void {
    push(this.cmds, c);
    this.wake();
  }

  seen(): void {
    this.seenAt = this.env.now();
  }

  unseen(): number {
    return this.env.now() - this.seenAt;
  }

  setStage(stage: Stage): void {
    this.state.stage = stage;
    this.env.host.repaint();
  }

  get hasCore(): boolean {
    return this.mpv !== null;
  }

  private wake(): void {
    if (this.pending || this.finished) return;
    this.pending = true;
    setImmediate(() => this.drain());
  }

  private async control(fetch: Fetch | undefined, paused: boolean): Promise<void> {
    const file = await fileOf(this.key, fetch);
    if (!file.ok) return this.setStage({ kind: "failed", why: file.error });
    this.loadPath = file.file;
    if (!(await this.waitForPlayer())) return;
    let engine: Engine;
    try {
      engine = this.env.load(this.env.source?.library() ?? null);
    } catch {
      if (!this.finished) this.env.noMpv(this, file.file);
      return;
    }
    if (this.finished) return;
    // (However long that took, it wasn't a window out of sight.)
    this.seen();
    let mpv: Mpv;
    try {
      mpv = Mpv.create(engine.lib, coreOptions({ paused, volume: this.env.volume(), blind: false, own: engine.own, log: logFile() }));
    } catch {
      return this.setStage({ kind: "failed", why: "mpv didn't start" });
    }
    let renderer: SwRenderer;
    try {
      renderer = SwRenderer.create(engine.lib, mpv);
    } catch {
      mpv.destroy();
      return this.setStage({ kind: "failed", why: "mpv can't draw in this window" });
    }
    this.mpv = mpv;
    this.renderer = renderer;
    this.target = new FrameTarget();
    mpv.onWakeup(() => this.wake());
    renderer.onFrame(() => this.frameDue());
    WATCH.forEach(([name, format], id) => mpv.observe(id, name, format));
    if (logFile() !== null) STATS.forEach((name, i) => mpv.observe(ID_STATS + i, name, FORMAT_STRING));
    this.cmds.unshift({ kind: "load" });
    this.env.host.repaint();
    this.wake();
  }

  private async waitForPlayer(): Promise<boolean> {
    const source = this.env.source;
    const began = this.env.now();
    while (source && !engineLoaded() && source.library() === null && this.env.now() - began < WAIT_FOR_PLAYER_MS) {
      source.ask();
      if (!source.coming()) break;
      if (this.state.stage.kind !== "preparing") this.setStage({ kind: "preparing" });
      if (this.finished) return false;
      await Bun.sleep(250);
    }
    return !this.finished;
  }

  private run(mpv: Mpv, c: Cmd): void {
    switch (c.kind) {
      case "load":
        this.state.stopped = false;
        mpv.command("loadfile", this.loadPath);
        break;
      case "pause":
        mpv.setProperty("pause", c.on ? "yes" : "no");
        break;
      case "seek":
        mpv.command("seek", c.to.toFixed(3), c.exact ? "absolute+exact" : "absolute+keyframes");
        break;
      case "nudge":
        mpv.command("seek", c.by.toFixed(3), "relative+exact");
        break;
      case "volume":
        mpv.setProperty("volume", c.percent.toFixed(3));
        break;
      case "mute":
        mpv.setProperty("mute", c.on ? "yes" : "no");
        break;
      case "stop":
        mpv.command("stop");
        break;
      case "quit":
        break;
    }
  }

  private drain(): void {
    this.pending = false;
    const mpv = this.mpv;
    if (mpv === null || this.finished) return;
    for (const c of this.cmds.splice(0)) this.run(mpv, c);
    let repaint = false;
    for (;;) {
      const e = mpv.waitEvent(0);
      if (e.kind === "none") break;
      repaint = this.event(mpv, e) || repaint;
    }
    if (outOfSight(!this.state.paused, this.unseen())) mpv.setProperty("pause", "yes");
    if (repaint) this.env.host.repaint();
    this.reapIfDone();
  }

  private event(mpv: Mpv, e: MpvEvent): boolean {
    const st = this.state;
    switch (e.kind) {
      case "fileLoaded":
        st.stage = { kind: "playing" };
        return true;
      case "playbackRestart":
        st.started = true;
        this.forceRender = true;
        this.frameDue();
        return true;
      case "idle":
        st.stopped = true;
        return true;
      case "endFile":
        if (e.reason !== END_FILE_ERROR) return false;
        st.stage = { kind: "failed", why: mpv.errorString(e.error) };
        return true;
      case "property":
        return changed(st, e.id, e);
      default:
        return false;
    }
  }

  frameDue(): void {
    if (this.rendering || this.finished) return;
    this.rendering = true;
    setImmediate(() => {
      this.rendering = false;
      this.renderNow();
    });
  }

  resize(width: number, height: number): void {
    this.size = [Math.max(Math.round(width), 1), Math.max(Math.round(height), 1)];
    this.frameDue();
  }

  private renderNow(): void {
    const { renderer, target } = this;
    if (this.finished || renderer === null || target === null || this.size[0] < 1) return;
    const resized = target.resize(this.size[0], this.size[1]);
    const fresh = renderer.hasNewFrame();
    if (!fresh && !resized && !this.forceRender) return;
    this.forceRender = false;
    const t = performance.now();
    const code = renderer.render(target);
    const took = performance.now() - t;
    this.frames += 1;
    this.renderMs += took;
    this.renderMax = Math.max(this.renderMax, took);
    if (code < 0) return;
    this.drawn ||= this.state.started;
    if (this.drawn && this.state.hasVideo) this.env.host.frame({ width: target.width, height: target.height, data: target.rgba });
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.closedAt = this.env.now();
    if (this.mpv === null) {
      this.env.reap(this);
      return;
    }
    this.send({ kind: "stop" });
    this.stopTimer = setTimeout(() => this.env.reap(this), STOP_WAIT_MS);
  }

  markClosing(): void {
    this.closing = true;
  }

  private reapIfDone(): void {
    if (this.closing && !this.finished && (this.state.stopped || this.env.now() - this.closedAt >= STOP_WAIT_MS)) this.env.reap(this);
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    const t = performance.now();
    this.renderer?.free();
    this.renderer = null;
    if (logFile() !== null) {
      const avg = this.renderMs / Math.max(this.frames, 1);
      note(`${this.key}: ${this.frames} frames drawn, ${avg.toFixed(2)} ms avg, ${this.renderMax.toFixed(2)} ms max; renderer freed in ${(performance.now() - t).toFixed(2)} ms`);
      note(`${this.key}: ${STATS.map((n, i) => `${n}=${this.state.stats[i]}`).join(", ")}`);
    }
    this.mpv?.destroy();
    this.mpv = null;
    this.target?.free();
    this.target = null;
  }
}

interface Next {
  key: string;
  fetch: Fetch | undefined;
  play: boolean;
}

export class Viewer implements VideoHooks {
  private player: Player | null = null;
  private next: Next | null = null;
  private wasFull: boolean | null = null;
  private level = 100;
  private levelChanged = false;
  private size: readonly [number, number] = [0, 0];
  private readonly env: Env;

  constructor(options: ViewerOptions) {
    this.env = {
      host: options.host,
      source: options.source,
      now: options.now ?? (() => performance.now()),
      load: options.loadEngine ?? loadEngine,
      volume: () => this.level,
      noMpv: (p, file) => this.noMpv(p, file),
      reap: (p) => this.reap(p),
    };
  }

  isOpen(): boolean {
    return this.next !== null || (this.player !== null && !this.player.closing);
  }

  open(key: string, fetch: Fetch | undefined, play: boolean): void {
    const p = this.player;
    if (p === null) {
      this.spawn({ key, fetch, play });
    } else if (p.key !== key || p.closing) {
      this.next = { key, fetch, play };
      p.close();
    }
  }

  close(): void {
    this.next = null;
    if (this.wasFull === false) this.env.host.setFullscreen(false);
    this.wasFull = null;
    this.player?.close();
  }

  shutdown(): void {
    this.next = null;
    const p = this.player;
    this.player = null;
    p?.finish();
  }

  resize(width: number, height: number): void {
    this.size = [width, height];
    this.player?.resize(width, height);
  }

  setVolume(percent: number): void {
    this.level = Math.min(Math.max(Math.round(percent), 0), 100);
  }

  volume(): number {
    return this.level;
  }

  takeVolume(): number | null {
    if (!this.levelChanged) return null;
    this.levelChanged = false;
    return this.level;
  }

  restoreVolume(store: Pick<Store, "get">): void {
    const saved = store.get("video_volume");
    if (saved !== null && /^\d+$/.test(saved)) this.setVolume(Number(saved));
  }

  persistVolume(store: Pick<Store, "set">): boolean {
    const v = this.takeVolume();
    if (v === null) return false;
    store.set("video_volume", String(v));
    return true;
  }

  snapshot(): Snapshot | null {
    const p = this.player;
    if (p === null) return null;
    const s = p.state;
    return {
      key: p.key,
      stage: s.stage,
      pos: s.pos,
      dur: s.dur,
      paused: s.paused,
      ended: s.ended,
      started: s.started,
      hasVideo: s.hasVideo,
      muted: p.muted,
      volume: this.level,
      drag: p.drag,
      closing: p.closing,
      picture: p.drawn && s.hasVideo,
    };
  }

  queued(): readonly Cmd[] {
    return this.player?.cmds ?? [];
  }

  seen(): void {
    this.player?.seen();
  }

  pointerMoved(): void {
    const p = this.player;
    if (p) p.moved = this.env.now();
  }

  controlsVisible(overBar: boolean): boolean {
    const p = this.player;
    if (p === null) return false;
    return p.state.paused || overBar || p.drag !== null || this.env.now() - p.moved < CONTROLS_FOR_MS;
  }

  toggle(): void {
    const p = this.player;
    if (p === null) return;
    // (Nothing was drawn while paused: this mustn't read as a window out of sight.)
    p.seen();
    if (p.state.ended) {
      p.send({ kind: "seek", to: 0, exact: true });
      p.send({ kind: "pause", on: false });
    } else {
      p.send({ kind: "pause", on: !p.state.paused });
    }
  }

  toggleMute(): void {
    const p = this.player;
    if (p === null) return;
    p.muted = !p.muted;
    p.send({ kind: "mute", on: p.muted });
  }

  holdVolume(percent: number): void {
    const p = this.player;
    if (p === null) return;
    const to = Math.min(Math.max(Math.round(percent), 0), 100);
    if (to !== this.level || p.muted) this.changeVolume(p, to);
  }

  holdSeek(seconds: number): void {
    const p = this.player;
    if (p === null || p.drag === seconds) return;
    p.drag = seconds;
    p.send({ kind: "seek", to: seconds, exact: false });
  }

  releaseSeek(): void {
    const p = this.player;
    if (p === null || p.drag === null) return;
    const to = p.drag;
    p.drag = null;
    p.send({ kind: "seek", to, exact: true });
  }

  toggleFullscreen(): void {
    const host = this.env.host;
    const full = host.fullscreen();
    this.wasFull ??= full;
    host.setFullscreen(!full);
  }

  clickPicture(double: boolean): void {
    if (double) this.toggleFullscreen();
    else this.toggle();
  }

  takeKeys(pressed: Iterable<Key>): KeyResult {
    const keys = new Set(pressed);
    const previous = keys.has("pageUp");
    const next = keys.has("pageDown");
    const space = keys.has("space");
    const left = keys.has("left");
    const right = keys.has("right");
    const up = keys.has("up");
    const down = keys.has("down");
    const m = keys.has("m");
    const f = keys.has("f");
    const esc = keys.has("escape");
    if (!(space || left || right || up || down || m || f || esc)) return { previous, next, close: false };
    const p = this.player;
    if (p === null) return { previous, next, close: esc };
    p.moved = this.env.now();
    if (space) this.toggle();
    if (left) p.send({ kind: "nudge", by: -NUDGE });
    if (right) p.send({ kind: "nudge", by: NUDGE });
    if (up || down) this.changeVolume(p, up ? this.level + VOLUME_STEP : Math.max(this.level - VOLUME_STEP, 0));
    if (m) this.toggleMute();
    if (f) this.toggleFullscreen();
    // Esc leaves full screen first, then the viewer.
    const leave = esc && this.env.host.fullscreen();
    if (leave) this.toggleFullscreen();
    return { previous, next, close: esc && !leave };
  }

  private changeVolume(p: Player, percent: number): void {
    this.level = Math.min(percent, 100);
    this.levelChanged = true;
    p.send({ kind: "volume", percent: this.level });
    if (p.muted) {
      p.muted = false;
      p.send({ kind: "mute", on: false });
    }
  }

  private spawn(n: Next): void {
    const p = new Player(n.key, this.env, n.fetch, n.play);
    this.player = p;
    if (this.size[0] > 0) p.resize(this.size[0], this.size[1]);
  }

  private noMpv(p: Player, file: string): void {
    p.setStage({ kind: "noMpv", file });
    this.env.host.openExternally(file);
    this.env.host.toast(WARN_NO_MPV);
    p.markClosing();
    this.env.host.shut();
    this.reap(p);
  }

  private reap(p: Player): void {
    if (this.player !== p) {
      p.finish();
      return;
    }
    this.player = null;
    p.finish();
    const n = this.next;
    this.next = null;
    if (n) this.spawn(n);
  }
}

function playThrough(mpv: Mpv, path: string, limitMs = 60_000): { ok: true; seen: string } | { ok: false; why: string } {
  mpv.command("loadfile", path);
  const until = Date.now() + limitMs;
  let seen = "";
  while (Date.now() < until) {
    const e = mpv.waitEvent(1);
    if (e.kind === "playbackRestart") seen = `${mpv.property("video-codec")} (${mpv.property("dwidth")} wide), ${mpv.property("audio-codec")}`;
    else if (e.kind === "endFile") return e.reason === END_FILE_ERROR ? { ok: false, why: mpv.errorString(e.error) } : { ok: true, seen };
  }
  return { ok: false, why: "took too long" };
}

/** `harbor --check-video [file...]`: changes nothing, plays the files through without picture or sound. */
export function checkVideo(files: readonly string[], own: string | null = null, load: (own: string | null) => Engine = loadEngine): { code: number; lines: string[] } {
  const lines: string[] = [];
  let engine: Engine;
  try {
    engine = load(own);
  } catch {
    return { code: 1, lines: ["no video player: Harbor's own isn't installed and this system has no libmpv"] };
  }
  lines.push(engine.own ? `player: Harbor's own, ${engine.path} (audio: ${engine.own.ao}, VA-API: ${engine.own.va ? "yes" : "no"})` : "player: the system's libmpv");
  let mpv: Mpv;
  try {
    mpv = Mpv.create(engine.lib, coreOptions({ paused: false, volume: 0, blind: true, own: engine.own, log: logFile() }));
  } catch {
    return { code: 1, lines: [...lines, "it didn't start"] };
  }
  let code = 0;
  lines.push(`${mpv.property("mpv-version")}, ${mpv.property("ffmpeg-version")}`);
  for (const name of ["options/config", "options/load-scripts", "options/ytdl", "options/access-references", "options/input-default-bindings", "options/resume-playback"]) {
    const value = mpv.property(name);
    lines.push(`${name}=${value}`);
    // (A build without Lua has no ytdl option at all.)
    if (value !== "no" && value !== "") code = 1;
  }
  lines.push(`protocols: ${mpv.property("protocol-list")}`);
  const url = playThrough(mpv, "http://127.0.0.1:9/a.mp4");
  if (url.ok) {
    lines.push("a URL was played");
    code = 1;
  } else {
    lines.push(`a URL is refused: ${url.why}`);
  }
  for (const file of files) {
    const p = playable(file);
    const played = p.ok ? playThrough(mpv, p.file) : { ok: false as const, why: p.error };
    if (played.ok) {
      lines.push(`${file}: ${played.seen}`);
    } else {
      lines.push(`${file}: can't play it: ${played.why}`);
      code = 1;
    }
  }
  mpv.destroy();
  return { code, lines };
}
