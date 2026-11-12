import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Store } from "@harbor/store";
import { LibmpvUnavailable } from "../src/libmpv.ts";
import * as v from "../src/video.ts";

const dirs: string[] = [];
const prevData = process.env.XDG_DATA_HOME;
const MP4 = Buffer.from("\0\0\0\x18ftypmp42\0\0\0\0", "latin1");

function tmp(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `hvideo-${name}-`));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  process.env.XDG_DATA_HOME = tmp("data");
});

afterEach(() => {
  if (prevData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = prevData;
});

afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("the_player_uses_only_what_the_system_has", () => {
  expect(v.audioOutputs(true, true, true)).toBe("pipewire,pulse,alsa,null");
  expect(v.audioOutputs(false, true, false)).toBe("pulse,null");
  expect(v.audioOutputs(false, false, false)).toBe("null");
  expect(v.versionOf("0.3.65")).toEqual([0, 3, 65]);
  const newer = v.versionOf("1.6.9");
  const older = v.versionOf("0.3.48");
  expect(newer !== null && v.versionAtLeast(newer, v.PIPEWIRE_MIN)).toBe(true);
  expect(older !== null && v.versionAtLeast(older, v.PIPEWIRE_MIN)).toBe(false);
  expect(v.versionOf("1.0")).toBeNull();
  expect(v.versionOf("1.x.3")).toBeNull();
});

test("the_clock_reads_like_a_player", () => {
  expect([v.clock(0), v.clock(9.9), v.clock(65), v.clock(3725), v.clock(-1), v.clock(Number.NaN)]).toEqual(["0:00", "0:09", "1:05", "1:02:05", "0:00", "0:00"]);
});

test("only_the_last_seek_of_a_drag_is_kept", () => {
  const q: v.Cmd[] = [];
  v.push(q, { kind: "seek", to: 1, exact: false });
  v.push(q, { kind: "pause", on: true });
  v.push(q, { kind: "seek", to: 2, exact: false });
  v.push(q, { kind: "seek", to: 3, exact: true });
  expect(q).toEqual([
    { kind: "pause", on: true },
    { kind: "seek", to: 3, exact: true },
  ]);
});

test("a_window_out_of_sight_pauses_a_playing_video_only", () => {
  expect(v.outOfSight(true, v.HIDDEN_MS + 1)).toBe(true);
  expect(v.outOfSight(true, v.HIDDEN_MS / 2)).toBe(false);
  expect(v.outOfSight(false, v.HIDDEN_MS * 10)).toBe(false);
});

test("the_player_reads_nothing_but_the_file", () => {
  for (const name of ["config", "load-scripts", "ytdl", "access-references", "ordered-chapters", "sub-auto", "audio-file-auto", "autoload-files", "resume-playback", "input-default-bindings"]) {
    expect(v.optionValue(name)).toBe("no");
  }
  expect(v.optionValue("vo")).toBe("libmpv");
});

test("plays_only_what_media_allows_as_an_absolute_path", () => {
  const d = tmp("playable");
  mkdirSync(join(d, ".ssh"));
  writeFileSync(join(d, "clip.mp4"), MP4);
  writeFileSync(join(d, "--script=x.mp4"), MP4);
  writeFileSync(join(d, ".ssh/key.mp4"), MP4);
  writeFileSync(join(d, "fake.mp4"), "not a video at all");
  writeFileSync(join(d, "pic.png"), Buffer.from("\x89PNG\r\n\x1a\n", "latin1"));
  const ok = v.playable(join(d, "clip.mp4"));
  expect(ok.ok && ok.file).toBe(realpathSync(join(d, "clip.mp4")));
  const odd = v.playable(join(d, "--script=x.mp4"));
  expect(odd.ok && isAbsolute(odd.file)).toBe(true);
  for (const bad of [join(d, ".ssh/key.mp4"), join(d, "fake.mp4"), join(d, "pic.png"), join(d, "missing.mp4"), "clip.mp4", "https://example.com/a.mp4"]) {
    expect(v.playable(bad).ok).toBe(false);
  }
});

test("a_video_of_another_pc_is_saved_here_before_it_plays", async () => {
  const key = `/home-pc/${process.pid}-run.mp4`;
  let asked = 0;
  const fetch = async (): Promise<Uint8Array | null> => {
    asked += 1;
    return MP4;
  };
  const got = await v.fileOf(key, fetch);
  expect(got.ok).toBe(true);
  if (!got.ok) return;
  expect(isAbsolute(got.file) && got.file.endsWith(".mp4")).toBe(true);
  expect(asked).toBe(1);
  rmSync(got.file);
  const off = await v.fileOf(key, async () => null);
  expect(!off.ok && off.error.includes("off")).toBe(true);
});

test("watched properties are mirrored, the position alone asks for no repaint", () => {
  const st = v.freshState(true);
  expect(v.changed(st, 0, { format: 5, value: 12.5 })).toBe(false);
  expect(st.pos).toBe(12.5);
  expect(v.changed(st, 1, { format: 5, value: 60 })).toBe(true);
  expect(v.changed(st, 2, { format: 3, value: false })).toBe(true);
  expect(st.paused).toBe(false);
  expect(v.changed(st, 3, { format: 3, value: true })).toBe(true);
  expect(st.ended).toBe(true);
  expect(v.changed(st, 4, { format: 4, value: 1920 })).toBe(true);
  expect(st.hasVideo).toBe(true);
  expect(v.changed(st, 4, { format: 0, value: null })).toBe(true);
  expect(st.hasVideo).toBe(false);
  expect(v.changed(st, 5, { format: 3, value: true })).toBe(true);
  expect(st.stopped).toBe(true);
  expect(v.changed(st, 101, { format: 1, value: "h264" })).toBe(false);
  expect(st.stats[1]).toBe("h264");
});

test("the picture's size and turn are mirrored: a quarter turn swaps its sides", () => {
  const st = v.freshState(false);
  v.changed(st, 4, { format: 4, value: 1920 });
  v.changed(st, 6, { format: 4, value: 1080 });
  expect(v.shownSize(st)).toEqual([1920, 1080]);
  v.changed(st, 7, { format: 4, value: 90 });
  expect(v.shownSize(st)).toEqual([1080, 1920]);
  v.changed(st, 7, { format: 4, value: -180 });
  expect(st.rotate).toBe(180);
  expect(v.shownSize(st)).toEqual([1920, 1080]);
  v.changed(st, 4, { format: 0, value: null });
  expect([st.hasVideo, st.width]).toEqual([false, 0]);
});

test("frames are drawn at the picture's size on screen, never above its own size or the pixel cap", () => {
  // A 1080p picture in a 1400x900 window: as wide as the window, its own aspect.
  expect(v.pictureSize([1400, 900], [1920, 1080])).toEqual([1400, 788]);
  // A tiny clip in a big window isn't blown up here: the window scales it.
  expect(v.pictureSize([1400, 900], [160, 90])).toEqual([160, 90]);
  // 4K on a 4K screen: capped at 1080p's pixels.
  expect(v.pictureSize([3840, 2160], [3840, 2160])).toEqual([1920, 1080]);
  // Portrait in a landscape window: the height decides.
  expect(v.pictureSize([1400, 900], [1080, 1920])).toEqual([506, 900]);
  // Nothing known yet: the area itself, within the cap.
  expect(v.pictureSize([800, 600], [0, 0])).toEqual([800, 600]);
  expect(v.pictureSize([0, 0], [1920, 1080])).toEqual([1, 1]);
});

test("frames get fewer pixels the more of them come each second", () => {
  expect(v.pixelBudget(60)).toBe(1280 * 720);
  expect(v.pixelBudget(30)).toBe(1280 * 720 * 2);
  expect(v.pixelBudget(0)).toBe(1280 * 720 * 2);
  expect(v.pixelBudget(10)).toBe(1920 * 1080);
  // 1080p60 in a 2560x1440 window: about 720p, its own aspect.
  expect(v.pictureSize([2560, 1440], [1920, 1080], v.pixelBudget(60))).toEqual([1280, 720]);
  const st = v.freshState(false);
  v.changed(st, 8, { format: 5, value: 59.94 });
  expect(st.fps).toBe(59.94);
});

test("a turned picture is drawn as the file stores it, sized for how it shows", () => {
  const st = { ...v.freshState(false), width: 640, height: 360, rotate: 270, fps: 30 };
  // Shown 360x640 in 1400x900: 360x640 fits; drawn 640x360, the window turns it.
  expect(v.drawSize([1400, 900], st)).toEqual([640, 360]);
  // In 300x300 it shows 169x300, so it is drawn 300x169 (296 wide: a multiple of 8).
  expect(v.drawSize([300, 300], st)).toEqual([296, 167]);
  expect(v.drawSize([300, 300], { ...st, rotate: 180 })).toEqual([296, 167]);
  // 4K at 30 fps in a 2560x1440 window: 1810x1018 by the budget, drawn 1808 wide.
  expect(v.drawSize([2560, 1440], { width: 3840, height: 2160, rotate: 0, fps: 30 })).toEqual([1808, 1017]);
  expect(v.coreOptions({ paused: false, volume: 100, blind: false, own: null, log: null })).toContainEqual(["video-rotate", "no"]);
});

test("the software scaler only shrinks, so it is a cheap one", () => {
  const o = v.coreOptions({ paused: false, volume: 100, blind: false, own: null, log: null });
  expect(o).toContainEqual(["sws-scaler", "bilinear"]);
});

test("the core's options follow the player and the mode", () => {
  const plain = v.coreOptions({ paused: true, volume: 40, blind: false, own: null, log: null });
  expect(plain.at(-2)).toEqual(["volume", "40"]);
  expect(plain.at(-1)).toEqual(["pause", "yes"]);
  const own = v.coreOptions({ paused: false, volume: 100, blind: false, own: { ao: "pulse,null", va: true }, log: "/x/log" });
  expect(own).toContainEqual(["ao", "pulse,null"]);
  expect(own).toContainEqual(["hwdec", "no"]);
  expect(own.at(-1)).toEqual(["log-file", "/x/log.mpv"]);
  const blind = v.coreOptions({ paused: false, volume: 0, blind: true, own: null, log: null });
  expect(blind).toContainEqual(["vo", "null"]);
  expect(blind).toContainEqual(["untimed", "yes"]);
});

interface Log {
  frames: v.Frame[];
  buffers: ArrayBufferLike[];
  repaints: number;
  external: string[];
  toasts: string[];
  shut: number;
  full: boolean;
  fullCalls: boolean[];
}

function host(): { log: Log; host: v.Host } {
  const log: Log = { frames: [], buffers: [], repaints: 0, external: [], toasts: [], shut: 0, full: false, fullCalls: [] };
  return {
    log,
    host: {
      repaint: () => void log.repaints++,
      frame: (f) => {
        log.frames.push({ width: f.width, height: f.height, data: f.data.slice() });
        log.buffers.push(f.data.buffer);
      },
      fullscreen: () => log.full,
      setFullscreen: (on) => {
        log.full = on;
        log.fullCalls.push(on);
      },
      openExternally: (f) => void log.external.push(f),
      toast: (m) => void log.toasts.push(m),
      shut: () => void log.shut++,
    },
  };
}

const waiting: v.PlayerSource = { library: () => null, coming: () => true, ask: () => {} };

async function until(what: string, ok: () => boolean, ms = 8000, tick?: () => void): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    tick?.();
    await Bun.sleep(10);
  }
}

