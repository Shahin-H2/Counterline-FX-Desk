// Copyright (c) 2026 Shahin Hassanyan. All rights reserved.

import test from "node:test";
import assert from "node:assert/strict";
import { isObservationStale, observationAgeInDays, observationAgeInLocalDays, STALE_AFTER_CALENDAR_DAYS } from "../src/domain/freshness.js";

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

test("the age shown to a viewer is counted on their own calendar, at any hour of their day", () => {
  // Built from local date parts, so these hold in whatever time zone the tests run.
  const justAfterMidnight = new Date(2026, 9, 13, 0, 30);
  const justBeforeMidnight = new Date(2026, 9, 13, 23, 30);
  for (const now of [justAfterMidnight, justBeforeMidnight]) {
    assert.equal(observationAgeInLocalDays("2026-10-06", now), 7);
    assert.equal(observationAgeInLocalDays("2026-10-12", now), 1);
    assert.equal(observationAgeInLocalDays("2026-10-13", now), 0);
    assert.equal(observationAgeInLocalDays("2026-10-14", now), -1);
  }
  assert.equal(observationAgeInLocalDays("2026-09-29", new Date(2026, 9, 13, 12, 0)), 14, "across a month boundary");
  assert.equal(observationAgeInLocalDays("2025-12-31", new Date(2026, 0, 2, 9, 0)), 2, "across a year boundary");
  assert.equal(observationAgeInLocalDays("2026-03-06", new Date(2026, 2, 13, 12, 0)), 7, "across a daylight saving change");
  assert.equal(observationAgeInLocalDays("not-a-date", justAfterMidnight), null);
  assert.equal(observationAgeInLocalDays("2026-02-30", justAfterMidnight), null);
  assert.equal(observationAgeInLocalDays(undefined, justAfterMidnight), null);
});

