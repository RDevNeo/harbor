import { DRAFT_HOLD, shouldApply, type SharedDraft } from "@harbor/net";

/** A chat's shared draft as the window gets it (windowmesh.ts `WindowDraft`; `files` null: the window keeps its own). */
export interface DraftIn {
  text: string;
  files: string[] | null;
  mentions: unknown[];
  by: string;
  rev: number;
}

/** What the window's composer holds for a chat, as it's shared. */
export interface DraftOut {
  text: string;
  mentions: unknown[];
  files: string[];
}

/** A clear the window waits for after a message of its went to another PC's chat, at most this long. */
const EXPECT_MS = 60_000;

/** "now": into the composer; a number: try again in that many ms (an edit here is fresh); "skip": nothing to do. */
export type Decision = "now" | number | "skip";

/**
 * The window's side of the shared draft (PROTOCOL.md "Typing", api.rs `should_apply`): one newer by rev, not written
 * by this PC, and not over an edit made here in the last second goes into the chat's composer; what the composer
 * holds goes to the hub when it changed, and only then (a draft that came in isn't sent back).
 */
export class DraftSync {
  private readonly applied = new Map<number, number>();
  private readonly edited = new Map<number, number>();
  private readonly shared = new Map<number, string>();
  private readonly expect = new Map<number, number>();

  constructor(
    private readonly me: () => string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  decide(chat: number, d: DraftIn | null): Decision {
    if (!d || d.rev <= (this.applied.get(chat) ?? 0)) return "skip";
    const at = this.now();
    const until = this.expect.get(chat);
    if (until !== undefined && d.by === "" && empty(d)) {
      // The clear of the message this window sent: its composer emptied then, and may hold new words since.
      this.expect.delete(chat);
      if (until > at) {
        this.applied.set(chat, d.rev);
        return "skip";
      }
    }
    const a = shouldApply({ ...d, files: [], label: "", quiet: null, held: false } satisfies SharedDraft, this.me(), this.edited.get(chat) ?? null, at);
    if (a === "skip") {
      this.applied.set(chat, d.rev);
      return "skip";
    }
    if (a === "later") return Math.max(1, (this.edited.get(chat) ?? at) + DRAFT_HOLD - at);
    return "now";
  }

  /** The draft went into the composer: it's what the composer holds now, not an edit to send back. */
  took(chat: number, d: DraftIn, held: DraftOut): void {
    this.applied.set(chat, d.rev);
    this.shared.set(chat, sig(held));
  }

  /** The chat's composer came on screen holding this: what it held from before isn't an edit (only edits go to the
   * hub, as the phone does: opening a chat doesn't make this PC its typer). */
  shown(chat: number, held: DraftOut): void {
    if (!this.shared.has(chat)) this.shared.set(chat, sig(held));
  }

  /** What the composer holds now; true when that's new (an edit here: it goes to the hub). */
  changed(chat: number, held: DraftOut): boolean {
    const s = sig(held);
    if (this.shared.get(chat) === s) return false;
    if (!this.shared.has(chat) && empty(held)) {
      this.shared.set(chat, s);
      return false;
    }
    this.shared.set(chat, s);
    this.edited.set(chat, this.now());
    return true;
  }

  /** A message went out of the composer and it's empty. `rev`: the clear's, when the hub here made it (this PC's
   * chat); null when another PC will (a copy): the first clear from there in the next minute is this one. */
  sent(chat: number, rev: number | null): void {
    this.shared.set(chat, sig({ text: "", mentions: [], files: [] }));
    this.edited.delete(chat);
    if (rev !== null) {
      this.applied.set(chat, Math.max(rev, this.applied.get(chat) ?? 0));
      this.expect.delete(chat);
    } else this.expect.set(chat, this.now() + EXPECT_MS);
  }

  /** The message didn't go (it's back in the composer): no clear comes for it. */
  unsent(chat: number): void {
    this.expect.delete(chat);
  }
}

function empty(d: { text: string; mentions: unknown[]; files: string[] | null }): boolean {
  return d.text.trim() === "" && d.mentions.length === 0 && (d.files ?? []).length === 0;
}

function sig(d: DraftOut): string {
  return JSON.stringify([d.text, d.mentions, d.files]);
}
