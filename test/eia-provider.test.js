import test from "node:test";
import assert from "node:assert/strict";
import { createEiaSpotPrices, parseEiaHistoryPage } from "../src/server/eia-provider.mjs";

const HOUR = 60 * 60 * 1000;
const START = Date.parse("2026-10-07T10:00:00Z");
const week = (label, cells) => `<tr><td class='B6'>&nbsp;&nbsp;${label}</td>${cells.map((cell) => `<td class='B3'>${cell}</td>`).join("")}</tr>`;
// The shape of https://www.eia.gov/dnav/pet/hist/RWTCD.htm: one row per week, Monday to Friday.
const PAGE = `<table><tr><th>Week Of</th><th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th><th>Fri</th></tr>
${week("2020 Apr-20 to Apr-24", ["-36.98", "8.91", "13.64", "15.06", "15.99"])}
${week("2025 Dec-29 to Jan- 2", ["57.89", "57.79", "57.26", "", "57.21"])}
${week("2026 Sep-28 to Oct- 2", ["99.37", "96.16", "97.18", "99.77", "97.89"])}
${week("2026 Oct- 5 to Oct- 9", ["96.13", "96.24", "", "", ""])}
</table>`;
const html = (text, status = 200) => ({ ok: status < 400, status, text: async () => text, json: async () => JSON.parse(text) });

function setup(respond, options = {}) {
  const state = { clock: START, calls: [] };
  const prices = createEiaSpotPrices({
    now: () => state.clock,
    fetchImpl: async (url, init) => {
      state.calls.push({ url: new URL(url), headers: init.headers });
      return respond(new URL(url), state);
    },
    ...options,
  });
  return { prices, state };
}

test("reads a history page: Monday-dated weeks, blank days, a year boundary, and no negative price", () => {
  const observations = parseEiaHistoryPage(PAGE);
  assert.deepEqual(observations.slice(0, 4), [
    { date: "2020-04-21", rate: "8.91" },
    { date: "2020-04-22", rate: "13.64" },
    { date: "2020-04-23", rate: "15.06" },
    { date: "2020-04-24", rate: "15.99" },
  ]);
  assert.deepEqual(observations.filter(({ date }) => date > "2025-12-01" && date < "2026-02-01"), [
    { date: "2025-12-29", rate: "57.89" },
    { date: "2025-12-30", rate: "57.79" },
    { date: "2025-12-31", rate: "57.26" },
    { date: "2026-01-02", rate: "57.21" },
  ]);
  assert.deepEqual(observations.slice(-2), [{ date: "2026-10-05", rate: "96.13" }, { date: "2026-10-06", rate: "96.24" }]);
  assert.deepEqual(parseEiaHistoryPage("<html>maintenance</html>"), []);
});

test("without a key it reads the public pages, one per series, and keeps them for six hours", async () => {
  const { prices, state } = setup(() => html(PAGE));
  const first = await prices.getSeries(["WTI", "BRENT", "WTI"]);
  assert.deepEqual(state.calls.map((call) => call.url.pathname).sort(), ["/dnav/pet/hist/RBRTED.htm", "/dnav/pet/hist/RWTCD.htm"]);
  assert.equal(first.WTI.observations.at(-1).date, "2026-10-06");
  assert.equal(first.WTI.observations[0].date, "2025-12-29", "older history than the charts need is dropped");
  assert.equal(first.WTI.stale, false);
  assert.equal(prices.usesApiKey(), false);

  state.clock = START + 5 * HOUR;
  await prices.getSeries(["WTI"]);
  assert.equal(state.calls.length, 2);
  state.clock = START + 7 * HOUR;
  await prices.getSeries(["WTI"]);
  assert.equal(state.calls.length, 3);
});

test("with a key it asks the API once for every series, with the key in a header", async () => {
  const { prices, state } = setup(() => html(JSON.stringify({ response: { data: [
    { period: "2026-10-05", series: "RWTC", value: "96.13" },
    { period: "2026-10-05", series: "RBRTE", value: "125.51" },
    { period: "2026-10-06", series: "RWTC", value: "96.24" },
    { period: "2026-10-06", series: "RBRTE", value: "125.44" },
    { period: "2026-10-06", series: "OTHER", value: "1" },
    { period: "bad", series: "RWTC", value: "5" },
    { period: "2026-10-07", series: "RWTC", value: null },
  ] } })), { apiKey: "eia-test-key" });
  const series = await prices.getSeries(["WTI", "BRENT"]);
  assert.equal(state.calls.length, 1);
  const [{ url, headers }] = state.calls;
  assert.equal(url.hostname, "api.eia.gov");
  assert.deepEqual(url.searchParams.getAll("facets[series][]"), ["RWTC", "RBRTE"]);
  assert.equal(url.searchParams.get("frequency"), "daily");
  assert.equal(url.searchParams.get("start"), "2025-09-02");
  assert.equal(headers["x-api-key"], "eia-test-key");
  assert.equal(url.href.includes("eia-test-key"), false);
  assert.deepEqual(series.WTI.observations, [{ date: "2026-10-05", rate: "96.13" }, { date: "2026-10-06", rate: "96.24" }]);
  assert.deepEqual(series.BRENT.observations.at(-1), { date: "2026-10-06", rate: "125.44" });
  assert.equal(prices.usesApiKey(), true);
});

test("shares one download between callers that ask at the same time", async () => {
  const { prices, state } = setup(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return html(PAGE);
  });
  const [first, second] = await Promise.all([prices.getSeries(["WTI"]), prices.getSeries(["WTI"])]);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(second, first);
});

test("when a refresh fails it serves the last series as stale, for up to two weeks", async () => {
  let down = false;
  const { prices, state } = setup(() => (down ? html("unavailable", 503) : html(PAGE)));
  await prices.getSeries(["WTI"]);
  down = true;
  state.clock = START + 7 * HOUR;
  const later = await prices.getSeries(["WTI"]);
  assert.equal(later.WTI.stale, true);
  assert.equal(later.WTI.observations.at(-1).rate, "96.24");
  assert.equal(later.WTI.fetchedAt, new Date(START).toISOString());

  state.clock = START + 15 * 24 * HOUR;
  assert.deepEqual(await prices.getSeries(["WTI"]), {});
});

test("a series that cannot be loaded is left out, and unknown codes are ignored", async () => {
  const { prices } = setup((url) => (url.pathname.includes("RBRTED") ? html("gone", 404) : html(PAGE)));
  const series = await prices.getSeries(["WTI", "BRENT", "URALS"]);
  assert.deepEqual(Object.keys(series), ["WTI"]);
  const offline = setup(() => { throw new TypeError("fetch failed"); });
  assert.deepEqual(await offline.prices.getSeries(["WTI", "BRENT"]), {});
});
