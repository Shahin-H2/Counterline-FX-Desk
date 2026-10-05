import test from "node:test";
import assert from "node:assert/strict";
import { fetchFrankfurterRates } from "../src/server/frankfurter-provider.mjs";

test("requests rates grouped by base and preserves pair direction and observation dates", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(new URL(url));
    return {
      ok: true,
      json: async () => [
        { date: "2026-10-02", base: "USD", quote: "EUR", rate: 0.91 },
        { date: "2026-10-02", base: "EUR", quote: "USD", rate: 1.0989 },
      ],
    };
  };

  const result = await fetchFrankfurterRates([{ base: "USD", quote: "EUR" }, { base: "EUR", quote: "USD" }], {
    fetchImpl,
    now: () => new Date("2026-10-03T08:00:00Z"),
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(new Set(requests.map((url) => url.searchParams.get("base"))), new Set(["USD", "EUR"]));
  assert.equal(result.rates["USD/EUR"].rate, "0.91");
  assert.equal(result.rates["USD/EUR"].date, "2026-10-02");
  assert.equal(result.rates["EUR/USD"].rate, "1.0989");
  assert.deepEqual(result.errors, []);
});

test("reports failed base groups while keeping successful pair coverage", async () => {
  const fetchImpl = async (url) => {
    const base = new URL(url).searchParams.get("base");
    if (base === "EUR") return { ok: false, status: 503 };
    return { ok: true, json: async () => [{ date: "2026-10-02", base: "USD", quote: "CAD", rate: 1.37 }] };
  };
  const result = await fetchFrankfurterRates([{ base: "USD", quote: "CAD" }, { base: "EUR", quote: "USD" }], { fetchImpl });
  assert.equal(result.rates["USD/CAD"].rate, "1.37");
  assert.equal(result.rates["EUR/USD"], undefined);
  assert.deepEqual(result.errors, [{ base: "EUR", message: "Reference provider unavailable for this base currency." }]);
});

