import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { dailyMessage, splitMessage, weeklyFinalMessage } from "./format.ts";
import { runDailyUpdate } from "./daily.ts";
import { parsePowerSnapshot, type PowerSnapshot } from "./mightpulse.ts";
import { loadSnapshotLog } from "./snapshot-log.ts";
import { addUpdate, createWeek, cumulativeRanking, loadStandings, saveStandings, type PointWeek } from "./standings.ts";
import { dueUpdate, hourKey, weekFinal, weekStart } from "./time.ts";

function row(id: number, rank: number, power = 1_000_000_000 - rank) {
  return { aid: id, rank, kid: 2426, name: `Alliance ${id}`, abbr: `A${id}`, score: power };
}

function apiResponse(rows = [row(1, 1), row(2, 2), row(3, 3)]) {
  return {
    ok: true,
    kid: 2426,
    boards: { "1": { type: 1, captured_at: Date.parse("2026-10-13T12:41:00Z") / 1000, rows } },
  };
}

function snapshot(ids: number[]): PowerSnapshot {
  return parsePowerSnapshot(apiResponse(ids.map((id, index) => row(id, index + 1))), 2426);
}

function dailySnapshot(ids: number[], time: string): PowerSnapshot {
  return {
    ...snapshot(ids),
    capturedAt: new Date(`${dueUpdate(new Date(time)).toISOString().slice(0, 10)}T00:41:00Z`),
  };
}

function tempStateFile(t: TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "leaderboard-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "leaderboard.json");
}

function createPointWeek(hour: Date): PointWeek {
  return { ...createWeek(2426, hour), version: 1, absentPoints: 0, alliances: [] };
}

test("daily slots stay at 01:01 UTC and weekly summaries are due Monday 00:01", () => {
  assert.equal(hourKey(dueUpdate(new Date("2026-10-13T00:59:59Z"))), "2026-10-12T01");
  assert.equal(hourKey(dueUpdate(new Date("2026-10-13T01:00:59Z"))), "2026-10-12T01");
  assert.equal(dueUpdate(new Date("2026-10-13T01:01:00Z")).toISOString(), "2026-10-13T01:01:00.000Z");
  assert.equal(hourKey(dueUpdate(new Date("2026-10-13T23:25:00Z"))), "2026-10-13T01");
  assert.equal(hourKey(dueUpdate(new Date("2027-01-01T00:30:00Z"))), "2026-12-31T01");
  assert.equal(weekStart(dueUpdate(new Date("2026-10-19T00:01:00Z"))).toISOString(), "2026-10-12T01:00:00.000Z");
  assert.equal(weekStart(dueUpdate(new Date("2026-10-19T01:01:00Z"))).toISOString(), "2026-10-19T01:00:00.000Z");
  assert.equal(weekFinal(new Date("2026-10-12T01:00:00Z")).toISOString(), "2026-10-19T00:01:00.000Z");
});

test("reads the Alliance Power API response and rejects invalid data", () => {
  const parsed = parsePowerSnapshot(apiResponse([row(2, 2), row(1, 1)]), 2426);
  assert.deepEqual(parsed.alliances.map((alliance) => alliance.id), [1, 2]);
  assert.equal(parsed.capturedAt.toISOString(), "2026-10-13T12:41:00.000Z");
  assert.throws(() => parsePowerSnapshot({ ...apiResponse(), ok: false }, 2426));
  assert.throws(() => parsePowerSnapshot(apiResponse(), 2446));
  assert.throws(() => parsePowerSnapshot(apiResponse([]), 2426));
  assert.throws(() => parsePowerSnapshot(apiResponse([row(1, 1), row(1, 2)]), 2426));
  assert.throws(() => parsePowerSnapshot(apiResponse([row(1, 1, -5)]), 2426));
  assert.throws(() => parsePowerSnapshot({ ...apiResponse(), boards: {} }, 2426));
  assert.throws(() => parsePowerSnapshot({
    ...apiResponse(), boards: { "1": { ...apiResponse().boards["1"], type: 2 } },
  }, 2426));
});

test("legacy point weeks continue their existing scoring until reset", () => {
  const first = new Date("2026-10-13T01:00:00Z");
  let week = addUpdate(createPointWeek(first), snapshot([1, 2, 3]), first);
  assert.throws(() => addUpdate(week, snapshot([1, 2, 3]), new Date("2026-10-12T01:00:00Z")), /older than the last counted hour/);
  week = addUpdate(week, snapshot([2, 1, 4]), new Date("2026-10-14T01:00:00Z"));
  assert.equal(week.version, 1);
  const points = Object.fromEntries(cumulativeRanking(week).map((standing) => [standing.id, standing.value]));
  assert.deepEqual(points, { 1: 3, 2: 3, 3: 7, 4: 7 });
  assert.equal(week.updates, 2);
  assert.deepEqual(cumulativeRanking(week).map((standing) => standing.id), [1, 2, 3, 4]);

});

