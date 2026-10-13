const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The UTC hour whose XX:01 post is due at `now`. */
export function dueHour(now: Date): Date {
  return new Date(Math.floor((now.getTime() - MINUTE_MS) / HOUR_MS) * HOUR_MS);
}

export function hourKey(hour: Date): string {
  return hour.toISOString().slice(0, 13);
}

export function postTime(hour: Date): Date {
  return new Date(hour.getTime() + MINUTE_MS);
}

/** Weeks run from Monday 01:01 UTC through the following Monday 00:01 UTC. */
export function weekStartHour(hour: Date): Date {
  const previous = new Date(hour.getTime() - HOUR_MS);
  const daysSinceMonday = (previous.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(
    previous.getUTCFullYear(),
    previous.getUTCMonth(),
    previous.getUTCDate() - daysSinceMonday,
    1,
  ));
}

export function weekFinalHour(weekStart: Date): Date {
  return new Date(weekStart.getTime() + 7 * 24 * HOUR_MS - HOUR_MS);
}

export function isFinalHourOfWeek(hour: Date): boolean {
  return hour.getUTCDay() === 1 && hour.getUTCHours() === 0;
}

export function formatUtc(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${DAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
