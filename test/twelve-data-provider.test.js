import test from "node:test";
import assert from "node:assert/strict";
import { parseDecimal } from "../src/domain/decimal.js";
import { createTwelveDataProvider } from "../src/server/twelve-data-provider.mjs";

const START = Date.parse("2026-10-07T10:00:20Z");
const MINUTE = 60_000;
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const minuteBars = (closes) => ({
  meta: { interval: "1min" },
  values: closes.map((close, index) => ({ datetime: `2026-10-07 09:5${9 - index}:00`, close: String(close) })),
  status: "ok",
});
const symbolsOf = (url) => new URL(url).searchParams.get("symbol").split(",");
const pair = (id) => ({ base: id.slice(0, 3), quote: id.slice(4) });

// A provider with a key and display rights, a controllable clock and a recorded fake upstream.
function setup(respond, options = {}) {
  const state = { clock: START, calls: [] };
  const provider = createTwelveDataProvider({
    apiKey: "test-key",
    externalDisplayLicensed: true,
    now: () => state.clock,
    fetchImpl: async (url, init) => {
      state.calls.push({ url: new URL(url), headers: init.headers, symbols: symbolsOf(url) });
      return respond(symbolsOf(url), state);
    },
    ...options,
  });
  return { provider, state };
}
const allOk = (symbols) => json(symbols.length === 1 ? minuteBars([1.1, 1.2]) : Object.fromEntries(symbols.map((symbol) => [symbol, minuteBars([1.1, 1.2])])));

test("stays off without a key, or without the display flag, and makes no request", async () => {
  let requests = 0;
  const fetchImpl = async () => { requests += 1; return json({}); };
  const noKey = createTwelveDataProvider({ apiKey: "", externalDisplayLicensed: true, fetchImpl });
  const noFlag = createTwelveDataProvider({ apiKey: "test-key", externalDisplayLicensed: false, fetchImpl });
  const first = await noKey.getHistories([pair("USD/EUR")], "5min");
  const second = await noFlag.getHistories([pair("USD/EUR")], "5min");
  assert.equal(requests, 0);
  assert.deepEqual(first.rates, { "USD/EUR": [] });
  assert.equal(first.details["USD/EUR"].reason, "no-api-key");
  assert.equal(second.details["USD/EUR"].reason, "display-license-unconfirmed");
  assert.equal(noKey.status().state, "no-api-key");
  assert.equal(noFlag.status().state, "display-license-unconfirmed");
});

test("sends one batched request with the key in a header, and caches the answer for five minutes", async () => {
  const { provider, state } = setup(allOk);
  const pairs = [pair("USD/EUR"), pair("USD/CAD")];
  const first = await provider.getHistories(pairs, "5min");
  assert.equal(state.calls.length, 1);
  assert.deepEqual(state.calls[0].symbols, ["USD/EUR", "USD/CAD"]);
  assert.equal(state.calls[0].headers.authorization, "apikey test-key");
  assert.equal(state.calls[0].url.searchParams.has("apikey"), false);
  assert.equal(state.calls[0].url.href.includes("test-key"), false);
  assert.equal(state.calls[0].url.searchParams.get("interval"), "1min");
  assert.equal(first.details["USD/EUR"].status, "fresh");
  assert.deepEqual(first.rates["USD/CAD"].map(({ rate }) => rate), ["1.2", "1.1"]);
  assert.equal(first.rates["USD/CAD"].at(-1).observedAt, "2026-10-07T09:59:00.000Z");

  state.clock = START + 4 * MINUTE;
  const second = await provider.getHistories(pairs, "5min");
  assert.equal(state.calls.length, 1);
  assert.equal(second.details["USD/EUR"].status, "cached");

  state.clock = START + 6 * MINUTE;
  await provider.getHistories(pairs, "5min");
  assert.equal(state.calls.length, 2);
});

test("shares one request between callers that ask for the same symbol at the same time", async () => {
  const { provider, state } = setup(allOk);
  const [first, second] = await Promise.all([
    provider.getHistories([pair("USD/EUR")], "24h"),
    provider.getHistories([pair("USD/EUR")], "24h"),
  ]);
  assert.equal(state.calls.length, 1);
  assert.equal(first.rates["USD/EUR"].length, 2);
  assert.deepEqual(second.rates, first.rates);
});

