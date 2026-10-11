import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { parseDecimal } from "../src/domain/decimal.js";
import { createApp, generateFallbackSeries } from "../server.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-07T10:07:30Z"); // a Wednesday
const LEVELS = { "USD/EUR": 0.9, "USD/CAD": 1.4, "XAU/USD": 4000, "XAG/USD": 50 };
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const isoDay = (date) => date.toISOString().slice(0, 10);

// Frankfurter as the app uses it: weekday records, the last one dated "today" at the level above.
function frankfurter(url) {
  if (url.pathname.endsWith("/currencies")) return json([{ iso_code: "USD", name: "US Dollar", symbol: "$" }, { iso_code: "EUR", name: "Euro", symbol: "€" }]);
  const base = url.searchParams.get("base");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to") ?? isoDay(NOW);
  const records = [];
  for (const quote of url.searchParams.get("quotes").split(",")) {
    const level = LEVELS[`${base}/${quote}`];
    if (!level) continue;
    if (!from) {
      records.push({ date: to, base, quote, rate: level });
      continue;
    }
    for (let time = Date.parse(`${from}T00:00:00Z`), index = 0; time <= Date.parse(`${to}T00:00:00Z`); time += DAY, index += 1) {
      const date = new Date(time);
      if ([0, 6].includes(date.getUTCDay())) continue;
      const rate = isoDay(date) === to ? level : Number((level * (1 + 0.004 * Math.sin(index))).toFixed(5));
      records.push({ date: isoDay(date), base, quote, rate });
    }
  }
  return json(records);
}

const minuteBars = (close) => ({
  values: [0, 1, 2, 3, 4].map((age) => ({ datetime: `2026-10-07 10:0${6 - age}:00`, close: String(close) })),
  status: "ok",
});

// Runs the app on a free local port with every upstream call answered by the given stubs.
async function withApp({ env = {}, twelveData = () => { throw new Error("Twelve Data must not be called"); }, reference = frankfurter, clock = { now: NOW } }, run) {
  const calls = [];
  const app = createApp({
    env,
    now: () => clock.now,
    log: { error() {} },
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      calls.push(url);
      if (url.hostname === "api.frankfurter.dev") return reference(url);
      if (url.hostname === "api.twelvedata.com") return twelveData(url.searchParams.get("symbol").split(","), init);
      throw new Error(`Unexpected upstream host ${url.hostname}`);
    },
  });
  const server = createServer(app.handleRequest).listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async (path) => {
    const response = await fetch(`${origin}${path}`);
    const type = response.headers.get("content-type") ?? "";
    return { status: response.status, type, body: type.includes("json") ? await response.json() : await response.text() };
  };
  const upstream = (host) => calls.filter((url) => url.hostname === host);
  try {
    await run({ get, upstream, clock, origin });
  } finally {
    server.closeAllConnections();
    server.close();
  }
}
const CONFIGURED = { TWELVE_DATA_API_KEY: "test-key", TWELVEDATA_EXTERNAL_DISPLAY_LICENSE: "confirmed" };

