// Copyright (c) 2026 Shahin Hassanyan. All rights reserved.
//
// Latest reference rates for a set of pairs, cached for ten minutes. When the provider fails, the
// last good response is served, marked as a stale cache.

import { fetchFrankfurterRates, FRANKFURTER_SOURCE } from "./frankfurter-provider.mjs";

const pairKey = (pair) => `${pair.base}/${pair.quote}`;
const cacheKeyFor = (pairs) => pairs.map(pairKey).sort().join("|");
// A response that had to lean on older rates is retried sooner than a clean one.
const DEGRADED_TTL_MS = 60 * 1000;
const MAX_CACHED_PAIR_SETS = 200;

export function createReferenceService({
  provider = fetchFrankfurterRates,
  now = () => new Date(),
  cacheTtlMs = 10 * 60 * 1000,
} = {}) {
  const cache = new Map();

  return {
    async getRates(pairs) {
      const key = cacheKeyFor(pairs);
      const instant = now();
      const previous = cache.get(key);
      if (previous && previous.expiresAt > instant.getTime()) {
        const cacheStatus = previous.payload.cacheStatus === "fresh" ? "cached" : previous.payload.cacheStatus;
        return { ...previous.payload, checkedAt: instant.toISOString(), cacheStatus };
      }
      const lastGood = previous && Object.keys(previous.payload.rates).length ? previous.payload : null;
      const staleResponse = () => ({
        ...lastGood,
        checkedAt: instant.toISOString(),
        cacheStatus: "stale-cache",
        errors: [{ message: "The reference provider could not be reached; showing the last successful server cache." }],
      });

      try {
        const result = await provider(pairs);
        // Nothing came back at all: keep the last good response and its original retrieval time.
        if (lastGood && !Object.keys(result.rates ?? {}).length) return staleResponse();
        const oldRates = previous?.payload.rates ?? {};
        const rates = { ...result.rates };
        const errors = [...(result.errors ?? [])];
        const fallbackPairs = [];
        for (const pair of pairs) {
          const key = pairKey(pair);
          if (!rates[key] && oldRates[key]) {
            rates[key] = { ...oldRates[key], cacheFallback: true };
            fallbackPairs.push(key);
          }
        }
        if (fallbackPairs.length) {
          errors.push({ message: "Some pairs are using the last successful local cache." });
        }
        const fetchedAt = result.retrievedAt ?? instant.toISOString();
        const payload = {
          source: result.source ?? FRANKFURTER_SOURCE,
          retrievedAt: fetchedAt,
          rates,
          errors,
          fallbackPairs,
          cacheStatus: fallbackPairs.length ? "partial-cache" : errors.length ? "partial" : "fresh",
        };
        if (Object.keys(rates).length) {
          const ttl = fallbackPairs.length || errors.length ? Math.min(cacheTtlMs, DEGRADED_TTL_MS) : cacheTtlMs;
          cache.delete(key);
          cache.set(key, { payload, expiresAt: instant.getTime() + ttl });
          if (cache.size > MAX_CACHED_PAIR_SETS) cache.delete(cache.keys().next().value);
        }
        return { ...payload, checkedAt: instant.toISOString() };
      } catch {
        if (lastGood) return staleResponse();
        throw new Error("Reference provider unavailable.");
      }
    },
  };
}
