import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { runDailyUpdate } from "./daily.ts";
import type { Alliance, PowerSnapshot } from "./mightpulse.ts";
import { loadSnapshotLog } from "./snapshot-log.ts";
import { cumulativeRanking, loadStandings, saveStandings } from "./standings.ts";

function alliance(id: number, power: number, rank = 1): Alliance {
  return { id, rank, power, tag: `A${id}`, name: `Alliance ${id}` };
}

function setup(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "leaderboard-correction-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, "leaderboard.json");
  const snapshotFile = path.join(directory, "snapshot.ts");
  const messages: string[] = [];
  let current: PowerSnapshot = {
    kingdom: 2426, capturedAt: new Date("2026-10-19T00:41:00Z"),
    alliances: [alliance(1, 100), alliance(2, 80, 2)],
  };
  return {
    directory, stateFile, snapshotFile, messages,
    setSnapshot: (value: PowerSnapshot) => { current = value; },
    run: (time: string, options: Partial<Parameters<typeof runDailyUpdate>[0]> = {}) => runDailyUpdate({
      now: new Date(time), kingdom: 2426, stateFile, snapshotFile,
      fetchSnapshot: async () => current,
      send: async (content) => { messages.push(content); },
      ...options,
    }),
  };
}

test("correction replaces today's sample, preserves prior days, and does not grow history or counts", async (t) => {
  const fixture = setup(t);
  await fixture.run("2026-10-19T01:01:00Z");
  fixture.setSnapshot({
    kingdom: 2426, capturedAt: new Date("2026-10-20T00:41:00Z"),
    alliances: [alliance(1, 200), alliance(3, 150, 2)],
  });
  await fixture.run("2026-10-20T01:01:00Z");
  fixture.setSnapshot({
    kingdom: 2426, capturedAt: new Date("2026-10-20T07:41:00Z"),
    alliances: [alliance(4, 600), alliance(1, 500, 2)],
  });
  assert.equal((await fixture.run("2026-10-20T08:01:00Z", { correctionDate: "2026-10-20" })).status, "posted");
  const week = loadStandings(fixture.stateFile)!;
  assert.equal(week.updates, 2);
  assert.deepEqual(cumulativeRanking(week).map(({ id, value }) => [id, value]), [[4, 600], [1, 300], [2, 80]]);
  assert.equal(week.alliances.find(({ id }) => id === 3), undefined);
  assert.equal(week.lastApiCapturedAt, "2026-10-20T07:41:00.000Z");
  const log = loadSnapshotLog(fixture.snapshotFile)!;
  assert.equal(log.history.length, 2);
  assert.deepEqual(log.history.map(({ update }) => update), ["2026-10-20T01:01:00.000Z", "2026-10-19T01:01:00.000Z"]);
  assert.deepEqual(log.latest.alliances.map(({ id, power }) => [id, power]), [[4, 600], [1, 500]]);
  assert.ok(fixture.messages[2].startsWith("Manually pushed to correct error.\n\n"));
  assert.ok(fixture.messages[2].includes("2 daily updates"));
  // An intentional resend of the same capture must still replace, never append.
  await fixture.run("2026-10-20T09:01:00Z", { correctionDate: "2026-10-20" });
  assert.equal(loadStandings(fixture.stateFile)?.updates, 2);
  assert.deepEqual(cumulativeRanking(loadStandings(fixture.stateFile)!), cumulativeRanking(week));
  assert.equal(loadSnapshotLog(fixture.snapshotFile)?.history.length, 2);
  assert.equal((await fixture.run("2026-10-20T10:01:00Z")).status, "skipped");
});

test("Monday's first sample can be replaced without retaining the incorrect alliance", async (t) => {
  const fixture = setup(t);
  await fixture.run("2026-10-19T01:01:00Z");
  fixture.setSnapshot({
    kingdom: 2426, capturedAt: new Date("2026-10-19T07:41:00Z"), alliances: [alliance(3, 900)],
  });
  await fixture.run("2026-10-19T08:01:00Z", { correctionDate: "2026-10-19" });
  assert.equal(loadStandings(fixture.stateFile)?.updates, 1);
  assert.deepEqual(cumulativeRanking(loadStandings(fixture.stateFile)!).map(({ id, value }) => [id, value]), [[3, 900]]);
  assert.equal(loadSnapshotLog(fixture.snapshotFile)?.history.length, 1);
});