test("average power includes top-20 observations and retains alliances after they leave", (t) => {
  const first = new Date("2026-10-13T01:01:00Z");
  const powerSnapshot = (rows: ReturnType<typeof row>[]) => parsePowerSnapshot(apiResponse(rows), 2426);
  let week = addUpdate(createWeek(2426, first), powerSnapshot([
    row(1, 1, 100), row(2, 2, 80), row(3, 20, 60), row(4, 12, 200), row(6, 21, 50),
  ]), first);
  week = addUpdate(week, powerSnapshot([
    row(1, 1, 200), row(3, 2, 100), row(5, 3, 180), row(4, 11, 300),
  ]), new Date("2026-10-14T01:01:00Z"));
  week = addUpdate(week, powerSnapshot([
    row(1, 1, 300), row(2, 2, 160), row(3, 20, 80),
  ]), new Date("2026-10-15T01:01:00Z"));
  assert.equal(week.version, 2);
  assert.deepEqual(cumulativeRanking(week).map(({ id, value }) => [id, value]), [
    [4, 250], [1, 200], [5, 180], [2, 120], [3, 80],
  ]);
  if (week.version !== 2) assert.fail("Expected average-power week");
  assert.equal(week.alliances.find(({ id }) => id === 5)?.observations, 1);
  assert.equal(week.alliances.find(({ id }) => id === 2)?.observations, 2);
  assert.equal(week.alliances.find(({ id }) => id === 3)?.observations, 3);
  assert.equal(week.alliances.find(({ id }) => id === 4)?.observations, 2);
  assert.equal(week.alliances.find(({ id }) => id === 6), undefined);
  const stateFile = tempStateFile(t);
  saveStandings(stateFile, week);
  assert.deepEqual(loadStandings(stateFile), week);
  const final = weeklyFinalMessage(week);
  assert.ok(final.includes("[A5] Alliance 5 — 180"));
  assert.ok(final.includes("[A4] Alliance 4 — 250"));
  assert.ok(!final.includes("Alliance Power"));
  assert.ok(!final.includes("pts"));
});

