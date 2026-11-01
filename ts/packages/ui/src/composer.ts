import type { MenuEntry } from "./window.ts";
import { join } from "node:path";
import { ICONS } from "./icons.ts";
import * as chatmention from "./logic/chatmention.ts";
import type { KeyPress } from "./logic/keys.ts";
import type { Mention } from "./logic/mentions.ts";
import { menuHover, menuKey, menuPicked, menuShown, menuWord, newMenu } from "./logic/menu.ts";
import * as slash from "./logic/slash.ts";
import * as tags from "./logic/tags.ts";

export type MenuRow = MenuEntry;

export interface MenuContext {
  /** The composer's chat (0: the draft). */
  key: number;
  /** The folder its agent works in: `@` lists its files. */
  cwd: string;
  repo: number | null;
  home: string;
  modes: slash.AgentModes;
  access: string;
  /** Its account's Claude config folder, for personal commands. */
  personal: string;
  chat: slash.SlashChat | null;
  chats: readonly chatmention.CandChat[];
}

/** What a pick does beyond writing the text: run a Harbor command, add a mentioned chat. */
export type Picked = { kind: "text" } | { kind: "command"; command: slash.HarborCommand } | { kind: "mention"; mention: Mention };

type Open =
  | { kind: "slash"; word: slash.Word; rows: slash.Entry[] }
  | { kind: "tag"; word: tags.TagWord; rows: tags.TagRow[] }
  | { kind: "chat"; word: chatmention.Word; rows: chatmention.Cand[] };

/** A UTF-8 byte offset (Slint's cursor) as a count of characters (the logic's positions). */
export function charAt(text: string, byte: number): number {
  return [...Buffer.from(text).subarray(0, byte).toString()].length;
}

export function byteAt(text: string, chars: number): number {
  return Buffer.byteLength([...text].slice(0, chars).join(""));
}

const FILES_TTL_MS = 10_000;

export class ComposerMenus {
  private state = newMenu();
  private open: Open | null = null;
  private files = new Map<string, { at: number; list: string[] | null }>();
  private locals = new Map<string, { at: number; list: slash.Local[] }>();

  get selected(): number {
    return this.state.sel;
  }

  private fileList(cwd: string): string[] | null {
    const hit = this.files.get(cwd);
    if (hit && Date.now() - hit.at < FILES_TTL_MS) return hit.list;
    const list = tags.listFiles(cwd);
    this.files.set(cwd, { at: Date.now(), list });
    return list;
  }

  private localList(dir: string): slash.Local[] {
    const hit = this.locals.get(dir);
    if (hit && Date.now() - hit.at < FILES_TTL_MS) return hit.list;
    const list = slash.scan(dir);
    this.locals.set(dir, { at: Date.now(), list });
    return list;
  }

  /** The rows for `text` with the cursor at byte `cursorByte`; empty: no menu. */
  update(text: string, cursorByte: number, ctx: MenuContext): MenuRow[] {
    const cur = charAt(text, cursorByte);
    const sw = menuWord(this.state, ctx.key, slash.word(text, cur));
    if (sw) {
      const all = slash.entries(ctx.modes, false, ctx.access, ctx.chat, null, this.localList(join(ctx.cwd, ".claude")), this.localList(ctx.personal));
      const rows = slash.search(all, sw);
      if (menuShown(this.state, ctx.key, rows.length)) {
        this.open = { kind: "slash", word: sw, rows };
        return rows.map((e) => {
          const b = slash.badge(e);
          return { icon: ICONS[b.icon], tone: "", label: `/${e.name}`, desc: slash.entryLine(e), section: b.label };
        });
      }
    }
    const tw = menuWord(this.state, ctx.key, tags.word(text, cur));
    if (tw) {
      const rows = tags.rows(tw.trigger, tw.query, tw.trigger === "@" ? this.fileList(ctx.cwd) : null, null);
      if (menuShown(this.state, ctx.key, rows.length)) {
        this.open = { kind: "tag", word: tw, rows };
        return rows.map((r) => {
          const t = tags.rowText(r);
          return { icon: ICONS[t.icon], tone: t.color === "subtle" ? "" : t.color, label: t.name, desc: t.rest, section: "" };
        });
      }
    }
    const cw = menuWord(this.state, ctx.key, chatmention.word(text, cur));
    if (cw) {
      const rows = chatmention.chatRows(ctx.chats, ctx.key, ctx.repo, cw.query);
      if (menuShown(this.state, ctx.key, rows.length)) {
        this.open = { kind: "chat", word: cw, rows };
        return rows.map((c) => ({ icon: ICONS.MESSAGE, tone: "", label: c.title, desc: chatmention.candLine(c), section: "" }));
      }
    }
    this.open = null;
    return [];
  }

  hover(i: number): void {
    menuHover(this.state, i);
  }

  /** A key while the menu shows: taken or not, and the row Enter or Tab picks. */
  key(ctxKey: number, p: KeyPress): { taken: boolean; pick: number | null } {
    const o = this.open;
    if (!o) return { taken: false, pick: null };
    const r = menuKey(this.state, ctxKey, o.word.start, o.rows.length, p);
    if (r.taken && r.pick === null && this.state.open === null) this.open = null;
    return r;
  }

  /** Row `i` picked in `text`: the new text, the cursor (bytes) and what else it does. */
  pick(text: string, i: number): { text: string; cursor: number; picked: Picked } | null {
    const o = this.open;
    if (!o) return null;
    menuPicked(this.state);
    this.open = null;
    switch (o.kind) {
      case "slash": {
        const e = o.rows[i];
        if (!e) return null;
        const r = slash.accept(text, o.word, e);
        return { text: r.text, cursor: byteAt(r.text, r.cursor), picked: r.command === null ? { kind: "text" } : { kind: "command", command: r.command } };
      }
      case "tag": {
        const row = o.rows[i];
        if (!row) return null;
        const r = tags.accept(text, o.word, row);
        return { text: r.text, cursor: byteAt(r.text, r.cursor), picked: { kind: "text" } };
      }
      case "chat": {
        const c = o.rows[i];
        if (!c) return null;
        const r = chatmention.accept(text, o.word, c);
        return { text: r.text, cursor: byteAt(r.text, r.cursor), picked: { kind: "mention", mention: r.mention } };
      }
    }
  }
}

export function pressOf(text: string, m: { control: boolean; shift: boolean; alt: boolean }): KeyPress {
  const names: Record<string, string> = { "\n": "Enter", "\r": "Enter", "\t": "Tab", "\u{1b}": "Escape", "\u{f700}": "ArrowUp", "\u{f701}": "ArrowDown", "\u{f702}": "ArrowLeft", "\u{f703}": "ArrowRight", "\u{8}": "Backspace", "\u{7f}": "Delete" };
  return { key: names[text] ?? text, ctrl: m.control, shift: m.shift, alt: m.alt };
}