test("without a key, 5 minute and 24 hour charts get a labelled estimate that ends on the Frankfurter reference", async () => {
  await withApp({}, async ({ get, upstream }) => {
    const fiveMinutes = (await get("/api/history?pairs=USD:EUR|USD:CAD&range=5min")).body;
    for (const id of ["USD/EUR", "USD/CAD"]) {
      const points = fiveMinutes.rates[id];
      assert.equal(points.length, 5);
      assert.ok(points.every((point) => point.estimated === true));
      assert.deepEqual(points.map((point) => point.observedAt), ["10:03", "10:04", "10:05", "10:06", "10:07"].map((time) => `2026-10-07T${time}:00.000Z`));
      assert.equal(points.at(-1).rate, String(LEVELS[id]));
      assert.equal(fiveMinutes.series[id].kind, "estimated");
      assert.equal(fiveMinutes.series[id].reason, "no-api-key");
      assert.deepEqual(fiveMinutes.series[id].baseline, { rate: String(LEVELS[id]), date: "2026-10-07", source: "Frankfurter" });
    }
    assert.deepEqual(fiveMinutes.errors, []);
    assert.equal(fiveMinutes.retryAfterMs, null);
    assert.equal(fiveMinutes.cacheStatus, "fallback");
    assert.equal(fiveMinutes.provider.twelveData.state, "no-api-key");

    const day = (await get("/api/history?pairs=USD:EUR&range=24h")).body;
    assert.equal(day.rates["USD/EUR"].length, 24);
    assert.equal(day.rates["USD/EUR"][0].observedAt, "2026-10-06T11:00:00.000Z");
    assert.equal(day.rates["USD/EUR"].at(-1).observedAt, "2026-10-07T10:00:00.000Z");
    assert.equal(day.rates["USD/EUR"].at(-1).rate, "0.9");
    assert.equal(day.series["USD/EUR"].kind, "estimated");
    assert.equal(upstream("api.twelvedata.com").length, 0);
  });
});

test("a key without the display flag keeps Twelve Data off and says why", async () => {
  await withApp({ env: { TWELVE_DATA_API_KEY: "test-key" } }, async ({ get, upstream }) => {
    const body = (await get("/api/history?pairs=USD:EUR&range=5min")).body;
    assert.equal(body.series["USD/EUR"].kind, "estimated");
    assert.equal(body.series["USD/EUR"].reason, "display-license-unconfirmed");
    assert.match(body.series["USD/EUR"].message, /TWELVEDATA_EXTERNAL_DISPLAY_LICENSE/);
    assert.equal(upstream("api.twelvedata.com").length, 0);
  });
});

test("without a key, gold and silver come from Frankfurter: observed daily history, and estimates only intraday", async () => {
  await withApp({}, async ({ get }) => {
    const month = (await get("/api/market-history?assets=XAU|XAG&range=1m")).body;
    for (const [code, level] of [["XAU", "4000"], ["XAG", "50"]]) {
      assert.equal(month.series[code].kind, "reference");
      assert.equal(month.series[code].source, "Frankfurter");
      assert.ok(month.rates[code].length >= 20);
      assert.ok(month.rates[code].every((point) => !point.estimated && !point.observedAt));
      assert.equal(month.rates[code].at(-1).rate, level);
    }
    assert.equal(month.cacheStatus, "fresh");

    const day = (await get("/api/market-history?assets=XAU|XAG&range=24h")).body;
    assert.equal(day.series.XAU.kind, "estimated");
    assert.equal(day.rates.XAU.length, 24);
    assert.equal(day.rates.XAU.at(-1).rate, "4000");
    assert.equal(day.rates.XAG.at(-1).rate, "50");

    const cards = (await get("/api/markets")).body;
    assert.equal(cards.rates.XAU.rate, "4000");
    assert.equal(cards.rates.XAU.date, "2026-10-07");
    assert.equal(cards.rates.XAU.source, "Frankfurter");
    assert.equal(cards.rates.XAU.kind, "reference");
    assert.equal(cards.rates.XAU.previous.date, "2026-10-06");
    assert.equal(cards.rates.XAG.rate, "50");
    assert.deepEqual(cards.errors, []);
  });
});

test("metal pairs on the board get a Frankfurter reference rate, inverted precisely when USD is the base", async () => {
  await withApp({}, async ({ get }) => {
    const body = (await get("/api/rates?pairs=USD:EUR|XAU:USD|USD:XAU|XAU:EUR")).body;
    assert.equal(body.rates["USD/EUR"].rate, "0.9");
    assert.equal(body.rates["XAU/USD"].rate, "4000");
    assert.equal(body.rates["XAU/USD"].source, "Frankfurter daily reference");
    assert.equal(body.rates["USD/XAU"].rate, "0.00025");
    assert.equal(body.rates["XAU/EUR"], undefined);
    assert.deepEqual(body.errors.map((error) => error.code), ["unsupported-metal-pair"]);
  });
});

