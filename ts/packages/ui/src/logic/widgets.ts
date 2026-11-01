/** How long something has run, in minutes: "<1m", "8m", "1h 12m". */
export function minutes(secs: number): string {
  if (secs < 60) return "<1m";
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}
