import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { formatLeaderboard, publishLeaderboard, splitLeaderboardMessages } from "./leaderboard.js";
import {
  addHourlyRanking,
  getRankingWeek,
  loadCumulativeRanking,
  saveCumulativeRanking,
  type CumulativeRanking,
} from "./cumulative-ranking.js";
import { fetchAllianceSnapshot, parseAllianceSnapshot } from "./rankings.js";

const firstHour = new Date("2026-10-13T01:01:00Z");

function apiRow(id = 101, rank = 1, power = 3_441_150_819) {
  return {
    aid: id, rank, kid: 2426, name: `Alliance ${id}`, abbr: `T${id}`,
    game_power: power, score: 123,
  };
}

function apiResponse(rows = [apiRow()]) {
  return {
    ok: true, kid: 2426,
    boards: {
      "1": {
        type: 1, name: "Alliance Power",
        captured_at: Date.parse("2026-10-13T00:41:03Z") / 1000,
        rows,
      },
      "9": { type: 9, name: "Troop Power", rows: [] },
    },
  };
}

function empty(): CumulativeRanking {
  return {
    kingdom: 2426, week: getRankingWeek(firstHour),
    updates: 0, lastSlot: null, alliances: [],
  };
}

test("reads exact alliance power, ranks and capture time; rejects invalid API data", () => {
  const snapshot = parseAllianceSnapshot(apiResponse([apiRow(102, 2), apiRow()]), 2426);
  assert.deepEqual(snapshot.alliances.map((row) => row.id), [101, 102]);
  assert.equal(snapshot.alliances[0].power, "3,441,150,819");
  assert.equal(snapshot.capturedAt.toISOString(), "2026-10-13T00:41:03.000Z");
  assert.throws(() => parseAllianceSnapshot({ ...apiResponse(), ok: false }, 2426));
  assert.throws(() => parseAllianceSnapshot(apiResponse(), 2446));
  assert.throws(() => parseAllianceSnapshot({ ...apiResponse(), boards: {} }, 2426));
  assert.throws(() => parseAllianceSnapshot(apiResponse([]), 2426));
  for (const power of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseAllianceSnapshot(apiResponse([apiRow(101, 1, power)]), 2426));
  }
  assert.throws(() => parseAllianceSnapshot(apiResponse([apiRow(), apiRow(101, 2)]), 2426));
  assert.throws(() => parseAllianceSnapshot(apiResponse([apiRow(), apiRow(102, 1)]), 2426));
  assert.throws(() => parseAllianceSnapshot(apiResponse([{ ...apiRow(), kid: 2446 }]), 2426));
});

test("three first places total 3, repeated slots do not count, unchanged API snapshots do", () => {
  const snapshot = parseAllianceSnapshot(apiResponse(), 2426);
  let ranking = empty();
  for (let hour = 1; hour <= 3; hour++) {
    const now = new Date(`2026-10-13T0${hour}:01:00Z`);
    ranking = addHourlyRanking(ranking, snapshot, now);
    assert.equal(addHourlyRanking(ranking, snapshot, now), ranking);
  }
  assert.equal(ranking.updates, 3);
  assert.equal(ranking.alliances[0].total, 3);
  assert.equal(addHourlyRanking(ranking, snapshot, firstHour), ranking);
});

test("applies rank 11 to dropouts and backfills new entrants; tracks IDs across renames", () => {
  const first = parseAllianceSnapshot(apiResponse([apiRow(), apiRow(102, 2)]), 2426);
  let ranking = addHourlyRanking(empty(), first, firstHour);
  const second = parseAllianceSnapshot(apiResponse([
    { ...apiRow(102, 1), name: "Renamed", abbr: "NEW" },
    apiRow(103, 2), apiRow(101, 11),
  ]), 2426);
  ranking = addHourlyRanking(ranking, second, new Date("2026-10-13T02:01:00Z"));
  assert.equal(ranking.alliances.find((row) => row.id === 101)?.total, 12);
  assert.equal(ranking.alliances.find((row) => row.id === 102)?.total, 3);
  assert.equal(ranking.alliances.find((row) => row.id === 102)?.name, "Renamed");
  assert.equal(ranking.alliances.find((row) => row.id === 103)?.total, 13);
});

