import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dictate, voice, voiceCtl } from "@harbor/media";
import { voiceChose, voiceEdited, voiceFacts, voicePressed, voiceToggled, voiceView, type VoiceFacts, type VoiceRow } from "../src/logic/settings-voice.ts";

class Kv {
  readonly map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const facts = (p: Partial<VoiceFacts> = {}): VoiceFacts => ({
  recorder: "pw-record",
  whisperCli: null,
  engine: "parakeet",
  parakeet: { installed: false, loaded: false, bytes: 671_000_000 },
  models: [
    { name: "tiny", what: "Fastest, rougher", bytes: 103_609_903, installed: false, used: false },
    { name: "base", what: "Fast, good for dictation", bytes: 160_609_290, installed: false, used: false },
  ],
  download: null,
  cleanup: true,
  commands: true,
  keepMin: 5,
  dict: [],
  lang: "auto",
  editing: false,
  term: "",
  sounds: "",
  shortcut: "Ctrl+Shift+Space",
  ...p,
});

const rowOf = (f: VoiceFacts, section: string, title: string): VoiceRow | undefined => voiceView(f).sections.find((s) => s.title === section)?.rows.find((r) => r.title.startsWith(title));

let root = "";
let saved: string | undefined;
let ctl: voiceCtl.VoiceCtl;
let kv: Kv;

beforeEach(() => {
  saved = process.env.XDG_DATA_HOME;
  root = mkdtempSync(join(tmpdir(), "hui-voice-"));
  process.env.XDG_DATA_HOME = root;
  kv = new Kv();
  ctl = new voiceCtl.VoiceCtl({ store: kv, mesh: { on: () => false, me: () => ({ name: "" }), peers: () => [], http: () => Promise.resolve([0, null]) }, insert: () => {}, toast: () => {}, wake: () => {}, account: () => null });
  ctl.load();
});

afterEach(() => {
  voice.setConfig("", "");
  dictate.set({ engine: "", cleanup: true, keepMin: 5 });
  dictate.setWords({ commands: true, dict: [] });
  if (saved === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = saved;
  rmSync(root, { recursive: true, force: true });
});

test("voice lists its sections in order, Whisper's as the fallback while Parakeet is the engine", () => {
  const v = voiceView(facts());
  expect(v.sections.map((s) => s.title)).toEqual(["On this PC", "Parakeet model", "Whisper models (fallback)", "Dictation", "Dictionary", "Language"]);
  expect(voiceView(facts({ engine: "whisper" })).sections[2]?.title).toBe("Whisper models");
  expect(v.footer.startsWith("The mic in the composer (or Ctrl+Shift+Space) starts and stops dictation;")).toBe(true);
  expect(v.sections[2]?.note.startsWith("Parakeet TDT 0.6B v3 is NVIDIA's model")).toBe(true);
});

test("voice says whether the microphone is ready, and with which recorder", () => {
  expect(rowOf(facts(), "On this PC", "Microphone")).toMatchObject({ text: "Ready", tone: "green", desc: "Records the default input with pw-record (PipeWire)." });
  expect(rowOf(facts({ recorder: "parecord" }), "On this PC", "Microphone")?.desc).toBe("Records the default input with parecord (PulseAudio).");
  expect(rowOf(facts({ recorder: null }), "On this PC", "Microphone")).toMatchObject({ text: "Missing", tone: "red", desc: "Needs pw-record (PipeWire) or parecord (PulseAudio): neither is installed." });
});

test("voice shows the engine, and a Whisper row only when HARBOR_WHISPER is set", () => {
  expect(rowOf(facts(), "On this PC", "Engine")).toMatchObject({ options: ["Parakeet", "Whisper"], selected: 0 });
  expect(rowOf(facts({ engine: "whisper" }), "On this PC", "Engine")).toMatchObject({ selected: 1, desc: "Whisper: many languages, slower and less accurate." });
  expect(voiceView(facts()).sections[0]?.rows).toHaveLength(2);
  expect(voiceView(facts({ whisperCli: "/bin/w" })).sections[0]?.rows[2]).toMatchObject({ title: "Whisper", desc: "Transcribes with /bin/w (HARBOR_WHISPER).", text: "Ready" });
});

test("voice offers Download, Remove or a progress bar for the Parakeet model", () => {
  const key = (f: VoiceFacts) => rowOf(f, "Parakeet model", "Parakeet")?.buttons.map((b) => [b.key, b.label, b.enabled]);
  expect(key(facts())).toEqual([["voice:parakeet:download", "Download", true]]);
  expect(rowOf(facts(), "Parakeet model", "Parakeet")?.desc).toBe("Parakeet TDT 0.6B v3, int8 \u{b7} 671 MB \u{b7} downloads by itself on the first dictation");
  const here = facts({ parakeet: { installed: true, loaded: true, bytes: 671_000_000 } });
  expect(key(here)).toEqual([["voice:parakeet:remove", "Remove", true]]);
  expect(rowOf(here, "Parakeet model", "Parakeet")).toMatchObject({ title: "Parakeet  \u{b7}  in memory", desc: "Parakeet TDT 0.6B v3, int8 \u{b7} 671 MB" });
  const busy = rowOf(facts({ download: ["parakeet", 335_000_000, 671_000_000] }), "Parakeet model", "Parakeet");
  expect(busy).toMatchObject({ buttons: [], progress_text: "335 MB of 671 MB" });
  expect(busy?.progress).toBeCloseTo(0.4993, 3);
});

test("voice lists each Whisper model with Use, Remove or Download, and blocks a second download", () => {
  const f = facts({
    models: [
      { name: "tiny", what: "Fastest, rougher", bytes: 103_609_903, installed: true, used: true },
      { name: "base", what: "Fast, good for dictation", bytes: 160_609_290, installed: true, used: false },
      { name: "small", what: "Slower, most accurate", bytes: 375_485_327, installed: false, used: false },
    ],
  });
  const r = voiceView(f).sections[2]?.rows ?? [];
  expect(r.map((x) => x.title)).toEqual(["Tiny  \u{b7}  in use", "Base", "Small"]);
  expect(r.map((x) => x.desc)).toEqual(["Fastest, rougher \u{b7} 103 MB", "Fast, good for dictation \u{b7} 160 MB", "Slower, most accurate \u{b7} 375 MB"]);
  expect(r.map((x) => x.buttons.map((b) => b.key))).toEqual([["voice:model:remove:tiny"], ["voice:model:use:base", "voice:model:remove:base"], ["voice:model:download:small"]]);
  const loading = voiceView({ ...f, download: ["small", 1_000_000, 375_485_327] }).sections[2]?.rows ?? [];
  expect(loading[2]).toMatchObject({ buttons: [], progress_text: "1 MB of 375 MB" });
  const other = voiceView(facts({ download: ["parakeet", 1, 2] })).sections[2]?.rows ?? [];
  expect(other[0]?.buttons).toEqual([{ key: "voice:model:download:tiny", label: "Download", enabled: false }]);
});

test("voice dictation: cleanup and commands on, the model kept 5 minutes, any other keep value 5", () => {
  const s = voiceView(facts()).sections[3]?.rows ?? [];
  expect(s.map((r) => [r.key, r.title, r.on])).toEqual([
    ["voice:cleanup", "Clean up dictation", true],
    ["voice:commands", "Voice commands", true],
    ["voice:keep", "Keep speech model loaded", false],
  ]);
  expect(s[2]).toMatchObject({ options: ["Off", "1 min", "5 min", "15 min", "1 h"], selected: 2 });
  expect(voiceView(facts({ keepMin: 60 })).sections[3]?.rows[2]?.selected).toBe(4);
  expect(voiceView(facts({ keepMin: 7 })).sections[3]?.rows[2]?.selected).toBe(2);
});

test("voice dictionary lists the words, then the form to add or edit one", () => {
  const f = facts({ dict: [{ term: "SpokPay", sounds: ["spoke pay", "spock pay"] }, { term: "Harbor", sounds: [] }] });
  const rows = voiceView(f).sections[4]?.rows ?? [];
  expect(rows.map((r) => [r.title, r.desc])).toEqual([
    ["SpokPay", "Sounds like: spoke pay, spock pay"],
    ["Harbor", ""],
    ["Add a word", "Spelled exactly like this when you say it (\"SpokPay\"). Sounds like, optional: how it comes out wrong, comma-separated (\"spoke pay\")."],
  ]);
  expect(rows[0]?.buttons.map((b) => b.key)).toEqual(["voice:dict:edit:0", "voice:dict:remove:0"]);
  expect(rows[2]).toMatchObject({ kind: "add", buttons: [{ key: "voice:dict:save", label: "Add", enabled: false }] });
  const editing = voiceView({ ...f, editing: true, term: "Harbor", sounds: "harbour" }).sections[4]?.rows[2];
  expect(editing).toMatchObject({ title: "Edit the word", term: "Harbor", sounds: "harbour", buttons: [{ label: "Save", enabled: true }] });
});

test("voice language: Detect, English, Portuguese, Detect when the stored one is unknown", () => {
  expect(rowOf(facts(), "Language", "Spoken language")).toMatchObject({ options: ["Detect", "English", "Portuguese"], selected: 0 });
  expect(rowOf(facts({ lang: "pt" }), "Language", "Spoken language")?.selected).toBe(2);
  expect(rowOf(facts({ lang: "xx" }), "Language", "Spoken language")?.selected).toBe(0);
});

test("voice facts read what the speech modules hold, after the stored settings load", () => {
  for (const [k, v] of Object.entries({ voice_lang2: "en", voice_engine: "whisper", voice_keep_min: "15", voice_cleanup: "0", voice_commands: "0", voice_dict: '[{"term":"Harbor","sounds":["harbour"]}]' })) kv.set(k, v);
  ctl.load();
  const f = voiceFacts(ctl, "Ctrl+Shift+Space");
  expect([f.lang, f.engine, f.keepMin, f.cleanup, f.commands]).toEqual(["en", "whisper", 15, false, false]);
  expect(f.dict).toEqual([{ term: "Harbor", sounds: ["harbour"] }]);
  expect(f.models.map((m) => [m.name, m.installed, m.used])).toEqual([["tiny", false, false], ["base", false, false], ["small", false, false]]);
  expect([f.parakeet.installed, f.parakeet.loaded, f.download]).toEqual([false, false, null]);
});

test("voice choices and toggles are written where the Rust app keeps them", () => {
  expect(voiceChose(ctl, "voice:engine", 1)).toBe(true);
  expect(kv.get("voice_engine")).toBe("whisper");
  expect(voiceChose(ctl, "voice:keep", 3)).toBe(true);
  expect(kv.get("voice_keep_min")).toBe("15");
  expect(voiceChose(ctl, "voice:lang", 2)).toBe(true);
  expect(kv.get("voice_lang2")).toBe("pt");
  expect(voiceToggled(ctl, "voice:cleanup", false)).toBe(true);
  expect(kv.get("voice_cleanup")).toBe("0");
  expect(voiceToggled(ctl, "voice:commands", false)).toBe(true);
  expect(kv.get("voice_commands")).toBe("0");
  expect(voiceChose(ctl, "voice:keep", 9)).toBe(false);
  expect(voiceChose(ctl, "follow_up", 1)).toBe(false);
  expect(voiceToggled(ctl, "fast_mode", true)).toBe(false);
});

test("voice picks a downloaded model with Use", async () => {
  expect(await voicePressed(ctl, "voice:model:use:base")).toBe(true);
  expect(kv.get("voice_model")).toBe("base");
  expect(voice.config()[1]).toBe("base");
});

test("voice dictionary: type, Add, Edit, Save and Remove, cleaned through the parser", async () => {
  expect(voiceEdited(ctl, "voice:term", "  SpokPay ")).toBe(true);
  expect(voiceEdited(ctl, "voice:sounds", "spoke pay, , spock pay")).toBe(true);
  expect(await voicePressed(ctl, "voice:dict:save")).toBe(true);
  expect(dictate.dictionary()).toEqual([{ term: "SpokPay", sounds: ["spoke pay", "spock pay"] }]);
  expect(JSON.parse(kv.get("voice_dict") ?? "")).toEqual([{ term: "SpokPay", sounds: ["spoke pay", "spock pay"] }]);
  expect([ctl.dictTerm, ctl.dictSounds]).toEqual(["", ""]);
  await voicePressed(ctl, "voice:dict:edit:0");
  expect(voiceFacts(ctl, "").editing).toBe(true);
  expect([ctl.dictTerm, ctl.dictSounds]).toEqual(["SpokPay", "spoke pay, spock pay"]);
  voiceEdited(ctl, "voice:term", "SpokPay Inc");
  await voicePressed(ctl, "voice:dict:save");
  expect(dictate.dictionary().map((e) => e.term)).toEqual(["SpokPay Inc"]);
  await voicePressed(ctl, "voice:dict:remove:0");
  expect(dictate.dictionary()).toEqual([]);
  expect(kv.get("voice_dict")).toBe("[]");
});

test("voice dictionary: a blank word is not added, and unknown keys are left alone", async () => {
  voiceEdited(ctl, "voice:term", "   ");
  expect(await voicePressed(ctl, "voice:dict:save")).toBe(true);
  expect(dictate.dictionary()).toEqual([]);
  expect(await voicePressed(ctl, "quit")).toBe(false);
  expect(await voicePressed(ctl, "voice:dict:edit:x")).toBe(false);
  expect(voiceEdited(ctl, "quiet_from", "x")).toBe(false);
});
