// Voice messages and audio files in a person's chat: played natively on this PC (@harbor/os audio.play: ffmpeg into
// PipeWire / PulseAudio / ALSA, else mpv or ffplay), one at a time, from any position and at 1x / 1.5x / 2x; marked
// played; bars measured from the samples when the platform sent no waveform; transcribed once with Hub's local
// speech to text (the composer mic's, injected) and the text kept. What is known per attachment lives in
// <persons dir>/audio.json, keyed "<connection>:<message id>:<attachment index>"; the decrypted files themselves are
// the connections' own caches (WhatsApp: files/, Discord: its attachment cache).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { audio as osAudio } from "@harbor/os";
import { writeAtomic } from "./store.ts";

/** An attachment's key in audio.json and in the API (`files[].audio`). */
export const audioKey = (connId: string, messageId: string, index: number): string => `${connId}:${messageId}:${index}`;

export interface AudioMeta {
  duration?: number;
  /** Peaks 0..1 (BARS of them), measured from the file. */
  bars?: number[];
  /** When it was first played here. */
  played?: string;
  transcript?: string;
  /** The last time making its transcript failed (the file couldn't be fetched, speech to text failed), and how often. */
  failed?: string;
  attempts?: number;
}

/** Bars a bubble draws. */
export const BARS = 40;
/** Samples per second when measuring bars. */
const BAR_RATE = 8000;
/** Speech to text takes 16 kHz mono (Hub's dictation). */
export const STT_RATE = 16_000;
/** Longest audio transcribed (Parakeet's worker takes 20 minutes). */
export const STT_MAX_SECS = 1200;

/**
 * A platform waveform (base64 bytes: Discord 0–255, WhatsApp 0–100) as BARS values 0..1, scaled to its loudest
 * byte so both look alike. Null when there is none.
 */
export function waveBars(b64: string | undefined, n = BARS): number[] | null {
  if (!b64) return null;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(b64, "base64"));
  } catch {
    return null;
  }
  if (!bytes.length) return null;
  const top = Math.max(1, ...bytes);
  return Array.from({ length: n }, (_, i) => {
    const a = Math.floor((i * bytes.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * bytes.length) / n));
    let peak = 0;
    for (let j = a; j < b && j < bytes.length; j++) peak = Math.max(peak, bytes[j]!);
    return Math.round((peak / top) * 100) / 100;
  });
}

/** Bars from samples: each slice's peak, scaled to the loudest slice (a quiet recording still shows its shape). */
export function sampleBars(samples: Int16Array, n = BARS): number[] {
  if (!samples.length) return Array.from({ length: n }, () => 0);
  const peaks = Array.from({ length: n }, (_, i) => {
    const a = Math.floor((i * samples.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * samples.length) / n));
    let sum = 0;
    for (let j = a; j < b && j < samples.length; j++) sum += Math.abs(samples[j]!);
    return sum / (b - a);
  });
  const top = Math.max(1, ...peaks);
  return peaks.map((p) => Math.round((p / top) * 100) / 100);
}

/** What the player is doing, as the API shows it. `pos` was the position at `at` (ms); it moves `speed` s per second while playing. */
export interface PlayState {
  key: string | null;
  playing: boolean;
  pos: number;
  speed: number;
  duration: number | null;
  at: number;
  error: string | null;
}

export interface AudioDeps {
  dir: string;
  /** The PC's speech to text (16 kHz mono samples → text); missing: no Transcribe. */
  transcribe?: (samples: Int16Array) => Promise<string>;
  /** Something changed that the window or the phone shows (playback ended, a transcript). */
  changed: () => void;
  log?: (...a: unknown[]) => void;
  /** Tests: the OS calls. */
  os?: { play: typeof osAudio.play; decode: (file: string, rate: number, maxSecs?: number, low?: boolean) => Promise<Int16Array | null>; player: typeof osAudio.player };
  now?: () => number;
}

export class AudioService {
  private file: string;
  private metas: Record<string, AudioMeta> = {};
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private playing: osAudio.Playing | null = null;
  private st: PlayState = { key: null, playing: false, pos: 0, speed: 1, duration: null, at: 0, error: null };
  private transcribing = new Map<string, Promise<string>>();
  private os: NonNullable<AudioDeps["os"]>;
  private now: () => number;

