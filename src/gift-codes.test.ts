import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { APIEmbed } from "discord.js";
import { sendDiscordMessage } from "./discord.ts";
import { fetchActiveGiftCodes, runGiftCodeUpdate, type GiftCode } from "./gift-codes.ts";

const channelId = "1568946919567392908";
const now = new Date("2026-11-08T12:00:00Z");
const baseline: GiftCode[] = [
  { code: "Kingshot888", expiresAt: null },
  { code: "VIP777", expiresAt: null },
];

test("fetches the Atlas feed, filters expired codes and normalizes order and duplicates", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(input, "https://kingshot-atlas.onrender.com/api/v1/player-link/gift-codes");
    assert.equal(new Headers(init?.headers).get("Accept"), "application/json");
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json({
      source: "database",
      codes: [
        { code: "VIP777", expire_date: null, is_expired: false },
        { code: "Kingshot888", expire_date: null, is_expired: false },
        { code: "VIP777", expire_date: null, is_expired: false },
        { code: "OLD", expire_date: null, is_expired: true },
        { code: "PAST", expire_date: "2026-11-08T12:00:00Z", is_expired: false },
        { code: "FUTURE", expire_date: "2026-11-09", is_expired: false },
      ],
    });
  });
  assert.deepEqual(await fetchActiveGiftCodes(now), [
    { code: "FUTURE", expiresAt: "2026-11-09T00:00:00.000Z" },
    ...baseline,
  ]);
});

test("source failures and malformed codes are rejected rather than treated as an empty list", async (t) => {
  let response = new Response("Unavailable", { status: 503 });
  t.mock.method(globalThis, "fetch", async () => response);
  await assert.rejects(fetchActiveGiftCodes(now), /HTTP 503/);
  response = Response.json({ source: "database" });
  await assert.rejects(fetchActiveGiftCodes(now), /invalid gift-code response/);
  for (const code of [
    { code: "GOOD", expire_date: null },
    { code: "bad`code", expire_date: null, is_expired: false },
    { code: "GOOD", expire_date: "2026-02-30", is_expired: false },
  ]) {
    response = Response.json({ source: "database", codes: [code] });
    await assert.rejects(fetchActiveGiftCodes(now), /[Ii]nvalid gift[- ]code/);
  }
  response = Response.json({ source: "database", codes: [] });
  assert.deepEqual(await fetchActiveGiftCodes(now), []);
});

test("first check posts the full list and subsequent reordered checks do not post or rewrite state", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gift-codes-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, "gift-codes.json");
  const messages: { embeds: APIEmbed[] }[] = [];
  const run = {
    channelId, stateFile, fetchCodes: async () => baseline,
    send: async (message: { embeds: APIEmbed[] }) => { messages.push(message); },
  };
  assert.deepEqual(await runGiftCodeUpdate(run), { status: "posted", count: 2 });
  const saved = fs.readFileSync(stateFile, "utf8");
  assert.match(messages[0].embeds[0].description ?? "", /`Kingshot888`\n\n`VIP777`/);
  assert.deepEqual(await runGiftCodeUpdate({
    ...run, fetchCodes: async () => [baseline[1], baseline[0], baseline[0]],
  }), { status: "unchanged", count: 2 });
  assert.equal(messages.length, 1);
  assert.equal(fs.readFileSync(stateFile, "utf8"), saved);
});

test("additions, expiry changes, removals and an empty active list each post exactly once", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gift-codes-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, "gift-codes.json");
  let sends = 0;
  const run = { channelId, stateFile, send: async () => { sends++; } };
  const snapshots = [
    baseline,
    [...baseline, { code: "NEW", expiresAt: null }],
    [...baseline, { code: "NEW", expiresAt: "2026-11-09T00:00:00Z" }],
    baseline,
    [],
  ];
  for (const codes of snapshots) {
    assert.equal((await runGiftCodeUpdate({ ...run, fetchCodes: async () => codes })).status, "posted");
    assert.equal((await runGiftCodeUpdate({ ...run, fetchCodes: async () => codes })).status, "unchanged");
  }
  assert.equal(sends, snapshots.length);
});

