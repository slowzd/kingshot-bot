import { hourlyMessage, splitMessage, weeklyFinalMessage } from "./format.ts";
import type { PowerSnapshot } from "./mightpulse.ts";
import { addHour, createWeek, loadStandings, saveStandings, type WeekStandings } from "./standings.ts";
import { dueHour, hourKey, isFinalHourOfWeek, weekStartHour } from "./time.ts";

export interface HourlyRun {
  now: Date;
  kingdom: number;
  stateFile: string;
  fetchSnapshot: () => Promise<PowerSnapshot>;
  send: (content: string) => Promise<void>;
  /** Prints messages without saving standings. */
  dryRun?: boolean;
}

export async function runHourlyUpdate(run: HourlyRun): Promise<"posted" | "already-posted"> {
  const hour = dueHour(run.now);
  let week = loadStandings(run.stateFile);
  if (week && week.kingdom !== run.kingdom) {
    console.warn(`Saved standings are for kingdom ${week.kingdom}; starting new standings for ${run.kingdom}.`);
    week = null;
  }
  if (week?.lastHour && week.lastHour >= hourKey(hour)) {
    console.log(`The ${hourKey(hour)}:01 UTC update was already posted.`);
    return "already-posted";
  }

  const snapshot = await run.fetchSnapshot();
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
  return "posted";
}
