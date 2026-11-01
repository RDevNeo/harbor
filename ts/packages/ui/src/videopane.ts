import { existsSync } from "node:fs";
import type { AppWindow, VideoData } from "./window.ts";
import { noPixels } from "./window.ts";

type MediaPkg = typeof import("@harbor/media");
type Images = import("@harbor/media").images.Images;
type Viewer = import("@harbor/media").video.Viewer;
type VideoKey = import("@harbor/media").video.Key;
type PlayerSource = import("@harbor/media").video.PlayerSource;

const TICK_MS = 250;

export const VIDEO_KEYS: Readonly<Record<string, VideoKey>> = {
  " ": "space",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  m: "m",
  M: "m",
  f: "f",
  F: "f",
  Escape: "escape",
  "\u{f72c}": "pageUp",
  "\u{f72d}": "pageDown",
};

export interface VideoPaneDeps {
  win: AppWindow;
  pkg: MediaPkg;
  images: Images;
  store: { get(k: string): string | null; set(k: string, v: string): void };
  toast: (m: string) => void;
  open: (file: string) => void;
  source?: PlayerSource;
}

/** The lightbox's video (images.rs `lightbox` with video.rs): the picture, its poster until then, and the controls. */
export class VideoPane {
  readonly viewer: Viewer;
  private overBar = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private size: readonly [number, number] = [0, 0];

  constructor(private readonly d: VideoPaneDeps) {
    const w = d.win;
    this.viewer = new d.pkg.video.Viewer({
      host: {
        repaint: () => this.refresh(),
        frame: (f) => {
          w.vid_frame = { width: f.width, height: f.height, data: new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength) };
          if (!w.vid_data.has_frame) this.refresh();
        },
        fullscreen: () => w.window.fullscreen,
        setFullscreen: (on) => {
          w.window.fullscreen = on;
        },
        openExternally: (file) => d.open(file),
        toast: (m) => d.toast(m),
        shut: () => d.images.close(),
      },
      ...(d.source ? { source: d.source } : {}),
    });
    this.viewer.restoreVolume(d.store);
    d.images.setVideo(this.viewer);
    w.vid_toggle = () => this.act(() => this.viewer.toggle());
    w.vid_fullscreen = () => this.act(() => this.viewer.toggleFullscreen());
    w.vid_mute = () => this.act(() => this.viewer.toggleMute());
    w.vid_volume = (v) => this.act(() => this.viewer.holdVolume(v * 100));
    w.vid_seek = (at) => this.act(() => {
      const dur = this.viewer.snapshot()?.dur ?? 0;
      if (dur > 0) this.viewer.holdSeek(at * dur);
    });
    w.vid_release_seek = () => this.act(() => this.viewer.releaseSeek());
    w.vid_moved = () => {
      this.viewer.pointerMoved();
      if (!w.vid_data.show) this.refresh();
    };
    w.vid_over_bar = (over) => {
      this.overBar = over;
      this.refresh();
    };
    w.vid_open_external = () => {
      const key = this.viewer.snapshot()?.key;
      if (key) d.open(d.pkg.media.located(key));
    };
  }

  isOpen(): boolean {
    return this.d.win.vid_open;
  }

  /** The lightbox now shows `key` when it is a video, or nothing of the viewer. */
  show(video: boolean): void {
    const w = this.d.win;
    if (!video) {
      if (w.vid_open) {
        w.vid_open = false;
        w.vid_frame = noPixels;
        this.stopTimer();
        this.viewer.persistVolume(this.d.store);
      }
      return;
    }
    if (!w.vid_open) {
      w.vid_open = true;
      this.overBar = false;
      this.timer = setInterval(() => this.refresh(), TICK_MS);
    }
    this.refresh();
  }

  /** A key while the viewer shows: what's left for the lightbox (previous, next, close). */
  key(text: string): { taken: boolean; previous: boolean; next: boolean; close: boolean } {
    const k = VIDEO_KEYS[text];
    if (k === undefined) return { taken: false, previous: false, next: false, close: false };
    const r = this.viewer.takeKeys([k]);
    this.refresh();
    return { taken: true, ...r };
  }

  shutdown(): void {
    this.stopTimer();
    this.viewer.persistVolume(this.d.store);
    this.viewer.shutdown();
  }

  private act(f: () => void): void {
    f();
    this.refresh();
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private refresh(): void {
    const w = this.d.win;
    if (!w.vid_open) return;
    const size = w.window.physicalSize;
    if (size.width !== this.size[0] || size.height !== this.size[1]) {
      this.size = [size.width, size.height];
      this.viewer.resize(size.width, size.height);
    }
    const s = this.viewer.snapshot();
    if (w.window.visible && !w.window.minimized) this.viewer.seen();
    this.viewer.persistVolume(this.d.store);
    const view = this.d.images.view();
    const full = view?.full?.state === "ready" ? view.full : null;
    const small = view?.small?.state === "ready" ? view.small : null;
    const poster = full ?? small;
    const clock = this.d.pkg.video.clock;
    const shown = s === null ? 0 : (s.drag ?? s.pos);
    const stage = s === null ? "starting" : s.stage.kind;
    const key = s?.key ?? view?.key ?? "";
    const data: VideoData = {
      has_frame: s?.picture ?? false,
      poster: poster ? poster.image : noPixels,
      poster_w: poster ? poster.dims[0] : 0,
      poster_h: poster ? poster.dims[1] : 0,
      stage: stage === "noMpv" ? "starting" : stage,
      why: s?.stage.kind === "failed" ? s.stage.why : "",
      can_open: s?.stage.kind === "failed" && key !== "" && existsSync(this.d.pkg.media.located(key)),
      started: s?.started ?? false,
      paused: s?.paused ?? false,
      ended: s?.ended ?? false,
      silent: s === null || s.muted || s.volume === 0,
      volume: s === null || s.muted ? 0 : s.volume / 100,
      at: s !== null && s.dur > 0 ? shown / s.dur : 0,
      has_dur: s !== null && s.dur > 0,
      clock: s === null ? "" : `${clock(shown)} / ${clock(s.dur)}`,
      show: this.viewer.controlsVisible(this.overBar),
      full: w.window.fullscreen,
      path: key.startsWith("/"),
      name: this.d.pkg.images.imageName(key),
      index: view?.index ?? 0,
      count: view?.gallery.length ?? 1,
    };
    w.vid_data = data;
  }
}
