import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  voice.setInputDevice("");
  dictate.set({ engine: "", cleanup: true, keepMin: 5 });
  dictate.setWords({ commands: true, dict: [] });
  if (saved === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = saved;
  rmSync(root, { recursive: true, force: true });
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


test("voice dictionary lists the words, then the form to add or edit one", () => {
  const f = facts({ dict: [{ term: "SpokPay", sounds: ["spoke pay", "spock pay"] }, { term: "Harbor", sounds: [] }] });
  const rows = voiceView(f).sections[2]?.rows ?? [];
  expect(rows.map((r) => [r.title, r.desc])).toEqual([
    ["SpokPay", "Sounds like: spoke pay, spock pay"],
    ["Harbor", ""],
    ["Add a word", "Spelled exactly like this when you say it (\"SpokPay\"). Sounds like, optional: how it comes out wrong, comma-separated (\"spoke pay\")."],
  ]);
  expect(rows[0]?.buttons.map((b) => b.key)).toEqual(["voice:dict:edit:0", "voice:dict:remove:0"]);
  expect(rows[2]).toMatchObject({ kind: "add", buttons: [{ key: "voice:dict:save", label: "Add", enabled: false }] });
  const editing = voiceView({ ...f, editing: true, term: "Harbor", sounds: "harbour" }).sections[2]?.rows[2];
  expect(editing).toMatchObject({ title: "Edit the word", term: "Harbor", sounds: "harbour", buttons: [{ label: "Save", enabled: true }] });
});

test("voice facts read what the speech modules hold, after the stored settings load", () => {
  for (const [k, v] of Object.entries({ voice_lang2: "en", voice_engine: "whisper", voice_keep_min: "15", voice_cleanup: "0", voice_commands: "0", voice_dict: '[{"term":"Harbor","sounds":["harbour"]}]' })) kv.set(k, v);
  ctl.load();
  const f = voiceFacts(ctl, "Ctrl+Shift+Space");
  expect([f.lang, f.engine, f.keepMin, f.cleanup, f.commands]).toEqual(["auto", "parakeet", 1, true, true]);
  expect(f.dict).toEqual([{ term: "Harbor", sounds: ["harbour"] }]);
  expect(f.models.map((m) => [m.name, m.installed, m.used])).toEqual([["tiny", false, false], ["base", false, false], ["small", false, false]]);
  expect([f.parakeet.installed, f.parakeet.loaded, f.download]).toEqual([false, false, null]);
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

test("Voice shows only microphone, Parakeet and dictionary", () => {
  const view = voiceView(facts({ inputs: [{ id: "", label: "System default" }, { id: "usb", label: "USB microphone" }], input: "usb" }));
  expect(view.sections.map((s) => s.title)).toEqual(["On this PC", "Parakeet model", "Dictionary"]);
  expect(view.sections[0]?.rows[0]).toMatchObject({ kind: "microphone", options: ["System default", "USB microphone"], selected: 1 });
  ctl.inputs = [{ id: "", label: "System default" }, { id: "usb", label: "USB microphone" }];
  expect(voiceChose(ctl, "voice:input", 1)).toBe(true);
  expect(kv.get("voice_input")).toBe("usb");
  // Dictation records from the chosen input: a stand-in pw-record on the PATH (a sandbox may have none).
  const bin = mkdtempSync(join(tmpdir(), "hvoice-bin-"));
  writeFileSync(join(bin, "pw-record"), "#!/bin/sh\n");
  chmodSync(join(bin, "pw-record"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = bin;
  try {
    expect(voice.recorder()?.args.slice(0, 2)).toEqual(["--target", "usb"]);
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
  expect(voiceToggled(ctl, "voice:cleanup", false)).toBe(false);
});
