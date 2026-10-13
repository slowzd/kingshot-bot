export interface AllianceRank {
  id: number;
  rank: number;
  tag: string;
  name: string;
  power: string;
}

export interface AllianceSnapshot {
  kingdom: number;
  capturedAt: Date;
  alliances: AllianceRank[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseAllianceSnapshot(
  data: unknown,
  kingdom: number,
): AllianceSnapshot {
  if (
    !isRecord(data) ||
    data.ok !== true ||
    data.kid !== kingdom ||
    !isRecord(data.boards)
  ) {
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
    throw new Error(`Mightpulse has no valid Alliance Power board for kingdom ${kingdom}.`);
  }

  const capturedAt = new Date(board.captured_at * 1000);
  if (!Number.isFinite(capturedAt.getTime())) {
    throw new Error("Mightpulse returned an invalid Alliance Power capture timestamp.");
  }

  const ids = new Set<number>();
  const ranks = new Set<number>();
  const alliances = board.rows.map((row: unknown): AllianceRank => {
    if (
      !isRecord(row) ||
      !isPositiveInteger(row.aid) ||
      !isPositiveInteger(row.rank) ||
      row.kid !== kingdom ||
      typeof row.name !== "string" ||
      !row.name.trim() ||
      typeof row.abbr !== "string" ||
      typeof row.game_power !== "number" ||
      !Number.isSafeInteger(row.game_power) ||
      row.game_power < 0
    ) {
      throw new Error("Mightpulse returned an invalid Alliance Power row.");
    }
    if (ids.has(row.aid) || ranks.has(row.rank)) {
      throw new Error("Mightpulse returned duplicate Alliance Power IDs or ranks.");
    }
    ids.add(row.aid);
    ranks.add(row.rank);
    return {
      id: row.aid,
      rank: row.rank,
      tag: row.abbr.trim(),
      name: row.name.trim(),
      power: row.game_power.toLocaleString("en-US"),
    };
  });

  alliances.sort((a, b) => a.rank - b.rank);
  return { kingdom, capturedAt, alliances };
}

export async function fetchAllianceSnapshot(
  kingdom: number,
): Promise<AllianceSnapshot> {
  if (!isPositiveInteger(kingdom)) {
    throw new Error("KINGDOM must be a positive safe integer.");
  }

  const response = await fetch(
    `https://mightpulse.com/api/kingdoms/${kingdom}/ingame-ranks`,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Mightpulse rankings request failed: HTTP ${response.status}.`);
  }
  const data: unknown = await response.json();
  return parseAllianceSnapshot(data, kingdom);
}
