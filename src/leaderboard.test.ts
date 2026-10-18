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
    board: { key: "alliance_power", captured_at: Date.parse("2026-10-13T12:41:00Z") / 1000, rows },
  };
}

function snapshot(ids: number[]): PowerSnapshot {
  return parsePowerSnapshot(apiResponse(ids.map((id, index) => row(id, index + 1))), 2426);
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

test("average power includes observed days only and retains alliances after they leave the API", (t) => {
  const first = new Date("2026-10-13T01:01:00Z");
  const powerSnapshot = (rows: ReturnType<typeof row>[]) => parsePowerSnapshot(apiResponse(rows), 2426);
  let week = addUpdate(createWeek(2426, first), powerSnapshot([
    row(1, 1, 100), row(2, 2, 80), row(3, 11, 60), row(4, 12, 200),
  ]), first);
  week = addUpdate(week, powerSnapshot([
    row(1, 1, 200), row(3, 2, 100), row(5, 3, 180), row(4, 11, 300),
  ]), new Date("2026-10-14T01:01:00Z"));
  week = addUpdate(week, powerSnapshot([
    row(1, 1, 300), row(2, 2, 160), row(3, 11, 80),
  ]), new Date("2026-10-15T01:01:00Z"));
  assert.equal(week.version, 2);
  assert.deepEqual(cumulativeRanking(week).map(({ id, value }) => [id, value]), [
    [1, 200], [5, 180], [2, 120], [3, 80],
  ]);
  // Alliance 5 qualifies from just one day; alliance 4 never reached the daily top 10.
  if (week.version !== 2) assert.fail("Expected average-power week");
  assert.equal(week.alliances.find(({ id }) => id === 5)?.observations, 1);
  assert.equal(week.alliances.find(({ id }) => id === 2)?.observations, 2);
  const stateFile = tempStateFile(t);
  saveStandings(stateFile, week);
  assert.deepEqual(loadStandings(stateFile), week);
  const final = weeklyFinalMessage(week);
  assert.ok(final.includes("[A5] Alliance 5 — 180 avg power"));
  assert.ok(!final.includes("[A4]"));
  assert.ok(!final.includes("Alliance Power"));
  assert.ok(!final.includes("pts"));
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
  assert.equal(final.match(/ avg power$/gm)?.length, 10);
  assert.ok(final.includes("100.33 avg power"));
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
    fetchSnapshot: async () => snapshot([1]),
    send: async (content: string) => { sent.push(content); },
  };
  assert.equal((await runDailyUpdate({ ...base, now: new Date("2026-10-19T00:01:00Z") })).status, "weekly-posted");
  assert.ok(sent[0].includes("1 pts"));
  assert.equal(loadStandings(stateFile)?.version, 1);
  assert.equal((await runDailyUpdate({ ...base, now: new Date("2026-10-19T01:01:00Z") })).status, "posted");
  assert.ok(sent[1].includes("999,999,999 avg power"));
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
});

test("the first average-power week bypasses legacy cooldown once, then restores the guard", async (t) => {
  const stateFile = tempStateFile(t);
  const sunday = new Date("2026-10-18T18:00:00Z");
  saveStandings(stateFile, addUpdate(createPointWeek(sunday), snapshot([1]), sunday));
  const sent: string[] = [];
  const base = {
    kingdom: 2426, stateFile,
    fetchSnapshot: async () => snapshot([1]),
    send: async (content: string) => { sent.push(content); },
  };
  const run = (time: string) => runDailyUpdate({ ...base, now: new Date(time) });
  assert.equal((await run("2026-10-19T00:01:00Z")).status, "weekly-posted");
  assert.ok(sent[0].includes("pts"));
  assert.equal((await run("2026-10-19T01:01:00Z")).status, "posted");
  assert.ok(sent[1].includes("avg power"));
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
  const message = dailyMessage(current, addUpdate(createWeek(2426, hour), current, hour), hour);
  assert.equal(message.match(/ — \d{3},/g)?.length, 20);
  assert.equal(message.match(/ avg power$/gm)?.length, 10);
  assert.ok(!message.includes("pts"));
  assert.ok(message.includes("\\*Bold\\* \\_name\\_"));
  assert.ok(message.includes("Update Tue 13 Oct 01:01 UTC"));
  assert.ok(message.includes("## Daily Cumulative Ranking"));
  assert.ok(message.includes("1 daily update"));
  assert.deepEqual(splitMessage(message), [message]);
});

