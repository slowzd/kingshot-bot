import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { hourlyMessage, splitMessage } from "./format.ts";
import { runHourlyUpdate } from "./hourly.ts";
import { parsePowerSnapshot, type PowerSnapshot } from "./mightpulse.ts";
import { loadSnapshotLog } from "./snapshot-log.ts";
import { addHour, createWeek, cumulativeRanking, loadStandings } from "./standings.ts";
import { dueHour, hourKey, isFinalHourOfWeek, weekStartHour } from "./time.ts";

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

test("posts are due from XX:01 UTC and weeks run Monday 01:01 to Monday 00:01", () => {
  assert.equal(hourKey(dueHour(new Date("2026-10-13T13:00:59Z"))), "2026-10-13T12");
  assert.equal(hourKey(dueHour(new Date("2026-10-13T13:01:00Z"))), "2026-10-13T13");
  assert.equal(hourKey(dueHour(new Date("2026-10-13T13:25:00Z"))), "2026-10-13T13");
  assert.equal(weekStartHour(new Date("2026-10-19T00:00:00Z")).toISOString(), "2026-10-12T01:00:00.000Z");
  assert.equal(weekStartHour(new Date("2026-10-19T01:00:00Z")).toISOString(), "2026-10-19T01:00:00.000Z");
  assert.equal(weekStartHour(new Date("2026-10-12T01:00:00Z")).toISOString(), "2026-10-12T01:00:00.000Z");
  assert.ok(isFinalHourOfWeek(new Date("2026-10-19T00:00:00Z")));
  assert.ok(!isFinalHourOfWeek(new Date("2026-10-19T01:00:00Z")));
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

test("each hour adds the rank held; dropouts and late entrants are scored fairly", () => {
  const first = new Date("2026-10-13T12:00:00Z");
  let week = addHour(createWeek(2426, first), snapshot([1, 2, 3]), first);
  assert.throws(() => addHour(week, snapshot([1, 2, 3]), first), /already been counted/);
  week = addHour(week, snapshot([2, 1, 4]), new Date("2026-10-13T13:00:00Z"));
  const points = Object.fromEntries(week.alliances.map((standing) => [standing.id, standing.points]));
  assert.deepEqual(points, { 1: 3, 2: 3, 3: 7, 4: 7 });
  assert.equal(week.updates, 2);
  assert.deepEqual(cumulativeRanking(week).map((standing) => standing.id), [1, 2, 3, 4]);
});

test("message shows top 10 power and cumulative ranking within Discord limits", () => {
  const ids = Array.from({ length: 100 }, (_, index) => index + 1);
  const current = snapshot(ids);
  current.alliances[0].name = "*Bold* _name_";
  const hour = new Date("2026-10-13T12:00:00Z");
  const message = hourlyMessage(current, addHour(createWeek(2426, hour), current, hour), hour);
  assert.equal(message.match(/ — \d{3},/g)?.length, 10);
  assert.equal(message.match(/ pts$/gm)?.length, 10);
  assert.ok(message.includes("\\*Bold\\* \\_name\\_"));
  assert.ok(message.includes("Update Tue 13 Oct 12:01 UTC"));
  assert.deepEqual(splitMessage(message), [message]);
});

test("hourly runs count once, Monday 00:01 posts the weekly final, and 01:01 starts over", async (t) => {
  const stateFile = tempStateFile(t);
  const sent: string[] = [];
  const run = (time: string, ids = [1, 2, 3]) => runHourlyUpdate({
    now: new Date(time),
    kingdom: 2426,
    stateFile,
    fetchSnapshot: async () => snapshot(ids),
    send: async (content) => { sent.push(content); },
  });

  assert.equal((await run("2026-10-18T23:01:00Z")).status, "posted");
  assert.equal((await run("2026-10-18T23:25:00Z")).status, "already-posted");
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes("## Cumulative Power Ranking"));

  await run("2026-10-19T00:01:30Z", [2, 1, 3]);
  assert.equal(sent.length, 2);
  assert.ok(sent[1].includes("Weekly Final"));
  assert.ok(sent[1].includes("Mon 12 Oct 01:01 – Mon 19 Oct 00:01 UTC · 2 hourly updates"));
  assert.match(sent[1], /\*\*#1\*\* \[A1\] Alliance 1 — 3 pts/);
  assert.equal(loadStandings(stateFile)?.finalPosted, true);

  await run("2026-10-19T01:01:00Z", [3, 2, 1]);
  assert.equal(sent.length, 3);
  assert.ok(!sent[2].includes("Weekly Final"));
  assert.ok(sent[2].includes("Mon 19 Oct 01:01 – Mon 26 Oct 00:01 UTC · 1 hourly update "));
  assert.match(sent[2], /\*\*#1\*\* \[A3\] Alliance 3 — 1 pts/);
  assert.equal(loadStandings(stateFile)?.updates, 1);
});

test("a missed Monday 00:01 run still posts last week's final before the new week", async (t) => {
  const stateFile = tempStateFile(t);
  const sent: string[] = [];
  const run = (time: string) => runHourlyUpdate({
    now: new Date(time), kingdom: 2426, stateFile,
    fetchSnapshot: async () => snapshot([1, 2]),
    send: async (content) => { sent.push(content); },
  });
  await run("2026-10-18T23:05:00Z");
  await run("2026-10-19T01:20:00Z");
  assert.equal(sent.length, 3);
  assert.ok(sent[1].startsWith("## 🏆 Weekly Final"));
  assert.ok(sent[1].includes("1 hourly update "));
  assert.ok(sent[2].includes("## Alliance Power"));
  assert.equal(loadStandings(stateFile)?.weekStart, "2026-10-19T01:00:00.000Z");
});

test("failed API or Discord requests do not count the hour", async (t) => {
  const stateFile = tempStateFile(t);
  const base = {
    now: new Date("2026-10-13T12:01:00Z"), kingdom: 2426, stateFile,
    fetchSnapshot: async () => snapshot([1]),
    send: async () => {},
  };
  await assert.rejects(runHourlyUpdate({ ...base, fetchSnapshot: async () => { throw new Error("API down"); } }), /API down/);
  await assert.rejects(runHourlyUpdate({ ...base, send: async () => { throw new Error("Discord down"); } }), /Discord down/);
  assert.equal(loadStandings(stateFile), null);
  assert.equal((await runHourlyUpdate(base)).status, "posted");
  assert.equal(loadStandings(stateFile)?.lastHour, "2026-10-13T12");
});

test("each posted update records the API snapshot it used in a generated .ts file", async (t) => {
  const stateFile = tempStateFile(t);
  const snapshotFile = path.join(path.dirname(stateFile), "snapshot.ts");
  const run = (time: string) => runHourlyUpdate({
    now: new Date(time), kingdom: 2426, stateFile, snapshotFile,
    fetchSnapshot: async () => snapshot([1, 2]),
    send: async () => {},
  });
  const first = await run("2026-10-13T13:01:30Z");
  assert.equal(first.status, "posted");
  assert.equal(first.status === "posted" && first.snapshotUsed.apiCapturedAt, "2026-10-13T12:41:00.000Z");
  await run("2026-10-13T13:20:00Z");
  await run("2026-10-13T14:01:00Z");

  const contents = fs.readFileSync(snapshotFile, "utf8");
  assert.ok(contents.startsWith("// Generated"));
  assert.ok(contents.includes("export const snapshotLog = {"));
  const log = loadSnapshotLog(snapshotFile);
  assert.equal(log?.latest.update, "2026-10-13T14:01:00.000Z");
  assert.equal(log?.latest.apiCapturedAt, "2026-10-13T12:41:00.000Z");
  assert.deepEqual(log?.latest.alliances.map((alliance) => alliance.id), [1, 2]);
  assert.deepEqual(log?.history.map((use) => use.update), ["2026-10-13T14:01:00.000Z", "2026-10-13T13:01:00.000Z"]);
});
