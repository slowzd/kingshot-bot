import { dailyMessage, splitMessage, weeklyFinalMessage } from "./format.ts";
import type { PowerSnapshot } from "./mightpulse.ts";
import { recordSnapshot, snapshotUse, type SnapshotUse } from "./snapshot-log.ts";
import { addUpdate, createWeek, loadStandings, saveStandings, type WeekStandings } from "./standings.ts";
import { dueUpdate, hourKey, weekFinal, weekStart } from "./time.ts";

export interface DailyRun {
  now: Date;
  kingdom: number;
  stateFile: string;
  /** Generated .ts file recording which API snapshot each update used. */
  snapshotFile?: string;
  fetchSnapshot: () => Promise<PowerSnapshot>;
  send: (content: string) => Promise<void>;
  /** Prints messages without saving standings. */
  dryRun?: boolean;
  /** Bypasses daily guards for a test post without saving any state. */
  force?: boolean;
}

export type DailyResult = {
  status: "posted";
  snapshotUsed: SnapshotUse;
} | {
  status: "weekly-posted";
} | {
  status: "skipped";
  reason: string;
};

export async function runDailyUpdate(run: DailyRun): Promise<DailyResult> {
  const hour = dueUpdate(run.now);
  let week = loadStandings(run.stateFile);
  if (week && week.kingdom !== run.kingdom) {
    console.warn(`Saved standings are for kingdom ${week.kingdom}; starting new standings for ${run.kingdom}.`);
    week = null;
  }

  const post = async (message: string) => {
    for (const part of splitMessage(message)) await run.send(part);
  };
  const save = (standings: WeekStandings) => {
    if (!run.dryRun && !run.force) saveStandings(run.stateFile, standings);
  };
  let weeklyPosted = false;
  if (week && !week.finalPosted && week.updates > 0 && run.now >= weekFinal(new Date(week.weekStart))) {
    await post(weeklyFinalMessage(week));
    week = { ...week, finalPosted: true };
    save(week);
    weeklyPosted = true;
  }
  const skip = (reason: string): DailyResult => weeklyPosted
    ? { status: "weekly-posted" }
    : { status: "skipped", reason };

  // Once the weekly summary is published, never add a late score to that closed week.
  if (
    run.now >= weekFinal(weekStart(hour)) ||
    (week?.finalPosted && week.weekStart === weekStart(hour).toISOString())
  ) {
    return skip("The completed week is closed; the new daily ranking starts Monday 01:01 UTC.");
  }

  if (!run.force && week?.lastHour) {
    // Legacy state has only the scheduled hourly time, not an exact posting timestamp.
    const lastPostedAt = week.lastPostedAt ?? `${week.lastHour}:01:00.000Z`;
    if (run.now.getTime() - Date.parse(lastPostedAt) < 23 * 60 * 60 * 1000) {
      return skip("The last successful daily update was less than 23 hours ago.");
    }
    if (week.lastHour >= hourKey(hour)) {
      return skip("The latest daily slot has already been posted.");
    }
  }

  const snapshot = await run.fetchSnapshot();
  const fetchedAt = new Date();
  if (week && week.weekStart !== weekStart(hour).toISOString()) {
    week = null;
  }

  const updated = {
    ...addUpdate(week ?? createWeek(run.kingdom, hour), snapshot, hour),
    finalPosted: false,
    lastPostedAt: run.now.toISOString(),
  };
  await post(dailyMessage(snapshot, updated, hour));
  save(updated);
  const snapshotUsed = run.snapshotFile && !run.dryRun && !run.force
    ? recordSnapshot(run.snapshotFile, snapshot, hour, fetchedAt)
    : snapshotUse(snapshot, hour, fetchedAt);
  return { status: "posted", snapshotUsed };
}