test("weekly boundary is Monday 00:01 UTC, not midnight", () => {
  assert.equal(getRankingWeek(new Date("2026-10-19T00:00:59.999Z")), "2026-10-12T00:01:00.000Z");
  assert.equal(getRankingWeek(new Date("2026-10-19T00:01:00Z")), "2026-10-19T00:01:00.000Z");
  assert.equal(getRankingWeek(new Date("2027-01-01T01:01:00Z")), "2026-12-28T00:01:00.000Z");
});

test("new entrants remain visible beyond ten cumulative entries and long lists split", () => {
  const first = parseAllianceSnapshot(apiResponse(
    Array.from({ length: 10 }, (_, index) => apiRow(index + 1, index + 1)),
  ), 2426);
  let ranking = addHourlyRanking(empty(), first, firstHour);
  const next = parseAllianceSnapshot(apiResponse([
    apiRow(11, 1),
    ...Array.from({ length: 9 }, (_, index) => apiRow(index + 1, index + 2)),
  ]), 2426);
  ranking = addHourlyRanking(ranking, next, new Date("2026-10-13T02:01:00Z"));
  const message = formatLeaderboard(next, ranking);
  const cumulative = message.split("**Cumulative Power**")[1];
  assert.equal(cumulative.match(/Cumulative rank:/g)?.length, 11);
  assert.ok(cumulative.includes("Alliance 11 | Cumulative rank: 12"));
  assert.ok(cumulative.includes("Alliance 10 | Cumulative rank: 21"));
  const largeRanking = {
    ...ranking,
    alliances: Array.from({ length: 100 }, (_, index) => ({
      id: index + 1, tag: `T${index + 1}`, name: `Alliance ${index + 1}`, total: 12,
    })),
  };
  const largeMessage = formatLeaderboard(next, largeRanking);
  const parts = splitLeaderboardMessages(largeMessage);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 2000));
  assert.equal(parts.join("\n"), largeMessage);
  assert.equal(parts.join("\n").match(/Cumulative rank:/g)?.length, 100);
});

test("separate cumulative section sorts lowest first and removes power deltas", () => {
  const snapshot = parseAllianceSnapshot(apiResponse(
    Array.from({ length: 12 }, (_, index) => apiRow(index + 1, index + 1)),
  ), 2426);
  snapshot.alliances[0].name = "*Winners*";
  const ranking = addHourlyRanking(empty(), snapshot, firstHour);
  const message = formatLeaderboard(snapshot, ranking);
  assert.ok(message.includes("\\*Winners\\*"));
  assert.ok(message.includes("**Cumulative Power**"));
  assert.ok(message.includes("Cumulative rank: 1"));
  assert.ok(!message.includes("Δ"));
  assert.ok(!message.includes("#11 "));
  assert.ok(message.includes("2026-10-13 00:41 UTC"));
  assert.ok(message.length <= 2000);
  const initialRanking = empty();
  const initialMessage = formatLeaderboard(snapshot, initialRanking);
  assert.equal(initialMessage.match(/Cumulative rank: 0/g)?.length, 10);
  assert.ok(!initialMessage.includes("No hourly updates"));
  assert.ok(initialMessage.includes("0 hourly updates"));
  assert.ok(initialMessage.includes("#1 [T1] \\*Winners\\* | Cumulative rank: 0"));
  assert.equal(initialRanking.updates, 0);
  assert.deepEqual(initialRanking.alliances, []);
  const cumulativeText = message.split("**Cumulative Power**")[1];
  assert.ok(cumulativeText.indexOf("Cumulative rank: 1\n") < cumulativeText.indexOf("Cumulative rank: 2\n"));
  snapshot.alliances[0].name = "a".repeat(2000);
  assert.throws(() => formatLeaderboard(snapshot, ranking), /message limit/);
});

