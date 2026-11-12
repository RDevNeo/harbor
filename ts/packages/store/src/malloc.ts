// glibc's allocator in Harbor main. Bun's own objects live in mimalloc and the JavaScript heap, but
// the native libraries (Slint, sharp/libvips, SQLite) use glibc's malloc, and their work on Bun's
// pool threads gives each thread an arena of its own. Over hours those arenas and the middle of the
// main heap fill with freed but unreturned pages: glibc gives back only the top of the main heap by
// itself. Capping the arenas (what MALLOC_ARENA_MAX=2 does, sharp's own advice) and calling
// malloc_trim(0) now and then hands that memory back. Linux with glibc only: elsewhere (macOS,
// musl) both are quietly nothing.
import { libc } from "@harbor/os";

/** mallopt's parameter for MALLOC_ARENA_MAX. */
const M_ARENA_MAX = -8;

/** Arenas for Harbor main: the main heap and one more, shared by every thread. */
export const ARENAS = 2;

/** How often an idle Harbor gives freed native memory back. */
export const TRIM_EVERY_MS = 5 * 60_000;

const glibc = (): libc.Glibc | null => libc.glibc();

/**
 * Caps glibc's arenas, as MALLOC_ARENA_MAX does. Only arenas made from now on are held back, so it
 * runs first thing. A MALLOC_ARENA_MAX of the person's own wins. False when there's nothing to cap.
 */
export function capArenas(max: number = ARENAS, env: Record<string, string | undefined> = process.env): boolean {
  if (env.MALLOC_ARENA_MAX) return false;
  const g = glibc();
  return g !== null && g.mallopt(M_ARENA_MAX, max) === 1;
}

/** Hands freed pages of every arena back to the system. True when glibc returned any. */
export function trim(): boolean {
  const g = glibc();
  return g !== null && g.malloc_trim(0) === 1;
}

/** Trims every TRIM_EVERY_MS for as long as the process runs. Stops when called back. */
export function trimEvery(ms: number = TRIM_EVERY_MS): () => void {
  if (glibc() === null) return () => {};
  const t = setInterval(trim, ms);
  t.unref?.();
  return () => clearInterval(t);
}