test("on HTTP 429 serves the last observations as stale and stops calling until the minute turns", async () => {
  let limited = false;
  const { provider, state } = setup((symbols) => (limited
    ? json({ code: 429, message: "You have run out of API credits for the current minute. 9 API credits were used, with the current limit being 8.", status: "error" }, 429)
    : allOk(symbols)));
  await provider.getHistories([pair("USD/EUR")], "5min");

  limited = true;
  state.clock = START + 6 * MINUTE;
  const stale = await provider.getHistories([pair("USD/EUR")], "5min");
  assert.equal(state.calls.length, 2);
  assert.equal(stale.details["USD/EUR"].status, "stale");
  assert.equal(stale.details["USD/EUR"].reason, "rate-limited");
  assert.equal(stale.rates["USD/EUR"].length, 2);
  assert.deepEqual(stale.errors, []);
  assert.equal(provider.status().state, "rate-limited");

  const other = await provider.getHistories([pair("USD/CAD")], "5min");
  assert.equal(state.calls.length, 2, "no request while the limit is in force");
  assert.equal(other.details["USD/CAD"].status, "missing");
  assert.equal(other.details["USD/CAD"].reason, "rate-limited");
  assert.ok(other.details["USD/CAD"].retryAfterMs > 0 && other.details["USD/CAD"].retryAfterMs <= 61_000);

  limited = false;
  state.clock += other.details["USD/CAD"].retryAfterMs;
  const recovered = await provider.getHistories([pair("USD/CAD")], "5min");
  assert.equal(state.calls.length, 3);
  assert.equal(recovered.details["USD/CAD"].status, "fresh");
  assert.equal(provider.status().state, "active");
});

test("tells a daily limit from a minute limit and waits for midnight UTC", async () => {
  const { provider, state } = setup(() => json({ code: 429, message: "You have run out of API credits for the day.", status: "error" }, 429));
  const result = await provider.getHistories([pair("USD/EUR")], "5min");
  assert.equal(result.details["USD/EUR"].reason, "quota-exhausted");
  assert.equal(provider.status().state, "quota-exhausted");
  assert.equal(state.clock + provider.status().retryAfterMs, Date.parse("2026-10-08T00:00:00Z"));
});

test("never spends more credits per minute than the plan allows, and says when to ask again", async () => {
  const { provider, state } = setup(allOk, { creditsPerMinute: 2 });
  const pairs = [pair("USD/EUR"), pair("USD/CAD"), pair("USD/JPY")];
  const first = await provider.getHistories(pairs, "5min");
  assert.deepEqual(state.calls.map((call) => call.symbols), [["USD/EUR", "USD/CAD"]]);
  assert.equal(first.details["USD/JPY"].status, "missing");
  assert.equal(first.details["USD/JPY"].reason, "rate-limited");
  assert.equal(first.details["USD/JPY"].retryAfterMs, 60_000);

  state.clock += first.details["USD/JPY"].retryAfterMs;
  const second = await provider.getHistories(pairs, "5min");
  assert.deepEqual(state.calls.at(-1).symbols, ["USD/JPY"]);
  assert.equal(second.details["USD/JPY"].status, "fresh");
  assert.equal(second.details["USD/EUR"].status, "cached");
});

test("stops at the daily credit budget", async () => {
  const { provider, state } = setup(allOk, { creditsPerDay: 1 });
  const result = await provider.getHistories([pair("USD/EUR"), pair("USD/CAD")], "5min");
  assert.equal(state.calls.length, 1);
  assert.equal(result.details["USD/EUR"].status, "fresh");
  assert.equal(result.details["USD/CAD"].reason, "quota-exhausted");
});

test("an error for one symbol inside a batch leaves the others intact and is not asked for again", async () => {
  const { provider, state } = setup((symbols) => json(Object.fromEntries(symbols.map((symbol) => [
    symbol,
    symbol === "USD/ZZZ" ? { code: 404, message: "**symbol** not found: USD/ZZZ.", status: "error" } : minuteBars([1.1, 1.2]),
  ]))));
  const pairs = [pair("USD/EUR"), pair("USD/ZZZ")];
  const first = await provider.getHistories(pairs, "5min");
  assert.equal(first.details["USD/EUR"].status, "fresh");
  assert.equal(first.details["USD/ZZZ"].status, "missing");
  assert.equal(first.details["USD/ZZZ"].reason, "unsupported-symbol");
  assert.deepEqual(first.errors.map((error) => error.pair), ["USD/ZZZ"]);

  state.clock += 10 * MINUTE;
  const otherRange = await provider.getHistories(pairs, "24h");
  assert.deepEqual(state.calls.at(-1).symbols, ["USD/EUR"], "the unsupported symbol is left out at every range");
  assert.equal(otherRange.details["USD/ZZZ"].reason, "unsupported-symbol");
  assert.equal(otherRange.details["USD/ZZZ"].retryAfterMs, null);
});

