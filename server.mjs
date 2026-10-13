import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decimalFromNumber } from "./src/domain/decimal.js";
import { isObservationStale } from "./src/domain/freshness.js";
import { createEiaSpotPrices, EIA_SOURCE } from "./src/server/eia-provider.mjs";
import { fetchFrankfurterCurrencies, fetchFrankfurterHistory, fetchFrankfurterRates } from "./src/server/frankfurter-provider.mjs";
import { createReferenceService } from "./src/server/reference-service.mjs";

const projectRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const ENV_NAMES = ["EIA_API_KEY"];

// Copies the market settings in a .env style file into process.env, unless they are already set
// there. `npm start` reads .env in the project folder; the desktop app names a file of its own.
export async function loadMarketEnvironment(file = resolve(projectRoot, ".env")) {
  const assignment = new RegExp(`^\\s*(${ENV_NAMES.join("|")})\\s*=\\s*(.*?)\\s*$`);
  try {
    const lines = await readFile(file, "utf8");
    for (const line of lines.split(/\r?\n/)) {
      const match = assignment.exec(line);
      if (!match || process.env[match[1]]) continue;
      const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
      process.env[match[1]] = value;
    }
  } catch {
    // Environment variables can also be supplied by the shell or deployment platform.
  }
}

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};
const STATIC_FILES = new Map([["/", "index.html"], ["/index.html", "index.html"], ["/display.html", "display.html"], ["/styles.css", "styles.css"]]);
// Browser modules: the two page scripts and the folders they import from. Nothing else under the
// project root is served, so .env, .git and the server source cannot be downloaded.
const BROWSER_MODULE = /^\/src\/(?:(?:app|display)\.js|(?:domain|ui)\/[A-Za-z0-9-]+\.js)$/;

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_RANGES = { "1w": { days: 7 }, "1m": { months: 1 }, "3m": { months: 3 }, "6m": { months: 6 } };
const INTRADAY_RANGES = new Set(["5min", "24h"]);
// The time grid of each chart range.
const SERIES_SHAPES = {
  "5min": { interval: "1min", stepMs: 60 * 1000, points: 5 },
  "24h": { interval: "1h", stepMs: 60 * 60 * 1000, points: 24 },
  "1w": { interval: "1day", stepMs: DAY_MS, points: 8 },
  "1m": { interval: "1day", stepMs: DAY_MS, points: 31 },
  "3m": { interval: "1day", stepMs: DAY_MS, points: 93 },
  "6m": { interval: "1day", stepMs: DAY_MS, points: 184 },
};
const METAL_CODES = new Set(["XAU", "XAG"]);
// The markets section: gold and silver per troy ounce from Frankfurter, crude oil per barrel
// from EIA. All are priced in US dollars.
const MARKET_ASSETS = {
  XAU: { base: "XAU", quote: "USD" },
  XAG: { base: "XAG", quote: "USD" },
  WTI: { oil: "WTI" },
  BRENT: { oil: "BRENT" },
};
const FRANKFURTER = "Frankfurter";
const HISTORY_TTL_MS = 5 * 60 * 1000;
const HISTORY_KEEP_MS = 72 * 60 * 60 * 1000; // a failed refresh may fall back on history this old
const CONTEXT_TTL_MS = 10 * 60 * 1000;
const CONTEXT_WINDOW_DAYS = 21;
const MAX_CACHE_ENTRIES = 500;
const MAX_DAILY_VOLATILITY = 0.03;

const pairKey = ({ base, quote }) => `${base}/${quote}`;
// What a chart request is cached and looked up under: its oil code, or its currency pair.
const seriesKey = (request) => request.oil ?? pairKey(request);
const sourceOf = (request) => (request.oil ? EIA_SOURCE : FRANKFURTER);
const isMetalPair = ({ base, quote }) => METAL_CODES.has(base) || METAL_CODES.has(quote);
const isUsdMetalPair = ({ base, quote }) => (METAL_CODES.has(base) && quote === "USD") || (base === "USD" && METAL_CODES.has(quote));
const isoDay = (date) => date.toISOString().slice(0, 10);