test("API fetch uses timeout and rejects HTTP, JSON and network failures", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async (
    url: string | URL | Request, options?: RequestInit,
  ) => {
    assert.equal(url, "https://mightpulse.com/api/kingdoms/2426/ingame-ranks");
    assert.ok(options?.signal instanceof AbortSignal);
    return Response.json(apiResponse());
  });
  assert.equal((await fetchAllianceSnapshot(2426)).alliances.length, 1);
  await assert.rejects(fetchAllianceSnapshot(0), /KINGDOM/);
  mock.mock.mockImplementation(async () => new Response("", { status: 503 }));
  await assert.rejects(fetchAllianceSnapshot(2426), /HTTP 503/);
  mock.mock.mockImplementation(async () => new Response("not JSON"));
  await assert.rejects(fetchAllianceSnapshot(2426), SyntaxError);
  mock.mock.mockImplementation(async () => { throw new Error("Network unavailable"); });
  await assert.rejects(fetchAllianceSnapshot(2426), /Network unavailable/);
});

test("persists weekly totals, isolates kingdoms and rejects corrupt state", () => {
  const original = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cumulative-test-"));
  try {
    process.chdir(directory);
    assert.deepEqual(loadCumulativeRanking(2426, firstHour), empty());
    const ranking = addHourlyRanking(empty(), parseAllianceSnapshot(apiResponse(), 2426), firstHour);
    saveCumulativeRanking(ranking);
    assert.deepEqual(loadCumulativeRanking(2426, firstHour), ranking);
    assert.equal(loadCumulativeRanking(2446, firstHour).updates, 0);
    assert.equal(loadCumulativeRanking(2426, new Date("2026-10-19T00:00:59Z")).updates, 1);
    assert.equal(loadCumulativeRanking(2426, new Date("2026-10-19T00:01:00Z")).updates, 0);
    fs.writeFileSync(path.resolve("snapshots", "cumulative-ranking-2426.json"), "{}");
    assert.throws(() => loadCumulativeRanking(2426, firstHour), /Invalid cumulative/);
  } finally {
    process.chdir(original);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("only successful scheduled posts count, duplicates and manual posts do not", async (t) => {
  const original = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cumulative-post-test-"));
  const mock = t.mock.method(globalThis, "fetch", async () => Response.json(apiResponse()));
  try {
    process.chdir(directory);
    await publishLeaderboard(2426, async () => {});
    assert.ok(!fs.existsSync(path.resolve("snapshots", "cumulative-ranking-2426.json")));
    await assert.rejects(publishLeaderboard(2426, async () => {
      throw new Error("Discord failed");
    }, firstHour), /Discord failed/);
    assert.equal(loadCumulativeRanking(2426, firstHour).updates, 0);
    mock.mock.mockImplementation(async () => new Response("", { status: 500 }));
    await assert.rejects(publishLeaderboard(2426, async () => {
      assert.fail("Should not send");
    }, firstHour), /HTTP 500/);
    assert.equal(loadCumulativeRanking(2426, firstHour).updates, 0);
    mock.mock.mockImplementation(async () => Response.json(apiResponse()));
    await Promise.all([
      publishLeaderboard(2426, async () => {}, firstHour),
      publishLeaderboard(2426, async () => {}, firstHour),
      publishLeaderboard(2426, async () => {}, new Date("2026-10-13T02:01:00Z")),
    ]);
    assert.equal(loadCumulativeRanking(2426, firstHour).updates, 2);
    assert.equal(loadCumulativeRanking(2426, firstHour).alliances[0].total, 2);
    await publishLeaderboard(2426, async () => {});
    assert.equal(loadCumulativeRanking(2426, firstHour).updates, 2);
  } finally {
    process.chdir(original);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