test("with Twelve Data on, intraday charts are observed data and repeat requests are served from the cache", async () => {
  let requests = 0;
  const twelveData = (symbols, init) => {
    requests += 1;
    assert.equal(init.headers.authorization, "apikey test-key");
    return json(Object.fromEntries(symbols.map((symbol) => [symbol, minuteBars(symbol === "USD/EUR" ? 0.91 : 1.41)])));
  };
  await withApp({ env: CONFIGURED, twelveData }, async ({ get, clock }) => {
    const first = (await get("/api/history?pairs=USD:EUR|USD:CAD&range=5min")).body;
    assert.equal(first.series["USD/EUR"].kind, "observed");
    assert.equal(first.series["USD/EUR"].source, "Twelve Data");
    assert.equal(first.rates["USD/CAD"].at(-1).rate, "1.41");
    assert.equal(first.rates["USD/CAD"].at(-1).estimated, undefined);
    assert.equal(first.cacheStatus, "fresh");
    assert.equal(first.provider.twelveData.state, "active");

    clock.now = new Date(NOW.getTime() + 4 * 60 * 1000);
    await get("/api/history?pairs=USD:EUR|USD:CAD&range=5min");
    await get("/api/history?pairs=USD:CAD&range=5min");
    assert.equal(requests, 1);
  });
});

test("a rate limit never empties a chart: an estimate is served with the time to ask again", async () => {
  let requests = 0;
  const twelveData = () => {
    requests += 1;
    return json({ code: 429, message: "You have run out of API credits for the current minute.", status: "error" }, 429);
  };
  await withApp({ env: CONFIGURED, twelveData }, async ({ get }) => {
    const first = await get("/api/history?pairs=USD:EUR|USD:CAD&range=5min");
    assert.equal(first.status, 200);
    assert.equal(first.body.series["USD/EUR"].kind, "estimated");
    assert.equal(first.body.series["USD/EUR"].reason, "rate-limited");
    assert.equal(first.body.rates["USD/CAD"].length, 5);
    assert.ok(first.body.retryAfterMs > 0 && first.body.retryAfterMs <= 61_500);
    assert.equal(first.body.provider.twelveData.state, "rate-limited");

    const second = await get("/api/history?pairs=USD:EUR|USD:CAD&range=24h");
    assert.equal(second.body.series["USD/EUR"].kind, "estimated");
    assert.equal(requests, 1, "nothing is sent while the limit is in force");
  });
});

test("when a refresh fails, the last observed series is shown as stale instead of an estimate", async () => {
  let fail = false;
  const twelveData = (symbols) => (fail ? json({ code: 500, message: "Internal error", status: "error" }, 500) : json(minuteBars(0.91)));
  await withApp({ env: CONFIGURED, twelveData }, async ({ get, clock }) => {
    await get("/api/history?pairs=USD:EUR&range=5min");
    fail = true;
    clock.now = new Date(NOW.getTime() + 6 * 60 * 1000);
    const body = (await get("/api/history?pairs=USD:EUR&range=5min")).body;
    assert.equal(body.series["USD/EUR"].kind, "stale");
    assert.equal(body.series["USD/EUR"].source, "Twelve Data");
    assert.equal(body.series["USD/EUR"].reason, "provider-error");
    assert.equal(body.rates["USD/EUR"].at(-1).rate, "0.91");
    assert.equal(body.cacheStatus, "fallback");
  });
});