test("failed fetches or deliveries preserve state and allow the next run to retry", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gift-codes-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, "gift-codes.json");
  const run = { channelId, stateFile, fetchCodes: async () => baseline, send: async () => {} };
  await assert.rejects(runGiftCodeUpdate({
    ...run, send: async () => { throw new Error("Discord unavailable"); },
  }), /Discord unavailable/);
  assert.equal(fs.existsSync(stateFile), false);
  await runGiftCodeUpdate(run);
  const saved = fs.readFileSync(stateFile, "utf8");
  await assert.rejects(runGiftCodeUpdate({
    ...run, fetchCodes: async () => { throw new Error("Atlas unavailable"); },
  }), /Atlas unavailable/);
  await assert.rejects(runGiftCodeUpdate({
    ...run, fetchCodes: async () => [],
    send: async () => { throw new Error("Discord unavailable"); },
  }), /Discord unavailable/);
  assert.equal(fs.readFileSync(stateFile, "utf8"), saved);
  assert.equal((await runGiftCodeUpdate({ ...run, fetchCodes: async () => [] })).status, "posted");
});

test("previews do not save state and corrupt saved state fails before fetching or posting", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gift-codes-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, "gift-codes.json");
  const run = { channelId, stateFile, fetchCodes: async () => baseline, send: async () => {} };
  assert.equal((await runGiftCodeUpdate({ ...run, dryRun: true })).status, "previewed");
  assert.equal(fs.existsSync(stateFile), false);
  await runGiftCodeUpdate(run);
  const saved = fs.readFileSync(stateFile, "utf8");
  await runGiftCodeUpdate({ ...run, fetchCodes: async () => [], dryRun: true });
  assert.equal(fs.readFileSync(stateFile, "utf8"), saved);
  fs.writeFileSync(stateFile, JSON.stringify({ version: 99, channelId, codes: baseline }));
  await assert.rejects(runGiftCodeUpdate({
    ...run, fetchCodes: async () => { throw new Error("Must not fetch"); },
    send: async () => { throw new Error("Must not post"); },
  }), /Invalid gift-code state/);
});

test("oversized gift-code lists fail before delivery or state changes", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gift-codes-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, "gift-codes.json");
  await assert.rejects(runGiftCodeUpdate({
    channelId, stateFile,
    fetchCodes: async () => Array.from({ length: 50 }, (_, index) => ({
      code: `${index}${"x".repeat(98)}`, expiresAt: null,
    })),
    send: async () => { throw new Error("Must not post"); },
  }), /exceeds Discord embed limits/);
  assert.equal(fs.existsSync(stateFile), false);
});

test("Discord delivers both gift-code embeds and existing plain messages with mentions suppressed", async (t) => {
  const payloads: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(input, `https://discord.com/api/v10/channels/${channelId}/messages`);
    assert.equal(init?.method, "POST");
    payloads.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "1568957584742944839" });
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gift-codes-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  await runGiftCodeUpdate({
    channelId, stateFile: path.join(directory, "gift-codes.json"), fetchCodes: async () => baseline,
    send: async (message) => { await sendDiscordMessage("test-token", channelId, message); },
  });
  const embedded = payloads[0] as { embeds: { description: string; color: number }[]; allowed_mentions: { parse: string[] } };
  assert.equal(embedded.embeds[0].color, 0x9B59B6);
  assert.match(embedded.embeds[0].description, /Kingshot888/);
  assert.deepEqual(embedded.allowed_mentions, { parse: [] });
  await sendDiscordMessage("test-token", channelId, "Existing leaderboard message");
  assert.deepEqual(payloads[1], { content: "Existing leaderboard message", allowed_mentions: { parse: [] } });
});
