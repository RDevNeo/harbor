import { rmSync } from "node:fs";
import type { Store } from "@harbor/store";
import * as dictate from "./dictate.ts";
import * as dictwords from "./dictwords.ts";
import * as parakeet from "./parakeet.ts";
import * as voice from "./voice.ts";
import { Fail, Recording } from "./voice.ts";

/** "Keep speech model loaded" choices: (minutes, label). */
export const KEEPS: readonly (readonly [number, string])[] = [
  [0, "Off"],
  [1, "1 min"],
  [5, "5 min"],
  [15, "15 min"],
  [60, "1 h"],
];

const ACCOUNT_EVERY_MS = 10_000;

export interface Host {
  store: Pick<Store, "get" | "set">;
  mesh: dictate.Mesh;
  /** Puts text into composer `key` at its cursor (voice.insertSpaced spaces it). */
  insert(key: number, text: string): void;
  toast(message: string): void;
  wake(): void;
  /** The Claude account the cleanup runs through, if one can be used now. */
  account(): dictate.Ask | null;
}

export interface Busy {
  key: number;
  since: number;
}

export class VoiceCtl {
  recording: { key: number; rec: Recording } | null = null;
  busy: Busy | null = null;
  send: number | null = null;
  dictEdit: number | null = null;
  dictTerm = "";
  dictSounds = "";
  private pending: { key: number; samples: Int16Array } | null = null;
  private accountAt = 0;

  constructor(private host: Host) {}

  load(): void {
    const { store } = this.host;
    voice.setConfig(store.get("voice_lang2") ?? "", store.get("voice_model") ?? "");
    const k = store.get("voice_keep_min");
    const keep = k !== null && /^\d+$/.test(k) ? Number(k) : 5;
    dictate.set({ engine: store.get("voice_engine") ?? "", cleanup: store.get("voice_cleanup") !== "0", keepMin: keep });
    let dict: dictwords.Entry[] = [];
    const raw = store.get("voice_dict");
    if (raw !== null) {
      try {
        dict = dictwords.parse(JSON.parse(raw));
      } catch {
        // an unreadable dictionary is an empty one
      }
    }
    dictate.setWords({ commands: store.get("voice_commands") !== "0", dict });
  }

  setWords(words: { commands?: boolean; dict?: dictwords.Entry[] }): void {
    const { store } = this.host;
    if (words.commands !== undefined) store.set("voice_commands", words.commands ? "1" : "0");
    if (words.dict !== undefined) store.set("voice_dict", JSON.stringify(dictwords.toJson(words.dict)));
    this.load();
  }

  set(pick: { lang?: string; model?: string }): void {
    const { store } = this.host;
    if (pick.lang !== undefined) store.set("voice_lang2", pick.lang);
    if (pick.model !== undefined) store.set("voice_model", pick.model);
    this.load();
  }

  setMore(pick: { engine?: string; cleanup?: boolean; keepMin?: number }): void {
    const { store } = this.host;
    if (pick.engine !== undefined) store.set("voice_engine", pick.engine);
    if (pick.cleanup !== undefined) store.set("voice_cleanup", pick.cleanup ? "1" : "0");
    if (pick.keepMin !== undefined) store.set("voice_keep_min", String(pick.keepMin));
    this.load();
  }

  recordingFor(key: number): { level: number; elapsedMs: number } | null {
    const r = this.recording;
    return r && r.key === key ? { level: r.rec.level(), elapsedMs: Date.now() - r.rec.started } : null;
  }

  busyFor(key: number): boolean {
    return this.busy?.key === key;
  }

  /** The speech model is still on its way for the recording waiting for it, or this PC can't transcribe yet. */
  waitingForModel(): boolean {
    return this.pending !== null || !dictate.readyHere();
  }

  takeSend(): number | null {
    const k = this.send;
    this.send = null;
    return k;
  }

