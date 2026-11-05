import { basename } from "node:path";
import { dictate, parakeet, voice, voiceCtl } from "@harbor/media";

/** A button of a voice row (slint/settings-voice.slint `VoiceButton`). */
export interface VoiceButton {
  key: string;
  label: string;
  enabled: boolean;
}

export type VoiceRowKind = "microphone" | "picker" | "status" | "choice" | "buttons" | "toggle" | "add";

export interface VoiceRow {
  kind: VoiceRowKind;
  key: string;
  title: string;
  desc: string;
  text: string;
  tone: "" | "green" | "red";
  options: string[];
  selected: number;
  buttons: VoiceButton[];
  on: boolean;
  progress: number;
  progress_text: string;
  term: string;
  sounds: string;
}

export interface VoiceSection {
  title: string;
  /** Space above the heading, beyond the usual. */
  before: number;
  rows: VoiceRow[];
  /** A small paragraph under the card. */
  note: string;
}

export interface VoiceView {
  sections: VoiceSection[];
  footer: string;
}

/** What the tab shows, read once from the speech modules (so the builder is plain data). */
export interface VoiceFacts {
  /** The recorder's file name, null when neither is installed. */
  recorder: string | null;
  inputs?: voice.InputDevice[];
  input?: string;
  micTesting?: boolean;
  micLevel?: number;
  micStatus?: string;
  /** HARBOR_WHISPER's binary, when one is set. */
  whisperCli: string | null;
  engine: "parakeet" | "whisper";
  parakeet: { installed: boolean; loaded: boolean; bytes: number };
  models: { name: string; what: string; bytes: number; installed: boolean; used: boolean }[];
  /** The download under way: model, bytes so far, bytes in all. */
  download: [string, number, number] | null;
  cleanup: boolean;
  /** "Transcribe on": [mesh id ("" = automatic), label], and the chosen id. */
  hosts?: [string, string][];
  host?: string;
  /** The chosen SSH device's state ("Setting up: …", "Ready …"), "" when not known here. */
  hostState?: string;
  commands: boolean;
  keepMin: number;
  dict: { term: string; sounds: string[] }[];
  lang: string;
  editing: boolean;
  term: string;
  sounds: string;
  /** The shortcut that starts and stops dictation, as shown. */
  shortcut: string;
}

const KEY = "voice:";

export function voiceFacts(ctl: voiceCtl.VoiceCtl, shortcut: string): VoiceFacts {
  const rec = voice.recorder();
  const eng = voice.engine();
  const current = voice.currentModel();
  return {
    recorder: rec === null ? null : basename(rec.bin),
    inputs: ctl.inputs, input: voice.currentInputDevice(), micTesting: ctl.micTesting, micLevel: ctl.micLevel, micStatus: ctl.micStatus,
    whisperCli: eng.kind === "cli" ? eng.bin : null,
    engine: dictate.engine(),
    parakeet: { installed: parakeet.installed(), loaded: parakeet.loaded(), bytes: parakeet.size() },
    models: voice.MODELS.map(([name, what, bytes]) => ({ name, what, bytes, installed: voice.installed(name), used: current === name })),
    download: voice.downloading(),
    cleanup: dictate.cleanupOn(),
    hosts: ctl.hosts(),
    host: dictate.host(),
    hostState: ctl.hostState(),
    commands: dictate.commandsOn(),
    keepMin: parakeet.keepMin(),
    dict: dictate.dictionary(),
    lang: voice.config()[0],
    editing: ctl.dictEdit !== null,
    term: ctl.dictTerm,
    sounds: ctl.dictSounds,
    shortcut,
  };
}

const row = (r: Partial<VoiceRow> & Pick<VoiceRow, "kind" | "title">): VoiceRow => ({ key: "", desc: "", text: "", tone: "", options: [], selected: 0, buttons: [], on: false, progress: 0, progress_text: "", term: "", sounds: "", ...r });
const button = (key: string, label: string, enabled = true): VoiceButton => ({ key, label, enabled });

/** voice.rs `voice_tab` and `voice_dictionary`. */
/** The speech model downloads by itself (voice.keepParakeet): while it does, the microphone row says so. */
function modelNote(f: VoiceFacts): string {
  if (f.download === null || f.download[0] !== "parakeet") return "";
  const [, done, total] = f.download;
  return `Getting the speech model (${voice.megabytes(done)} of ${voice.megabytes(total)})\u{2026} Dictation works once it's here.`;
}

/** What "Transcribe on" does with the choice: Automatic, another PC, or an SSH device (with its state when this PC knows it). */
function hostDesc(at: number, host: string, state: string): string {
  if (at === 0) return "Automatic: the PC of your mesh with the most free memory (this one on a near tie).";
  if (dictate.parseChoice(host).device === null) return "Dictation here, and from phones through this PC, goes to that PC; when it can't be reached, Automatic takes over.";
  const what = "Dictation here, and from phones through this PC, goes to that device over SSH: Parakeet runs there, set up once in ~/.harbor-voice (about 3 GB). When it's asleep or away, Automatic takes over.";
  return state === "" ? what : `${state} ${what}`;
}