function waitingViewer(): { viewer: v.Viewer; log: Log; clip: string } {
  const d = tmp("keys");
  const clip = join(d, "clip.mp4");
  writeFileSync(clip, MP4);
  const h = host();
  return { viewer: new v.Viewer({ host: h.host, source: waiting }), log: h.log, clip };
}

test("a video waits in the preparing stage until the player is here", async () => {
  const { viewer, clip } = waitingViewer();
  viewer.open(clip, undefined, true);
  expect(viewer.isOpen()).toBe(true);
  await until("preparing", () => viewer.snapshot()?.stage.kind === "preparing");
  viewer.shutdown();
  expect(viewer.snapshot()).toBeNull();
});

test("keys: space, arrows, m and f drive the player and the rest is left to the viewer", async () => {
  const { viewer, log, clip } = waitingViewer();
  viewer.open(clip, undefined, true);
  await until("preparing", () => viewer.snapshot()?.stage.kind === "preparing");
  expect(viewer.takeKeys(["pageUp"])).toEqual({ previous: true, next: false, close: false });
  expect(viewer.takeKeys(["pageDown"])).toEqual({ previous: false, next: true, close: false });
  expect(viewer.queued()).toEqual([]);
  viewer.takeKeys(["space", "left", "right"]);
  viewer.takeKeys(["up"]);
  viewer.takeKeys(["down", "down", "down"]);
  expect(viewer.queued()).toEqual([
    { kind: "pause", on: true },
    { kind: "nudge", by: -5 },
    { kind: "nudge", by: 5 },
    { kind: "volume", percent: 100 },
    { kind: "volume", percent: 95 },
  ]);
  expect(viewer.volume()).toBe(95);
  expect(viewer.takeVolume()).toBe(95);
  expect(viewer.takeVolume()).toBeNull();
  viewer.takeKeys(["m"]);
  expect(viewer.snapshot()?.muted).toBe(true);
  viewer.takeKeys(["up"]);
  expect(viewer.snapshot()?.muted).toBe(false);
  expect(viewer.queued().slice(-3)).toEqual([
    { kind: "mute", on: true },
    { kind: "volume", percent: 100 },
    { kind: "mute", on: false },
  ]);
  viewer.takeKeys(["f"]);
  expect(log.fullCalls).toEqual([true]);
  viewer.shutdown();
});