function historyDates(range, instant = new Date()) {
  const to = new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
  const from = new Date(to);
  const rangeInfo = HISTORY_RANGES[range];
  if (rangeInfo.days) from.setUTCDate(from.getUTCDate() - rangeInfo.days);
  if (rangeInfo.months) {
    const day = from.getUTCDate();
    from.setUTCDate(1);
    from.setUTCMonth(from.getUTCMonth() - rangeInfo.months);
    const lastDay = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0)).getUTCDate();
    from.setUTCDate(Math.min(day, lastDay));
  }
  return { from: isoDay(from), to: isoDay(to) };
}

// Every route answers with { status, headers, body }, so the same app can be served over HTTP
// or straight into a desktop window.
function json(status, payload) {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify(payload),
  };
}

function parsePairs(value) {
  if (!value || value.length > 1200) return null;
  const entries = value.split("|");
  if (entries.length > 30) return null;
  const pairs = [];
  for (const entry of entries) {
    const match = /^([A-Z]{3}):([A-Z]{3})$/.exec(entry);
    if (!match || match[1] === match[2]) return null;
    pairs.push({ base: match[1], quote: match[2] });
  }
  return pairs.length ? pairs : null;
}

function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_CACHE_ENTRIES) map.delete(map.keys().next().value);
}

// A repeatable number in (0, 1) for a piece of text: FNV-1a followed by an avalanche step.
function hashUnit(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 2246822507);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 3266489909);
  hash ^= hash >>> 16;
  return ((hash >>> 0) + 0.5) / 4294967296;
}

function standardNormal(key) {
  const value = Math.sqrt(-2 * Math.log(hashUnit(`${key}|a`))) * Math.cos(2 * Math.PI * hashUnit(`${key}|b`));
  return Math.max(-3, Math.min(3, value));
}

// Day-to-day movement of a pair, from its recent weekday reference observations. Blended
// central-bank references move less from one day to the next than a market close does, hence
// the uplift. Returns null when there are too few observations to say.
function realisedDailyVolatility(observations) {
  const weekdays = observations.filter(({ date }) => ![0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()));
  const returns = [];
  for (let index = 1; index < weekdays.length; index += 1) {
    const previous = Number(weekdays[index - 1].rate);
    const current = Number(weekdays[index].rate);
    if (previous > 0 && current > 0) returns.push(Math.log(current / previous));
  }
  if (returns.length < 5) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const volatility = Math.sqrt(variance) * 1.3;
  return Number.isFinite(volatility) ? volatility : null;
}

function typicalDailyVolatility(id) {
  if (id.includes("XAG") || id === "WTI" || id === "BRENT") return 0.018;
  if (id.includes("XAU")) return 0.009;
  return 0.0045;
}

/**
 * The last tier of the fallback engine: an estimated series for a chart that has no observed one.
 *
 * It is a random walk on the range's own time grid that ends exactly on the latest reference
 * price. Each step is derived from the series id and the step's timestamp, so the same chart is
 * drawn on every request and its shape holds still as the window slides forward. The step size
 * follows the pair's own recent day-to-day movement.
 *
 * Every point is flagged `estimated`. These are illustrations, never observed market rates.
 */
export function generateFallbackSeries({ id, range, reference, dailyVolatility = null, now = Date.now() }) {
  const shape = SERIES_SHAPES[range];
  const anchor = Number(reference?.rate);
  if (!shape || !Number.isFinite(anchor) || anchor <= 0) return [];
  const daily = Number.isFinite(dailyVolatility) && dailyVolatility >= 0 ? dailyVolatility : typicalDailyVolatility(id);
  const stepVolatility = Math.min(daily, MAX_DAILY_VOLATILITY) * Math.sqrt(shape.stepMs / DAY_MS);
  const end = Math.floor(now / shape.stepMs) * shape.stepMs;
  const timeAt = (index) => end - (shape.points - 1 - index) * shape.stepMs;

  // Walk backwards from the anchor, in log space so that a rate can never reach zero.
  const offsets = new Array(shape.points).fill(0);
  for (let index = shape.points - 2; index >= 0; index -= 1) {
    offsets[index] = offsets[index + 1] - stepVolatility * standardNormal(`${id}|${shape.stepMs}|${timeAt(index + 1)}`);
  }

  return offsets.map((offset, index) => {
    const observedAt = new Date(timeAt(index)).toISOString();
    const isAnchor = index === shape.points - 1;
    const rate = (isAnchor ? null : decimalFromNumber(anchor * Math.exp(offset))) ?? String(reference.rate);
    const point = { date: observedAt.slice(0, 10), rate, estimated: true };
    // Daily points carry a date only, like the daily observations they stand in for.
    return shape.stepMs < DAY_MS ? { ...point, observedAt } : point;
  });
}