export function voiceView(f: VoiceFacts): VoiceView {
  const devices = f.inputs ?? [{ id: "", label: "System default" }];
  const onPc = [row({ kind: "microphone", key: `${KEY}input`, title: "Microphone",
    desc: f.recorder === null ? "Install pw-record (PipeWire) or parecord (PulseAudio) to record." : f.micStatus || modelNote(f) || "Choose an input and test its level.",
    options: devices.map((d) => d.label), selected: Math.max(0, devices.findIndex((d) => d.id === (f.input ?? ""))),
    buttons: [button(`${KEY}test`, f.micTesting ? "Testing…" : "Test", f.recorder !== null && !f.micTesting)],
    on: f.micTesting ?? false, progress: f.micLevel ?? 0,
  })];
  const hosts = f.hosts ?? [["", "Automatic"]];
  const hostAt = Math.max(0, hosts.findIndex(([id]) => id === (f.host ?? "")));
  onPc.push(
    row({
      kind: "picker",
      key: `${KEY}host`,
      title: "Transcribe on",
      desc: hostDesc(hostAt, f.host ?? "", f.hostState ?? ""),
      options: hosts.map(([, label]) => label),
      selected: hostAt,
    }),
  );
  // One value for every PC and phone of the workspace (@harbor/store wssettings): the newest change wins.
  const shared = [
    row({
      kind: "toggle",
      key: `${KEY}cleanup`,
      title: "Clean up dictation",
      desc: "Claude removes filler words and fixes punctuation (a few seconds more). Never for fewer than 8 words.",
      on: f.cleanup,
    }),
  ];

  const words = f.dict.map((e, i) => row({ kind: "buttons", title: e.term, desc: e.sounds.length === 0 ? "" : `Sounds like: ${e.sounds.join(", ")}`, buttons: [button(`${KEY}dict:edit:${i}`, "Edit"), button(`${KEY}dict:remove:${i}`, "Remove")] }));
  words.push(
    row({
      kind: "add",
      key: `${KEY}dict:save`,
      title: f.editing ? "Edit the word" : "Add a word",
      desc: "Spelled exactly like this when you say it (\"SpokPay\"). Sounds like, optional: how it comes out wrong, comma-separated (\"spoke pay\").",
      buttons: [button(`${KEY}dict:save`, f.editing ? "Save" : "Add", f.term.trim() !== "")],
      term: f.term,
      sounds: f.sounds,
    }),
  );

  return {
    sections: [
      { title: "On this PC", before: 0, rows: onPc, note: "" },
      { title: "For the whole workspace", before: 11, rows: shared, note: "" },
      { title: "Dictionary", before: 11, rows: words, note: "" },
    ],
    footer: `The mic in the composer (or ${f.shortcut}) starts and stops dictation; the text goes in at the cursor, to edit before you send. The speech model loads while you speak and stays loaded for ${f.keepMin} minutes after. Phones send their recordings here the same way.`,
  };
}

function num(s: string | undefined): number | null {
  return s !== undefined && /^\d+$/.test(s) ? Number(s) : null;
}

/** A choice of the tab: the engine, how long the model stays loaded, the language. False for a key that isn't one. */
export function voiceChose(ctl: voiceCtl.VoiceCtl, key: string, n: number): boolean {
  if (key === `${KEY}input`) ctl.selectInput(n);
  else if (key === `${KEY}host`) ctl.selectHost(n);
  else return false;
  return true;
}

export function voiceToggled(ctl: voiceCtl.VoiceCtl, key: string, on: boolean): boolean {
  if (key !== `${KEY}cleanup`) return false;
  ctl.setMore({ cleanup: on });
  return true;
}

/** The text of the two dictionary fields, kept as typed until Add or Save. */
export function voiceEdited(ctl: voiceCtl.VoiceCtl, key: string, text: string): boolean {
  if (key === `${KEY}term`) ctl.dictTerm = text;
  else if (key === `${KEY}sounds`) ctl.dictSounds = text;
  else return false;
  return true;
}

export async function voicePressed(ctl: voiceCtl.VoiceCtl, key: string): Promise<boolean> {
  if (!key.startsWith(KEY)) return false;
  const [what, a, b] = key.slice(KEY.length).split(":");
  if (what === "parakeet" && (a === "download" || a === "remove")) await ctl.parakeetAction(a);
  else if (what === "model" && (a === "download" || a === "use" || a === "remove") && b !== undefined) ctl.modelAction(a, b);
  else if (what === "dict" && a === "save") ctl.saveEntry();
  else if (what === "dict" && a === "edit" && num(b) !== null) ctl.editEntry(num(b) ?? 0);
  else if (what === "dict" && a === "remove" && num(b) !== null) ctl.removeEntry(num(b) ?? 0);
  else return false;
  return true;
}
