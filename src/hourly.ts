import { hourlyMessage, splitMessage, weeklyFinalMessage } from "./format.ts";
import type { PowerSnapshot } from "./mightpulse.ts";
import { recordSnapshot, snapshotUse, type SnapshotUse } from "./snapshot-log.ts";
import { addHour, createWeek, loadStandings, saveStandings, type WeekStandings } from "./standings.ts";
import { dueHour, isFinalHourOfWeek, weekStartHour } from "./time.ts";

export interface HourlyRun {
  now: Date;
  kingdom: number;
  stateFile: string;
  /** Generated .ts file recording which API snapshot each update used. */
  snapshotFile?: string;
  fetchSnapshot: () => Promise<PowerSnapshot>;
  send: (content: string) => Promise<void>;
  /** Prints messages without saving standings. */
  dryRun?: boolean;
}

export interface HourlyResult {
  status: "posted";
  snapshotUsed: SnapshotUse;
}

/** Every run posts and counts, even when the same hour was already posted. */
export async function runHourlyUpdate(run: HourlyRun): Promise<HourlyResult> {
  const hour = dueHour(run.now);
  let week = loadStandings(run.stateFile);
  if (week && week.kingdom !== run.kingdom) {
    console.warn(`Saved standings are for kingdom ${week.kingdom}; starting new standings for ${run.kingdom}.`);
    week = null;
  }

  const snapshot = await run.fetchSnapshot();
  const fetchedAt = new Date();
  const post = async (message: string) => {
    for (const part of splitMessage(message)) await run.send(part);
  };
  const save = (standings: WeekStandings) => {
    if (!run.dryRun) saveStandings(run.stateFile, standings);
  };

  if (week && week.weekStart !== weekStartHour(hour).toISOString()) {
    // The Monday 00:01 run was missed, so publish last week's final result before starting over.
    if (!week.finalPosted && week.updates > 0) {
      await post(weeklyFinalMessage(week));
      save({ ...week, finalPosted: true });
    }
    week = null;
  }

  const final = isFinalHourOfWeek(hour);
  const updated = { ...addHour(week ?? createWeek(run.kingdom, hour), snapshot, hour), finalPosted: final };
  await post(final ? weeklyFinalMessage(updated, snapshot, hour) : hourlyMessage(snapshot, updated, hour));
  save(updated);
  const snapshotUsed = run.snapshotFile && !run.dryRun
    ? recordSnapshot(run.snapshotFile, snapshot, hour, fetchedAt)
    : snapshotUse(snapshot, hour, fetchedAt);
  return { status: "posted", snapshotUsed };
}