test("Monday 00:01 posts only the weekly cumulative ranking and 01:01 starts a new daily week", async (t) => {
  const stateFile = tempStateFile(t);
  const sent: string[] = [];
  let fetched = 0;
  const run = (time: string, ids = [1, 2, 3]) => runDailyUpdate({
    now: new Date(time),
    kingdom: 2426,
    stateFile,
    fetchSnapshot: async () => { fetched++; return snapshot(ids); },
    send: async (content) => { sent.push(content); },
  });

  assert.equal((await run("2026-10-17T01:01:00Z")).status, "posted");
  assert.equal((await run("2026-10-17T02:01:00Z")).status, "skipped");
  assert.equal((await run("2026-10-18T00:01:00Z")).status, "skipped");
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes("## Daily Cumulative Ranking"));
  assert.equal(loadStandings(stateFile)?.updates, 1);

  await run("2026-10-18T01:01:30Z", [2, 1, 3]);
  assert.equal(sent.length, 2);
  assert.ok(!sent[1].includes("Weekly"));
  assert.ok(sent[1].includes("Mon 12 Oct 01:01 – Mon 19 Oct 00:01 UTC · 2 daily updates"));
  assert.match(sent[1], /\*\*#1\*\* \[A1\] Alliance 1 — 999,999,998\.5 avg power/);
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
  assert.ok(sent[3].includes("Mon 19 Oct 01:01 – Mon 26 Oct 00:01 UTC · 1 daily update "));
  assert.match(sent[3], /\*\*#1\*\* \[A3\] Alliance 3 — 999,999,999 avg power/);
  assert.equal(loadStandings(stateFile)?.updates, 1);
});

test("a missed Monday 00:01 run posts the cumulative-only summary before the next daily update", async (t) => {
  const stateFile = tempStateFile(t);
  const sent: string[] = [];
  const run = (time: string) => runDailyUpdate({
    now: new Date(time), kingdom: 2426, stateFile,
    fetchSnapshot: async () => snapshot([1, 2]),
    send: async (content) => { sent.push(content); },
  });
  await run("2026-10-17T01:05:00Z");
  await run("2026-10-19T01:20:00Z");
  assert.equal(sent.length, 3);
  assert.ok(sent[1].startsWith("## 🏆 Weekly Cumulative Ranking"));
  assert.ok(!sent[1].includes("Alliance Power"));
  assert.ok(sent[1].includes("1 daily update "));
  assert.ok(sent[2].includes("## Alliance Power"));
  assert.equal(loadStandings(stateFile)?.weekStart, "2026-10-19T01:00:00.000Z");
});

test("weekly summaries bypass the daily cooldown, leave snapshots intact and retry failed delivery", async (t) => {
  const stateFile = tempStateFile(t);
  const snapshotFile = path.join(path.dirname(stateFile), "snapshot.ts");
  const sent: string[] = [];
  const base = {
    kingdom: 2426, stateFile, snapshotFile,
    fetchSnapshot: async () => snapshot([1, 2]),
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
  assert.equal((await runDailyUpdate({ ...base, now: new Date("2026-10-19T01:01:00Z") })).status, "skipped");
  assert.equal(sent.length, 2);
});

test("a saved catch-up weekly summary is not repeated after the daily API fails", async (t) => {
  const stateFile = tempStateFile(t);
  const sent: string[] = [];
  const base = {
    kingdom: 2426, stateFile,
    fetchSnapshot: async () => snapshot([1]),
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
    fetchSnapshot: async () => snapshot([1]),
    send: async () => {},
  };
  await assert.rejects(runDailyUpdate({ ...base, fetchSnapshot: async () => { throw new Error("API down"); } }), /API down/);
  await assert.rejects(runDailyUpdate({ ...base, send: async () => { throw new Error("Discord down"); } }), /Discord down/);
  assert.equal(loadStandings(stateFile), null);
  assert.equal((await runDailyUpdate(base)).status, "posted");
  assert.equal(loadStandings(stateFile)?.lastHour, "2026-10-13T01");
});

test("each posted update records the API snapshot it used in a generated .ts file", async (t) => {
  const stateFile = tempStateFile(t);
  const snapshotFile = path.join(path.dirname(stateFile), "snapshot.ts");
  const run = (time: string) => runDailyUpdate({
    now: new Date(time), kingdom: 2426, stateFile, snapshotFile,
    fetchSnapshot: async () => snapshot([1, 2]),
    send: async () => {},
  });
  const first = await run("2026-10-13T13:01:30Z");
  assert.equal(first.status, "posted");
  assert.equal(first.status === "posted" && first.snapshotUsed.apiCapturedAt, "2026-10-13T12:41:00.000Z");
  await run("2026-10-13T13:20:00Z");
  await run("2026-10-14T13:01:00Z");

  const contents = fs.readFileSync(snapshotFile, "utf8");
  assert.ok(contents.startsWith("// Generated"));
  assert.ok(contents.includes("export const snapshotLog = {"));
  const log = loadSnapshotLog(snapshotFile);
  assert.equal(log?.latest.update, "2026-10-14T01:01:00.000Z");
  assert.equal(log?.latest.apiCapturedAt, "2026-10-13T12:41:00.000Z");
  assert.deepEqual(log?.latest.alliances.map((alliance) => alliance.id), [1, 2]);
  assert.deepEqual(log?.history.map((use) => use.update), ["2026-10-14T01:01:00.000Z", "2026-10-13T01:01:00.000Z"]);
});

test("the persistent guard skips before 23 hours and allows exactly 23 hours without drifting", async (t) => {
  const stateFile = tempStateFile(t);
  let fetched = 0;
  let sent = 0;
  const run = (time: string) => runDailyUpdate({
    now: new Date(time), kingdom: 2426, stateFile,
    fetchSnapshot: async () => { fetched++; return snapshot([1, 2]); },
    send: async () => { sent++; },
  });
  await run("2026-10-13T02:01:00Z");
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

test("a long delay catches up once and returns to 01:01 instead of permanently shifting", async (t) => {
  const stateFile = tempStateFile(t);
  const run = (time: string) => runDailyUpdate({
    now: new Date(time), kingdom: 2426, stateFile,
    fetchSnapshot: async () => snapshot([1]),
    send: async () => {},
  });
  await run("2026-10-13T04:01:00Z");
  assert.equal((await run("2026-10-14T01:01:00Z")).status, "skipped");
  assert.equal((await run("2026-10-14T02:01:00Z")).status, "skipped");
  assert.equal((await run("2026-10-14T03:01:00Z")).status, "posted");
  assert.equal((await run("2026-10-15T02:01:00Z")).status, "posted");
  assert.equal((await run("2026-10-16T01:01:00Z")).status, "posted");
  assert.equal((await run("2026-10-17T01:01:00Z")).status, "posted");
  assert.equal((await run("2026-10-22T01:01:00Z")).status, "posted");
  assert.equal(loadStandings(stateFile)?.updates, 1);
  assert.equal(loadStandings(stateFile)?.lastHour, "2026-10-22T01");
});

test("legacy hourly state is retained and observes the 23-hour guard during migration", async (t) => {
  const stateFile = tempStateFile(t);
  const legacyHour = new Date("2026-10-13T13:00:00Z");
  saveStandings(stateFile, addUpdate(createPointWeek(legacyHour), snapshot([1]), legacyHour));
  const run = (time: string) => runDailyUpdate({
    now: new Date(time), kingdom: 2426, stateFile,
    fetchSnapshot: async () => snapshot([1]),
    send: async () => {},
  });
  assert.equal((await run("2026-10-14T01:01:00Z")).status, "skipped");
  assert.equal((await run("2026-10-14T12:01:00Z")).status, "posted");
  assert.equal(loadStandings(stateFile)?.updates, 2);
  assert.equal(loadStandings(stateFile)?.lastPostedAt, "2026-10-14T12:01:00.000Z");
});

test("previews do not persist state and invalid saved posting times fail explicitly", async (t) => {
  const stateFile = tempStateFile(t);
  const base = {
    now: new Date("2026-10-13T01:00:00Z"), kingdom: 2426, stateFile,
    fetchSnapshot: async () => snapshot([1]),
    send: async () => {},
  };
  assert.equal((await runDailyUpdate({ ...base, dryRun: true })).status, "posted");
  assert.equal(loadStandings(stateFile), null);
  await runDailyUpdate(base);
  const week = loadStandings(stateFile)!;
  saveStandings(stateFile, { ...week, lastPostedAt: "invalid" });
  await assert.rejects(runDailyUpdate(base), /Saved standings .* are invalid/);
});

test("forced test posts bypass both guards without changing standings or snapshot history", async (t) => {
  const stateFile = tempStateFile(t);
  const snapshotFile = path.join(path.dirname(stateFile), "snapshot.ts");
  let sent = 0;
  const base = {
    now: new Date("2026-10-13T01:01:00Z"), kingdom: 2426, stateFile, snapshotFile,
    fetchSnapshot: async () => snapshot([1, 2]),
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
  const preload = `globalThis.fetch = async (url) => {
    console.log("REQUEST " + url);
    if (url.startsWith("https://api.mightpulse.com/")) {
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
        MIGHTPULSE_API_KEY: "test-key",
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
