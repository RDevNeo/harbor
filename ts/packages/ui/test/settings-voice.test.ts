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
  dictate.set({ engine: "", cleanup: false, keepMin: 5 });
  dictate.setHost("");
  dictate.setWords({ commands: true, dict: [] });
  if (saved === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = saved;
  rmSync(root, { recursive: true, force: true });
});

test("the speech model downloads by itself: no model row, and the microphone row says while it comes", () => {
  expect(voiceView(facts()).sections.flatMap((s) => s.rows).some((r) => r.title.startsWith("Parakeet"))).toBe(false);
  const mic = voiceView(facts({ download: ["parakeet", 335_000_000, 671_000_000] })).sections[0]?.rows[0];
  expect(mic?.desc).toBe("Getting the speech model (335 MB of 671 MB)\u{2026} Dictation works once it's here.");
  expect(voiceView(facts({ download: ["parakeet", 1, 2], micStatus: "Microphone is working." })).sections[0]?.rows[0]?.desc).toBe("Microphone is working.");
});

test("voice dictionary lists the words, then the form to add or edit one", () => {
  const f = facts({ dict: [{ term: "SpokPay", sounds: ["spoke pay", "spock pay"] }, { term: "Harbor", sounds: [] }] });
  const rows = voiceView(f).sections[1]?.rows ?? [];
  expect(rows.map((r) => [r.title, r.desc])).toEqual([
    ["SpokPay", "Sounds like: spoke pay, spock pay"],
    ["Harbor", ""],
    ["Add a word", "Spelled exactly like this when you say it (\"SpokPay\"). Sounds like, optional: how it comes out wrong, comma-separated (\"spoke pay\")."],
  ]);
  expect(rows[0]?.buttons.map((b) => b.key)).toEqual(["voice:dict:edit:0", "voice:dict:remove:0"]);
  expect(rows[2]).toMatchObject({ kind: "add", buttons: [{ key: "voice:dict:save", label: "Add", enabled: false }] });
  const editing = voiceView({ ...f, editing: true, term: "Harbor", sounds: "harbour" }).sections[1]?.rows[2];
  expect(editing).toMatchObject({ title: "Edit the word", term: "Harbor", sounds: "harbour", buttons: [{ label: "Save", enabled: true }] });
});

