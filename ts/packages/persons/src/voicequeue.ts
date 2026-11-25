// Voice messages transcribed in the background, so the person's AI knows what was said (ai.ts aiContext) and the
// bubble shows the text without a click: their incoming voice messages and audio files (WhatsApp, Discord, email) of
// the last weeks, newest first, one at a time with a pause between them, ffmpeg at low priority; each transcript kept
// in audio.json by connection, message id and attachment (audio.ts). One that failed waits a day (three tries at
// most); the bubble's Transcribe still asks again at once.
import { attachmentKind } from "./model/conversation.ts";
import type { Message } from "./model/types.ts";
import { audioKey, type AudioMeta, type AudioService } from "./audio.ts";

export interface VoiceJob {
  key: string;
  connId: string;
  url: string;
  name: string;
  at: string;
}

/** Only messages this recent are transcribed by themselves (older ones on a click). */
export const MAX_AGE_MS = 30 * 24 * 3600_000;
/** A failed one is tried again after this long, at most this often. */
export const RETRY_MS = 24 * 3600_000;
export const MAX_ATTEMPTS = 3;

/** An attachment of `m` the queue (and the AI context) treats as speech. */
export const isAudio = (m: Pick<Message, "voice">, a: { name: string; type?: string }): boolean => attachmentKind(a as never, m.voice) === "audio";

/** What still needs a transcript in these chats: their audio, recent, not done, not failed lately; newest first. */
export function voiceJobs(chats: { connId: string; messages: readonly Message[] }[], meta: (key: string) => AudioMeta | undefined, now = Date.now(), maxAgeMs = MAX_AGE_MS): VoiceJob[] {
  const out: VoiceJob[] = [];
  for (const c of chats) {
    for (const m of c.messages) {
      if (m.fromMe) continue;
      const t = Date.parse(m.timestamp);
      if (!Number.isFinite(t) || now - t > maxAgeMs) continue;
      (m.attachments ?? []).forEach((a, i) => {
        if (!isAudio(m, a)) return;
        const key = audioKey(c.connId, m.id, i);
        const x = meta(key);
        if (x?.transcript !== undefined) return;
        if (x?.failed && ((x.attempts ?? 1) >= MAX_ATTEMPTS || now - Date.parse(x.failed) < RETRY_MS)) return;
        out.push({ key, connId: c.connId, url: a.url, name: a.name, at: m.timestamp });
      });
    }
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export interface VoiceQueueDeps {
  audio: Pick<AudioService, "meta" | "transcribe" | "markFailed" | "canTranscribe">;
  /** Every chat the engine holds now (connection id and its messages). */
  chats: () => { connId: string; messages: readonly Message[] }[];
  /** The attachment on disk (downloaded and decrypted by its connection), or null. */
  fetch: (url: string, name: string, connId: string) => Promise<string | null>;
  log?: (...a: unknown[]) => void;
  /** Pause between two (ms); the first waits `startMs` after the first kick. */
  gapMs?: number;
  startMs?: number;
  now?: () => number;
}

export class VoiceQueue {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private started = false;
  /** The one being transcribed now (its bubble says so). */
  current: string | null = null;

  constructor(private readonly d: VoiceQueueDeps) {}

  /** Something changed (new messages): look for work soon. */
  kick(): void {
    if (this.stopped || this.running || this.timer || !this.d.audio.canTranscribe()) return;
    const wait = this.started ? this.d.gapMs ?? 3000 : this.d.startMs ?? 30_000;
    this.started = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, wait);
  }

  /** Transcribes what is waiting, one at a time, until nothing is (or it's stopped). Returns how many it did. */
  async run(): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    let n = 0;
    try {
      for (;;) {
        if (this.stopped) break;
        const job = voiceJobs(this.d.chats(), (k) => this.d.audio.meta(k), this.d.now?.() ?? Date.now())[0];
        if (!job) break;
        this.current = job.key;
        try {
          const file = await this.d.fetch(job.url, job.name, job.connId).catch(() => null);
          if (!file) this.d.audio.markFailed(job.key);
          else {
            await this.d.audio.transcribe(job.key, file, true);
            n++;
          }
        } catch (e) {
          // the speech model is still downloading: try again in a minute (not a failure of this one)
          if ((e as { kind?: string } | null)?.kind === "wait") {
            this.current = null;
            this.later(60_000);
            break;
          }
          // remembered as failed by transcribe
          this.d.log?.("voice transcript failed", e instanceof Error ? e.message : String(e));
        } finally {
          this.current = null;
        }
        const gap = this.d.gapMs ?? 3000;
        if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      }
    } finally {
      this.running = false;
    }
    return n;
  }

  private later(ms: number): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, ms);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
