import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as dictate from "../src/dictate.ts";
import * as dictwords from "../src/dictwords.ts";
import * as parakeet from "../src/parakeet.ts";
import * as voice from "../src/voice.ts";
import { type Host, VoiceCtl } from "../src/voicectl.ts";
import { type Sandbox, fakeRecorder, findModel, installModel, sandbox, tmp, until, wavFile } from "./fixture.ts";

interface Rig {
  ctl: VoiceCtl;
  kv: Map<string, string>;
  inserted: [number, string][];
  toasts: string[];
  host: Host;
}

function rig(account: dictate.Ask | null = null): Rig {
  const kv = new Map<string, string>();
  const inserted: [number, string][] = [];
  const toasts: string[] = [];
  const host: Host = {
    store: { get: (k) => kv.get(k) ?? null, set: (k, v) => void kv.set(k, v) },
    mesh: { on: () => false, me: () => ({ name: "desk" }), peers: () => [], http: async () => [500, null] },
    insert: (key, text) => void inserted.push([key, text]),
    toast: (m) => void toasts.push(m),
    wake: () => undefined,
    account: () => account,
  };
  return { kv, inserted, toasts, host, ctl: new VoiceCtl(host) };
}

describe("settings", () => {
  let box: Sandbox;
  beforeEach(() => {
    box = sandbox();
  });
  afterEach(async () => {
    await box.restore();
  });

  test("load mirrors the stored settings and falls back to the defaults", () => {
    const r = rig();
    r.ctl.load();
    expect(voice.config()).toEqual(["auto", ""]);
    expect(parakeet.keepMin()).toBe(5);
    expect([dictate.engine(), dictate.cleanupOn(), dictate.commandsOn(), dictate.dictionary()]).toEqual(["parakeet", true, true, []]);
    const stored = { voice_lang2: "pt", voice_model: "tiny", voice_keep_min: "15", voice_engine: "whisper", voice_cleanup: "0", voice_commands: "0", voice_dict: '[{"term":"Harbor","sounds":["harbour"]}]' };
    for (const [k, v] of Object.entries(stored)) r.kv.set(k, v);
    r.ctl.load();
    expect(voice.config()).toEqual(["pt", "tiny"]);
    expect(parakeet.keepMin()).toBe(15);
    expect([dictate.engine(), dictate.cleanupOn(), dictate.commandsOn()]).toEqual(["whisper", false, false]);
    expect(dictate.dictionary()).toEqual([{ term: "Harbor", sounds: ["harbour"] }]);
    r.kv.set("voice_keep_min", "soon");
    r.kv.set("voice_dict", "{not json");
    r.ctl.load();
    expect(parakeet.keepMin()).toBe(5);
    expect(dictate.dictionary()).toEqual([]);
  });

  test("the settings screen's choices are stored and applied", () => {
    const r = rig();
    r.ctl.set({ lang: "en", model: "base" });
    expect(voice.config()).toEqual(["en", "base"]);
    expect([r.kv.get("voice_lang2"), r.kv.get("voice_model")]).toEqual(["en", "base"]);
    r.ctl.setMore({ engine: "whisper", cleanup: false, keepMin: 60 });
    expect([r.kv.get("voice_engine"), r.kv.get("voice_cleanup"), r.kv.get("voice_keep_min")]).toEqual(["whisper", "0", "60"]);
    expect([dictate.engine(), dictate.cleanupOn(), parakeet.keepMin()]).toEqual(["whisper", false, 60]);
    r.ctl.setWords({ commands: false, dict: [{ term: "Harbor", sounds: [] }] });
    expect([r.kv.get("voice_commands"), r.kv.get("voice_dict")]).toEqual(["0", '[{"term":"Harbor","sounds":[]}]']);
    expect([dictate.commandsOn(), dictate.dictionary()]).toEqual([false, [{ term: "Harbor", sounds: [] }]]);
    r.ctl.setMore({ cleanup: true });
    expect(r.kv.get("voice_cleanup")).toBe("1");
  });

  test("dictionary entries are added, edited and removed through the form", () => {
    const r = rig();
    const c = r.ctl;
    c.dictTerm = "  ";
    expect(c.saveEntry()).toBe(false);
    c.dictTerm = " SpokPay ";
    c.dictSounds = "spoke pay, , spock pay";
    expect(c.saveEntry()).toBe(true);
    expect([c.dictTerm, c.dictSounds]).toEqual(["", ""]);
    c.dictTerm = "Harbor";
    c.saveEntry();
    expect(dictate.dictionary()).toEqual([
      { term: "SpokPay", sounds: ["spoke pay", "spock pay"] },
      { term: "Harbor", sounds: [] },
    ]);
    c.editEntry(0);
    expect([c.dictEdit, c.dictTerm, c.dictSounds]).toEqual([0, "SpokPay", "spoke pay, spock pay"]);
    c.dictSounds = "spoke pay";
    c.saveEntry();
    expect(c.dictEdit).toBeNull();
    expect(dictate.dictionary()[0]).toEqual({ term: "SpokPay", sounds: ["spoke pay"] });
    c.dictTerm = "harbor";
    c.saveEntry();
    expect(dictate.dictionary()).toHaveLength(2);
    c.editEntry(1);
    c.removeEntry(1);
    expect(c.dictEdit).toBeNull();
    expect(dictate.dictionary().map((e) => e.term)).toEqual(["SpokPay"]);
    expect(JSON.parse(r.kv.get("voice_dict") ?? "[]")).toEqual([{ term: "SpokPay", sounds: ["spoke pay"] }]);
    c.editEntry(9);
    expect(c.dictEdit).toBeNull();
  });

  test("poll saves what a phone changed and mirrors the cleanup account", async () => {
    const r = rig(async () => "Ship it on Monday.");
    r.ctl.load();
    dictate.set({ cleanup: false, keepMin: 15 }, true);
    dictate.setWords({ commands: false, dict: dictwords.parse([{ term: "Harbor" }]) }, true);
    r.ctl.poll();
    expect([r.kv.get("voice_cleanup"), r.kv.get("voice_keep_min"), r.kv.get("voice_commands"), r.kv.get("voice_dict")]).toEqual(["0", "15", "0", '[{"term":"Harbor","sounds":[]}]']);
    r.kv.clear();
    r.ctl.poll();
    expect(r.kv.size).toBe(0);
    expect(await dictate.cleanupText("uh ship it on friday no wait monday")).toBe("Ship it on Monday.");
  });

  test("a Whisper model is downloaded, used and removed", async () => {
    const r = rig();
    voice.setFetcher(async () => {
      throw new Error("offline");
    });
    r.ctl.modelAction("download", "small");
    expect(voice.downloading()?.[0]).toBe("small");
    expect(r.kv.get("voice_model")).toBe("small");
    await voice.downloadSettled();
    voice.takeDownloadError();
    const dir = voice.modelDir("tiny");
    mkdirSync(dir, { recursive: true });
    for (const [f, size] of voice.modelFiles("tiny")) {
      writeFileSync(join(dir, f), "");
      truncateSync(join(dir, f), size);
    }
    r.ctl.modelAction("use", "tiny");
    expect(voice.currentModel()).toBe("tiny");
    r.ctl.modelAction("remove", "tiny");
    expect(existsSync(dir)).toBe(false);
    expect(r.kv.get("voice_model")).toBe("");
    expect(voice.config()[1]).toBe("");
  });

  test("the Parakeet model is downloaded from its button", async () => {
    const r = rig();
    const urls: string[] = [];
    voice.setFetcher(async (url) => {
      urls.push(url);
      return new Response("no", { status: 404 });
    });
    await r.ctl.parakeetAction("download");
    await voice.downloadSettled();
    expect(voice.takeDownloadError()?.[0]).toBe("parakeet");
    expect(urls).toHaveLength(1);
    await r.ctl.parakeetAction("remove");
  });
});