test("esc_closes_a_video_in_full_screen_too", async () => {
  const { viewer, log, clip } = waitingViewer();
  viewer.open(clip, undefined, true);
  await until("preparing", () => viewer.snapshot()?.stage.kind === "preparing");
  viewer.takeKeys(["f"]);
  expect(log.fullCalls).toEqual([true]);
  expect(viewer.takeKeys(["escape"])).toEqual({ previous: false, next: false, close: true });
  viewer.close();
  expect(log.fullCalls).toEqual([true, false]);
  viewer.shutdown();
});

test("a held seek bar sends coarse seeks and the exact one on release; an ended video plays again", async () => {
  const { viewer, clip } = waitingViewer();
  viewer.open(clip, undefined, true);
  await until("preparing", () => viewer.snapshot()?.stage.kind === "preparing");
  viewer.holdSeek(3);
  viewer.holdSeek(4);
  viewer.holdSeek(4);
  expect(viewer.snapshot()?.drag).toBe(4);
  expect(viewer.controlsVisible(false)).toBe(true);
  viewer.releaseSeek();
  expect(viewer.snapshot()?.drag).toBeNull();
  expect(viewer.queued()).toEqual([{ kind: "seek", to: 4, exact: true }]);
  viewer.toggle();
  expect(viewer.queued().at(-1)).toEqual({ kind: "pause", on: true });
  viewer.shutdown();
});