test("voice facts read what the speech modules hold, after the stored settings load", () => {
  expect(voiceFacts(ctl, "").cleanup).toBe(false);
  for (const [k, v] of Object.entries({ voice_lang2: "en", voice_engine: "whisper", voice_keep_min: "15", voice_cleanup: "1", voice_commands: "0", voice_dict: '[{"term":"Harbor","sounds":["harbour"]}]' })) kv.set(k, v);
  ctl.load();
  const f = voiceFacts(ctl, "Ctrl+Shift+Space");
  expect([f.lang, f.engine, f.keepMin, f.cleanup, f.commands]).toEqual(["auto", "parakeet", 5, true, true]);
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

test("Voice shows the microphone, where to transcribe, the cleanup switch and the dictionary", () => {
  const view = voiceView(facts({ inputs: [{ id: "", label: "System default" }, { id: "usb", label: "USB microphone" }], input: "usb" }));
  expect(view.sections.map((s) => s.title)).toEqual(["On this PC", "Dictionary"]);
  expect(view.sections[0]?.rows.map((r) => [r.kind, r.key, r.title])).toEqual([
    ["microphone", "voice:input", "Microphone"],
    ["picker", "voice:host", "Transcribe on"],
    ["toggle", "voice:cleanup", "Clean up dictation"],
  ]);
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
  expect(voiceToggled(ctl, "voice:cleanup", true)).toBe(true);
  expect([kv.get("voice_cleanup"), dictate.cleanupOn()]).toEqual(["1", true]);
  expect(voiceToggled(ctl, "voice:cleanup", false)).toBe(true);
  expect([kv.get("voice_cleanup"), dictate.cleanupOn()]).toEqual(["0", false]);
  expect(voiceToggled(ctl, "voice:other", true)).toBe(false);
});

test("Transcribe on lists Automatic, this PC and the mesh's PCs, and stores the pick by mesh id", () => {
  const peers = [
    { id: "pc:zed", name: "Zed", online: false },
    { id: "pc:big", name: "Big desk", online: true },
  ];
  const meshed = new voiceCtl.VoiceCtl({ store: kv, mesh: { on: () => true, me: () => ({ name: "Laptop", id: "pc:lap" }), peers: () => peers.filter((p) => p.online), known: () => peers, http: () => Promise.resolve([0, null]) }, insert: () => {}, toast: () => {}, wake: () => {}, account: () => null });
  meshed.load();
  expect(meshed.hosts()).toEqual([["", "Automatic"], ["pc:lap", "Laptop (this PC)"], ["pc:big", "Big desk"], ["pc:zed", "Zed (offline)"]]);
  let row = voiceView(voiceFacts(meshed, "")).sections[0]?.rows[1];
  expect(row).toMatchObject({ kind: "picker", options: ["Automatic", "Laptop (this PC)", "Big desk", "Zed (offline)"], selected: 0 });
  expect(row?.desc).toStartWith("Automatic:");
  expect(voiceChose(meshed, "voice:host", 2)).toBe(true);
  expect([kv.get("voice_host"), dictate.host()]).toEqual(["pc:big", "pc:big"]);
  row = voiceView(voiceFacts(meshed, "")).sections[0]?.rows[1];
  expect(row?.selected).toBe(2);
  // A saved PC the mesh forgot stays listed, so the choice can be seen and changed.
  kv.set("voice_host", "pc:gone");
  meshed.load();
  expect(meshed.hosts().at(-1)).toEqual(["pc:gone", "Saved PC (unknown)"]);
  expect(voiceChose(meshed, "voice:host", 0)).toBe(true);
  expect(dictate.host()).toBe("");
});

test("Transcribe on lists this PC's SSH devices and those other PCs offer, and picking one prepares it", async () => {
  const peers = [{ id: "pc:big", name: "Big desk", online: true }];
  const prepared: string[] = [];
  let state = "Setting up: getting the speech model…";
  const mesh = {
    on: () => true,
    me: () => ({ name: "Laptop", id: "pc:lap" }),
    peers: () => peers,
    known: () => peers,
    http: () => Promise.resolve([200, { devices: [{ id: "ssh:2", name: "Studio" }, { id: "ssh:9", name: "studio mac" }] }] as [number, unknown]),
    speech: { list: () => [{ id: "ssh:1", name: "Studio Mac" }], transcribe: () => Promise.reject(new Error("no")), warm: () => {}, prepare: (id: string) => void prepared.push(id), state: () => state },
  };
  const meshed = new voiceCtl.VoiceCtl({ store: kv, mesh, insert: () => {}, toast: () => {}, wake: () => {}, account: () => null });
  meshed.load();
  await dictate.refreshPeerDevices(mesh);
  // Big desk's "studio mac" is this PC's Studio Mac: listed once, as this PC's.
  expect(meshed.hosts()).toEqual([["", "Automatic"], ["pc:lap", "Laptop (this PC)"], ["pc:big", "Big desk"], ["pc:lap#ssh:1", "Studio Mac (SSH device)"], ["pc:big#ssh:2", "Studio (SSH device, through Big desk)"]]);
  expect(voiceChose(meshed, "voice:host", 3)).toBe(true);
  expect([kv.get("voice_host"), prepared]).toEqual(["pc:lap#ssh:1", ["ssh:1"]]);
  let row = voiceView(voiceFacts(meshed, "")).sections[0]?.rows[1];
  expect(row?.selected).toBe(3);
  expect(row?.desc).toStartWith("Setting up: getting the speech model… Dictation here, and from phones through this PC, goes to that device over SSH");
  state = "";
  expect(voiceChose(meshed, "voice:host", 4)).toBe(true);
  expect(prepared).toEqual(["ssh:1"]);
  row = voiceView(voiceFacts(meshed, "")).sections[0]?.rows[1];
  expect(row?.desc).toStartWith("Dictation here, and from phones through this PC, goes to that device over SSH");
  kv.set("voice_host", "pc:gone#ssh:3");
  meshed.load();
  expect(meshed.hosts().at(-1)).toEqual(["pc:gone#ssh:3", "Saved SSH device (unknown)"]);
  expect(voiceChose(meshed, "voice:host", 0)).toBe(true);
});