  constructor(private readonly d: AudioDeps) {
    this.file = join(d.dir, "audio.json");
    this.os = d.os ?? osAudio;
    this.now = d.now ?? Date.now;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { items?: Record<string, AudioMeta> };
      if (raw.items && typeof raw.items === "object") this.metas = raw.items;
    } catch {
      this.metas = {};
    }
  }

  meta(key: string): AudioMeta | undefined {
    return this.metas[key];
  }

  /** Whether this PC can play audio at all (the bubble says so otherwise). */
  canPlay(): boolean {
    return this.os.player() !== null;
  }

  private set(key: string, patch: Partial<AudioMeta>): void {
    this.metas[key] = { ...this.metas[key], ...patch };
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 500);
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      writeAtomic(this.file, `${JSON.stringify({ version: 1, items: this.metas })}\n`);
    } catch (e) {
      this.d.log?.("audio.json not saved", e instanceof Error ? e.message : String(e));
    }
  }

  /** The player now, its position brought up to date. */
  state(): PlayState {
    const s = { ...this.st };
    if (s.playing) {
      s.pos = this.posNow();
      s.at = this.now();
    }
    return s;
  }

  private posNow(): number {
    const s = this.st;
    if (!s.playing) return s.pos;
    const p = s.pos + ((this.now() - s.at) / 1000) * s.speed;
    return s.duration ? Math.min(p, s.duration) : p;
  }

  markPlayed(key: string): void {
    if (!this.metas[key]?.played) {
      this.set(key, { played: new Date(this.now()).toISOString() });
      this.d.changed();
    }
  }

  /**
   * Plays `file` (the attachment `key`) from `at` seconds (null: where it was paused, or the start) at `speed`
   * (null: the current speed). Whatever was playing stops first. Marks it played; measures its bars and length the
   * first time.
   */
  async play(key: string, file: string, at: number | null, speed: number | null, duration: number | null): Promise<PlayState> {
    const same = this.st.key === key;
    const from = at ?? (same ? this.posNow() : 0);
    const sp = speed ?? this.st.speed;
    this.stopPlayer();
    let dur = duration ?? this.metas[key]?.duration ?? null;
    if (!this.metas[key]?.bars || !dur) {
      const samples = await this.os.decode(file, BAR_RATE).catch(() => null);
      if (samples) {
        dur = samples.length / BAR_RATE;
        this.set(key, { bars: sampleBars(samples), duration: Math.round(dur * 100) / 100 });
      }
    }
    const start = dur && from >= dur - 0.05 ? 0 : Math.max(0, from);
    this.st = { key, playing: true, pos: start, speed: sp, duration: dur, at: this.now(), error: null };
    const handle = this.os.play(file, start, sp, (error) => {
      if (this.playing !== handle) return;
      this.playing = null;
      // the end (or a failure): back to the start, paused
      this.st = { ...this.st, playing: false, pos: error ? this.posNow() : 0, at: this.now(), error: error ?? null };
      if (error) this.d.log?.("audio playback failed", error);
      this.d.changed();
    });
    if (!handle) {
      this.st = { ...this.st, playing: false, error: "No audio player on this PC (install ffmpeg, or mpv)" };
      return this.state();
    }
    this.playing = handle;
    this.markPlayed(key);
    this.d.changed();
    return this.state();
  }

  private stopPlayer(): void {
    const p = this.playing;
    this.playing = null;
    p?.stop();
  }

  pause(): PlayState {
    if (this.st.playing) {
      const pos = this.posNow();
      this.stopPlayer();
      this.st = { ...this.st, playing: false, pos, at: this.now() };
      this.d.changed();
    }
    return this.state();
  }

  /** Moves a paused one (or the next play) to `pos` seconds. */
  seek(key: string, pos: number, duration: number | null): PlayState {
    if (this.st.key !== key) this.st = { key, playing: false, pos: 0, speed: this.st.speed, duration, at: this.now(), error: null };
    this.st = { ...this.st, pos: Math.max(0, pos), at: this.now() };
    return this.state();
  }

  /** Stops (another chat opened, the chat closed, Hub quitting). */
  stop(): PlayState {
    const was = this.st.key;
    this.stopPlayer();
    this.st = { key: null, playing: false, pos: 0, speed: this.st.speed, duration: null, at: this.now(), error: null };
    if (was) this.d.changed();
    return this.state();
  }

  /** The speed for the next play (and the one playing: it goes on from where it is). */
  setSpeed(speed: number): PlayState {
    this.st = { ...this.st, speed };
    return this.state();
  }

  canTranscribe(): boolean {
    return !!this.d.transcribe;
  }

  /** The text of an audio attachment (cached once made; a second ask waits for the first). */
  /** Making its transcript failed: remembered, so the background queue doesn't try again at once (Transcribe still can). */
  markFailed(key: string): void {
    const m = this.metas[key];
    this.set(key, { failed: new Date(this.now()).toISOString(), attempts: (m?.attempts ?? 0) + 1 });
    this.d.changed();
  }

  /** `low`: the background queue's (ffmpeg at low CPU priority). */
  async transcribe(key: string, file: string, low = false): Promise<string> {
    const had = this.metas[key]?.transcript;
    if (had !== undefined) return had;
    const busy = this.transcribing.get(key);
    if (busy) return busy;
    const stt = this.d.transcribe;
    if (!stt) throw new Error("Speech to text isn't set up on this PC (Settings › Voice)");
    const run = (async () => {
      try {
        const samples = await this.os.decode(file, STT_RATE, STT_MAX_SECS, low);
        if (!samples) throw new Error("ffmpeg is needed to read audio files");
        const text = samples.length < STT_RATE / 4 ? "" : (await stt(samples)).trim();
        this.set(key, { transcript: text });
        this.d.changed();
        return text;
      } catch (e) {
        // the speech model still on its way (dictate's Fail "wait") isn't this audio's failure
        if ((e as { kind?: string } | null)?.kind !== "wait") this.markFailed(key);
        throw e;
      }
    })();
    this.transcribing.set(key, run);
    try {
      return await run;
    } finally {
      this.transcribing.delete(key);
    }
  }

  isTranscribing(key: string): boolean {
    return this.transcribing.has(key);
  }

  close(): void {
    this.stopPlayer();
    if (this.saveTimer) this.flush();
  }
}