test("the volume is kept under video_volume", async () => {
  const store = Store.openTemp();
  try {
    const { viewer } = waitingViewer();
    expect(viewer.persistVolume(store)).toBe(false);
    store.set("video_volume", "35");
    viewer.restoreVolume(store);
    expect(viewer.volume()).toBe(35);
    store.set("video_volume", "250");
    viewer.restoreVolume(store);
    expect(viewer.volume()).toBe(100);
    store.set("video_volume", "loud");
    viewer.restoreVolume(store);
    expect(viewer.volume()).toBe(100);
    viewer.setVolume(20);
    expect(viewer.persistVolume(store)).toBe(false);
    const { viewer: v2, clip } = waitingViewer();
    v2.open(clip, undefined, true);
    await until("preparing", () => v2.snapshot()?.stage.kind === "preparing");
    v2.takeKeys(["down"]);
    expect(v2.persistVolume(store)).toBe(true);
    expect(store.get("video_volume")).toBe("95");
    v2.shutdown();
  } finally {
    store.close();
  }
});

test("without libmpv the file opens in the system's player", async () => {
  const d = tmp("nompv");
  const clip = join(d, "clip.mp4");
  writeFileSync(clip, MP4);
  const h = host();
  const viewer = new v.Viewer({
    host: h.host,
    loadEngine: () => {
      throw new LibmpvUnavailable(["libmpv.so.2"]);
    },
  });
  viewer.open(clip, undefined, true);
  await until("external", () => h.log.external.length > 0);
  expect(h.log.external[0]?.endsWith("clip.mp4")).toBe(true);
  expect(h.log.toasts).toEqual([v.WARN_NO_MPV]);
  expect(h.log.shut).toBe(1);
  expect(viewer.isOpen()).toBe(false);
});

