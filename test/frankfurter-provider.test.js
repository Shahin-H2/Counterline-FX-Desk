import test from "node:test";
import assert from "node:assert/strict";
import { fetchFrankfurterHistory, fetchFrankfurterRates } from "../src/server/frankfurter-provider.mjs";

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


test("fetches a pair quoted in gold metal-first and inverts it, because the direct rate is rounded to 0.00024", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(new URL(url));
    return { ok: true, json: async () => [{ date: "2026-10-09", base: "XAU", quote: "USD", rate: 4000 }] };
  };
  const result = await fetchFrankfurterRates([{ base: "USD", quote: "XAU" }, { base: "XAU", quote: "USD" }], { fetchImpl });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].searchParams.get("base"), "XAU");
  assert.equal(requests[0].searchParams.get("quotes"), "USD");
  assert.equal(result.rates["XAU/USD"].rate, "4000");
  assert.deepEqual(result.rates["USD/XAU"], { base: "USD", quote: "XAU", rate: "0.00025", date: "2026-10-09" });
  assert.deepEqual(result.errors, []);
});

test("asks for the opposite direction when a rate is too small to carry enough digits", async () => {
  const bases = [];
  const fetchImpl = async (url) => {
    const base = new URL(url).searchParams.get("base");
    bases.push(base);
    const record = base === "IRR"
      ? { date: "2026-10-09", base: "IRR", quote: "USD", rate: 0.000001 }
      : { date: "2026-10-09", base: "USD", quote: "IRR", rate: 1739580 };
    return { ok: true, json: async () => [record] };
  };
  const result = await fetchFrankfurterRates([{ base: "IRR", quote: "USD" }], { fetchImpl });
  assert.deepEqual(bases, ["IRR", "USD"]);
  assert.equal(result.rates["IRR/USD"].rate, "0.000000574851");
});

test("keeps the rounded rate when the opposite direction cannot be loaded", async () => {
  const fetchImpl = async (url) => {
    if (new URL(url).searchParams.get("base") === "USD") return { ok: false, status: 503 };
    return { ok: true, json: async () => [{ date: "2026-10-09", base: "JPY", quote: "USD", rate: 0.00632 }] };
  };
  const result = await fetchFrankfurterRates([{ base: "JPY", quote: "USD" }], { fetchImpl });
  assert.equal(result.rates["JPY/USD"].rate, "0.00632");
  assert.deepEqual(result.errors, []);
});

test("returns history in date order, inside the requested window, in the requested direction", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [
      { date: "2026-10-07", base: "XAG", quote: "USD", rate: 50 },
      { date: "2026-09-30", base: "XAG", quote: "USD", rate: 48 },
      { date: "2026-10-06", base: "XAG", quote: "USD", rate: 40 },
      { date: "2026-10-06", base: "XAG", quote: "EUR", rate: 36 },
    ],
  });
  const result = await fetchFrankfurterHistory([{ base: "USD", quote: "XAG" }], { from: "2026-10-01", to: "2026-10-07", fetchImpl });
  assert.deepEqual(result.rates["USD/XAG"], [{ date: "2026-10-06", rate: "0.025" }, { date: "2026-10-07", rate: "0.02" }]);
});
