import fs from "node:fs";
import path from "node:path";
import type { AllianceSnapshot } from "./rankings.js";

export interface CumulativeAlliance {
  id: number;
  tag: string;
  name: string;
  total: number;
}

export interface CumulativeRanking {
  kingdom: number;
  week: string;
  updates: number;
  lastSlot: string | null;
  alliances: CumulativeAlliance[];
}

export function getRankingWeek(now: Date): string {
  const monday = new Date(now.getTime() - 60_000);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  monday.setUTCHours(0, 1, 0, 0);
  return monday.toISOString();
}

function getFile(kingdom: number): string {
  return path.resolve("snapshots", `cumulative-ranking-${kingdom}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function loadCumulativeRanking(kingdom: number, now: Date): CumulativeRanking {
  const empty: CumulativeRanking = {
    kingdom, week: getRankingWeek(now), updates: 0, lastSlot: null, alliances: [],
  };
  let contents: string;
  try {
    contents = fs.readFileSync(getFile(kingdom), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return empty;
    throw error;
  }
  const data: unknown = JSON.parse(contents);
  if (
    !isRecord(data) || data.kingdom !== kingdom ||
    typeof data.week !== "string" ||
    !Number.isFinite(Date.parse(data.week)) ||
    getRankingWeek(new Date(data.week)) !== data.week ||
    !isNonnegativeInteger(data.updates) ||
    !(data.lastSlot === null || (
      typeof data.lastSlot === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(data.lastSlot)
    )) ||
    !Array.isArray(data.alliances)
  ) throw new Error(`Invalid cumulative ranking in ${getFile(kingdom)}.`);

  const updates = data.updates;
  const ids = new Set<number>();
  const alliances = data.alliances.map((row: unknown): CumulativeAlliance => {
    if (
      !isRecord(row) || !isNonnegativeInteger(row.id) || row.id === 0 ||
      typeof row.tag !== "string" || typeof row.name !== "string" ||
      !isNonnegativeInteger(row.total) || row.total < updates ||
      row.total > updates * 11 || ids.has(row.id)
    ) throw new Error(`Invalid cumulative alliance in ${getFile(kingdom)}.`);
    ids.add(row.id);
    return { id: row.id, tag: row.tag, name: row.name, total: row.total };
  });
  if (data.week !== empty.week) return empty;
  return {
    kingdom, week: data.week, updates: data.updates,
    lastSlot: data.lastSlot, alliances,
  };
}

export function addHourlyRanking(
  previous: CumulativeRanking,
  snapshot: AllianceSnapshot,
  now: Date,
): CumulativeRanking {
  if (previous.kingdom !== snapshot.kingdom || previous.week !== getRankingWeek(now)) {
    throw new Error("Cumulative ranking does not match the kingdom or current week.");
  }
  const slot = new Date(now.getTime() - 60_000).toISOString().slice(0, 13);
  if (previous.lastSlot !== null && slot <= previous.lastSlot) return previous;

  const top = snapshot.alliances.filter((alliance) => alliance.rank <= 10);
  const ranks = new Map(top.map((alliance) => [alliance.id, alliance.rank]));
  const entries = new Map(previous.alliances.map((alliance) => [
    alliance.id, { ...alliance, total: alliance.total + (ranks.get(alliance.id) ?? 11) },
  ]));
  for (const alliance of top) {
    const entry = entries.get(alliance.id);
    entries.set(alliance.id, {
      id: alliance.id, tag: alliance.tag, name: alliance.name,
      total: entry?.total ?? previous.updates * 11 + alliance.rank,
    });
  }
  return {
    ...previous, updates: previous.updates + 1, lastSlot: slot,
    alliances: [...entries.values()],
  };
}

export function saveCumulativeRanking(ranking: CumulativeRanking): void {
  const file = getFile(ranking.kingdom);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(ranking, null, 2));
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
