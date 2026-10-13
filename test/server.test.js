import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDecimal } from "../src/domain/decimal.js";
import { createApp, generateFallbackSeries, loadMarketEnvironment } from "../server.mjs";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-10-07T10:07:30Z"); // a Wednesday
const LEVELS = { "USD/EUR": 0.9, "USD/CAD": 1.4, "XAU/USD": 4000, "XAG/USD": 50 };
const OIL = { RWTCD: 96.24, RBRTED: 125.44 }; // the latest published prices, dated the day before NOW
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const answer = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => String(body) });
const isoDay = (date) => date.toISOString().slice(0, 10);

// Frankfurter as the app uses it: weekday records, the last one dated "today" at the level above.
function frankfurter(url) {
  if (url.pathname.endsWith("/currencies")) return answer([{ iso_code: "USD", name: "US Dollar", symbol: "$" }, { iso_code: "EUR", name: "Euro", symbol: "€" }]);
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
  return answer(records);
}

// EIA's public history page for one series: 30 weekly rows ending with the day before NOW.
function eiaPage(url) {
  const level = OIL[url.pathname.split("/").pop().replace(".htm", "")];
  if (!level) return answer("not found", 404);
  const last = Date.parse("2026-10-06T00:00:00Z");
  const rows = [];
  for (let monday = Date.parse("2026-03-16T00:00:00Z"); monday <= last; monday += 7 * DAY) {
    const start = new Date(monday);
    const end = new Date(monday + 4 * DAY);
    const cells = [0, 1, 2, 3, 4].map((weekday) => {
      const time = monday + weekday * DAY;
      if (time > last) return "";
      return time === last ? String(level) : (level * (1 + 0.02 * Math.sin(time / DAY))).toFixed(2);
    });
    rows.push(`<tr><td class='B6'>&nbsp;&nbsp;${start.getUTCFullYear()} ${MONTHS[start.getUTCMonth()]}-${String(start.getUTCDate()).padStart(2, " ")} to ${MONTHS[end.getUTCMonth()]}-${String(end.getUTCDate()).padStart(2, " ")}</td>${cells.map((cell) => `<td class='B3'>${cell}</td>`).join("")}</tr>`);
  }
  return answer(`<table>${rows.join("\n")}</table>`);
}