  /** The mic button or its shortcut: starts recording into composer `key`, or stops and transcribes. */
  async toggle(key: number): Promise<void> {
    const cur = this.recording;
    if (cur) {
      this.recording = null;
      this.busy = { key: cur.key, since: Date.now() };
      const samples = await cur.rec.stop();
      this.transcribe(cur.key, samples);
      return;
    }
    if (this.busy) return;
    const why = voice.cantRecord();
    if (why) {
      this.host.toast(why);
      return;
    }
    // The model loads (or downloads, the first time) while the person speaks.
    if (dictate.engine() === "parakeet") {
      if (parakeet.installed()) parakeet.preload();
      else voice.startDownload("parakeet");
    } else if (voice.currentModel() === null) {
      voice.startDownload(voice.DEFAULT_MODEL);
    }
    try {
      this.recording = { key, rec: Recording.start(() => this.host.wake()) };
    } catch (e) {
      this.host.toast(`Couldn't record: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private transcribe(key: number, samples: Int16Array): void {
    const [lang] = voice.config();
    dictate.transcribe(this.host.mesh, samples, lang, { cleanup: dictate.cleanupOn(), commands: true, localOnly: false }).then(
      (d) => this.back(key, { text: d.text, send: d.send }),
      (e: unknown) => {
        if (e instanceof Fail && e.kind === "wait") {
          // The model is still on its way: transcribed once it's here (poll).
          this.pending = { key, samples };
          this.host.wake();
        } else {
          this.back(key, e instanceof Error ? e.message : String(e));
        }
      },
    );
  }

  private back(key: number, r: { text: string; send: boolean } | string): void {
    this.busy = null;
    if (typeof r === "string") {
      this.host.toast(r);
    } else {
      if (r.text.trim() !== "") this.host.insert(key, r.text);
      if (r.send) this.send = key;
      else if (r.text.trim() === "") this.host.toast("Didn't catch any words.");
    }
    this.host.wake();
  }

  /** Called every tick: long recordings stop, phones' setting changes are saved, a waiting recording is retried. */
  poll(): void {
    const { store } = this.host;
    if (this.recording?.rec.tooLong()) void this.toggle(this.recording.key);
    if (Date.now() - this.accountAt > ACCOUNT_EVERY_MS) {
      this.accountAt = Date.now();
      dictate.setAccount(this.host.account());
    }
    const dirty = dictate.takeDirty();
    if (dirty) {
      store.set("voice_cleanup", dirty.cleanup ? "1" : "0");
      store.set("voice_keep_min", String(dirty.keepMin));
      store.set("voice_commands", dirty.commands ? "1" : "0");
      store.set("voice_dict", JSON.stringify(dictwords.toJson(dirty.dict)));
    }
    const failed = voice.takeDownloadError();
    if (failed) {
      this.host.toast(`Couldn't download the ${voice.label(failed[0])} speech model: ${failed[1]}`);
      if (this.pending) {
        this.pending = null;
        this.busy = null;
      }
    }
    if (this.pending) {
      if (dictate.readyHere()) {
        const p = this.pending;
        this.pending = null;
        this.transcribe(p.key, p.samples);
      } else if (voice.downloading() === null) {
        voice.startDownload(dictate.engine() === "parakeet" ? "parakeet" : voice.DEFAULT_MODEL);
      }
    }
  }

  async parakeetAction(action: "download" | "remove"): Promise<void> {
    if (action === "download") voice.startDownload("parakeet");
    else await parakeet.remove();
  }

  modelAction(action: "download" | "use" | "remove", name: string): void {
    if (action === "download") {
      voice.startDownload(name);
      this.set({ model: name });
    } else if (action === "use") {
      this.set({ model: name });
    } else {
      rmSync(voice.modelDir(name), { recursive: true, force: true });
      if (voice.config()[1] === name) this.set({ model: "" });
    }
  }

  editEntry(i: number): void {
    const e = dictate.dictionary()[i];
    if (!e) return;
    this.dictEdit = i;
    this.dictTerm = e.term;
    this.dictSounds = e.sounds.join(", ");
  }

  saveEntry(): boolean {
    const term = this.dictTerm.trim();
    if (term === "") return false;
    const entry = {
      term,
      sounds: this.dictSounds
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== ""),
    };
    const dict = dictate.dictionary();
    const i = this.dictEdit;
    this.dictEdit = null;
    if (i !== null && i < dict.length) dict[i] = entry;
    else dict.push(entry);
    this.dictTerm = "";
    this.dictSounds = "";
    this.commit(dict);
    return true;
  }

  removeEntry(i: number): void {
    const dict = dictate.dictionary();
    dict.splice(i, 1);
    if (this.dictEdit === i) this.dictEdit = null;
    this.commit(dict);
  }

  private commit(dict: dictwords.Entry[]): void {
    this.setWords({ dict: dictwords.parse(dictwords.toJson(dict)) });
  }
}