export function createApp({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  root = projectRoot,
  log = console,
} = {}) {
  const eia = createEiaSpotPrices({ apiKey: env.EIA_API_KEY || "", fetchImpl, now: () => now().getTime() });
  const referenceService = createReferenceService({
    provider: (pairs) => fetchFrankfurterRates(pairs, { fetchImpl, now }),
    now,
  });
  const dailyHistory = new Map(); // "BASE/QUOTE|range" -> { observations, from, fetchedAt }
  const contexts = new Map(); // "BASE/QUOTE" -> { reference, previous, dailyVolatility, fetchedAt }
  const contextLoads = new Map(); // "BASE/QUOTE" -> the request that is filling its context
  let currencyCache;

  // Daily observations per series for a chart range: Frankfurter for currency pairs and metals
  // (cached for five minutes), EIA for oil (cached by its provider). When a refresh fails, the
  // last history that did arrive is returned with `stale: true`.
  async function loadDailyHistory(requests, range) {
    const { from, to } = historyDates(range, now());
    const at = now().getTime();
    const found = new Map();
    const oil = requests.filter((request) => request.oil);
    const pairs = requests.filter((request) => !request.oil);
    const missing = [];
    for (const pair of pairs) {
      const cached = dailyHistory.get(`${pairKey(pair)}|${range}`);
      if (cached && cached.from === from && at - cached.fetchedAt < HISTORY_TTL_MS) {
        found.set(pairKey(pair), { observations: cached.observations, stale: false, fetchedAt: new Date(cached.fetchedAt).toISOString() });
      } else {
        missing.push(pair);
      }
    }
    const [loaded, oilSeries] = await Promise.all([
      missing.length ? fetchFrankfurterHistory(missing, { from, to, fetchImpl }).catch(() => ({ rates: {} })) : { rates: {} },
      oil.length ? eia.getSeries(oil.map((request) => request.oil)) : {},
    ]);
    for (const pair of missing) {
      const key = pairKey(pair);
      const observations = loaded.rates[key] ?? [];
      const kept = dailyHistory.get(`${key}|${range}`);
      if (observations.length) {
        remember(dailyHistory, `${key}|${range}`, { observations, from, fetchedAt: at });
        found.set(key, { observations, stale: false, fetchedAt: new Date(at).toISOString() });
      } else if (kept && at - kept.fetchedAt < HISTORY_KEEP_MS) {
        found.set(key, { observations: kept.observations, stale: true, fetchedAt: new Date(kept.fetchedAt).toISOString() });
      }
    }
    for (const { oil: code } of oil) {
      const series = oilSeries[code];
      const latest = series?.observations.at(-1);
      if (!latest) continue;
      // EIA publishes about a week in arrears, so an oil range is counted back from its latest price.
      const window = historyDates(range, new Date(`${latest.date}T00:00:00Z`));
      found.set(code, { observations: series.observations.filter(({ date }) => date >= window.from), stale: series.stale, fetchedAt: series.fetchedAt });
    }
    return found;
  }

  // Fills `contexts` for pairs from one recent-history request per base currency. Never rejects.
  async function fetchContexts(pairs) {
    const at = now().getTime();
    let history = { rates: {} };
    try {
      history = await fetchFrankfurterHistory(pairs, {
        from: isoDay(new Date(at - CONTEXT_WINDOW_DAYS * DAY_MS)),
        to: isoDay(new Date(at)),
        fetchImpl,
      });
    } catch {
      // Handled per pair below.
    }
    const withoutHistory = [];
    for (const pair of pairs) {
      const observations = history.rates[pairKey(pair)] ?? [];
      const latest = observations.at(-1);
      if (!latest) {
        withoutHistory.push(pair);
        continue;
      }
      remember(contexts, pairKey(pair), {
        reference: { rate: latest.rate, date: latest.date },
        previous: observations.at(-2) ?? null,
        dailyVolatility: realisedDailyVolatility(observations),
        fetchedAt: at,
      });
    }
    if (!withoutHistory.length) return;
    try {
      // The latest-rate service keeps its own last good answer, which can still anchor an estimate.
      const latest = await referenceService.getRates(withoutHistory);
      for (const pair of withoutHistory) {
        const rate = latest.rates[pairKey(pair)];
        if (rate) remember(contexts, pairKey(pair), { reference: { rate: rate.rate, date: rate.date }, previous: null, dailyVolatility: null, fetchedAt: at });
      }
    } catch {
      // An older context, if there is one, stays in place.
    }
  }

  // The latest reference price of each series, with the observation before it and the series'
  // recent volatility. Pair contexts are cached for ten minutes and survive a failed refresh;
  // oil contexts are read from the series its provider already keeps.
  async function referenceContexts(requests) {
    const at = now().getTime();
    const oil = requests.filter((request) => request.oil);
    const pairs = requests.filter((request) => !request.oil);
    const toLoad = pairs.filter((pair) => {
      const cached = contexts.get(pairKey(pair));
      return !(cached && at - cached.fetchedAt < CONTEXT_TTL_MS) && !contextLoads.has(pairKey(pair));
    });
    if (toLoad.length) {
      const batch = fetchContexts(toLoad);
      for (const pair of toLoad) {
        const key = pairKey(pair);
        let load;
        load = batch.finally(() => {
          if (contextLoads.get(key) === load) contextLoads.delete(key);
        });
        contextLoads.set(key, load);
      }
    }
    const [oilSeries] = await Promise.all([
      oil.length ? eia.getSeries(oil.map((request) => request.oil)) : {},
      ...pairs.map((pair) => contextLoads.get(pairKey(pair))),
    ]);
    const found = new Map(pairs.map((pair) => [pairKey(pair), contexts.get(pairKey(pair)) ?? null]));
    for (const { oil: code } of oil) {
      const series = oilSeries[code];
      const recent = series?.observations.slice(-CONTEXT_WINDOW_DAYS) ?? [];
      found.set(code, recent.length
        ? { reference: recent.at(-1), previous: recent.at(-2) ?? null, dailyVolatility: realisedDailyVolatility(recent), stale: series.stale }
        : null);
    }
    return found;
  }

  // The fallback engine. Every requested chart series leaves here with data and a label saying
  // where the data came from:
  //   reference  - daily observations from Frankfurter (currencies, gold, silver) or EIA (oil)
  //   stale      - the last series a source delivered, because its refresh failed
  //   estimated  - generateFallbackSeries, anchored to the latest reference price
  // No source here publishes intraday prices, so the 5 minute and 24 hour views are always
  // estimates. A series is "unavailable" when there is no recent reference price to anchor on.
  async function resolveChartSeries(requests, range) {
    const intraday = INTRADAY_RANGES.has(range);
    const { interval } = SERIES_SHAPES[range];
    const rates = {};
    const series = {};
    const errors = [];
    const open = new Map(requests.map((request) => [request.id, request]));
    const notes = new Map(); // id -> why a better tier did not answer
    const lastDelivered = new Map();
    const settle = (request, observations, detail) => {
      rates[request.id] = observations;
      series[request.id] = { interval, ...detail, ...notes.get(request.id) };
      open.delete(request.id);
    };

    // Daily ranges: observed daily history.
    if (!intraday) {
      const history = await loadDailyHistory(requests, range);
      for (const request of requests) {
        const found = history.get(seriesKey(request));
        if (found && !found.stale) {
          settle(request, found.observations, { kind: "reference", source: sourceOf(request), fetchedAt: found.fetchedAt });
          continue;
        }
        if (found) lastDelivered.set(request.id, found);
        notes.set(request.id, { reason: "source-unreachable", message: `${sourceOf(request)} could not be reached for this history.` });
      }
    }

    // The last history a source did deliver, shown as stale.
    for (const request of [...open.values()]) {
      const kept = lastDelivered.get(request.id);
      if (kept) settle(request, kept.observations, { kind: "stale", source: sourceOf(request), fetchedAt: kept.fetchedAt });
    }

    // An estimate anchored to the latest reference price.
    if (open.size) {
      const anchors = await referenceContexts([...open.values()]);
      for (const request of [...open.values()]) {
        const context = anchors.get(seriesKey(request));
        if (!context) continue;
        if (intraday && request.oil) {
          notes.set(request.id, { reason: "daily-only", message: "EIA publishes one oil price per day, about a week in arrears. Choose 1 week or longer." });
          continue;
        }
        if (intraday && isObservationStale(context.reference.date, now())) {
          notes.set(request.id, { reason: "reference-too-old", message: `The latest ${sourceOf(request)} reference is from ${context.reference.date}, too old to estimate an intraday view from.` });
          continue;
        }
        const observations = generateFallbackSeries({
          id: seriesKey(request),
          range,
          reference: context.reference,
          dailyVolatility: context.dailyVolatility,
          now: now().getTime(),
        });
        if (!observations.length) continue;
        if (intraday) notes.set(request.id, { reason: "no-intraday-source", message: "No intraday source is connected; this view is drawn from the daily reference." });
        settle(request, observations, {
          kind: "estimated",
          source: `Estimate from the latest ${sourceOf(request)} reference`,
          baseline: { ...context.reference, source: sourceOf(request) },
        });
      }
    }

    // Nothing to anchor on: say so rather than invent a price level.
    for (const request of open.values()) {
      const note = notes.get(request.id) ?? { reason: "no-reference-data", message: "No source returned data, and there is no reference price to estimate from." };
      rates[request.id] = [];
      series[request.id] = { interval, kind: "unavailable", source: null, ...note };
      errors.push({ code: note.reason, id: request.id, message: note.message });
    }
    return { rates, series, errors };
  }

  function chartPayload({ rates, series, errors }, range) {
    const kinds = new Set(Object.values(series).map(({ kind }) => kind));
    return {
      source: [...new Set(Object.values(series).map(({ source }) => source).filter(Boolean))].join(" · "),
      range,
      interval: SERIES_SHAPES[range].interval,
      generatedAt: now().toISOString(),
      rates,
      series,
      errors,
      cacheStatus: kinds.has("unavailable") ? "partial" : kinds.has("estimated") || kinds.has("stale") ? "fallback" : "fresh",
    };
  }

  async function ratesRoute(url) {
    const pairs = parsePairs(url.searchParams.get("pairs"));
    if (!pairs) return json(400, { error: "Provide up to 30 currency pairs as BASE:QUOTE entries." });
    // Gold and silver are quoted against USD only; every other pair is an ordinary reference pair.
    const unsupported = pairs.filter((pair) => isMetalPair(pair) && !isUsdMetalPair(pair));
    const supported = pairs.filter((pair) => !unsupported.includes(pair));
    let payload = null;
    try {
      if (supported.length) payload = await referenceService.getRates(supported);
    } catch {
      return json(503, { error: "Reference data is unavailable. Try again shortly." });
    }
    const errors = [...(payload?.errors ?? [])];
    if (unsupported.length) errors.push({ code: "unsupported-metal-pair", message: "Gold and silver are currently supported against USD only." });
    const cacheStatus = ["stale-cache", "partial-cache"].includes(payload?.cacheStatus)
      ? payload.cacheStatus
      : errors.length ? "partial" : payload?.cacheStatus ?? "fresh";
    return json(200, {
      source: payload?.source ?? "Reference data",
      retrievedAt: payload?.retrievedAt ?? now().toISOString(),
      checkedAt: now().toISOString(),
      rates: payload?.rates ?? {},
      errors,
      fallbackPairs: payload?.fallbackPairs ?? [],
      cacheStatus,
    });
  }

  // The quote cards: the latest daily reference price of each market asset, with the observation
  // before it. A quote card never shows an estimate.
  async function marketsRoute() {
    const requests = Object.entries(MARKET_ASSETS).map(([id, asset]) => ({ id, ...asset }));
    const anchors = await referenceContexts(requests);
    const rates = {};
    const errors = [];
    for (const request of requests) {
      const context = anchors.get(seriesKey(request));
      if (context) {
        rates[request.id] = { ...context.reference, source: sourceOf(request), kind: context.stale ? "stale" : "reference", previous: context.previous };
      } else {
        errors.push({ code: "no-reference-data", asset: request.id, message: `No ${sourceOf(request)} price could be loaded.` });
      }
    }
    return json(200, {
      source: [...new Set(Object.values(rates).map(({ source }) => source))].join(" · "),
      retrievedAt: now().toISOString(),
      rates,
      errors,
      cacheStatus: errors.length ? "partial" : "fresh",
    });
  }

  async function historyRoute(url) {
    const pairs = parsePairs(url.searchParams.get("pairs"));
    const range = url.searchParams.get("range");
    if (!pairs || !Object.hasOwn(SERIES_SHAPES, range)) return json(400, { error: "Provide up to 30 currency pairs and a supported range." });
    const requests = pairs.map((pair) => ({ ...pair, id: pairKey(pair) }));
    return json(200, chartPayload(await resolveChartSeries(requests, range), range));
  }

  async function marketHistoryRoute(url) {
    const assets = [...new Set(url.searchParams.get("assets")?.split("|") ?? [])];
    const range = url.searchParams.get("range");
    if (!assets.length || assets.some((asset) => !Object.hasOwn(MARKET_ASSETS, asset)) || !Object.hasOwn(SERIES_SHAPES, range)) {
      return json(400, { error: "Provide supported market assets and a supported history range." });
    }
    const requests = assets.map((id) => ({ id, ...MARKET_ASSETS[id] }));
    return json(200, chartPayload(await resolveChartSeries(requests, range), range));
  }

  async function currenciesRoute() {
    const at = now().getTime();
    if (currencyCache && currencyCache.expiresAt > at) return json(200, { currencies: currencyCache.currencies, cacheStatus: "cached" });
    try {
      const currencies = await fetchFrankfurterCurrencies({ fetchImpl });
      currencyCache = { currencies, expiresAt: at + 12 * 60 * 60 * 1000 };
      return json(200, { currencies, cacheStatus: "fresh" });
    } catch {
      if (currencyCache) return json(200, { currencies: currencyCache.currencies, cacheStatus: "stale-cache" });
      return json(503, { error: "Currency coverage is unavailable. Try again shortly." });
    }
  }

  async function staticRoute(url) {
    const file = STATIC_FILES.get(url.pathname) ?? (BROWSER_MODULE.test(url.pathname) ? url.pathname.slice(1) : null);
    let body = null;
    try {
      if (file) body = await readFile(resolve(root, file));
    } catch {
      // Answered as not found below.
    }
    if (body === null) {
      return { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" }, body: "Not found" };
    }
    return {
      status: 200,
      headers: {
        "content-type": MIME_TYPES[extname(file)],
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "strict-origin-when-cross-origin",
        "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      },
      body,
    };
  }

  // `target` is a request path with its query string. Never rejects.
  async function respond(method, target) {
    try {
      let url;
      try {
        url = new URL(target, "http://localhost");
      } catch {
        return json(400, { error: "Malformed request URL." });
      }
      if (method !== "GET") return json(405, { error: "Method not allowed." });
      if (url.pathname === "/api/rates") return await ratesRoute(url);
      if (url.pathname === "/api/markets") return await marketsRoute();
      if (url.pathname === "/api/history") return await historyRoute(url);
      if (url.pathname === "/api/market-history") return await marketHistoryRoute(url);
      if (url.pathname === "/api/currencies") return await currenciesRoute();
      return await staticRoute(url);
    } catch (error) {
      // No request may end in an unhandled rejection: Node would stop the whole server.
      log.error(`Request failed: ${error?.message ?? error}`);
      return json(500, { error: "Unexpected server error." });
    }
  }

  return {
    respond,
    async handleRequest(request, response) {
      const { status, headers, body } = await respond(request.method, request.url);
      response.writeHead(status, headers);
      response.end(body);
    },
    describeMarketData() {
      const oilRoute = eia.usesApiKey() ? "the EIA API" : "EIA's public history pages (no key set)";
      return `Market data: Frankfurter daily reference for currencies, gold and silver; crude oil from ${oilRoute}.`;
    },
    // Starts fetching the oil prices before a page asks for them. EIA's public pages answer a
    // script slowly, about ten seconds, and the first page would otherwise wait that long.
    warmUp() {
      eia.getSeries(Object.values(MARKET_ASSETS).flatMap((asset) => asset.oil ?? []));
    },
  };
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  await loadMarketEnvironment();
  const app = createApp();
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || "127.0.0.1";
  createServer(app.handleRequest).listen(port, host, () => {
    console.log(`Counterline FX Desk running at http://${host.includes(":") ? `[${host}]` : host}:${port}`);
    console.log(app.describeMarketData());
    app.warmUp();
  });
}
