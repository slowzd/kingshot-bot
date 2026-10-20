import { dailyMessage, splitMessage, weeklyFinalMessage } from "./format.ts";
import type { PowerSnapshot } from "./mightpulse.ts";
import { loadSnapshotLog, recordSnapshot, snapshotUse, type SnapshotUse } from "./snapshot-log.ts";
import { addUpdate, createWeek, loadStandings, replaceDailyUpdate, saveStandings, type WeekStandings } from "./standings.ts";
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
  /** Bypasses daily slot and freshness guards for a test post without saving any state. */
  force?: boolean;
  /** Replaces this UTC date's accepted sample; never creates an extra daily observation. */
  correctionDate?: string;
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
  if (run.force && run.correctionDate) throw new Error("Correction and forced test modes cannot be combined.");
  const hour = dueUpdate(run.now);
  let week = loadStandings(run.stateFile);
  const correctionLog = run.correctionDate && run.snapshotFile ? loadSnapshotLog(run.snapshotFile) : null;
  if (run.correctionDate) {
    if (
      run.correctionDate !== run.now.toISOString().slice(0, 10) ||
      run.correctionDate !== hour.toISOString().slice(0, 10)
    ) throw new Error("A correction must run on its requested UTC date, at or after 01:01 UTC.");
    if (
      !week || week.kingdom !== run.kingdom || week.version !== 2 ||
      week.weekStart !== weekStart(hour).toISOString() || week.finalPosted ||
      run.now >= weekFinal(new Date(week.weekStart)) || week.lastHour !== hourKey(hour) ||
      !correctionLog || correctionLog.kingdom !== run.kingdom ||
      correctionLog.latest.update !== hour.toISOString() ||
      !Array.isArray(correctionLog.latest.alliances) ||
      (week.lastApiCapturedAt && week.lastApiCapturedAt !== correctionLog.latest.apiCapturedAt)
    ) throw new Error("Cannot safely correct: today's saved standings and matching daily snapshot are required.");
  }
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

  if (!run.force && !run.correctionDate && week?.lastHour && week.lastHour >= hourKey(hour)) {
    return skip("The latest daily slot has already been posted.");
  }

  const fetched = await run.fetchSnapshot();
  const fetchedAt = new Date();
  if (!run.force) {
    const captureTime = fetched.capturedAt.getTime();
    if (!Number.isFinite(captureTime) || captureTime > run.now.getTime()) {
      throw new Error("Mightpulse returned an invalid or future capture timestamp.");
    }
    const captureDay = fetched.capturedAt.toISOString().slice(0, 10);
    if (captureDay !== hour.toISOString().slice(0, 10)) {
      if (run.correctionDate) throw new Error("Mightpulse has no capture for today's UTC date; correction not posted.");
      return skip(`Waiting for Mightpulse data for ${hour.toISOString().slice(0, 10)} UTC; latest capture is ${fetched.capturedAt.toISOString()}.`);
    }
    const previousLog = run.snapshotFile && !week?.lastApiCapturedAt
      ? loadSnapshotLog(run.snapshotFile)
      : null;
    const lastCapture = week?.lastApiCapturedAt ??
      (previousLog?.kingdom === run.kingdom ? previousLog.latest.apiCapturedAt : undefined);
    if (!run.correctionDate && lastCapture && captureTime <= Date.parse(lastCapture)) {
      return skip(`Waiting for a newer Mightpulse capture; ${lastCapture} has already been used.`);
    }
  }
  const snapshot = {
    ...fetched,
    alliances: fetched.alliances.filter(({ rank }) => rank <= 10).sort((a, b) => a.rank - b.rank),
  };
  if (!snapshot.alliances.length) throw new Error("Mightpulse returned no top-10 Alliance Power data.");
  if (week && week.weekStart !== weekStart(hour).toISOString()) {
    week = null;
  }

  const updated = {
    ...(run.correctionDate && week && correctionLog
      ? replaceDailyUpdate(week, correctionLog.latest.alliances, snapshot, hour)
      : addUpdate(week ?? createWeek(run.kingdom, hour), week?.version === 1 ? fetched : snapshot, hour)),
    finalPosted: false,
    lastPostedAt: run.now.toISOString(),
    lastApiCapturedAt: snapshot.capturedAt.toISOString(),
  };
  await post(`${run.correctionDate ? "**Corrected daily update — replaces today's earlier ranking**\n\n" : ""}${dailyMessage(snapshot, updated, hour)}`);
  save(updated);
  const snapshotUsed = run.snapshotFile && !run.dryRun && !run.force
    ? recordSnapshot(run.snapshotFile, snapshot, hour, fetchedAt, Boolean(run.correctionDate))
    : snapshotUse(snapshot, hour, fetchedAt);
  return { status: "posted", snapshotUsed };
}
