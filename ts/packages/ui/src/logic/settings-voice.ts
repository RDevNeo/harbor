import { basename } from "node:path";
import { dictate, parakeet, voice, voiceCtl } from "@harbor/media";

/** A button of a voice row (slint/settings-voice.slint `VoiceButton`). */
export interface VoiceButton {
  key: string;
  label: string;
  enabled: boolean;
}

export type VoiceRowKind = "microphone" | "status" | "choice" | "buttons" | "toggle" | "add";

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
export function voiceView(f: VoiceFacts): VoiceView {
  const bar = (model: string): Pick<VoiceRow, "progress" | "progress_text"> | null => {
    if (f.download === null || f.download[0] !== model) return null;
    const [, done, total] = f.download;
    return { progress: total > 0 ? Math.min(1, done / total) : 0, progress_text: `${voice.megabytes(done)} of ${voice.megabytes(total)}` };
  };
  const devices = f.inputs ?? [{ id: "", label: "System default" }];
  const onPc = [row({ kind: "microphone", key: `${KEY}input`, title: "Microphone",
    desc: f.recorder === null ? "Install pw-record (PipeWire) or parecord (PulseAudio) to record." : f.micStatus || "Choose an input and test its level.",
    options: devices.map((d) => d.label), selected: Math.max(0, devices.findIndex((d) => d.id === (f.input ?? ""))),
    buttons: [button(`${KEY}test`, f.micTesting ? "Testing…" : "Test", f.recorder !== null && !f.micTesting)],
    on: f.micTesting ?? false, progress: f.micLevel ?? 0,
  })];

  const pkBar = bar("parakeet");
  const pkButtons = pkBar !== null ? [] : f.parakeet.installed ? [button(`${KEY}parakeet:remove`, "Remove")] : [button(`${KEY}parakeet:download`, "Download", f.download === null)];
  const parakeetRows: VoiceRow[] = [
    row({
      kind: "buttons",
      title: `Parakeet${f.parakeet.loaded ? "  \u{b7}  in memory" : ""}`,
      desc: `Parakeet TDT 0.6B v3, int8 \u{b7} ${voice.megabytes(f.parakeet.bytes)}${f.parakeet.installed ? "" : " \u{b7} downloads by itself on the first dictation"}`,
      buttons: pkButtons,
      ...pkBar,
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
      { title: "Parakeet model", before: 11, rows: parakeetRows, note: "" },
      { title: "Dictionary", before: 11, rows: words, note: "" },
    ],
    footer: `The mic in the composer (or ${f.shortcut}) starts and stops dictation; the text goes in at the cursor, to edit before you send. Each recording is transcribed on the PC of your mesh with the most free memory (this one on a near tie). Phones send their recordings here the same way.`,
  };
}

function num(s: string | undefined): number | null {
  return s !== undefined && /^\d+$/.test(s) ? Number(s) : null;
}

/** A choice of the tab: the engine, how long the model stays loaded, the language. False for a key that isn't one. */
export function voiceChose(ctl: voiceCtl.VoiceCtl, key: string, n: number): boolean {
  if (key !== `${KEY}input`) return false;
  ctl.selectInput(n);
  return true;
}

export function voiceToggled(ctl: voiceCtl.VoiceCtl, key: string, on: boolean): boolean {
  return false;
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