describe("the mic", () => {
  let box: Sandbox;
  beforeEach(() => {
    box = sandbox();
  });
  afterEach(async () => {
    await box.restore();
  });

  test("says why it cannot record", async () => {
    process.env.PATH = tmp("nopath");
    const r = rig();
    await r.ctl.toggle(1);
    expect(r.toasts).toEqual(["Can't record: neither pw-record (PipeWire) nor parecord (PulseAudio) is on this PC."]);
    expect(r.ctl.recording).toBeNull();
  });

  test("a recording waits for the model that is downloading, and reports a download that failed", async () => {
    const dir = tmp("mic");
    writeFileSync(join(dir, "pcm"), Buffer.alloc(16000));
    fakeRecorder(join(dir, "bin"), join(dir, "pcm"), 16000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    voice.setFetcher(async () => {
      await gate;
      throw new Error("offline");
    });
    const r = rig();
    r.ctl.load();
    await r.ctl.toggle(7);
    expect(r.ctl.recordingFor(7)?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(r.ctl.recordingFor(8)).toBeNull();
    await until(() => (r.ctl.recording?.rec.length() ?? 0) >= 8000);
    expect(r.ctl.busyFor(7)).toBe(false);
    await r.ctl.toggle(8);
    expect(r.ctl.recording).toBeNull();
    expect(r.ctl.busyFor(7)).toBe(true);
    await r.ctl.toggle(9);
    expect(r.ctl.recording).toBeNull();
    await until(() => r.ctl.waitingForModel() && r.ctl.busy !== null);
    r.ctl.poll();
    expect(r.ctl.busy).not.toBeNull();
    expect(r.toasts).toEqual([]);
    release();
    await voice.downloadSettled();
    r.ctl.poll();
    expect(r.toasts).toEqual(["Couldn't download the Parakeet speech model: offline"]);
    expect(r.ctl.busy).toBeNull();
    expect(r.inserted).toEqual([]);
  });

  test("a failed transcription is shown and frees the mic", async () => {
    const dir = tmp("mic-fail");
    writeFileSync(join(dir, "pcm"), Buffer.alloc(100));
    fakeRecorder(join(dir, "bin"), join(dir, "pcm"), 100);
    const r = rig();
    await r.ctl.toggle(1);
    await until(() => (r.ctl.recording?.rec.length() ?? 0) >= 50);
    await r.ctl.toggle(1);
    await until(() => r.ctl.busy === null);
    expect(r.toasts).toEqual(["Nothing was recorded (check the input device)."]);
    expect(r.inserted).toEqual([]);
  });
});

const model = findModel();
if (!model) console.warn("SKIPPED dictation test: no Parakeet model on this PC (set HARBOR_TEST_PARAKEET_DIR to a folder with its files and test_wavs/en.wav)");

describe.skipIf(!model)("dictating with the model", () => {
  let box: Sandbox;
  let src: NonNullable<typeof model>;
  beforeAll(() => {
    src = model as NonNullable<typeof model>;
    box = sandbox();
    installModel(src);
    process.env.HARBOR_TEST_MEMAVAIL_MB = "4000";
  });
  afterAll(async () => {
    await parakeet.unload();
    await box.restore();
  });

  test("the mic records, transcribes and puts the text into its composer", async () => {
    const en = wavFile(src, "en");
    writeFileSync(join(box.data, "pcm"), Buffer.from(en.buffer, en.byteOffset, en.byteLength));
    fakeRecorder(join(box.data, "bin"), join(box.data, "pcm"), en.byteLength);
    const r = rig();
    r.ctl.load();
    await r.ctl.toggle(3);
    await until(() => (r.ctl.recording?.rec.length() ?? 0) >= en.length);
    expect(r.ctl.recordingFor(3)?.level).toBeGreaterThan(0);
    await r.ctl.toggle(3);
    expect(r.ctl.busyFor(3)).toBe(true);
    await until(() => r.ctl.busy === null, 40_000);
    expect(r.toasts).toEqual([]);
    expect(r.inserted).toHaveLength(1);
    expect(r.inserted[0]?.[0]).toBe(3);
    expect(r.inserted[0]?.[1].toLowerCase()).toContain("ask not what your country can do for you");
    expect(r.ctl.takeSend()).toBeNull();
    await parakeet.unload();
  }, 60_000);
});
