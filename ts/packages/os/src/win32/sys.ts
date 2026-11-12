// sys.ts's answers on Windows: memory from GlobalMemoryStatusEx, the boot from the tick count.
import type { Memory } from "../sys.ts";
import { bootFiletime, memoryStatus } from "./k32.ts";

export function memory(): Memory | null {
  const m = memoryStatus();
  if (m === null || m.total <= 0) return null;
  // The commit limit beyond physical memory stands in for swap (the page file).
  const swapTotal = Math.max(0, m.pageTotal - m.total);
  return { total: m.total, available: m.available, swapTotal, swapFree: Math.min(swapTotal, Math.max(0, m.pageAvail - m.available)) };
}

/** Changes at every boot, the same until the next: the boot's own time. */
export function bootId(): string {
  const b = bootFiletime();
  return b === null ? "" : `win-boot-${b}`;
}
