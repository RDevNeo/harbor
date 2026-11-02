const WD = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function divEuclid(a: number, b: number): number {
  return Math.floor(a / b);
}

export function remEuclid(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/** The civil date of `day` days since 1970-01-01: [year, month 1–12, day of month]. */
export function civil(day: number): [number, number, number] {
  // Howard Hinnant's algorithm.
  const z = day + 719_468;
  const era = divEuclid(z, 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.trunc((doe - Math.trunc(doe / 1_460) + Math.trunc(doe / 36_524) - Math.trunc(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.trunc(yoe / 4) - Math.trunc(yoe / 100));
  const mp = Math.trunc((5 * doy + 2) / 153);
  const d = doy - Math.trunc((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

export function monthName(m: number): string {
  return MON[m - 1] ?? "";
}

/** "Mon 26 Oct" for `day` days since 1970-01-01. */
export function dayLabel(day: number): string {
  const [, m, d] = civil(day);
  return `${WD[remEuclid(day, 7)] ?? ""} ${d} ${monthName(m)}`;
}
