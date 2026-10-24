import fs from "node:fs";
import path from "node:path";
import { TRACKED_ALLIANCE_LIMIT, type Alliance, type PowerSnapshot } from "./mightpulse.ts";
import { hourKey, weekStart } from "./time.ts";

interface AllianceIdentity {
  id: number;
  tag: string;
  name: string;
}

export interface PowerStanding extends AllianceIdentity {
  totalPower: number;
  observations: number;
}

export interface WeekStandings {
  version: 2;
  kingdom: number;
  weekStart: string;
  updates: number;
  lastHour: string | null;
  /** Actual run time of the last successful daily update. */
  lastPostedAt?: string;
  /** Source capture accepted by the last successful daily update. */
  lastApiCapturedAt?: string;
  finalPosted: boolean;
  alliances: PowerStanding[];
}

export function createWeek(kingdom: number, hour: Date): WeekStandings {
  return {
    version: 2,
    kingdom,
    weekStart: weekStart(hour).toISOString(),
    updates: 0,
    lastHour: null,
    finalPosted: false,
    alliances: [],
  };
}

export function addUpdate(week: WeekStandings, snapshot: PowerSnapshot, hour: Date): WeekStandings {
  if (week.kingdom !== snapshot.kingdom || week.weekStart !== weekStart(hour).toISOString()) {
    throw new Error("Standings do not belong to this kingdom and week.");
  }
  const key = hourKey(hour);
  if (week.lastHour !== null && key < week.lastHour) {
    throw new Error(`Hour ${key} is older than the last counted hour ${week.lastHour}.`);
  }

  const alliances = new Map(week.alliances.map((alliance) => [alliance.id, alliance]));
  for (const alliance of snapshot.alliances) {
    if (alliance.rank > TRACKED_ALLIANCE_LIMIT) continue;
    const previous = alliances.get(alliance.id);
    const totalPower = (previous?.totalPower ?? 0) + alliance.power;
    if (!Number.isSafeInteger(totalPower)) throw new Error(`Power total for alliance ${alliance.id} exceeds safe integer precision.`);
    alliances.set(alliance.id, {
      id: alliance.id,
      tag: alliance.tag,
      name: alliance.name,
      totalPower,
      observations: (previous?.observations ?? 0) + 1,
    });
  }
  return { ...week, updates: week.updates + 1, lastHour: key, alliances: [...alliances.values()] };
}

export function cumulativeRanking(week: WeekStandings): (AllianceIdentity & { value: number })[] {
  return week.alliances
    .map((alliance) => ({ ...alliance, value: alliance.totalPower / alliance.observations }))
    .sort((a, b) => b.value - a.value || a.id - b.id);
}

export function replaceDailyUpdate(
  week: WeekStandings,
  previous: Alliance[],
  snapshot: PowerSnapshot,
  hour: Date,
): WeekStandings {
  if (week.finalPosted || week.updates < 1 || week.lastHour !== hourKey(hour)) {
    throw new Error("Corrections require an existing daily average-power update in the current open week.");
  }
  const removed = new Map<number, Alliance>();
  for (const alliance of previous) {
    if (removed.has(alliance.id) || !Number.isSafeInteger(alliance.power) || alliance.power < 0) {
      throw new Error("The saved daily snapshot contains invalid or duplicate power data.");
    }
    removed.set(alliance.id, alliance);
  }
  if (!removed.size) throw new Error("The saved daily snapshot has no alliance data to replace.");
  const alliances: PowerStanding[] = [];
  for (const standing of week.alliances) {
    const old = removed.get(standing.id);
    if (!old) {
      if (standing.observations > week.updates - 1) {
        throw new Error("The saved daily snapshot is incomplete; cannot safely replace its sample.");
      }
      alliances.push(standing);
      continue;
    }
    removed.delete(standing.id);
    const totalPower = standing.totalPower - old.power;
    const observations = standing.observations - 1;
    if (totalPower < 0 || (observations === 0 && totalPower !== 0)) {
      throw new Error("The saved daily snapshot does not match the saved power totals.");
    }
    if (observations > 0) alliances.push({ ...standing, totalPower, observations });
  }
  if (removed.size) throw new Error("The saved daily snapshot does not match the saved alliances.");
  return addUpdate({ ...week, updates: week.updates - 1, alliances }, snapshot, hour);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isWeekStandings(data: unknown): data is WeekStandings {
  return !(
    !isRecord(data) ||
    data.version !== 2 ||
    !isCount(data.kingdom) ||
    typeof data.weekStart !== "string" ||
    !Number.isFinite(Date.parse(data.weekStart)) ||
    !isCount(data.updates) ||
    !(data.lastHour === null || (typeof data.lastHour === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(data.lastHour))) ||
    !(data.lastPostedAt === undefined || (typeof data.lastPostedAt === "string" && Number.isFinite(Date.parse(data.lastPostedAt)))) ||
    !(data.lastApiCapturedAt === undefined || (typeof data.lastApiCapturedAt === "string" && Number.isFinite(Date.parse(data.lastApiCapturedAt)))) ||
    typeof data.finalPosted !== "boolean" ||
    !Array.isArray(data.alliances) ||
    !data.alliances.every((row) =>
      isRecord(row) && isCount(row.id) && typeof row.tag === "string" &&
      typeof row.name === "string" &&
      isCount(row.totalPower) && isCount(row.observations) &&
      row.observations > 0 && row.observations <= Number(data.updates))
  );
}

export function loadStandings(file: string): WeekStandings | null {
  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const data: unknown = JSON.parse(contents);
  if (isRecord(data) && data.version !== 2) {
    throw new Error(`Saved standings in ${file} use unsupported version ${String(data.version)}; only version 2 average-power standings are supported.`);
  }
  if (!isWeekStandings(data)) {
    throw new Error(`Saved standings in ${file} are invalid.`);
  }
  return data;
}

export function saveStandings(file: string, week: WeekStandings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(week, null, 2)}\n`);
  fs.renameSync(temporary, file);
}