test("correction preview and failed deliveries leave both saved files unchanged", async (t) => {
  const fixture = setup(t);
  await fixture.run("2026-10-19T01:01:00Z");
  const stateBefore = fs.readFileSync(fixture.stateFile, "utf8");
  const logBefore = fs.readFileSync(fixture.snapshotFile, "utf8");
  fixture.setSnapshot({
    kingdom: 2426, capturedAt: new Date("2026-10-19T07:41:00Z"), alliances: [alliance(1, 900)],
  });
  await fixture.run("2026-10-19T08:01:00Z", { correctionDate: "2026-10-19", dryRun: true });
  await assert.rejects(fixture.run("2026-10-19T08:01:00Z", {
    correctionDate: "2026-10-19", send: async () => { throw new Error("Discord down"); },
  }), /Discord down/);
  await assert.rejects(fixture.run("2026-10-19T08:01:00Z", {
    correctionDate: "2026-10-19", fetchSnapshot: async () => { throw new Error("API down"); },
  }), /API down/);
  assert.equal(fs.readFileSync(fixture.stateFile, "utf8"), stateBefore);
  assert.equal(fs.readFileSync(fixture.snapshotFile, "utf8"), logBefore);
  await fixture.run("2026-10-19T09:01:00Z", { correctionDate: "2026-10-19" });
  assert.equal(loadStandings(fixture.stateFile)?.updates, 1);
});

test("corrections reject missing or inconsistent saved state before posting", async (t) => {
  for (const problem of ["missing-state", "missing-log", "wrong-kingdom", "wrong-slot", "closed", "capture-mismatch", "bad-total", "incomplete-log"]) {
    const fixture = setup(t);
    if (problem !== "missing-state") await fixture.run("2026-10-19T01:01:00Z");
    const week = loadStandings(fixture.stateFile);
    if (problem === "missing-log") fs.unlinkSync(fixture.snapshotFile);
    if (week) {
      if (problem === "wrong-kingdom") saveStandings(fixture.stateFile, { ...week, kingdom: 2446 });
      if (problem === "wrong-slot") saveStandings(fixture.stateFile, { ...week, lastHour: "2026-10-18T01" });
      if (problem === "closed") saveStandings(fixture.stateFile, { ...week, finalPosted: true });
      if (problem === "capture-mismatch") saveStandings(fixture.stateFile, { ...week, lastApiCapturedAt: "2026-10-19T00:42:00Z" });
      if (problem === "bad-total" && week.version === 2) {
        saveStandings(fixture.stateFile, { ...week, alliances: week.alliances.map((entry) => ({ ...entry, totalPower: 0 })) });
      }
      if (problem === "incomplete-log") {
        fs.writeFileSync(fixture.snapshotFile, fs.readFileSync(fixture.snapshotFile, "utf8").replace('"id": 2', '"id": 3'));
      }
    }
    const messagesBefore = fixture.messages.length;
    await assert.rejects(fixture.run("2026-10-19T08:01:00Z", { correctionDate: "2026-10-19" }), /Cannot safely correct|does not match|incomplete/);
    assert.equal(fixture.messages.length, messagesBefore);
  }
});

test("corrections reject stale data, queued dates, pre-01:01 runs, and forced test mode", async (t) => {
  const fixture = setup(t);
  await fixture.run("2026-10-19T01:01:00Z");
  fixture.setSnapshot({
    kingdom: 2426, capturedAt: new Date("2026-10-18T22:00:00Z"), alliances: [alliance(1, 900)],
  });
  await assert.rejects(fixture.run("2026-10-19T08:01:00Z", { correctionDate: "2026-10-19" }), /no capture for today/);
  await assert.rejects(fixture.run("2026-10-20T08:01:00Z", { correctionDate: "2026-10-19" }), /requested UTC date/);
  await assert.rejects(fixture.run("2026-10-19T01:00:59Z", { correctionDate: "2026-10-19" }), /at or after 01:01/);
  await assert.rejects(fixture.run("2026-10-19T08:01:00Z", { correctionDate: "2026-10-19", force: true }), /cannot be combined/);
  assert.equal(fixture.messages.length, 1);
  assert.equal(loadStandings(fixture.stateFile)?.updates, 1);
});

test("legacy snapshots with a full API board can be used to replace an old average-power sample", async (t) => {
  const fixture = setup(t);
  await fixture.run("2026-10-19T01:01:00Z");
  const week = loadStandings(fixture.stateFile)!;
  if (week.version !== 2) assert.fail("Expected power standings");
  const { lastApiCapturedAt, ...legacyWeek } = week;
  saveStandings(fixture.stateFile, {
    ...legacyWeek,
    alliances: [...week.alliances, { id: 11, tag: "A11", name: "Alliance 11", totalPower: 50, observations: 1, reachedTop10: false }],
  });
  const log = loadSnapshotLog(fixture.snapshotFile)!;
  log.latest.alliances.push(alliance(11, 50, 11));
  fs.writeFileSync(fixture.snapshotFile, `// Generated by the hourly leaderboard job. Do not edit by hand.\nexport const snapshotLog = ${JSON.stringify(log)};\n`);
  fixture.setSnapshot({
    kingdom: 2426, capturedAt: new Date("2026-10-19T07:41:00Z"), alliances: [alliance(1, 900)],
  });
  await fixture.run("2026-10-19T08:01:00Z", { correctionDate: "2026-10-19" });
  assert.equal(loadStandings(fixture.stateFile)?.alliances.length, 1);
  assert.equal(loadStandings(fixture.stateFile)?.updates, 1);
});

