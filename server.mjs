import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decimalFromNumber } from "./src/domain/decimal.js";
import { createReferenceService } from "./src/server/reference-service.mjs";
import { fetchFrankfurterCurrencies, fetchFrankfurterHistory, fetchFrankfurterRates } from "./src/server/frankfurter-provider.mjs";
import { createTwelveDataProvider } from "./src/server/twelve-data-provider.mjs";

const projectRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const ENV_NAMES = [
  "TWELVE_DATA_API_KEY",
  "TWELVEDATA_API_KEY",
  "TWELVEDATA_EXTERNAL_DISPLAY_LICENSE",
  "TWELVE_DATA_CREDITS_PER_MINUTE",
  "TWELVE_DATA_CREDITS_PER_DAY",
];

async function loadMarketEnvironment() {
  const assignment = new RegExp(`^\\s*(${ENV_NAMES.join("|")})\\s*=\\s*(.*?)\\s*$`);
  try {
    const lines = await readFile(resolve(projectRoot, ".env"), "utf8");
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
const STATIC_FILES = new Map([["/", "index.html"], ["/index.html", "index.html"], ["/styles.css", "styles.css"]]);
// Browser modules: src/app.js and the folders it imports from. Nothing else under the project
// root is served, so .env, .git and the server source cannot be downloaded.
const BROWSER_MODULE = /^\/src\/(?:app\.js|(?:domain|ui)\/[A-Za-z0-9-]+\.js)$/;

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_RANGES = { "1w": { days: 7 }, "1m": { months: 1 }, "3m": { months: 3 }, "6m": { months: 6 } };
const INTRADAY_RANGES = new Set(["5min", "24h"]);
// The time grid of each chart range, matching what Twelve Data is asked for.
const SERIES_SHAPES = {
  "5min": { interval: "1min", stepMs: 60 * 1000, points: 5 },
  "24h": { interval: "1h", stepMs: 60 * 60 * 1000, points: 24 },
  "1w": { interval: "1day", stepMs: DAY_MS, points: 8 },
  "1m": { interval: "1day", stepMs: DAY_MS, points: 31 },
  "3m": { interval: "1day", stepMs: DAY_MS, points: 93 },
  "6m": { interval: "1day", stepMs: DAY_MS, points: 184 },
};
const METAL_CODES = new Set(["XAU", "XAG"]);
const MARKET_ASSETS = ["XAU", "XAG"];
const HISTORY_TTL_MS = 5 * 60 * 1000;
const HISTORY_KEEP_MS = 72 * 60 * 60 * 1000; // a failed refresh may fall back on history this old
const CONTEXT_TTL_MS = 10 * 60 * 1000;
const CONTEXT_WINDOW_DAYS = 21;
const TWELVE_DATA_DEADLINE_MS = 2500; // charts are answered by then, with a fallback if need be
const MAX_RETRY_HINT_MS = 2 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const MAX_DAILY_VOLATILITY = 0.03;

const pairKey = ({ base, quote }) => `${base}/${quote}`;
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

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
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
  if (id.includes("XAG")) return 0.018;
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
  const twelveData = createTwelveDataProvider({
    apiKey: env.TWELVE_DATA_API_KEY || env.TWELVEDATA_API_KEY || "",
    externalDisplayLicensed: env.TWELVEDATA_EXTERNAL_DISPLAY_LICENSE === "confirmed",
    creditsPerMinute: env.TWELVE_DATA_CREDITS_PER_MINUTE,
    creditsPerDay: env.TWELVE_DATA_CREDITS_PER_DAY,
    fetchImpl,
    now: () => now().getTime(),
  });
  const referenceService = createReferenceService({
    provider: (pairs) => fetchFrankfurterRates(pairs, { fetchImpl, now }),
    now,
  });
  const dailyHistory = new Map(); // "BASE/QUOTE|range" -> { observations, from, fetchedAt }
  const contexts = new Map(); // "BASE/QUOTE" -> { reference, previous, dailyVolatility, fetchedAt }
  const contextLoads = new Map(); // "BASE/QUOTE" -> the request that is filling its context
  let currencyCache;

  // Frankfurter daily observations per pair, cached for five minutes. When a refresh fails, the
  // last history that did arrive is returned with `stale: true`.
  async function loadDailyHistory(pairs, range) {
    const { from, to } = historyDates(range, now());
    const at = now().getTime();
    const found = new Map();
    const missing = [];
    for (const pair of pairs) {
      const cached = dailyHistory.get(`${pairKey(pair)}|${range}`);
      if (cached && cached.from === from && at - cached.fetchedAt < HISTORY_TTL_MS) {
        found.set(pairKey(pair), { observations: cached.observations, stale: false, fetchedAt: new Date(cached.fetchedAt).toISOString() });
      } else {
        missing.push(pair);
      }
    }
    if (missing.length) {
      let loaded = { rates: {} };
      try {
        loaded = await fetchFrankfurterHistory(missing, { from, to, fetchImpl });
      } catch {
        // Handled per pair below.
      }
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

  // The latest Frankfurter reference price of each pair, with the observation before it and the
  // pair's recent volatility. Cached for ten minutes; an older context survives a failed refresh.
  async function referenceContexts(pairs) {
    const at = now().getTime();
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
    await Promise.all(pairs.map((pair) => contextLoads.get(pairKey(pair))));
    return new Map(pairs.map((pair) => [pairKey(pair), contexts.get(pairKey(pair)) ?? null]));
  }

  // The fallback engine. Every requested chart series leaves here with data and a label saying
  // where the data came from:
  //   observed   - Twelve Data, inside its five minute cache window
  //   reference  - Frankfurter daily observations (real data, no key needed)
  //   stale      - the last series a provider delivered, because its refresh failed
  //   estimated  - generateFallbackSeries, anchored to the latest Frankfurter reference price
  // A series is "unavailable" only when there is no reference price to anchor an estimate on.
  async function resolveChartSeries(requests, range) {
    const intraday = INTRADAY_RANGES.has(range);
    const { interval } = SERIES_SHAPES[range];
    const rates = {};
    const series = {};
    const errors = [];
    const open = new Map(requests.map((request) => [request.id, request]));
    const notes = new Map(); // id -> why the preferred source did not answer
    const lastDelivered = new Map();
    const why = (id) => {
      const note = notes.get(id);
      return note ? { reason: note.reason, message: note.message } : {};
    };
    const settle = (request, observations, detail) => {
      rates[request.id] = observations;
      series[request.id] = { interval, ...detail, ...why(request.id) };
      open.delete(request.id);
    };

    // Twelve Data: the source for intraday charts, and for gold and silver at every range.
    const marketRequests = requests.filter((request) => intraday || isMetalPair(request));
    if (marketRequests.length && twelveData.isConfigured()) {
      const market = await twelveData.getHistories(marketRequests, range, { deadlineMs: TWELVE_DATA_DEADLINE_MS });
      for (const request of marketRequests) {
        const key = pairKey(request);
        const detail = market.details[key];
        if (detail.status === "fresh" || detail.status === "cached") {
          settle(request, market.rates[key], { kind: "observed", source: "Twelve Data", fetchedAt: detail.fetchedAt });
          continue;
        }
        notes.set(request.id, { reason: detail.reason, message: detail.message, retryAfterMs: detail.retryAfterMs });
        if (detail.status === "stale") lastDelivered.set(request.id, { observations: market.rates[key], source: "Twelve Data", fetchedAt: detail.fetchedAt });
      }
    } else if (marketRequests.length) {
      const { state, message } = twelveData.status();
      for (const request of marketRequests) notes.set(request.id, { reason: state, message, retryAfterMs: null });
    }

    // Daily ranges: Frankfurter's daily reference history.
    if (!intraday && open.size) {
      const history = await loadDailyHistory([...open.values()], range);
      for (const request of [...open.values()]) {
        const found = history.get(pairKey(request));
        if (found && !found.stale) {
          settle(request, found.observations, { kind: "reference", source: "Frankfurter", fetchedAt: found.fetchedAt });
          continue;
        }
        if (found && !lastDelivered.has(request.id)) lastDelivered.set(request.id, { observations: found.observations, source: "Frankfurter", fetchedAt: found.fetchedAt });
        if (!notes.has(request.id)) notes.set(request.id, { reason: "provider-error", message: "Frankfurter history could not be loaded.", retryAfterMs: null });
      }
    }

    // The last series a provider did deliver, shown as stale.
    for (const request of [...open.values()]) {
      const kept = lastDelivered.get(request.id);
      if (kept) settle(request, kept.observations, { kind: "stale", source: kept.source, fetchedAt: kept.fetchedAt });
    }

    // An estimate anchored to the latest Frankfurter reference price.
    if (open.size) {
      const anchors = await referenceContexts([...open.values()]);
      for (const request of [...open.values()]) {
        const context = anchors.get(pairKey(request));
        if (!context) continue;
        const observations = generateFallbackSeries({
          id: pairKey(request),
          range,
          reference: context.reference,
          dailyVolatility: context.dailyVolatility,
          now: now().getTime(),
        });
        if (observations.length) {
          settle(request, observations, {
            kind: "estimated",
            source: "Estimate from the latest Frankfurter reference",
            baseline: { ...context.reference, source: "Frankfurter" },
          });
        }
      }
    }

    // No reference price to anchor on: say so rather than invent a price level.
    for (const request of open.values()) {
      rates[request.id] = [];
      series[request.id] = { interval, kind: "unavailable", source: null, ...why(request.id) };
      errors.push({ code: "no-reference-data", id: request.id, message: "No source returned data, and there is no reference price to estimate from." });
    }

    // When the preferred source should answer soon, tell the browser when to ask again.
    const retryHints = requests
      .filter((request) => series[request.id].kind !== "observed")
      .map((request) => notes.get(request.id)?.retryAfterMs)
      .filter((delay) => Number.isFinite(delay) && delay > 0 && delay <= MAX_RETRY_HINT_MS);
    return { rates, series, errors, retryAfterMs: retryHints.length ? Math.min(...retryHints) + 250 : null };
  }

  function chartPayload({ rates, series, errors, retryAfterMs }, range) {
    const kinds = new Set(Object.values(series).map(({ kind }) => kind));
    const sources = [...new Set(Object.values(series).map(({ source }) => source).filter(Boolean))];
    return {
      source: sources.join(" · "),
      range,
      interval: SERIES_SHAPES[range].interval,
      generatedAt: now().toISOString(),
      rates,
      series,
      errors,
      retryAfterMs,
      provider: { twelveData: twelveData.status() },
      cacheStatus: errors.length ? "partial" : kinds.has("estimated") || kinds.has("stale") ? "fallback" : "fresh",
    };
  }

  async function ratesRoute(url, response) {
    const pairs = parsePairs(url.searchParams.get("pairs"));
    if (!pairs) {
      sendJson(response, 400, { error: "Provide up to 30 currency pairs as BASE:QUOTE entries." });
      return;
    }
    // Gold and silver are quoted against USD only; every other pair is an ordinary reference pair.
    const unsupported = pairs.filter((pair) => isMetalPair(pair) && !isUsdMetalPair(pair));
    const supported = pairs.filter((pair) => !unsupported.includes(pair));
    const metalPairs = supported.filter(isMetalPair);
    let payload = null;
    try {
      if (supported.length) payload = await referenceService.getRates(supported);
    } catch {
      sendJson(response, 503, { error: "Reference data is unavailable. Try again shortly." });
      return;
    }
    const rates = { ...(payload?.rates ?? {}) };
    const errors = [...(payload?.errors ?? [])];
    for (const pair of metalPairs) {
      if (rates[pairKey(pair)]) rates[pairKey(pair)] = { ...rates[pairKey(pair)], source: "Frankfurter daily reference" };
    }
    if (metalPairs.length && twelveData.isConfigured()) {
      const market = await twelveData.getHistories(metalPairs, "5min", { deadlineMs: TWELVE_DATA_DEADLINE_MS });
      for (const pair of metalPairs) {
        const key = pairKey(pair);
        const latest = market.rates[key].at(-1);
        if (latest) rates[key] = { ...latest, base: pair.base, quote: pair.quote, source: "Twelve Data", cacheFallback: market.details[key].status === "stale" };
      }
    }
    if (unsupported.length) errors.push({ code: "unsupported-metal-pair", message: "Gold and silver are currently supported against USD only." });
    const cacheStatus = ["stale-cache", "partial-cache"].includes(payload?.cacheStatus)
      ? payload.cacheStatus
      : errors.length ? "partial" : payload?.cacheStatus ?? "fresh";
    sendJson(response, 200, {
      source: payload?.source ?? "Reference data",
      retrievedAt: payload?.retrievedAt ?? now().toISOString(),
      checkedAt: now().toISOString(),
      rates,
      errors,
      fallbackPairs: payload?.fallbackPairs ?? [],
      cacheStatus,
    });
  }

  // Gold and silver quote cards: Twelve Data's latest bar when it is on, otherwise Frankfurter's
  // daily reference price. A quote card never shows an estimate.
  async function marketsRoute(response) {
    const pairs = MARKET_ASSETS.map((code) => ({ base: code, quote: "USD" }));
    const market = twelveData.isConfigured()
      ? await twelveData.getHistories(pairs, "5min", { deadlineMs: TWELVE_DATA_DEADLINE_MS })
      : null;
    const anchors = await referenceContexts(pairs.filter((pair) => !market?.rates[pairKey(pair)].length));
    const rates = {};
    const errors = [];
    for (const code of MARKET_ASSETS) {
      const key = `${code}/USD`;
      const latest = market?.rates[key].at(-1);
      const context = anchors.get(key);
      if (latest) {
        const detail = market.details[key];
        rates[code] = { ...latest, source: "Twelve Data", kind: detail.status === "stale" ? "stale" : "observed", fetchedAt: detail.fetchedAt };
      } else if (context) {
        rates[code] = { ...context.reference, source: "Frankfurter", kind: "reference", previous: context.previous };
      } else {
        errors.push({ code: "no-reference-data", asset: code, message: "No gold or silver reference price could be loaded." });
      }
    }
    sendJson(response, 200, {
      source: [...new Set(Object.values(rates).map(({ source }) => source))].join(" · "),
      retrievedAt: now().toISOString(),
      rates,
      errors,
      provider: { twelveData: twelveData.status() },
      cacheStatus: errors.length ? "partial" : "fresh",
    });
  }

  async function historyRoute(url, response) {
    const pairs = parsePairs(url.searchParams.get("pairs"));
    const range = url.searchParams.get("range");
    if (!pairs || !Object.hasOwn(SERIES_SHAPES, range)) {
      sendJson(response, 400, { error: "Provide up to 30 currency pairs and a supported range." });
      return;
    }
    const requests = pairs.map((pair) => ({ ...pair, id: pairKey(pair) }));
    sendJson(response, 200, chartPayload(await resolveChartSeries(requests, range), range));
  }

  async function marketHistoryRoute(url, response) {
    const assets = url.searchParams.get("assets")?.split("|") ?? [];
    const range = url.searchParams.get("range");
    if (!assets.length || assets.length > MARKET_ASSETS.length || assets.some((asset) => !MARKET_ASSETS.includes(asset)) || !Object.hasOwn(SERIES_SHAPES, range)) {
      sendJson(response, 400, { error: "Provide supported market assets and a supported history range." });
      return;
    }
    const requests = [...new Set(assets)].map((asset) => ({ id: asset, base: asset, quote: "USD" }));
    sendJson(response, 200, chartPayload(await resolveChartSeries(requests, range), range));
  }

  async function currenciesRoute(response) {
    const at = now().getTime();
    if (currencyCache && currencyCache.expiresAt > at) {
      sendJson(response, 200, { currencies: currencyCache.currencies, cacheStatus: "cached" });
      return;
    }
    try {
      const currencies = await fetchFrankfurterCurrencies({ fetchImpl });
      currencyCache = { currencies, expiresAt: at + 12 * 60 * 60 * 1000 };
      sendJson(response, 200, { currencies, cacheStatus: "fresh" });
    } catch {
      if (currencyCache) {
        sendJson(response, 200, { currencies: currencyCache.currencies, cacheStatus: "stale-cache" });
      } else {
        sendJson(response, 503, { error: "Currency coverage is unavailable. Try again shortly." });
      }
    }
  }

  async function staticRoute(url, response) {
    const file = STATIC_FILES.get(url.pathname) ?? (BROWSER_MODULE.test(url.pathname) ? url.pathname.slice(1) : null);
    let body = null;
    try {
      if (file) body = await readFile(resolve(root, file));
    } catch {
      // Answered as not found below.
    }
    if (body === null) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "content-type": MIME_TYPES[extname(file)],
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin",
      "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(body);
  }

  async function route(request, response) {
    let url;
    try {
      url = new URL(request.url, "http://localhost");
    } catch {
      sendJson(response, 400, { error: "Malformed request URL." });
      return;
    }
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    if (url.pathname === "/api/rates") return ratesRoute(url, response);
    if (url.pathname === "/api/markets") return marketsRoute(response);
    if (url.pathname === "/api/history") return historyRoute(url, response);
    if (url.pathname === "/api/market-history") return marketHistoryRoute(url, response);
    if (url.pathname === "/api/currencies") return currenciesRoute(response);
    return staticRoute(url, response);
  }

  return {
    // No request may end in an unhandled rejection: Node would stop the whole server.
    async handleRequest(request, response) {
      try {
        await route(request, response);
      } catch (error) {
        log.error(`Request failed: ${error?.message ?? error}`);
        if (response.headersSent) response.destroy();
        else sendJson(response, 500, { error: "Unexpected server error." });
      }
    },
    describeMarketData() {
      const { creditsPerMinute, creditsPerDay } = twelveData.limits();
      const intraday = twelveData.isConfigured()
        ? `Twelve Data is on (${creditsPerMinute} credits per minute, ${creditsPerDay} per day).`
        : `${twelveData.configurationMessage()} Intraday charts show labelled estimates.`;
      return `Market data: Frankfurter daily reference for currencies, gold and silver. ${intraday}`;
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
  });
}
