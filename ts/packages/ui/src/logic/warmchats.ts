/**
 * The chats left most recently, kept ready to show again: their transcript stays in memory and their built cards
 * (parsed markdown) stay, so going back to one draws it in the next frame instead of reading and parsing it again.
 * At most `max` chats and `budget` transcript items in all; the one left last always stays.
 */
export class WarmChats {
  /** Most recently left first. */
  private ids: number[] = [];

  constructor(
    private readonly max: number,
    private readonly budget: number,
    /** How many items a chat's transcript holds. */
    private readonly size: (id: number) => number,
    /** A chat that leaves the warm ones: its transcript and cards may go. */
    private readonly evict: (id: number) => void,
  ) {}

  /** The chat went off screen. */
  leave(id: number): void {
    this.ids = [id, ...this.ids.filter((x) => x !== id)];
    let total = 0;
    const keep: number[] = [];
    const out: number[] = [];
    for (const [i, x] of this.ids.entries()) {
      const n = this.size(x);
      if (i === 0 || (keep.length < this.max && total + n <= this.budget)) {
        keep.push(x);
        total += n;
      } else out.push(x);
    }
    this.ids = keep;
    for (const x of out) this.evict(x);
  }

  /** The chat is on screen again: it's no longer one of the warm ones (nothing goes). */
  take(id: number): boolean {
    const had = this.ids.includes(id);
    if (had) this.ids = this.ids.filter((x) => x !== id);
    return had;
  }

  has(id: number): boolean {
    return this.ids.includes(id);
  }

  get list(): readonly number[] {
    return this.ids;
  }
}