const fixedClock = `const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(value) { super(value === undefined ? "2026-10-19T08:01:00Z" : value); }
  static now() { return RealDate.parse("2026-10-19T08:01:00Z"); }
};`;

test("local correction command dispatches a date-pinned correction and reports acceptance, not delivery", (t) => {
  const fixture = setup(t);
  const preload = `${fixedClock}
  globalThis.fetch = async (url, options) => {
    if (url !== "https://api.github.com/repos/slowzd/kingshot-bot/actions/workflows/hourly-leaderboard.yml/dispatches") throw new Error("Wrong dispatch URL");
    if (options.method !== "POST" || options.headers.Authorization !== "Bearer test-github-token") throw new Error("Wrong request");
    const data = JSON.parse(options.body);
    if (data.ref !== "main" || data.inputs.correct !== true || data.inputs.correction_date !== "2026-10-19") throw new Error("Wrong dispatch inputs");
    return new Response(null, { status: 204 });
  };`;
  const result = spawnSync(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(preload)}`, path.join(import.meta.dirname, "correct.ts"),
  ], {
    cwd: fixture.directory, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, GH_TOKEN: "test-github-token", GITHUB_TOKEN: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("Correction requested for 2026-10-19 UTC"));
  assert.ok(result.stdout.includes("not delivery"));
  assert.ok(!result.stdout.includes("test-github-token"));
  assert.equal(fs.existsSync(fixture.stateFile), false);
});

test("local dispatch failures and missing credentials exit unsuccessfully without claiming success", (t) => {
  const fixture = setup(t);
  for (const status of [401, 403, 404, 422, 500]) {
    const preload = `${fixedClock} globalThis.fetch = async () => new Response(null, { status: ${status} });`;
    const result = spawnSync(process.execPath, [
      "--import", `data:text/javascript,${encodeURIComponent(preload)}`, path.join(import.meta.dirname, "correct.ts"),
    ], {
      cwd: fixture.directory, encoding: "utf8", timeout: 15_000,
      env: { ...process.env, GH_TOKEN: "test-github-token", GITHUB_TOKEN: "" },
    });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`HTTP ${status}`));
    assert.ok(!result.stdout.includes("Correction requested"));
  }
  const missing = spawnSync(process.execPath, [path.join(import.meta.dirname, "correct.ts")], {
    cwd: fixture.directory, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" },
  });
  assert.notEqual(missing.status, 0);
  assert.ok(missing.stderr.includes("Set GH_TOKEN or GITHUB_TOKEN"));
});

test("correction CLI posts to the normal channel and persists a replacement sample", async (t) => {
  const fixture = setup(t);
  await fixture.run("2026-10-19T01:01:00Z");
  const preload = `${fixedClock}
  globalThis.fetch = async (url) => {
    if (url.startsWith("https://api.mightpulse.com/")) {
      return Response.json({
        ok: true, kid: 2426, board: {
          key: "alliance_power", captured_at: Date.parse("2026-10-19T07:41:00Z") / 1000,
          rows: [{ aid: 1, rank: 1, kid: 2426, name: "Alliance 1", abbr: "A1", score: 900 }]
        }
      });
    }
    if (url === "https://discord.com/api/v10/channels/1559288525201866814/messages") return Response.json({ id: "corrected-message" });
    throw new Error("Unexpected destination " + url);
  };`;
  const result = spawnSync(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(preload)}`, path.join(import.meta.dirname, "run.ts"), "--correct",
  ], {
    cwd: fixture.directory, encoding: "utf8", timeout: 15_000,
    env: {
      ...process.env, KINGDOM: "2426", MIGHTPULSE_API_KEY: "test-key", DISCORD_TOKEN: "test-token",
      DISCORD_CHANNEL_ID: "1559288525201866814", STATE_FILE: fixture.stateFile,
      SNAPSHOT_FILE: fixture.snapshotFile, CORRECTION_DATE: "2026-10-19", GITHUB_STEP_SUMMARY: "",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("corrected (sample replaced)"));
  assert.equal(loadStandings(fixture.stateFile)?.updates, 1);
  assert.equal(cumulativeRanking(loadStandings(fixture.stateFile)!)[0].value, 900);
});