test("a file that is not a video fails with a reason", async () => {
  const d = tmp("notvideo");
  const clip = join(d, "fake.mp4");
  writeFileSync(clip, "nothing");
  const h = host();
  const viewer = new v.Viewer({ host: h.host });
  viewer.open(clip, undefined, true);
  await until("failure", () => viewer.snapshot()?.stage.kind === "failed");
  const stage = viewer.snapshot()?.stage;
  expect(stage?.kind === "failed" && stage.why).toContain("contents");
  viewer.shutdown();
});

const live = { dir: "", clip: "", turned: "" };
// The tests below play a real clip: they need ffmpeg to make it and a libmpv to play it (Harbor's own
// or the system's libmpv.so.2). A machine without them (the release image, Ubuntu 22.04) skips them.
// Probed in another process: loading the player here would change what the tests above see.
const canPlay =
  Bun.which("ffmpeg") !== null &&
  Bun.spawnSync([process.execPath, "-e", `(await import(${JSON.stringify(join(import.meta.dir, "../src/video.ts"))})).loadEngine(null)`], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

async function ffmpeg(args: string[]): Promise<void> {
  const p = Bun.spawn(["ffmpeg", "-v", "error", "-y", ...args], { stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) throw new Error(`ffmpeg failed: ${await new Response(p.stderr).text()}`);
}

beforeAll(async () => {
  if (!canPlay) return;
  live.dir = tmp("live");
  live.clip = join(live.dir, "clip.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", live.clip]);
  live.turned = join(live.dir, "turned.mp4");
  await ffmpeg(["-display_rotation", "90", "-i", live.clip, "-c", "copy", live.turned]);
});

async function playing(clip = live.clip): Promise<{ viewer: v.Viewer; log: Log }> {
  const h = host();
  const viewer = new v.Viewer({ host: h.host });
  viewer.resize(320, 240);
  viewer.open(clip, undefined, true);
  await until("frames", () => h.log.frames.length >= 3, 10_000, () => viewer.seen());
  return { viewer, log: h.log };
}

test.skipIf(!canPlay)("libmpv draws frames into RGBA buffers: size, opaque picture, moving content", async () => {
  const { viewer, log } = await playing();
  const first = log.frames[0]!;
  expect([first.width, first.height]).toEqual([320, 240]);
  expect(first.data.length).toBe(320 * 240 * 4);
  const mid = (160 + 120 * 320) * 4;
  expect(first.data[mid + 3]).toBe(255);
  const last = log.frames.at(-1)!;
  expect(Buffer.compare(Buffer.from(first.data), Buffer.from(last.data))).not.toBe(0);
  // Drawn on the renderer's thread into two buffers that are used again: no frame allocates.
  const homes = new Set(log.buffers);
  expect(homes.size).toBeLessThanOrEqual(2);
  const snap = viewer.snapshot();
  expect(snap?.picture).toBe(true);
  expect(snap?.dur).toBeGreaterThan(1.5);
  viewer.shutdown();
});

test.skipIf(!canPlay)("frames follow the picture's room on screen, never above its own size", async () => {
  const { viewer, log } = await playing();
  viewer.resize(1280, 1000);
  await Bun.sleep(150);
  const n = log.frames.length;
  await until("more frames", () => log.frames.length > n + 2, 5000, () => viewer.seen());
  expect([log.frames.at(-1)!.width, log.frames.at(-1)!.height]).toEqual([320, 240]);
  viewer.resize(200, 100);
  // 133x100 fits; drawn 128 wide (a multiple of 8).
  await until("smaller frames", () => log.frames.at(-1)!.width === 128, 5000, () => viewer.seen());
  expect(log.frames.at(-1)!.height).toBe(96);
  expect(log.frames.at(-1)!.data.length).toBe(128 * 96 * 4);
  viewer.shutdown();
});

test.skipIf(!canPlay)("a turned video is drawn in the file's orientation and the window is told the turn", async () => {
  const { viewer, log } = await playing(live.turned);
  // Shown 240x320 in 320x240: 180x240 on screen, drawn 240x180.
  await until("sized frames", () => log.frames.at(-1)!.width === 240, 5000, () => viewer.seen());
  expect(log.frames.at(-1)!.height).toBe(180);
  expect((viewer.snapshot()?.rotate ?? 0) % 180).toBe(90);
  viewer.shutdown();
});

test.skipIf(!canPlay)("pause, seek, mute and volume reach the core and its position", async () => {
  const { viewer } = await playing();
  viewer.toggle();
  await until("paused", () => viewer.snapshot()?.paused === true);
  const at = viewer.snapshot()!.pos;
  await Bun.sleep(300);
  expect(viewer.snapshot()!.pos).toBe(at);
  viewer.holdSeek(1.5);
  viewer.releaseSeek();
  await until("seek", () => Math.abs(viewer.snapshot()!.pos - 1.5) < 0.2, 5000, () => viewer.seen());
  viewer.takeKeys(["left"]);
  await until("nudge back past the start", () => viewer.snapshot()!.pos < 0.2, 5000, () => viewer.seen());
  viewer.takeKeys(["m", "down"]);
  expect(viewer.volume()).toBe(95);
  viewer.shutdown();
});

test.skipIf(!canPlay)("a video that reaches its end stays on the last frame, and Space plays it again", async () => {
  const { viewer } = await playing();
  await until("end", () => viewer.snapshot()?.ended === true, 10_000, () => viewer.seen());
  expect(viewer.snapshot()?.picture).toBe(true);
  viewer.toggle();
  await until("restart", () => viewer.snapshot()?.ended === false && viewer.snapshot()!.pos < 1, 5000, () => viewer.seen());
  viewer.shutdown();
});

test.skipIf(!canPlay)("a window out of sight pauses the video by itself", async () => {
  const h = host();
  let t = 0;
  const viewer = new v.Viewer({ host: h.host, now: () => t });
  viewer.resize(320, 240);
  viewer.open(live.clip, undefined, true);
  await until("playing", () => viewer.snapshot()?.stage.kind === "playing", 10_000);
  t += v.HIDDEN_MS + 100;
  viewer.toggleMute();
  await until("auto pause", () => viewer.snapshot()?.paused === true, 5000);
  viewer.shutdown();
});

test.skipIf(!canPlay)("closing lets go of the video and opening another one starts after it", async () => {
  const { viewer } = await playing();
  const other = join(live.dir, "other.mp4");
  writeFileSync(other, readFileSync(live.clip));
  viewer.open(other, undefined, false);
  expect(viewer.isOpen()).toBe(true);
  await until("second video", () => viewer.snapshot()?.key === other && viewer.snapshot()?.stage.kind === "playing", 10_000);
  expect(viewer.snapshot()?.paused).toBe(true);
  viewer.close();
  expect(viewer.isOpen()).toBe(false);
  await until("closed", () => viewer.snapshot() === null, 5000);
  viewer.shutdown();
});

test.skipIf(!canPlay)("a file mpv can not decode ends in the failed stage", async () => {
  const bad = join(live.dir, "bad.mp4");
  writeFileSync(bad, Buffer.concat([MP4, Buffer.alloc(2000, 7)]));
  const h = host();
  const viewer = new v.Viewer({ host: h.host });
  viewer.open(bad, undefined, true);
  await until("failure", () => viewer.snapshot()?.stage.kind === "failed", 10_000, () => viewer.seen());
  viewer.shutdown();
});

test.skipIf(!canPlay)("--check-video loads the player, checks it is locked down and plays files through", () => {
  const out = v.checkVideo([live.clip, join(live.dir, "missing.mp4")]);
  expect(out.lines[0]).toBe("player: the system's libmpv");
  expect(out.lines).toContain("options/config=no");
  expect(out.lines.some((l) => l.startsWith("a URL is refused"))).toBe(true);
  expect(out.lines.some((l) => l.startsWith(`${live.clip}: H.264`))).toBe(true);
  expect(out.lines.some((l) => l.includes("missing.mp4: can't play it"))).toBe(true);
  expect(out.code).toBe(1);
  expect(existsSync(live.clip)).toBe(true);
});

test("--check-video says so when there is no libmpv", () => {
  const out = v.checkVideo([], null, () => {
    throw new LibmpvUnavailable(["libmpv.so.2"]);
  });
  expect(out.code).toBe(1);
  expect(out.lines[0]).toContain("no video player");
});
