import fs from "node:fs";
import path from "node:path";
import type { PowerSnapshot } from "./mightpulse.ts";
import { hourKey, weekStartHour } from "./time.ts";

export interface Standing {
  id: number;
  tag: string;
  name: string;
  points: number;
}

export interface WeekStandings {
  version: 1;
  kingdom: number;
  weekStart: string;
  updates: number;
  /** Points an alliance would have collected if it was unranked in every counted hour. */
  absentPoints: number;
  lastHour: string | null;
  finalPosted: boolean;
  alliances: Standing[];
}

export function createWeek(kingdom: number, hour: Date): WeekStandings {
  return {
    version: 1,
    kingdom,
    weekStart: weekStartHour(hour).toISOString(),
    updates: 0,
    absentPoints: 0,
    lastHour: null,
    finalPosted: false,
    alliances: [],
  };
}

/** Adds each alliance's current rank as points; alliances outside the API list get last rank + 1. */
export function addHour(week: WeekStandings, snapshot: PowerSnapshot, hour: Date): WeekStandings {
  if (week.kingdom !== snapshot.kingdom || week.weekStart !== weekStartHour(hour).toISOString()) {
    throw new Error("Standings do not belong to this kingdom and week.");
  }
  const key = hourKey(hour);
  if (week.lastHour !== null && key <= week.lastHour) {
    throw new Error(`Hour ${key} has already been counted.`);
  }

  const current = new Map(snapshot.alliances.map((alliance) => [alliance.id, alliance]));
  const absent = Math.max(...snapshot.alliances.map((alliance) => alliance.rank)) + 1;
  const alliances = week.alliances.map((standing): Standing => {
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

export function cumulativeRanking(week: WeekStandings): Standing[] {
  return [...week.alliances].sort((a, b) => a.points - b.points || a.id - b.id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
  if (
    !isRecord(data) ||
    data.version !== 1 ||
    !isCount(data.kingdom) ||
    typeof data.weekStart !== "string" ||
    !Number.isFinite(Date.parse(data.weekStart)) ||
    !isCount(data.updates) ||
    !isCount(data.absentPoints) ||
    !(data.lastHour === null || (typeof data.lastHour === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(data.lastHour))) ||
    typeof data.finalPosted !== "boolean" ||
    !Array.isArray(data.alliances) ||
    !data.alliances.every((row) =>
      isRecord(row) && isCount(row.id) && typeof row.tag === "string" &&
      typeof row.name === "string" && isCount(row.points))
  ) {
    throw new Error(`Saved standings in ${file} are invalid.`);
  }
  return data as unknown as WeekStandings;
}

export function saveStandings(file: string, week: WeekStandings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(week, null, 2)}\n`);
  fs.renameSync(temporary, file);
}
