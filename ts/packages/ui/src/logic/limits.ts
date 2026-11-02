import { civil, divEuclid, monthName } from "./cost.ts";
import { clock } from "./team.ts";

/** "11:40 AM" within 20 hours, else "Nov 2, 11:40 AM"; `off` is the local zone's UTC offset. */
export function when(ts: number, now: number, off: number): string {
  const hm = clock(ts, off);
  if (ts - now < 20 * 3600) return hm;
  const [, m, d] = civil(divEuclid(ts + off, 86400));
  return `${monthName(m)} ${d}, ${hm}`;
}