test("on a plan without silver, gold stays on Twelve Data and silver falls back to Frankfurter", async () => {
  const twelveData = (symbols) => (symbols[0] === "XAG/USD"
    ? json({ code: 403, message: "This symbol is available starting with the Grow plan.", status: "error" }, 403)
    : json(minuteBars(4012.5)));
  await withApp({ env: CONFIGURED, twelveData }, async ({ get }) => {
    const cards = (await get("/api/markets")).body;
    assert.equal(cards.rates.XAU.source, "Twelve Data");
    assert.equal(cards.rates.XAU.kind, "observed");
    assert.equal(cards.rates.XAU.rate, "4012.5");
    assert.equal(cards.rates.XAU.observedAt, "2026-10-07T10:06:00.000Z");
    assert.equal(cards.rates.XAG.source, "Frankfurter");
    assert.equal(cards.rates.XAG.kind, "reference");
    assert.equal(cards.rates.XAG.rate, "50");

    const month = (await get("/api/market-history?assets=XAU|XAG&range=1m")).body;
    assert.equal(month.series.XAU.kind, "observed");
    assert.equal(month.series.XAG.kind, "reference");
    assert.equal(month.series.XAG.reason, "unsupported-symbol");

    const board = (await get("/api/rates?pairs=XAU:USD|XAG:USD")).body;
    assert.equal(board.rates["XAU/USD"].source, "Twelve Data");
    assert.equal(board.rates["XAG/USD"].source, "Frankfurter daily reference");
  });
});

test("when Frankfurter history stops answering, the last history it delivered is kept and marked stale", async () => {
  let down = false;
  const reference = (url) => (down ? json({ message: "unavailable" }, 503) : frankfurter(url));
  await withApp({ reference }, async ({ get, clock }) => {
    const fresh = (await get("/api/history?pairs=USD:EUR&range=1w")).body;
    assert.equal(fresh.series["USD/EUR"].kind, "reference");
    down = true;
    clock.now = new Date(NOW.getTime() + 20 * 60 * 1000);
    const later = (await get("/api/history?pairs=USD:EUR&range=1w")).body;
    assert.equal(later.series["USD/EUR"].kind, "stale");
    assert.equal(later.series["USD/EUR"].source, "Frankfurter");
    assert.deepEqual(later.rates["USD/EUR"], fresh.rates["USD/EUR"]);
  });
});

test("with no reference price at all, a chart is reported unavailable rather than invented", async () => {
  await withApp({ reference: () => json({ message: "unavailable" }, 503) }, async ({ get }) => {
    const response = await get("/api/history?pairs=USD:EUR&range=5min");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.rates["USD/EUR"], []);
    assert.equal(response.body.series["USD/EUR"].kind, "unavailable");
    assert.deepEqual(response.body.errors.map((error) => [error.code, error.id]), [["no-reference-data", "USD/EUR"]]);
    assert.equal(response.body.cacheStatus, "partial");
    assert.equal((await get("/api/markets")).body.errors.length, 2);
  });
});

test("serves only the browser's files: no .env, no .git, no server source", async () => {
  await withApp({}, async ({ get }) => {
    for (const path of ["/.env", "/.env.example", "/.git/config", "/.gitignore", "/server.mjs", "/package.json", "/README.md", "/src/server/twelve-data-provider.mjs", "/test/server.test.js", "/src/../.env", "/src/domain/../../.env", "/src/domain/%2e%2e/%2e%2e/.env"]) {
      assert.equal((await get(path)).status, 404, path);
    }
    const expected = { "/": "text/html", "/index.html": "text/html", "/styles.css": "text/css", "/src/app.js": "text/javascript", "/src/domain/decimal.js": "text/javascript" };
    for (const [path, type] of Object.entries(expected)) {
      const response = await get(path);
      assert.equal(response.status, 200, path);
      assert.ok(response.type.startsWith(type), `${path}: ${response.type}`);
    }
  });
});

