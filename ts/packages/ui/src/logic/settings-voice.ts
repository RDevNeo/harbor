import { basename } from "node:path";
import { dictate, parakeet, voice, voiceCtl } from "@harbor/media";

/** A button of a voice row (slint/settings-voice.slint `VoiceButton`). */
export interface VoiceButton {
  key: string;
  label: string;
  enabled: boolean;
}

export type VoiceRowKind = "status" | "choice" | "buttons" | "toggle" | "add";

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
  const mic = f.recorder === null ? "Needs pw-record (PipeWire) or parecord (PulseAudio): neither is installed." : f.recorder === "pw-record" ? "Records the default input with pw-record (PipeWire)." : `Records the default input with ${f.recorder} (PulseAudio).`;
  const parakeetOn = f.engine === "parakeet";
  const onPc: VoiceRow[] = [
    row({ kind: "status", title: "Microphone", desc: mic, text: f.recorder === null ? "Missing" : "Ready", tone: f.recorder === null ? "red" : "green" }),
    row({
      kind: "choice",
      key: `${KEY}engine`,
      title: "Engine",
      desc: parakeetOn ? "Parakeet: fast and accurate in 25 European languages, detects the language itself. Whisper takes over for other languages." : "Whisper: many languages, slower and less accurate.",
      options: ["Parakeet", "Whisper"],
      selected: parakeetOn ? 0 : 1,
    }),
  ];
  if (f.whisperCli !== null) onPc.push(row({ kind: "status", title: "Whisper", desc: `Transcribes with ${f.whisperCli} (HARBOR_WHISPER).`, text: "Ready", tone: "green" }));

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

  const whisperRows = f.models.map((m): VoiceRow => {
    const b = bar(m.name);
    const buttons = b !== null ? [] : m.installed ? [...(m.used ? [] : [button(`${KEY}model:use:${m.name}`, "Use")]), button(`${KEY}model:remove:${m.name}`, "Remove")] : [button(`${KEY}model:download:${m.name}`, "Download", f.download === null)];
    return row({ kind: "buttons", title: `${voice.capital(m.name)}${m.used ? "  \u{b7}  in use" : ""}`, desc: `${m.what} \u{b7} ${voice.megabytes(m.bytes)}`, buttons, ...b });
  });

  const keepAt = voiceCtl.KEEPS.findIndex((k) => k[0] === f.keepMin);
  const dictation: VoiceRow[] = [
    row({
      kind: "toggle",
      key: `${KEY}cleanup`,
      title: "Clean up dictation",
      desc: "Removes filler words and false starts, fixes punctuation and applies spoken corrections (\"no wait, I meant\u{2026}\"), through this PC's Claude account. Never adds anything; the raw text when it can't.",
      on: f.cleanup,
    }),
    row({
      kind: "toggle",
      key: `${KEY}commands`,
      title: "Voice commands",
      desc: "End with \"press enter\" or say \"send\" (\"aperta enter\", \"enviar\") as the last sentence to send the message. \"New line\" (\"nova linha\") alone makes a line break. Anywhere else these words are just text.",
      on: f.commands,
    }),
    row({ kind: "choice", key: `${KEY}keep`, title: "Keep speech model loaded", desc: "After the last dictation, then it's freed: no memory or CPU while idle.", options: voiceCtl.KEEPS.map((k) => k[1]), selected: keepAt < 0 ? 2 : keepAt }),
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

  const langAt = voice.LANGS.findIndex((l) => l[0] === f.lang);
  const language: VoiceRow[] = [
    row({
      kind: "choice",
      key: `${KEY}lang`,
      title: "Spoken language",
      desc: "Detect: each phrase in the language you spoke it, so you can mix languages. Picking one makes Whisper write everything in it, translating the rest.",
      options: voice.LANGS.map(([code, label]) => (code === "auto" ? "Detect" : label)),
      selected: langAt < 0 ? 0 : langAt,
    }),
  ];

  return {
    sections: [
      { title: "On this PC", before: 0, rows: onPc, note: "" },
      { title: "Parakeet model", before: 11, rows: parakeetRows, note: "" },
      {
        title: parakeetOn ? "Whisper models (fallback)" : "Whisper models",
        before: 11,
        rows: whisperRows,
        note: "Parakeet TDT 0.6B v3 is NVIDIA's model (CC-BY-4.0), run with sherpa-onnx (Apache-2.0); Whisper is OpenAI's (MIT), in sherpa-onnx's export. Both download from Hugging Face and stay in Harbor's data folder.",
      },
      { title: "Dictation", before: 11, rows: dictation, note: "" },
      { title: "Dictionary", before: 11, rows: words, note: "" },
      { title: "Language", before: 11, rows: language, note: "" },
    ],
    footer: `The mic in the composer (or ${f.shortcut}) starts and stops dictation; the text goes in at the cursor, to edit before you send. Each recording is transcribed on the PC of your mesh with the most free memory (this one on a near tie). Phones send their recordings here the same way.`,
  };
}

function num(s: string | undefined): number | null {
  return s !== undefined && /^\d+$/.test(s) ? Number(s) : null;
}

/** A choice of the tab: the engine, how long the model stays loaded, the language. False for a key that isn't one. */
export function voiceChose(ctl: voiceCtl.VoiceCtl, key: string, n: number): boolean {
  if (key === `${KEY}engine`) ctl.setMore({ engine: n === 0 ? "parakeet" : "whisper" });
  else if (key === `${KEY}keep`) {
    const k = voiceCtl.KEEPS[n];
    if (k === undefined) return false;
    ctl.setMore({ keepMin: k[0] });
  } else if (key === `${KEY}lang`) {
    const l = voice.LANGS[n];
    if (l === undefined) return false;
    ctl.set({ lang: l[0] });
  } else return false;
  return true;
}

export function voiceToggled(ctl: voiceCtl.VoiceCtl, key: string, on: boolean): boolean {
  if (key === `${KEY}cleanup`) ctl.setMore({ cleanup: on });
  else if (key === `${KEY}commands`) ctl.setWords({ commands: on });
  else return false;
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
