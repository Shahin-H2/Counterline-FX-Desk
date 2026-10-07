import test from "node:test";
import assert from "node:assert/strict";
import { isObservationStale, observationAgeInDays, STALE_AFTER_CALENDAR_DAYS } from "../src/domain/freshness.js";

test("daily observations remain fresh for three calendar days and then become stale", () => {
  const now = new Date("2026-10-05T12:00:00Z");
  assert.equal(observationAgeInDays("2026-10-02", now), 3);
  assert.equal(isObservationStale("2026-10-02", now), false);
  assert.equal(isObservationStale("2026-10-01", now), true);
  assert.equal(STALE_AFTER_CALENDAR_DAYS, 3);
});

test("invalid or missing observation dates fail closed as stale", () => {
  assert.equal(isObservationStale("not-a-date", new Date("2026-10-05T12:00:00Z")), true);
  assert.equal(isObservationStale("2026-02-30", new Date("2026-10-05T12:00:00Z")), true);
});