test("asks for each metal on its own, so a plan without silver still returns gold", async () => {
  const { provider, state } = setup((symbols) => {
    if (symbols[0] === "XAG/USD") return json({ code: 403, message: "This symbol is available starting with the Grow plan.", status: "error" }, 403);
    return json(minuteBars(symbols[0] === "XAU/USD" ? [4000, 4010] : [0.9, 0.91]));
  });
  const result = await provider.getHistories([pair("XAU/USD"), pair("USD/XAU"), pair("XAG/USD"), pair("USD/EUR")], "5min");
  assert.deepEqual(state.calls.map((call) => call.symbols).sort(), [["USD/EUR"], ["XAG/USD"], ["XAU/USD"]]);
  assert.equal(result.rates["XAU/USD"].at(-1).rate, "4000");
  assert.equal(result.rates["USD/XAU"].at(-1).rate, "0.00025");
  assert.notEqual(parseDecimal(result.rates["USD/XAU"][0].rate), null);
  assert.equal(result.details["XAG/USD"].reason, "unsupported-symbol");
  assert.equal(result.details["USD/EUR"].status, "fresh");
});

test("a batch refused as a whole is retried one symbol at a time", async () => {
  const { provider, state } = setup((symbols) => (symbols.length > 1
    ? json({ code: 404, message: "**symbol** not found", status: "error" }, 404)
    : symbols[0] === "USD/ZZZ" ? json({ code: 404, message: "**symbol** not found", status: "error" }, 404) : json(minuteBars([1.1, 1.2]))));
  const pairs = [pair("USD/EUR"), pair("USD/ZZZ")];
  const first = await provider.getHistories(pairs, "5min");
  assert.equal(first.details["USD/EUR"].status, "missing");
  assert.equal(first.details["USD/EUR"].reason, "provider-error");
  assert.equal(first.details["USD/EUR"].retryAfterMs, 1_500);

  state.clock += 2_000;
  const second = await provider.getHistories(pairs, "5min");
  assert.deepEqual(state.calls.slice(1).map((call) => call.symbols).sort(), [["USD/EUR"], ["USD/ZZZ"]]);
  assert.equal(second.details["USD/EUR"].status, "fresh");
  assert.equal(second.details["USD/ZZZ"].reason, "unsupported-symbol");
});

test("keeps daily bars as plain dates, in date order, without repeated dates", async () => {
  const { provider } = setup(() => json({
    values: [
      { datetime: "2026-10-05", close: "1.3" },
      { datetime: "2026-10-04", close: "1.2" },
      { datetime: "2026-10-04", close: "1.19" },
      { datetime: "2026-10-03", close: "0" },
      { datetime: "not a date", close: "1.0" },
    ],
    status: "ok",
  }));
  const result = await provider.getHistories([pair("USD/EUR")], "1m");
  assert.deepEqual(result.rates["USD/EUR"], [{ date: "2026-10-04", rate: "1.2" }, { date: "2026-10-05", rate: "1.3" }]);
});

test("reports a rejected key and stops calling", async () => {
  const { provider, state } = setup(() => json({ code: 401, message: "**apikey** parameter is incorrect or not specified.", status: "error" }, 401));
  const result = await provider.getHistories([pair("USD/EUR")], "5min");
  assert.equal(result.details["USD/EUR"].reason, "unauthorized");
  assert.equal(provider.status().state, "unauthorized");
  await provider.getHistories([pair("USD/CAD")], "5min");
  assert.equal(state.calls.length, 1);
});

test("gives the credit back when the request never reached the provider", async () => {
  let offline = true;
  const { provider, state } = setup((symbols) => {
    if (offline) throw new TypeError("fetch failed");
    return allOk(symbols);
  }, { creditsPerMinute: 1 });
  const failed = await provider.getHistories([pair("USD/EUR")], "5min");
  assert.equal(failed.details["USD/EUR"].reason, "provider-error");
  offline = false;
  const next = await provider.getHistories([pair("USD/CAD")], "5min");
  assert.equal(state.calls.length, 2);
  assert.equal(next.details["USD/CAD"].status, "fresh");
});

test("answers by the deadline and finishes loading in the background", async () => {
  const { provider, state } = setup(async (symbols) => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return allOk(symbols);
  });
  const early = await provider.getHistories([pair("USD/EUR")], "5min", { deadlineMs: 5 });
  assert.equal(early.details["USD/EUR"].status, "missing");
  assert.equal(early.details["USD/EUR"].reason, "pending");
  assert.equal(early.details["USD/EUR"].retryAfterMs, 1_500);

  await new Promise((resolve) => setTimeout(resolve, 120));
  const later = await provider.getHistories([pair("USD/EUR")], "5min", { deadlineMs: 5 });
  assert.equal(state.calls.length, 1);
  assert.equal(later.details["USD/EUR"].status, "cached");
});
