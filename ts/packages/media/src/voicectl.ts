import { rmSync } from "node:fs";
import type { Store } from "@harbor/store";
import * as dictate from "./dictate.ts";
import * as dictwords from "./dictwords.ts";
import * as parakeet from "./parakeet.ts";
import * as voice from "./voice.ts";
import { Fail, Recording } from "./voice.ts";

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
  inputs: voice.InputDevice[] = [{ id: "", label: "System default" }];
  micTesting = false;
  micLevel = 0;
  micStatus = "";
  private pending: { key: number; samples: Int16Array } | null = null;
  private accountAt = 0;

  constructor(private host: Host) {}

  load(): void {
    const { store } = this.host;
    voice.setConfig("auto", store.get("voice_model") ?? "");
    voice.setInputDevice(store.get("voice_input") ?? "");
    dictate.loadFrom(store);
    let dict: dictwords.Entry[] = [];
    const raw = store.get("voice_dict");
    if (raw !== null) {
      try {
        dict = dictwords.parse(JSON.parse(raw));
      } catch {
        // an unreadable dictionary is an empty one
      }
    }
    dictate.setWords({ commands: true, dict });
  }

  setWords(words: { commands?: boolean; dict?: dictwords.Entry[] }): void {
    const { store } = this.host;
    if (words.dict !== undefined) store.set("voice_dict", JSON.stringify(dictwords.toJson(words.dict)));
    this.load();
  }

  set(pick: { lang?: string; model?: string }): void {
    const { store } = this.host;
    if (pick.model !== undefined) store.set("voice_model", pick.model);
    this.load();
  }

  setMore(pick: { engine?: string; cleanup?: boolean; keepMin?: number }): void {
    if (pick.cleanup !== undefined) this.host.store.set(dictate.CLEANUP_KEY, pick.cleanup ? "1" : "0");
    this.load();
  }

  /** The PCs "Transcribe on" can pick, Automatic first: [mesh id ("" = automatic), label]. A saved PC the mesh no longer knows stays listed. */
  hosts(): [string, string][] {
    const { mesh } = this.host;
    const me = mesh.me();
    const all = (mesh.known ? mesh.known() : mesh.peers()).filter((p) => p.id !== "" && p.id !== me.id);
    const out: [string, string][] = [["", "Automatic"]];
    if (me.id !== undefined && me.id !== "") out.push([me.id, `${me.name === "" ? "This PC" : me.name} (this PC)`]);
    for (const p of [...all].sort((a, b) => a.name.localeCompare(b.name))) out.push([p.id, p.online ? p.name : `${p.name} (offline)`]);
    const saved = dictate.host();
    if (saved !== "" && !out.some(([id]) => id === saved)) out.push([saved, "Saved PC (unknown)"]);
    return out;
  }

  selectHost(index: number): void {
    const h = this.hosts()[index];
    if (!h) return;
    this.host.store.set(dictate.HOST_KEY, h[0]);
    dictate.setHost(h[0]);
  }

  async refreshInputs(): Promise<void> {
    this.inputs = await voice.inputDevices();
    const id = voice.currentInputDevice();
    if (id && !this.inputs.some((d) => d.id === id)) this.inputs.push({ id, label: "Saved microphone (unavailable)" });
  }

  selectInput(index: number): void {
    const device = this.inputs[index];
    if (!device || this.micTesting) return;
    this.host.store.set("voice_input", device.id);
    voice.setInputDevice(device.id);
    this.micStatus = "";
  }

  /** Tests the selected input for three seconds without downloading a model or entering a composer. */
  async testMicrophone(changed: () => void): Promise<void> {
    if (this.micTesting || this.recording || this.busy) return;
    this.micTesting = true; this.micLevel = 0; this.micStatus = "Speak for 3 seconds…";
    changed();
    let rec: Recording | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let peak = 0;
    try {
      rec = Recording.start(() => { peak = Math.max(peak, rec?.level() ?? 0); });
      timer = setInterval(() => { this.micLevel = Math.min(1, (rec?.level() ?? 0) * 8); changed(); }, 100);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const samples = await rec.stop(); rec = null;
      this.micLevel = Math.min(1, peak * 8);
      this.micStatus = micVerdict(samples);
    } catch (e) { this.micStatus = e instanceof Error ? e.message : String(e); }
    finally { clearInterval(timer); rec?.cancel(); this.micTesting = false; changed(); }
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
    if (this.busy || this.micTesting) return;
    const why = voice.cantRecord();
    if (why) {
      this.host.toast(why);
      return;
    }
    // The model loads (or downloads, the first time) while the person speaks: on the PC chosen to transcribe, else here.
    if (dictate.warmUp(this.host.mesh) !== null) {
      // that PC loads its own
    } else if (dictate.engine() === "parakeet") {
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
      (d) => {
        if (d.warn !== undefined) this.host.toast(d.warn);
        this.back(key, { text: d.text, send: d.send });
      },
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
      store.set(dictate.CLEANUP_KEY, dirty.cleanup ? "1" : "0");
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

/** Full scale for 16-bit samples, and what counts as touching it. */
const CLIP_AT = 32_000;

/** What the 3-second test says about a recording: nothing, too quiet, clipping, or fine; with what to do about it. */
export function micVerdict(samples: Int16Array): string {
  if (samples.length === 0) return "Could not record from this microphone.";
  let peak = 0;
  let clipped = 0;
  let sum = 0;
  for (const v of samples) {
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a >= CLIP_AT) clipped += 1;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / samples.length) / 32768;
  const top = peak / 32768;
  if (top < 0.001) return "No sound detected. Check that the right microphone is picked, that it isn't muted, and its input volume in the system's sound settings.";
  // More than 0.1 % of the samples at full scale: the words are distorted, and the speech model mishears them.
  if (clipped > samples.length / 1000) return `The sound is clipping (${((clipped * 100) / samples.length).toFixed(1)}% of it at full volume): lower the input volume in the system's sound settings (or the mic's own gain) until loud words stay under the top.`;
  if (top < 0.05 || rms < 0.003) return `The level is very low (peak ${Math.round(top * 100)}%): raise the input volume, or speak closer to the microphone. Dictation may miss words.`;
  return `Microphone is working (peak ${Math.round(top * 100)}%, no clipping).`;
}