test("top-20 history follows an alliance into the displayed top 10 without expanding either list", async (t) => {
  const stateFile = tempStateFile(t);
  const snapshotFile = path.join(path.dirname(stateFile), "snapshot.ts");
  const sent: string[] = [];
  const run = (time: string, promoted = false) => runDailyUpdate({
    now: new Date(time), kingdom: 2426, stateFile, snapshotFile,
    fetchSnapshot: async () => ({
      ...dailySnapshot([1], time),
      alliances: Array.from({ length: 21 }, (_, index) => {
        const id = index + 1;
        const rank = promoted && id === 20 ? 1 : promoted && id < 20 ? id + 1 : id;
        return { ...row(id, rank), id, tag: `A${id}`, power: promoted && id === 20 ? 3000 : 2100 - id * 100 };
      }),
    }),
    send: async (content) => { sent.push(content); },
  });
  await run("2026-10-19T01:01:00Z");
  const first = loadSnapshotLog(snapshotFile)!;
  assert.deepEqual(first.latest.alliances.map(({ rank }) => rank), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.ok(!sent[0].includes("[A20]"));
  await run("2026-10-20T01:01:00Z", true);
  const week = loadStandings(stateFile)!;
  if (week.version !== 2) assert.fail("Expected average-power week");
  assert.deepEqual(week.alliances.find(({ id }) => id === 20), {
    id: 20, tag: "A20", name: "Alliance 20", totalPower: 3100, observations: 2, reachedTop10: true,
  });
  assert.equal(week.alliances.length, 20);
  assert.equal(cumulativeRanking(week).find(({ id }) => id === 20)?.value, 1550);
  const log = loadSnapshotLog(snapshotFile)!;
  assert.ok(log.history.every(({ alliances }) => alliances?.length === 20));
  const [daily, average] = sent[1].split("## Current Average Power Ranking");
  assert.equal(daily.match(/^\*\*#/gm)?.length, 10);
  assert.equal(average.match(/^\*\*#/gm)?.length, 10);
  assert.match(daily, /\*\*#1\*\* \[A20\] Alliance 20 — 3,000$/m);
  assert.match(average, /\[A20\] Alliance 20 — 1,550$/m);
  assert.ok(!sent[1].includes("[A21]"));
  assert.equal(weeklyFinalMessage(week).match(/^\*\*#/gm)?.length, 10);
});

test("cumulative averages sort before rounding, break ties by ID, and display at most ten", () => {
  const hour = new Date("2026-10-13T01:01:00Z");
  let week = createWeek(2426, hour);
  assert.equal(week.version, 2);
  if (week.version !== 2) assert.fail("Expected average-power week");
  week = {
    ...week,
    updates: 3,
    alliances: Array.from({ length: 12 }, (_, index) => ({
      id: index + 1, tag: `A${index + 1}`, name: `Alliance ${index + 1}`,
      totalPower: index < 2 ? 301 : 300,
      observations: 3, reachedTop10: true,
    })),
  };
  assert.deepEqual(cumulativeRanking(week).map(({ id }) => id), Array.from({ length: 12 }, (_, index) => index + 1));
  const final = weeklyFinalMessage(week);
  assert.equal(final.match(/ — \d+(?:\.\d+)?$/gm)?.length, 10);
  assert.ok(final.includes("100.33"));
  assert.ok(!final.includes("[A11]"));
});

test("legacy state finishes with points and switches to power at Monday's daily reset", async (t) => {
  const stateFile = tempStateFile(t);
  const sunday = new Date("2026-10-18T01:01:00Z");
  saveStandings(stateFile, {
    ...addUpdate(createPointWeek(sunday), snapshot([1]), sunday),
    lastPostedAt: sunday.toISOString(),
  });
  const sent: string[] = [];
  const base = {
    kingdom: 2426, stateFile,
    fetchSnapshot: async () => dailySnapshot([1], "2026-10-19T01:01:00Z"),
    send: async (content: string) => { sent.push(content); },
  };
  assert.equal((await runDailyUpdate({ ...base, now: new Date("2026-10-19T00:01:00Z") })).status, "weekly-posted");
  assert.ok(sent[0].includes("— 1"));
  assert.ok(!sent[0].includes("pts"));
  assert.equal(loadStandings(stateFile)?.version, 1);
  assert.equal((await runDailyUpdate({ ...base, now: new Date("2026-10-19T01:01:00Z") })).status, "posted");
  assert.ok(sent[1].includes("— 999,999,999"));
  assert.ok(!sent[1].includes("pts"));
  assert.equal(loadStandings(stateFile)?.version, 2);
  assert.equal(loadStandings(stateFile)?.updates, 1);
});

test("invalid average-power state is rejected and overflowing totals fail explicitly", (t) => {
  const stateFile = tempStateFile(t);
  const hour = new Date("2026-10-13T01:01:00Z");
  const week = addUpdate(createWeek(2426, hour), snapshot([1]), hour);
  if (week.version !== 2) assert.fail("Expected average-power week");
  for (const invalid of [
    { observations: 0 }, { observations: 2 }, { totalPower: -1 }, { reachedTop10: "yes" },
  ]) {
    fs.writeFileSync(stateFile, JSON.stringify({ ...week, alliances: [{ ...week.alliances[0], ...invalid }] }));
    assert.throws(() => loadStandings(stateFile), /are invalid/);
  }
  assert.throws(() => addUpdate({
    ...week, alliances: [{ ...week.alliances[0], totalPower: Number.MAX_SAFE_INTEGER }],
  }, snapshot([1]), new Date("2026-10-14T01:01:00Z")), /safe integer precision/);
  fs.writeFileSync(stateFile, JSON.stringify({ ...week, lastApiCapturedAt: "invalid" }));
  assert.throws(() => loadStandings(stateFile), /are invalid/);
});

test("stale data waits across hourly runs without posting, creating files, or counting a sample", async (t) => {
  const stateFile = tempStateFile(t);
  const snapshotFile = path.join(path.dirname(stateFile), "snapshot.ts");
  const sent: string[] = [];
  let current = dailySnapshot([1, 2], "2026-10-18T01:01:00Z");
  const run = (time: string) => runDailyUpdate({
    now: new Date(time), kingdom: 2426, stateFile, snapshotFile,
    fetchSnapshot: async () => current,
    send: async (content) => { sent.push(content); },
  });
  for (const time of ["2026-10-19T01:01:00Z", "2026-10-19T02:01:00Z"]) {
    const result = await run(time);
    assert.equal(result.status, "skipped");
    assert.ok(result.status === "skipped" && result.reason.includes("Waiting for Mightpulse"));
    assert.equal(fs.existsSync(stateFile), false);
    assert.equal(fs.existsSync(snapshotFile), false);
  }
  current = dailySnapshot([1, 2], "2026-10-19T03:01:00Z");
  assert.equal((await run("2026-10-19T03:01:00Z")).status, "posted");
  assert.equal(loadStandings(stateFile)?.updates, 1);
  const saved = fs.readFileSync(stateFile, "utf8");
  const snapshotSaved = fs.readFileSync(snapshotFile, "utf8");
  for (const time of ["2026-10-20T01:01:00Z", "2026-10-20T02:01:00Z"]) {
    assert.equal((await run(time)).status, "skipped");
    assert.equal(fs.readFileSync(stateFile, "utf8"), saved);
    assert.equal(fs.readFileSync(snapshotFile, "utf8"), snapshotSaved);
  }
  // Unchanged power is legitimate if Mightpulse captured it on the new day.
  current = dailySnapshot([1, 2], "2026-10-20T03:01:00Z");
  assert.equal((await run("2026-10-20T03:01:00Z")).status, "posted");
  assert.equal((await run("2026-10-20T04:01:00Z")).status, "skipped");
  assert.equal(sent.length, 2);
  assert.equal(loadStandings(stateFile)?.updates, 2);
  assert.equal(loadStandings(stateFile)?.lastApiCapturedAt, "2026-10-20T00:41:00.000Z");
  assert.ok(sent[1].includes("Update Tue 20 Oct 01:01 UTC"));
  assert.ok(!sent[1].includes("Mightpulse captured"));
});

test("a capture newer than yesterday but still from yesterday does not count as today's data", async (t) => {
  const stateFile = tempStateFile(t);
  const run = (time: string, capturedAt: string) => runDailyUpdate({
    now: new Date(time), kingdom: 2426, stateFile,
    fetchSnapshot: async () => ({ ...snapshot([1]), capturedAt: new Date(capturedAt) }),
    send: async () => {},
  });
  await run("2026-10-19T01:01:00Z", "2026-10-19T00:40:00Z");
  assert.equal((await run("2026-10-20T01:01:00Z", "2026-10-19T23:59:59Z")).status, "skipped");
  assert.equal(loadStandings(stateFile)?.updates, 1);
  assert.equal((await run("2026-10-20T02:01:00Z", "2026-10-20T00:00:00Z")).status, "posted");
  assert.equal(loadStandings(stateFile)?.updates, 2);
});

test("today's capture is not backdated into yesterday's catch-up slot before 01:01", async (t) => {
  const stateFile = tempStateFile(t);
  const current = dailySnapshot([1], "2026-10-20T01:01:00Z");
  let sent = 0;
  const run = (time: string) => runDailyUpdate({
    now: new Date(time), kingdom: 2426, stateFile,
    fetchSnapshot: async () => current,
    send: async () => { sent++; },
  });
  assert.equal((await run("2026-10-20T01:00:59Z")).status, "skipped");
  assert.equal(loadStandings(stateFile), null);
  assert.equal(sent, 0);
  assert.equal((await run("2026-10-20T01:01:00Z")).status, "posted");
  assert.equal(loadStandings(stateFile)?.lastHour, "2026-10-20T01");
  assert.equal(sent, 1);
});

test("previously used capture timestamps are rejected with standings or legacy snapshot metadata", async (t) => {
  for (const source of ["standings", "snapshot", "week-reset"] as const) {
    const stateFile = tempStateFile(t);
    const snapshotFile = path.join(path.dirname(stateFile), "snapshot.ts");
    const now = new Date(source === "week-reset" ? "2026-10-19T02:01:00Z" : "2026-10-20T02:01:00Z");
    const current = dailySnapshot([1], now.toISOString());
    const previousSlot = dueUpdate(new Date(now.getTime() - 24 * 60 * 60_000));
    const week = addUpdate(createWeek(2426, previousSlot), current, previousSlot);
    if (source !== "snapshot") {
      saveStandings(stateFile, { ...week, lastApiCapturedAt: current.capturedAt.toISOString() });
    } else {
      // The old bot could use tomorrow's capture for a catch-up slot after midnight.
      saveStandings(stateFile, week);
      const use = {
        update: "2026-10-19T01:01:00.000Z", fetchedAt: now.toISOString(),
        apiCapturedAt: current.capturedAt.toISOString(), apiAgeMinutes: 79,
      };
      fs.writeFileSync(snapshotFile, `// Generated by the hourly leaderboard job. Do not edit by hand.\nexport const snapshotLog = ${JSON.stringify({
        kingdom: 2426, latest: { ...use, alliances: current.alliances }, history: [use],
      })};\n`);
    }
    const saved = fs.readFileSync(stateFile, "utf8");
    const sent: string[] = [];
    const result = await runDailyUpdate({
      now, kingdom: 2426, stateFile, snapshotFile,
      fetchSnapshot: async () => current,
      send: async (content) => { sent.push(content); },
    });
    if (source === "week-reset") {
      assert.equal(result.status, "weekly-posted");
      assert.equal(sent.length, 1);
      assert.ok(!sent[0].includes("Today's Alliance Power"));
      assert.deepEqual(loadStandings(stateFile), { ...week, lastApiCapturedAt: current.capturedAt.toISOString(), finalPosted: true });
    } else {
      assert.equal(result.status, "skipped");
      assert.ok(result.status === "skipped" && result.reason.includes("already been used"));
      assert.equal(sent.length, 0);
      assert.equal(fs.readFileSync(stateFile, "utf8"), saved);
    }
  }
});

test("invalid or future capture timestamps fail without saving or posting", async (t) => {
  const stateFile = tempStateFile(t);
  for (const capturedAt of [new Date(NaN), new Date("2026-10-20T03:00:00Z")]) {
    await assert.rejects(runDailyUpdate({
      now: new Date("2026-10-20T02:01:00Z"), kingdom: 2426, stateFile,
      fetchSnapshot: async () => ({ ...snapshot([1]), capturedAt }),
      send: async () => { assert.fail("Invalid capture must not post"); },
    }), /invalid or future capture timestamp/);
    assert.equal(loadStandings(stateFile), null);
  }
});

test("seven fresh daily top-20 snapshots produce a true weekly average and Monday resets only with fresh data", async (t) => {
  const stateFile = tempStateFile(t);
  const snapshotFile = path.join(path.dirname(stateFile), "snapshot.ts");
  const sent: string[] = [];
  const powers = [100, 200, 600, 300, 400, 500, 700];
  let current = snapshot([1]);
  let fetched = 0;
  const run = (time: string) => runDailyUpdate({
    now: new Date(time), kingdom: 2426, stateFile, snapshotFile,
    fetchSnapshot: async () => { fetched++; return current; },
    send: async (content) => { sent.push(content); },
  });
  for (let day = 12; day <= 18; day++) {
    const time = `2026-10-${day}T01:01:00Z`;
    current = {
      ...dailySnapshot(Array.from({ length: 21 }, (_, index) => index + 1), time),
      alliances: Array.from({ length: 21 }, (_, index) => ({
        id: index + 1, rank: index + 1, tag: `A${index + 1}`,
        name: `Alliance ${index + 1}`, power: powers[day - 12] - index,
      })),
    };
    assert.equal((await run(time)).status, "posted");
    const week = loadStandings(stateFile)!;
    const expected = powers.slice(0, day - 11).reduce((sum, power) => sum + power, 0) / (day - 11);
    assert.equal(cumulativeRanking(week)[0].value, expected);
    assert.equal(week.alliances.length, 20);
    assert.equal(loadSnapshotLog(snapshotFile)?.latest.alliances.length, 20);
  }
  const snapshots = fs.readFileSync(snapshotFile, "utf8");
  const log = loadSnapshotLog(snapshotFile)!;
  assert.equal(log.history.length, 7);
  assert.deepEqual(log.history.map((entry) => entry.alliances?.[0].power), [...powers].reverse());
  assert.equal((await run("2026-10-19T00:01:00Z")).status, "weekly-posted");
  assert.equal(fetched, 7);
  assert.ok(sent[7].includes("Calculated from 7 updates"));
  assert.match(sent[7], /Alliance 1 — 400$/m);
  assert.ok(!sent[7].includes("Today's Alliance Power"));
  assert.equal(fs.readFileSync(snapshotFile, "utf8"), snapshots);
  assert.equal((await run("2026-10-19T00:30:00Z")).status, "skipped");
  assert.equal((await run("2026-10-19T01:01:00Z")).status, "skipped");
  assert.equal((await run("2026-10-19T02:01:00Z")).status, "skipped");
  assert.equal(loadStandings(stateFile)?.updates, 7);
  assert.equal(sent.length, 8);
  current = {
    ...dailySnapshot([1], "2026-10-19T03:01:00Z"),
    alliances: [{ id: 1, rank: 1, tag: "A1", name: "Alliance 1", power: 900 }],
  };
  assert.equal((await run("2026-10-19T03:01:00Z")).status, "posted");
  assert.equal(loadStandings(stateFile)?.updates, 1);
  assert.equal(loadStandings(stateFile)?.weekStart, "2026-10-19T01:00:00.000Z");
  assert.equal(cumulativeRanking(loadStandings(stateFile)!)[0].value, 900);
  assert.ok(sent[8].includes("Calculated from 1 update"));
});

test("a late legacy update does not block the first average-power slot or allow duplicates", async (t) => {
  const stateFile = tempStateFile(t);
  const sunday = new Date("2026-10-18T18:00:00Z");
  saveStandings(stateFile, addUpdate(createPointWeek(sunday), snapshot([1]), sunday));
  const sent: string[] = [];
  const base = {
    kingdom: 2426, stateFile,
    send: async (content: string) => { sent.push(content); },
  };
  const run = (time: string) => runDailyUpdate({
    ...base, now: new Date(time), fetchSnapshot: async () => dailySnapshot([1], time),
  });
  assert.equal((await run("2026-10-19T00:01:00Z")).status, "weekly-posted");
  assert.ok(sent[0].includes("— 1"));
  assert.ok(!sent[0].includes("pts"));
  assert.equal((await run("2026-10-19T01:01:00Z")).status, "posted");
  assert.ok(sent[1].includes("— 999,999,999"));
  assert.equal(loadStandings(stateFile)?.version, 2);
  assert.equal((await run("2026-10-19T02:01:00Z")).status, "skipped");
  assert.equal((await run("2026-10-20T00:01:00Z")).status, "skipped");
  assert.equal((await run("2026-10-20T01:01:00Z")).status, "posted");
  assert.equal(sent.length, 3);
});

test("message shows top 10 power and cumulative ranking within Discord limits", () => {
  const ids = Array.from({ length: 100 }, (_, index) => index + 1);
  const current = snapshot(ids);
  current.alliances[0].name = "*Bold* _name_";
  const hour = new Date("2026-10-13T01:01:00Z");
  const week = addUpdate(createWeek(2426, hour), current, hour);
  const message = dailyMessage(current, week, hour);
  assert.equal(message.match(/ — \d{3},/g)?.length, 20);
  assert.equal(message.match(/ — \d{3},\d{3},\d{3}$/gm)?.length, 20);
  assert.ok(!message.includes("avg power"));
  assert.ok(!message.includes("pts"));
  assert.ok(message.includes("\\*Bold\\* \\_name\\_"));
  assert.ok(message.includes("Update Tue 13 Oct 01:01 UTC"));
  assert.match(message.split("\n").at(-1)!, /^> .+/);
  assert.ok(message.includes("## Current Average Power Ranking"));
  assert.ok(message.includes("Calculated from 1 update"));
  assert.deepEqual(splitMessage(message), [message]);

  const sameDay = dailyMessage(current, week, new Date("2026-10-13T23:59:00Z")).split("\n").at(-1);
  assert.equal(sameDay, message.split("\n").at(-1));
  const quotesAcrossAWeek = Array.from({ length: 7 }, (_, day) => {
    const date = new Date(hour);
    date.setUTCDate(date.getUTCDate() + day);
    return dailyMessage(current, week, date).split("\n").at(-1);
  });
  assert.ok(new Set(quotesAcrossAWeek).size > 1);
});

test("Monday 00:01 posts only the weekly cumulative ranking and 01:01 starts a new daily week", async (t) => {
  const stateFile = tempStateFile(t);
  const sent: string[] = [];
  let fetched = 0;
  const run = (time: string, ids = [1, 2, 3]) => runDailyUpdate({
    now: new Date(time),
    kingdom: 2426,
    stateFile,
    fetchSnapshot: async () => { fetched++; return dailySnapshot(ids, time); },
    send: async (content) => { sent.push(content); },
  });

  assert.equal((await run("2026-10-17T01:01:00Z")).status, "posted");
  assert.equal((await run("2026-10-17T02:01:00Z")).status, "skipped");
  assert.equal((await run("2026-10-18T00:01:00Z")).status, "skipped");
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes("## Current Average Power Ranking"));
  assert.equal(loadStandings(stateFile)?.updates, 1);

  await run("2026-10-18T01:01:30Z", [2, 1, 3]);
  assert.equal(sent.length, 2);
  assert.ok(!sent[1].includes("Weekly"));
  assert.ok(sent[1].includes("Mon 12 Oct 01:01 – Mon 19 Oct 00:01 UTC · Calculated from 2 updates"));
  assert.match(sent[1], /\*\*#1\*\* \[A1\] Alliance 1 — 999,999,998\.5/);
  assert.equal(loadStandings(stateFile)?.finalPosted, false);
  const before = loadStandings(stateFile)!;
  assert.equal((await run("2026-10-19T00:00:59Z")).status, "skipped");
  assert.equal((await run("2026-10-19T00:01:00Z")).status, "weekly-posted");
  assert.equal(sent.length, 3);
  assert.ok(sent[2].startsWith("## 🏆 Weekly Cumulative Ranking"));
  assert.ok(!sent[2].includes("Alliance Power"));
  assert.equal(fetched, 2);
  assert.deepEqual(loadStandings(stateFile), { ...before, finalPosted: true });
  assert.equal((await run("2026-10-19T00:30:00Z")).status, "skipped");
  assert.equal((await run("2026-10-19T01:00:59Z")).status, "skipped");
  assert.equal(sent.length, 3);

  await run("2026-10-19T01:01:30Z", [3, 2, 1]);
  assert.equal(sent.length, 4);
  assert.ok(!sent[3].includes("Weekly"));
  assert.ok(sent[3].includes("Mon 19 Oct 01:01 – Mon 26 Oct 00:01 UTC · Calculated from 1 update"));
  assert.match(sent[3], /\*\*#1\*\* \[A3\] Alliance 3 — 999,999,999/);
  assert.equal(loadStandings(stateFile)?.updates, 1);
});

test("a missed Monday 00:01 run posts the cumulative-only summary before the next daily update", async (t) => {
  const stateFile = tempStateFile(t);
  const sent: string[] = [];
  const run = (time: string) => runDailyUpdate({
    now: new Date(time), kingdom: 2426, stateFile,
    fetchSnapshot: async () => dailySnapshot([1, 2], time),
    send: async (content) => { sent.push(content); },
  });
  await run("2026-10-17T01:05:00Z");
  await run("2026-10-19T01:20:00Z");
  assert.equal(sent.length, 3);
  assert.ok(sent[1].startsWith("## 🏆 Weekly Cumulative Ranking"));
  assert.ok(!sent[1].includes("Alliance Power"));
  assert.ok(sent[1].includes("Calculated from 1 update ·"));
  assert.ok(sent[2].includes("## Today's Alliance Power"));
  assert.equal(loadStandings(stateFile)?.weekStart, "2026-10-19T01:00:00.000Z");
});

test("weekly summaries leave snapshots intact and retry failed delivery after a late daily post", async (t) => {
  const stateFile = tempStateFile(t);
  const snapshotFile = path.join(path.dirname(stateFile), "snapshot.ts");
  const sent: string[] = [];
  const base = {
    kingdom: 2426, stateFile, snapshotFile,
    fetchSnapshot: async () => dailySnapshot([1, 2], "2026-10-18T23:01:00Z"),
    send: async (content: string) => { sent.push(content); },
  };
  await runDailyUpdate({ ...base, now: new Date("2026-10-18T23:01:00Z") });
  const before = loadStandings(stateFile)!;
  const snapshotBefore = fs.readFileSync(snapshotFile, "utf8");
  const weekly = {
    ...base, now: new Date("2026-10-19T00:01:00Z"),
    fetchSnapshot: async (): Promise<PowerSnapshot> => { throw new Error("Weekly must not fetch"); },
  };
  await assert.rejects(runDailyUpdate({
    ...weekly, send: async () => { throw new Error("Discord down"); },
  }), /Discord down/);
  assert.deepEqual(loadStandings(stateFile), before);
  assert.equal((await runDailyUpdate(weekly)).status, "weekly-posted");
  assert.deepEqual(loadStandings(stateFile), { ...before, finalPosted: true });
  assert.equal(fs.readFileSync(snapshotFile, "utf8"), snapshotBefore);
  assert.equal((await runDailyUpdate({
    ...base, now: new Date("2026-10-19T01:01:00Z"),
    fetchSnapshot: async () => dailySnapshot([1, 2], "2026-10-19T01:01:00Z"),
  })).status, "posted");
  assert.equal(loadStandings(stateFile)?.updates, 1);
  assert.equal((await runDailyUpdate({ ...base, now: new Date("2026-10-19T02:01:00Z") })).status, "skipped");
  assert.equal(sent.length, 3);
});

test("a saved catch-up weekly summary is not repeated after the daily API fails", async (t) => {
  const stateFile = tempStateFile(t);
  const sent: string[] = [];
  const base = {
    kingdom: 2426, stateFile,
    fetchSnapshot: async () => dailySnapshot([1], "2026-10-18T01:01:00Z"),
    send: async (content: string) => { sent.push(content); },
  };
  await runDailyUpdate({ ...base, now: new Date("2026-10-18T01:01:00Z") });
  await assert.rejects(runDailyUpdate({
    ...base, now: new Date("2026-10-19T01:01:00Z"),
    fetchSnapshot: async () => { throw new Error("API down"); },
  }), /API down/);
  assert.equal(loadStandings(stateFile)?.finalPosted, true);
  assert.equal(sent.length, 2);
  assert.equal((await runDailyUpdate({
    ...base, now: new Date("2026-10-19T02:01:00Z"),
    fetchSnapshot: async () => dailySnapshot([1], "2026-10-19T02:01:00Z"),
  })).status, "posted");
  assert.equal(sent.length, 3);
  assert.equal(sent.filter((message) => message.includes("Weekly Cumulative Ranking")).length, 1);
});

test("a fresh Monday 00:01 check does not post Alliance Power or score the closed Sunday slot", async (t) => {
  const stateFile = tempStateFile(t);
  const result = await runDailyUpdate({
    now: new Date("2026-10-19T00:01:00Z"), kingdom: 2426, stateFile,
    fetchSnapshot: async () => { throw new Error("Must not fetch a closed week's slot"); },
    send: async () => { throw new Error("No saved scores to summarize"); },
  });
  assert.equal(result.status, "skipped");
  assert.equal(loadStandings(stateFile), null);
});

test("failed API or Discord requests do not count or block retries", async (t) => {
  const stateFile = tempStateFile(t);
  const base = {
    now: new Date("2026-10-13T12:01:00Z"), kingdom: 2426, stateFile,
    fetchSnapshot: async () => dailySnapshot([1], "2026-10-13T12:01:00Z"),
    send: async () => {},
  };
  await assert.rejects(runDailyUpdate({ ...base, fetchSnapshot: async () => { throw new Error("API down"); } }), /API down/);
  await assert.rejects(runDailyUpdate({ ...base, send: async () => { throw new Error("Discord down"); } }), /Discord down/);
  assert.equal(loadStandings(stateFile), null);
  assert.equal((await runDailyUpdate(base)).status, "posted");
  assert.equal(loadStandings(stateFile)?.lastHour, "2026-10-13T01");
});

test("hourly checks retry until Discord succeeds, then wait for the next 01:01 UTC slot", async (t) => {
  const stateFile = tempStateFile(t);
  let fetched = 0;
  let deliveries = 0;
  let discordAvailable = true;
  const run = (time: string) => runDailyUpdate({
    now: new Date(time), kingdom: 2426, stateFile,
    fetchSnapshot: async () => { fetched++; return dailySnapshot([1], time); },
    send: async () => {
      if (!discordAvailable) throw new Error("Discord unavailable");
      deliveries++;
    },
  });
  assert.equal((await run("2026-10-13T01:01:00Z")).status, "posted");
  const previous = fs.readFileSync(stateFile, "utf8");
  assert.equal((await run("2026-10-14T01:00:59Z")).status, "skipped");
  discordAvailable = false;
  for (const hour of ["01", "02"]) {
    await assert.rejects(run(`2026-10-14T${hour}:01:00Z`), /Discord unavailable/);
    assert.equal(fs.readFileSync(stateFile, "utf8"), previous);
  }
  discordAvailable = true;
  assert.equal((await run("2026-10-14T03:01:00Z")).status, "posted");
  assert.equal(loadStandings(stateFile)?.lastHour, "2026-10-14T01");
  const saved = fs.readFileSync(stateFile, "utf8");
  for (let hour = 4; hour < 24; hour++) {
    assert.equal((await run(`2026-10-14T${String(hour).padStart(2, "0")}:01:00Z`)).status, "skipped");
  }
  for (const time of ["2026-10-15T00:01:00Z", "2026-10-15T01:00:59Z"]) {
    assert.equal((await run(time)).status, "skipped");
  }
  assert.equal(fs.readFileSync(stateFile, "utf8"), saved);
  assert.equal(fetched, 4);
  assert.equal(deliveries, 2);
  assert.equal((await run("2026-10-15T01:01:00Z")).status, "posted");
  assert.equal((await run("2026-10-15T02:01:00Z")).status, "skipped");
  assert.equal(fetched, 5);
  assert.equal(deliveries, 3);
  assert.equal(loadStandings(stateFile)?.updates, 3);
});

test("each posted update records the API snapshot it used in a generated .ts file", async (t) => {
  const stateFile = tempStateFile(t);
  const snapshotFile = path.join(path.dirname(stateFile), "snapshot.ts");
  const run = (time: string) => runDailyUpdate({
    now: new Date(time), kingdom: 2426, stateFile, snapshotFile,
    fetchSnapshot: async () => dailySnapshot([1, 2], time),
    send: async () => {},
  });
  const first = await run("2026-10-13T13:01:30Z");
  assert.equal(first.status, "posted");
  assert.equal(first.status === "posted" && first.snapshotUsed.apiCapturedAt, "2026-10-13T00:41:00.000Z");
  await run("2026-10-13T13:20:00Z");
  await run("2026-10-14T13:01:00Z");

  const contents = fs.readFileSync(snapshotFile, "utf8");
  assert.ok(contents.startsWith("// Generated"));
  assert.ok(contents.includes("export const snapshotLog = {"));
  const log = loadSnapshotLog(snapshotFile);
  assert.equal(log?.latest.update, "2026-10-14T01:01:00.000Z");
  assert.equal(log?.latest.apiCapturedAt, "2026-10-14T00:41:00.000Z");
  assert.deepEqual(log?.latest.alliances.map((alliance) => alliance.id), [1, 2]);
  assert.deepEqual(log?.history.map((use) => use.update), ["2026-10-14T01:01:00.000Z", "2026-10-13T01:01:00.000Z"]);
});

test("daily slot protection allows a new slot 31 minutes after catch-up but prevents duplicates", async (t) => {
  const stateFile = tempStateFile(t);
  let fetched = 0;
  let sent = 0;
  const run = (time: string) => runDailyUpdate({
    now: new Date(time), kingdom: 2426, stateFile,
    fetchSnapshot: async () => { fetched++; return dailySnapshot([1, 2], time); },
    send: async () => { sent++; },
  });
  await run("2026-10-14T00:30:00Z");
  const saved = fs.readFileSync(stateFile, "utf8");
  assert.equal((await run("2026-10-14T01:00:59Z")).status, "skipped");
  assert.equal(fs.readFileSync(stateFile, "utf8"), saved);
  assert.equal(fetched, 1);
  assert.equal(sent, 1);
  assert.equal((await run("2026-10-14T01:01:00Z")).status, "posted");
  for (let day = 15; day <= 18; day++) {
    assert.equal((await run(`2026-10-${day}T00:01:00Z`)).status, "skipped");
    assert.equal((await run(`2026-10-${day}T01:01:00Z`)).status, "posted");
  }
  assert.equal(loadStandings(stateFile)?.updates, 6);
  assert.equal(loadStandings(stateFile)?.lastPostedAt, "2026-10-18T01:01:00.000Z");
  assert.equal(sent, 6);
});

test("a long delay catches up once and the next day still posts at 01:01", async (t) => {
  const stateFile = tempStateFile(t);
  const run = (time: string) => runDailyUpdate({
    now: new Date(time), kingdom: 2426, stateFile,
    fetchSnapshot: async () => dailySnapshot([1], time),
    send: async () => {},
  });
  await run("2026-10-13T04:01:00Z");
  assert.equal((await run("2026-10-14T01:01:00Z")).status, "posted");
  assert.equal((await run("2026-10-14T02:01:00Z")).status, "skipped");
  assert.equal((await run("2026-10-14T03:01:00Z")).status, "skipped");
  assert.equal((await run("2026-10-15T02:01:00Z")).status, "posted");
  assert.equal((await run("2026-10-16T01:01:00Z")).status, "posted");
  assert.equal((await run("2026-10-17T01:01:00Z")).status, "posted");
  assert.equal((await run("2026-10-22T01:01:00Z")).status, "posted");
  assert.equal(loadStandings(stateFile)?.updates, 1);
  assert.equal(loadStandings(stateFile)?.lastHour, "2026-10-22T01");
});

test("legacy hourly state is retained without blocking the next daily slot", async (t) => {
  const stateFile = tempStateFile(t);
  const legacyHour = new Date("2026-10-13T13:00:00Z");
  saveStandings(stateFile, addUpdate(createPointWeek(legacyHour), snapshot([1]), legacyHour));
  const run = (time: string) => runDailyUpdate({
    now: new Date(time), kingdom: 2426, stateFile,
    fetchSnapshot: async () => dailySnapshot([1], time),
    send: async () => {},
  });
  assert.equal((await run("2026-10-14T01:01:00Z")).status, "posted");
  assert.equal((await run("2026-10-14T12:01:00Z")).status, "skipped");
  assert.equal(loadStandings(stateFile)?.updates, 2);
  assert.equal(loadStandings(stateFile)?.lastPostedAt, "2026-10-14T01:01:00.000Z");
});

test("previews do not persist state and invalid saved posting times fail explicitly", async (t) => {
  const stateFile = tempStateFile(t);
  const base = {
    now: new Date("2026-10-13T01:00:00Z"), kingdom: 2426, stateFile,
    fetchSnapshot: async () => dailySnapshot([1], "2026-10-13T01:00:00Z"),
    send: async () => {},
  };
  assert.equal((await runDailyUpdate({ ...base, dryRun: true })).status, "posted");
  assert.equal(loadStandings(stateFile), null);
  await runDailyUpdate(base);
  const week = loadStandings(stateFile)!;
  saveStandings(stateFile, { ...week, lastPostedAt: "invalid" });
  await assert.rejects(runDailyUpdate(base), /Saved standings .* are invalid/);
});

test("forced test posts bypass slot protection without changing standings or snapshot history", async (t) => {
  const stateFile = tempStateFile(t);
  const snapshotFile = path.join(path.dirname(stateFile), "snapshot.ts");
  let sent = 0;
  const base = {
    now: new Date("2026-10-13T01:01:00Z"), kingdom: 2426, stateFile, snapshotFile,
    fetchSnapshot: async () => dailySnapshot([1, 2], "2026-10-13T01:01:00Z"),
    send: async () => { sent++; },
  };
  await runDailyUpdate(base);
  const stateBefore = fs.readFileSync(stateFile, "utf8");
  const snapshotBefore = fs.readFileSync(snapshotFile, "utf8");
  assert.equal((await runDailyUpdate({ ...base, force: true })).status, "posted");
  assert.equal((await runDailyUpdate({
    ...base, now: new Date("2026-10-14T00:01:00Z"), force: true,
  })).status, "posted");
  assert.equal(sent, 3);
  assert.equal(fs.readFileSync(stateFile, "utf8"), stateBefore);
  assert.equal(fs.readFileSync(snapshotFile, "utf8"), snapshotBefore);
  assert.equal((await runDailyUpdate(base)).status, "skipped");
  assert.equal((await runDailyUpdate({
    ...base, now: new Date("2026-10-14T01:01:00Z"),
    fetchSnapshot: async () => dailySnapshot([1, 2], "2026-10-14T01:01:00Z"),
  })).status, "posted");
});

test("forced posts on fresh state do not create files and still propagate send failures", async (t) => {
  const stateFile = tempStateFile(t);
  const snapshotFile = path.join(path.dirname(stateFile), "snapshot.ts");
  const base = {
    now: new Date("2026-10-13T01:01:00Z"), kingdom: 2426, stateFile, snapshotFile,
    fetchSnapshot: async () => snapshot([1]),
    send: async () => {},
    force: true,
  };
  assert.equal((await runDailyUpdate(base)).status, "posted");
  assert.equal(fs.existsSync(stateFile), false);
  assert.equal(fs.existsSync(snapshotFile), false);
  await assert.rejects(runDailyUpdate({
    ...base, send: async () => { throw new Error("Discord down"); },
  }), /Discord down/);
});

test("CLI routes forced posts to the test channel and normal posts to the configured channel", (t) => {
  const preload = `const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(value) { super(value === undefined ? "2026-10-13T13:01:00Z" : value); }
    static now() { return RealDate.parse("2026-10-13T13:01:00Z"); }
  };
  globalThis.fetch = async (url, options) => {
    console.log("REQUEST " + url);
    if (url === "https://mightpulse.com/api/kingdoms/2426/ingame-ranks") {
      if (new Headers(options?.headers).has("Authorization")) throw new Error("Public rankings must not use API credentials");
      return Response.json(${JSON.stringify(apiResponse())});
    }
    if (url.startsWith("https://discord.com/api/v10/channels/")) {
      return Response.json({ id: "test-message" });
    }
    throw new Error("Unexpected request: " + url);
  };`;
  for (const force of [true, false]) {
    const stateFile = tempStateFile(t);
    const result = spawnSync(process.execPath, [
      "--import", `data:text/javascript,${encodeURIComponent(preload)}`,
      path.join(import.meta.dirname, "run.ts"),
      ...(force ? ["--force"] : []),
    ], {
      cwd: path.dirname(stateFile),
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        KINGDOM: "2426",
        MIGHTPULSE_API_KEY: "",
        DISCORD_TOKEN: "test-token",
        DISCORD_CHANNEL_ID: "1559288525201866814",
        STATE_FILE: stateFile,
        SNAPSHOT_FILE: path.join(path.dirname(stateFile), "snapshot.ts"),
        GITHUB_STEP_SUMMARY: "",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const destination = force ? "1561449272690344068" : "1559288525201866814";
    assert.ok(result.stdout.includes(`REQUEST https://discord.com/api/v10/channels/${destination}/messages`));
    const other = force ? "1559288525201866814" : "1561449272690344068";
    assert.ok(!result.stdout.includes(`REQUEST https://discord.com/api/v10/channels/${other}/messages`));
    assert.equal(fs.existsSync(stateFile), !force);
  }
});
