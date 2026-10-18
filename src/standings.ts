import fs from "node:fs";
import path from "node:path";
import type { PowerSnapshot } from "./mightpulse.ts";
import { hourKey, weekStart } from "./time.ts";

interface AllianceIdentity {
  id: number;
  tag: string;
  name: string;
}

export interface PointStanding extends AllianceIdentity {
  points: number;
}

export interface PowerStanding extends AllianceIdentity {
  totalPower: number;
  observations: number;
  reachedTop10: boolean;
}

interface WeekBase {
  kingdom: number;
  weekStart: string;
  updates: number;
  lastHour: string | null;
  /** Actual run time of the last successful daily update; absent in legacy hourly state. */
  lastPostedAt?: string;
  finalPosted: boolean;
}

export interface PointWeek extends WeekBase {
  version: 1;
  absentPoints: number;
  alliances: PointStanding[];
}

export interface PowerWeek extends WeekBase {
  version: 2;
  alliances: PowerStanding[];
}

export type WeekStandings = PointWeek | PowerWeek;

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

/** Legacy point weeks finish unchanged; new weeks accumulate observed daily power. */
export function addUpdate(week: WeekStandings, snapshot: PowerSnapshot, hour: Date): WeekStandings {
  if (week.kingdom !== snapshot.kingdom || week.weekStart !== weekStart(hour).toISOString()) {
    throw new Error("Standings do not belong to this kingdom and week.");
  }
  const key = hourKey(hour);
  if (week.lastHour !== null && key < week.lastHour) {
    throw new Error(`Hour ${key} is older than the last counted hour ${week.lastHour}.`);
  }

  if (week.version === 2) {
    const alliances = new Map(week.alliances.map((alliance) => [alliance.id, alliance]));
    for (const alliance of snapshot.alliances) {
      const previous = alliances.get(alliance.id);
      const totalPower = (previous?.totalPower ?? 0) + alliance.power;
      if (!Number.isSafeInteger(totalPower)) throw new Error(`Power total for alliance ${alliance.id} exceeds safe integer precision.`);
      alliances.set(alliance.id, {
        id: alliance.id,
        tag: alliance.tag,
        name: alliance.name,
        totalPower,
        observations: (previous?.observations ?? 0) + 1,
        reachedTop10: (previous?.reachedTop10 ?? false) || alliance.rank <= 10,
      });
    }
    return { ...week, updates: week.updates + 1, lastHour: key, alliances: [...alliances.values()] };
  }

  const current = new Map(snapshot.alliances.map((alliance) => [alliance.id, alliance]));
  const absent = Math.max(...snapshot.alliances.map((alliance) => alliance.rank)) + 1;
  const alliances = week.alliances.map((standing): PointStanding => {
    const alliance = current.get(standing.id);
    return alliance
      ? { id: alliance.id, tag: alliance.tag, name: alliance.name, points: standing.points + alliance.rank }
      : { ...standing, points: standing.points + absent };
  });
  const known = new Set(week.alliances.map((standing) => standing.id));
  for (const alliance of snapshot.alliances) {
    if (!known.has(alliance.id)) {
      alliances.push({
        id: alliance.id,
        tag: alliance.tag,
        name: alliance.name,
        points: week.absentPoints + alliance.rank,
      });
    }
  }

  return {
    ...week,
    updates: week.updates + 1,
    absentPoints: week.absentPoints + absent,
    lastHour: key,
    alliances,
  };
}

export function cumulativeRanking(week: WeekStandings): (AllianceIdentity & { value: number })[] {
  if (week.version === 1) {
    return [...week.alliances]
      .sort((a, b) => a.points - b.points || a.id - b.id)
      .map((alliance) => ({ ...alliance, value: alliance.points }));
  }
  return week.alliances
    .filter((alliance) => alliance.reachedTop10)
    .map((alliance) => ({ ...alliance, value: alliance.totalPower / alliance.observations }))
    .sort((a, b) => b.value - a.value || a.id - b.id);
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
    !(data.version === 1 || data.version === 2) ||
    !isCount(data.kingdom) ||
    typeof data.weekStart !== "string" ||
    !Number.isFinite(Date.parse(data.weekStart)) ||
    !isCount(data.updates) ||
    !(data.lastHour === null || (typeof data.lastHour === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(data.lastHour))) ||
    !(data.lastPostedAt === undefined || (typeof data.lastPostedAt === "string" && Number.isFinite(Date.parse(data.lastPostedAt)))) ||
    typeof data.finalPosted !== "boolean" ||
    !Array.isArray(data.alliances) ||
    !data.alliances.every((row) =>
      isRecord(row) && isCount(row.id) && typeof row.tag === "string" &&
      typeof row.name === "string" &&
      (data.version === 1
        ? isCount(row.points)
        : isCount(row.totalPower) && isCount(row.observations) &&
          row.observations > 0 && row.observations <= Number(data.updates) &&
          typeof row.reachedTop10 === "boolean")) ||
    (data.version === 1 && !isCount(data.absentPoints))
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
