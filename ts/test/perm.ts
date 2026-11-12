// File modes in tests: POSIX systems have them; Windows has none (its files are owner-only through their folder's
// ACL, not a mode), so there the check is skipped.
import { expect } from "bun:test";
import { statSync } from "node:fs";

export const posixModes = process.platform !== "win32";

/** `path`'s permission bits are `want` (POSIX only). */
export function expectPerm(path: string, want: number): void {
  if (posixModes) expect(statSync(path).mode & 0o777).toBe(want);
}