test("malformed requests are answered and the server keeps running", async () => {
  await withApp({}, async ({ get, origin }) => {
    assert.equal((await get("/%")).status, 404);
    assert.equal((await get("/%E0%A4%A")).status, 404);
    assert.equal((await get("//")).status, 400);
    assert.equal((await get("/api/history?pairs=USD:EUR&range=2y")).status, 400);
    assert.equal((await get("/api/history?pairs=usd:eur&range=5min")).status, 400);
    assert.equal((await get("/api/market-history?assets=XAU|WTI&range=1m")).status, 400);
    assert.equal((await fetch(`${origin}/api/markets`, { method: "POST" })).status, 405);
    assert.equal((await get("/api/currencies")).status, 200);
  });
});

test("the fallback estimate is repeatable, ends on the reference, and holds its shape as time moves on", () => {
  const input = { id: "USD/EUR", range: "24h", reference: { rate: "0.89154" }, dailyVolatility: 0.004, now: NOW.getTime() };
  const series = generateFallbackSeries(input);
  assert.deepEqual(generateFallbackSeries(input), series);
  assert.equal(series.length, 24);
  assert.equal(series.at(-1).rate, "0.89154");
  assert.ok(new Set(series.map((point) => point.rate)).size > 12, "the line moves");

  // One hour later the 23 shared hours keep their step-to-step ratios; only the anchor moves.
  const later = generateFallbackSeries({ ...input, now: NOW.getTime() + 60 * 60 * 1000 });
  for (let index = 1; index < 23; index += 1) {
    assert.equal(later[index - 1].observedAt, series[index].observedAt);
    const before = Number(series[index + 1].rate) / Number(series[index].rate);
    const after = Number(later[index].rate) / Number(later[index - 1].rate);
    assert.ok(Math.abs(before - after) < 1e-5, `step ${index}: ${before} vs ${after}`);
  }
});

test("the fallback estimate stays within believable bounds for every range and price level", () => {
  const expected = { "5min": 5, "24h": 24, "1w": 8, "1m": 31, "3m": 93, "6m": 184 };
  for (const [range, count] of Object.entries(expected)) {
    for (const rate of ["0.000000574851", "0.00025", "0.89154", "158.24", "4148.64", "1739580"]) {
      const series = generateFallbackSeries({ id: "XAU/USD", range, reference: { rate }, dailyVolatility: 0.012, now: NOW.getTime() });
      assert.equal(series.length, count);
      assert.equal(series.at(-1).rate, rate);
      for (const point of series) {
        assert.equal(point.estimated, true);
        assert.notEqual(parseDecimal(point.rate), null, `${range} ${rate}: ${point.rate}`);
        assert.ok(Number(point.rate) > 0);
        assert.ok(Math.abs(Math.log(Number(point.rate) / Number(rate))) < 0.5, `${range} ${rate}: ${point.rate}`);
        assert.equal("observedAt" in point, range === "5min" || range === "24h");
      }
      assert.deepEqual(series.map((point) => point.date), [...series.map((point) => point.date)].sort());
    }
  }
});

test("the fallback estimate is flat for a pegged pair and empty without a usable reference", () => {
  const pegged = generateFallbackSeries({ id: "USD/AED", range: "24h", reference: { rate: "3.6725" }, dailyVolatility: 0, now: NOW.getTime() });
  assert.deepEqual([...new Set(pegged.map((point) => point.rate))], ["3.6725"]);
  for (const reference of [undefined, {}, { rate: "0" }, { rate: "-1" }, { rate: "abc" }]) {
    assert.deepEqual(generateFallbackSeries({ id: "USD/EUR", range: "5min", reference, now: NOW.getTime() }), []);
  }
  assert.deepEqual(generateFallbackSeries({ id: "USD/EUR", range: "2y", reference: { rate: "1" }, now: NOW.getTime() }), []);
  const guessed = generateFallbackSeries({ id: "USD/EUR", range: "5min", reference: { rate: "1" }, dailyVolatility: Number.NaN, now: NOW.getTime() });
  assert.ok(guessed.every((point) => parseDecimal(point.rate) !== null));
});
