/** Named time units, so no file contains bare `60 * 60 * 1000`. */
export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** "1 hour", "45 minutes", "24 hours", "7 days": for user-facing text such as emails. */
export function formatDuration(ms: number): string {
  const plural = (n: number, unit: string) =>
    `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (ms % DAY_MS === 0) return plural(ms / DAY_MS, 'day');
  if (ms % HOUR_MS === 0) return plural(ms / HOUR_MS, 'hour');
  if (ms % MINUTE_MS === 0) return plural(ms / MINUTE_MS, 'minute');
  return plural(Math.round(ms / SECOND_MS), 'second');
}
