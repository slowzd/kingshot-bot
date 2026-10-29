import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchPowerSnapshot } from "./mightpulse.ts";

test("fetch identifies the bot and parses the requested kingdom's power board", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(input, "https://mightpulse.com/api/kingdoms/2446/ingame-ranks");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Accept"), "application/json");
    assert.equal(headers.get("User-Agent"), "kingshot-stratforge-bot/1.0");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    return Response.json({
      ok: true,
      kid: 2446,
      boards: {
        "1": {
          type: 1,
          captured_at: Date.parse("2026-10-29T01:00:39Z") / 1000,
          rows: [{ aid: 1, rank: 1, kid: 2446, name: "Alliance", abbr: "TAG", score: 100 }],
        },
      },
    });
  });

  const snapshot = await fetchPowerSnapshot(2446);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(snapshot.kingdom, 2446);
  assert.equal(snapshot.capturedAt.toISOString(), "2026-10-29T01:00:39.000Z");
  assert.deepEqual(snapshot.alliances, [{ id: 1, rank: 1, tag: "TAG", name: "Alliance", power: 100 }]);
});

test("fetch propagates HTTP failures instead of treating them as missing daily data", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("Access denied", { status: 403 }));
  await assert.rejects(fetchPowerSnapshot(2426), /Mightpulse API request failed: HTTP 403/);
});

test("fetch still rejects invalid API data", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: false }));
  await assert.rejects(fetchPowerSnapshot(2426), /Mightpulse returned an invalid response/);
});
