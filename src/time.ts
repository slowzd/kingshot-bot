const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Latest daily slot, fixed at 01:01 UTC, including catch-up after midnight. */
export function dueUpdate(now: Date): Date {
  const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 1, 1));
  if (now < slot) slot.setUTCDate(slot.getUTCDate() - 1);
  return slot;
}

export function hourKey(hour: Date): string {
  return hour.toISOString().slice(0, 13);
}

/** The stored week key stays at Monday 01:00 for compatibility with existing standings. */
export function weekStart(hour: Date): Date {
  const daysSinceMonday = (hour.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(
    hour.getUTCFullYear(),
    hour.getUTCMonth(),
    hour.getUTCDate() - daysSinceMonday,
    1,
  ));
}

export function weekFinal(weekStart: Date): Date {
  return new Date(weekStart.getTime() + 7 * 24 * HOUR_MS - HOUR_MS + MINUTE_MS);
}

export function formatUtc(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${DAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
