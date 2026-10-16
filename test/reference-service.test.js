// Copyright (c) 2026 Shahin Hassanyan. All rights reserved.

import test from "node:test";
import assert from "node:assert/strict";
import { createReferenceService } from "../src/server/reference-service.mjs";

test("serves short-lived server cache without another provider call", async () => {
  let clock = new Date("2026-10-03T08:00:00Z");
  let providerCalls = 0;
  const service = createReferenceService({
    now: () => clock,
    cacheTtlMs: 60_000,
    provider: async () => {
      providerCalls += 1;
      return { source: "fixture provider", retrievedAt: clock.toISOString(), rates: { "USD/EUR": { base: "USD", quote: "EUR", rate: "0.91", date: "2026-10-02" }, }, errors: [] };
    },
  });
  const pairs = [{ base: "USD", quote: "EUR" }];
  const first = await service.getRates(pairs);
  clock = new Date("2026-10-03T08:00:20Z");
  const second = await service.getRates(pairs);
  assert.equal(providerCalls, 1);
  assert.equal(first.cacheStatus, "fresh");
  assert.equal(second.cacheStatus, "cached");
  assert.equal(second.rates["USD/EUR"].date, "2026-10-02");
});

test("falls back transparently to an expired local cache after provider failure", async () => {
  let clock = new Date("2026-10-03T08:00:00Z");
  let fail = false;
  const service = createReferenceService({
    now: () => clock,
    cacheTtlMs: 1000,
    provider: async () => {
      if (fail) throw new Error("provider unavailable");
      return { retrievedAt: clock.toISOString(), rates: { "USD/TRY": { base: "USD", quote: "TRY", rate: "41", date: "2026-10-02" } }, errors: [] };
    },
  });
  const pairs = [{ base: "USD", quote: "TRY" }];
  await service.getRates(pairs);
  fail = true;
  clock = new Date("2026-10-03T08:01:01Z");
  const fallback = await service.getRates(pairs);
  assert.equal(fallback.cacheStatus, "stale-cache");
  assert.equal(fallback.rates["USD/TRY"].rate, "41");
  assert.match(fallback.errors[0].message, /could not be reached/);
});

test("keeps cached-pair warnings when a partial response is served from the short cache", async () => {
  let clock = new Date("2026-10-03T08:00:00Z");
  let calls = 0;
  const service = createReferenceService({
    now: () => clock,
    cacheTtlMs: 60_000,
    provider: async () => {
      calls += 1;
      if (calls === 1) return { retrievedAt: clock.toISOString(), rates: { "USD/EUR": { rate: "0.91", date: "2026-10-02" }, "USD/CAD": { rate: "1.37", date: "2026-10-02" } }, errors: [] };
      return { retrievedAt: clock.toISOString(), rates: { "USD/EUR": { rate: "0.92", date: "2026-10-03" } }, errors: [{ base: "USD", message: "Partial provider coverage." }] };
    },
  });
  const pairs = [{ base: "USD", quote: "EUR" }, { base: "USD", quote: "CAD" }];
  await service.getRates(pairs);
  clock = new Date("2026-10-03T08:01:01Z");
  const partial = await service.getRates(pairs);
  assert.equal(partial.cacheStatus, "partial-cache");
  assert.equal(partial.rates["USD/CAD"].cacheFallback, true);
  clock = new Date("2026-10-03T08:01:10Z");
  const cachedPartial = await service.getRates(pairs);
  assert.equal(cachedPartial.cacheStatus, "partial-cache");
  assert.equal(cachedPartial.rates["USD/CAD"].cacheFallback, true);
});