// Runs the app on a free local port with every upstream call answered by the given stubs.
async function withApp({ env = {}, reference = frankfurter, oil = eiaPage, clock = { now: NOW } }, run) {
  const calls = [];
  const app = createApp({
    env,
    now: () => clock.now,
    log: { error() {} },
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      calls.push({ url, headers: init?.headers ?? {} });
      if (url.hostname === "api.frankfurter.dev") return reference(url);
      if (url.hostname === "www.eia.gov" || url.hostname === "api.eia.gov") return oil(url, init);
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
  const upstream = (host) => calls.filter((call) => call.url.hostname === host);
  try {
    await run({ get, upstream, clock, origin, app });
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test("5 minute and 24 hour charts are labelled estimates that end on the Frankfurter reference", async () => {
  await withApp({}, async ({ get, upstream }) => {
    const fiveMinutes = (await get("/api/history?pairs=USD:EUR|USD:CAD&range=5min")).body;
    for (const id of ["USD/EUR", "USD/CAD"]) {
      const points = fiveMinutes.rates[id];
      assert.equal(points.length, 5);
      assert.ok(points.every((point) => point.estimated === true));
      assert.deepEqual(points.map((point) => point.observedAt), ["10:03", "10:04", "10:05", "10:06", "10:07"].map((time) => `2026-10-07T${time}:00.000Z`));
      assert.equal(points.at(-1).rate, String(LEVELS[id]));
      assert.equal(fiveMinutes.series[id].kind, "estimated");
      assert.equal(fiveMinutes.series[id].reason, "no-intraday-source");
      assert.deepEqual(fiveMinutes.series[id].baseline, { rate: String(LEVELS[id]), date: "2026-10-07", source: "Frankfurter" });
    }
    assert.deepEqual(fiveMinutes.errors, []);
    assert.equal(fiveMinutes.cacheStatus, "fallback");

    const day = (await get("/api/history?pairs=USD:EUR&range=24h")).body;
    assert.equal(day.rates["USD/EUR"].length, 24);
    assert.equal(day.rates["USD/EUR"][0].observedAt, "2026-10-06T11:00:00.000Z");
    assert.equal(day.rates["USD/EUR"].at(-1).rate, "0.9");
    assert.deepEqual([...new Set(upstream("api.frankfurter.dev").map((call) => call.url.hostname))], ["api.frankfurter.dev"]);
  });
});

test("an intraday view is not estimated from a reference that is more than three days old", async () => {
  const oldReference = (url) => {
    const base = url.searchParams.get("base");
    return answer([{ date: "2026-10-01", base, quote: "EUR", rate: 0.9 }, { date: "2026-09-30", base, quote: "EUR", rate: 0.89 }]);
  };
  await withApp({ reference: oldReference }, async ({ get }) => {
    const body = (await get("/api/history?pairs=USD:EUR&range=5min")).body;
    assert.deepEqual(body.rates["USD/EUR"], []);
    assert.equal(body.series["USD/EUR"].kind, "unavailable");
    assert.equal(body.series["USD/EUR"].reason, "reference-too-old");
    assert.match(body.series["USD/EUR"].message, /2026-10-01/);
  });
});

test("gold and silver come from Frankfurter: observed daily history, and estimates only intraday", async () => {
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
  });
});

test("crude oil comes from EIA's public pages: quote cards, daily history, and no invented intraday view", async () => {
  await withApp({}, async ({ get, upstream }) => {
    const cards = (await get("/api/markets")).body;
    assert.deepEqual(Object.keys(cards.rates), ["XAU", "XAG", "WTI", "BRENT"]);
    assert.deepEqual({ rate: cards.rates.WTI.rate, date: cards.rates.WTI.date, source: cards.rates.WTI.source, kind: cards.rates.WTI.kind }, { rate: "96.24", date: "2026-10-06", source: "EIA", kind: "reference" });
    assert.equal(cards.rates.WTI.previous.date, "2026-10-05");
    assert.equal(cards.rates.BRENT.rate, "125.44");
    assert.equal(cards.rates.XAU.source, "Frankfurter");
    assert.equal(cards.rates.XAU.previous.date, "2026-10-06");
    assert.deepEqual(cards.errors, []);
    assert.equal(cards.source, "Frankfurter · EIA");

    const month = (await get("/api/market-history?assets=XAU|WTI|BRENT&range=1m")).body;
    assert.equal(month.series.WTI.kind, "reference");
    assert.equal(month.series.WTI.source, "EIA");
    assert.equal(month.rates.WTI[0].date, "2026-09-07");
    assert.deepEqual(month.rates.WTI.at(-1), { date: "2026-10-06", rate: "96.24" });
    assert.equal(month.rates.BRENT.at(-1).rate, "125.44");
    assert.equal(month.cacheStatus, "fresh");

    const fiveMinutes = (await get("/api/market-history?assets=XAU|WTI&range=5min")).body;
    assert.equal(fiveMinutes.series.XAU.kind, "estimated");
    assert.deepEqual(fiveMinutes.rates.WTI, []);
    assert.equal(fiveMinutes.series.WTI.kind, "unavailable");
    assert.equal(fiveMinutes.series.WTI.reason, "daily-only");

    const pages = upstream("www.eia.gov");
    assert.deepEqual(pages.map((call) => call.url.pathname).sort(), ["/dnav/pet/hist/RBRTED.htm", "/dnav/pet/hist/RWTCD.htm"], "each oil series is downloaded once");
    assert.equal(upstream("api.eia.gov").length, 0);
  });
});

test("with an EIA key the oil prices come from the EIA API, and the key stays out of the URL", async () => {
  const api = (url, init) => {
    assert.equal(url.hostname, "api.eia.gov");
    assert.equal(init.headers["x-api-key"], "eia-test-key");
    assert.equal(url.href.includes("eia-test-key"), false);
    return answer({ response: { data: [
      { period: "2026-10-05", series: "RWTC", value: "96.13" }, { period: "2026-10-05", series: "RBRTE", value: "125.51" },
      { period: "2026-10-06", series: "RWTC", value: "96.24" }, { period: "2026-10-06", series: "RBRTE", value: "125.44" },
    ] } });
  };
  await withApp({ env: { EIA_API_KEY: "eia-test-key" }, oil: api }, async ({ get, upstream, app }) => {
    const cards = (await get("/api/markets")).body;
    assert.equal(cards.rates.WTI.rate, "96.24");
    assert.equal(cards.rates.BRENT.previous.rate, "125.51");
    assert.equal(upstream("api.eia.gov").length, 1);
    assert.match(app.describeMarketData(), /EIA API/);
  });
});

test("when EIA stops answering, the last oil prices are kept and marked stale; other assets are unaffected", async () => {
  let down = false;
  await withApp({ oil: (url) => (down ? answer("unavailable", 503) : eiaPage(url)) }, async ({ get, clock }) => {
    await get("/api/markets");
    down = true;
    clock.now = new Date(NOW.getTime() + 7 * HOUR);
    const cards = (await get("/api/markets")).body;
    assert.equal(cards.rates.WTI.kind, "stale");
    assert.equal(cards.rates.WTI.rate, "96.24");
    assert.equal(cards.rates.XAU.kind, "reference");
    const week = (await get("/api/market-history?assets=WTI&range=1w")).body;
    assert.equal(week.series.WTI.kind, "stale");
    assert.equal(week.series.WTI.source, "EIA");
    assert.equal(week.rates.WTI.at(-1).rate, "96.24");
    assert.equal(week.cacheStatus, "fallback");
  });
});

test("when EIA cannot be reached at all, oil is reported unavailable rather than invented", async () => {
  await withApp({ oil: () => answer("unavailable", 503) }, async ({ get }) => {
    const cards = (await get("/api/markets")).body;
    assert.deepEqual(Object.keys(cards.rates), ["XAU", "XAG"]);
    assert.deepEqual(cards.errors.map((error) => error.asset), ["WTI", "BRENT"]);
    const month = (await get("/api/market-history?assets=WTI|XAU&range=1m")).body;
    assert.equal(month.series.WTI.kind, "unavailable");
    assert.deepEqual(month.rates.WTI, []);
    assert.equal(month.series.XAU.kind, "reference");
    assert.equal(month.cacheStatus, "partial");
  });
});

test("metal pairs on the board get a Frankfurter reference rate, inverted precisely when USD is the base", async () => {
  await withApp({}, async ({ get }) => {
    const body = (await get("/api/rates?pairs=USD:EUR|XAU:USD|USD:XAU|XAU:EUR")).body;
    assert.equal(body.rates["USD/EUR"].rate, "0.9");
    assert.equal(body.rates["XAU/USD"].rate, "4000");
    assert.equal(body.rates["USD/XAU"].rate, "0.00025");
    assert.equal(body.rates["XAU/EUR"], undefined);
    assert.deepEqual(body.errors.map((error) => error.code), ["unsupported-metal-pair"]);
  });
});

test("when Frankfurter history stops answering, the last history it delivered is kept and marked stale", async () => {
  let down = false;
  const reference = (url) => (down ? answer({ message: "unavailable" }, 503) : frankfurter(url));
  await withApp({ reference }, async ({ get, clock }) => {
    const fresh = (await get("/api/history?pairs=USD:EUR&range=1w")).body;
    assert.equal(fresh.series["USD/EUR"].kind, "reference");
    down = true;
    clock.now = new Date(NOW.getTime() + 20 * 60 * 1000);
    const later = (await get("/api/history?pairs=USD:EUR&range=1w")).body;
    assert.equal(later.series["USD/EUR"].kind, "stale");
    assert.equal(later.series["USD/EUR"].source, "Frankfurter");
    assert.equal(later.series["USD/EUR"].reason, "source-unreachable");
    assert.deepEqual(later.rates["USD/EUR"], fresh.rates["USD/EUR"]);
  });
});

test("with no reference price at all, a chart is reported unavailable rather than invented", async () => {
  await withApp({ reference: () => answer({ message: "unavailable" }, 503), oil: () => answer("unavailable", 503) }, async ({ get }) => {
    const response = await get("/api/history?pairs=USD:EUR&range=5min");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.rates["USD/EUR"], []);
    assert.equal(response.body.series["USD/EUR"].kind, "unavailable");
    assert.deepEqual(response.body.errors.map((error) => [error.code, error.id]), [["no-reference-data", "USD/EUR"]]);
    assert.equal(response.body.cacheStatus, "partial");
    assert.equal((await get("/api/markets")).body.errors.length, 4);
  });
});

test("the app can answer without a network port, which is how the desktop window uses it", async () => {
  const app = createApp({ env: {}, now: () => NOW, log: { error() {} }, fetchImpl: async (input) => frankfurter(new URL(input)) });
  const page = await app.respond("GET", "/");
  assert.equal(page.status, 200);
  assert.ok(page.headers["content-type"].startsWith("text/html"));
  assert.ok(page.body.length > 1000);
  const rates = await app.respond("GET", "/api/rates?pairs=USD:EUR");
  assert.equal(JSON.parse(rates.body).rates["USD/EUR"].rate, "0.9");
  assert.equal((await app.respond("POST", "/api/rates?pairs=USD:EUR")).status, 405);
  assert.equal((await app.respond("GET", "//")).status, 400);
});

test("warming up fetches the oil prices before a page asks, and the page reuses them", async () => {
  await withApp({}, async ({ get, upstream, app }) => {
    app.warmUp();
    assert.equal(upstream("www.eia.gov").length, 2, "one request per oil series, started at once");
    const { rates } = (await get("/api/markets")).body;
    assert.equal(rates.WTI.rate, "96.24");
    assert.equal(rates.BRENT.rate, "125.44");
    assert.equal(upstream("www.eia.gov").length, 2, "the page did not fetch them again");
  });
});

test("market settings are read from a named file, and never replace what is already set", async () => {
  const folder = await mkdtemp(join(tmpdir(), "counterline-settings-"));
  const file = join(folder, "settings.env");
  const before = process.env.EIA_API_KEY;
  try {
    await writeFile(file, '# desktop settings\nEIA_API_KEY = "from-the-file"\nPORT=1\nSOMETHING_ELSE=ignored\n');
    delete process.env.EIA_API_KEY;
    await loadMarketEnvironment(file);
    assert.equal(process.env.EIA_API_KEY, "from-the-file");
    assert.equal(process.env.SOMETHING_ELSE, undefined, "only the market settings are read");
    process.env.EIA_API_KEY = "already-set";
    await loadMarketEnvironment(file);
    assert.equal(process.env.EIA_API_KEY, "already-set");
    await loadMarketEnvironment(join(folder, "missing.env")); // a missing file is not an error
  } finally {
    if (before === undefined) delete process.env.EIA_API_KEY;
    else process.env.EIA_API_KEY = before;
    await rm(folder, { recursive: true, force: true });
  }
});

test("serves only the browser's files: no .env, no .git, no server source", async () => {
  await withApp({}, async ({ get }) => {
    for (const path of ["/.env", "/.env.example", "/.git/config", "/.gitignore", "/server.mjs", "/package.json", "/package-lock.json", "/electron-builder.yml", "/README.md", "/build/icon.png", "/src/server/eia-provider.mjs", "/test/server.test.js", "/desktop/main.mjs", "/src/../.env", "/src/domain/../../.env", "/src/domain/%2e%2e/%2e%2e/.env"]) {
      assert.equal((await get(path)).status, 404, path);
    }
    const expected = { "/": "text/html", "/index.html": "text/html", "/display.html": "text/html", "/styles.css": "text/css", "/src/app.js": "text/javascript", "/src/display.js": "text/javascript", "/src/domain/decimal.js": "text/javascript", "/src/ui/card-reorder.js": "text/javascript" };
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
    assert.equal((await get("/api/market-history?assets=XAU|URALS&range=1m")).status, 400);
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
  const later = generateFallbackSeries({ ...input, now: NOW.getTime() + HOUR });
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
