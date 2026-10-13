export function getDueHourlySlot(
  now: Date,
  lastScheduledSlot: string,
): string | null {
  if (now.getUTCMinutes() < 1) return null;

  const slot = now.toISOString().slice(0, 13);
  return slot > lastScheduledSlot ? slot : null;
}
