import { fetchFrankfurterRates, FRANKFURTER_SOURCE } from "./frankfurter-provider.mjs";

const pairKey = (pair) => `${pair.base}/${pair.quote}`;
const cacheKeyFor = (pairs) => pairs.map(pairKey).sort().join("|");

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

      try {
        const result = await provider(pairs);
        const oldRates = previous?.payload.rates ?? {};
        const rates = { ...result.rates };
        const errors = result.errors ?? [];
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
        if (Object.keys(rates).length) cache.set(key, { payload, expiresAt: instant.getTime() + cacheTtlMs });
        return { ...payload, checkedAt: instant.toISOString() };
      } catch {
        if (previous && Object.keys(previous.payload.rates).length) {
          return {
            ...previous.payload,
            checkedAt: instant.toISOString(),
            cacheStatus: "stale-cache",
            errors: [{ message: "The reference provider could not be reached; showing the last successful server cache." }],
          };
        }
        throw new Error("Reference provider unavailable.");
      }
    },
  };
}
