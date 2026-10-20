export const TRACKED_ALLIANCE_LIMIT = 20;

export interface Alliance {
  id: number;
  rank: number;
  tag: string;
  name: string;
  power: number;
}

export interface PowerSnapshot {
  kingdom: number;
  capturedAt: Date;
  alliances: Alliance[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parsePowerSnapshot(data: unknown, kingdom: number): PowerSnapshot {
  if (!isRecord(data) || data.ok !== true || data.kid !== kingdom || !isRecord(data.boards)) {
    throw new Error(`Mightpulse returned an invalid response for kingdom ${kingdom}.`);
  }
  const board = data.boards["1"];
  if (
    !isRecord(board) ||
    board.type !== 1 ||
    typeof board.captured_at !== "number" ||
    !Number.isFinite(board.captured_at) ||
    board.captured_at <= 0 ||
    !Array.isArray(board.rows) ||
    board.rows.length === 0
  ) {
    throw new Error(`Mightpulse has no Alliance Power ranking for kingdom ${kingdom}.`);
  }

  const ids = new Set<number>();
  const ranks = new Set<number>();
  const alliances = board.rows.map((row: unknown): Alliance => {
    if (
      !isRecord(row) ||
      !isPositiveInteger(row.aid) ||
      !isPositiveInteger(row.rank) ||
      row.kid !== kingdom ||
      typeof row.name !== "string" ||
      !row.name.trim() ||
      typeof row.abbr !== "string" ||
      typeof row.score !== "number" ||
      !Number.isSafeInteger(row.score) ||
      row.score < 0
    ) {
      throw new Error("Mightpulse returned an invalid Alliance Power row.");
    }
    if (ids.has(row.aid) || ranks.has(row.rank)) {
      throw new Error("Mightpulse returned duplicate alliances or ranks.");
    }
    ids.add(row.aid);
    ranks.add(row.rank);
    return { id: row.aid, rank: row.rank, tag: row.abbr.trim(), name: row.name.trim(), power: row.score };
  });

  alliances.sort((a, b) => a.rank - b.rank);
  return { kingdom, capturedAt: new Date(board.captured_at * 1000), alliances };
}

export async function fetchPowerSnapshot(kingdom: number): Promise<PowerSnapshot> {
  const response = await fetch(
    `https://mightpulse.com/api/kingdoms/${kingdom}/ingame-ranks`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Mightpulse API request failed: HTTP ${response.status}.`);
  }
  return parsePowerSnapshot(await response.json(), kingdom);
}
