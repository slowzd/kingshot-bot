import assert from "node:assert/strict";
import { test } from "node:test";
import { getDueHourlySlot } from "./hourly-scheduler.js";

test("returns the current hourly slot after UTC :01, including late starts", () => {
  assert.equal(getDueHourlySlot(new Date("2026-10-13T11:00:59Z"), ""), null);
  assert.equal(getDueHourlySlot(new Date("2026-10-13T11:01:00Z"), ""), "2026-10-13T11");
  assert.equal(getDueHourlySlot(new Date("2026-10-13T11:04:00Z"), ""), "2026-10-13T11");
});

test("does not repeat an hourly slot and advances to the next one", () => {
  assert.equal(
    getDueHourlySlot(new Date("2026-10-13T11:59:00Z"), "2026-10-13T11"),
    null,
  );
  assert.equal(
    getDueHourlySlot(new Date("2026-10-13T12:01:00Z"), "2026-10-13T11"),
    "2026-10-13T12",
  );
});
