import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createReferenceService } from "./src/server/reference-service.mjs";
import { fetchFrankfurterCurrencies, fetchFrankfurterHistory } from "./src/server/frankfurter-provider.mjs";
import { createTwelveDataProvider } from "./src/server/twelve-data-provider.mjs";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
async function loadMarketEnvironment() {
  try {
    const lines = await readFile(resolve(root, ".env"), "utf8");
    for (const line of lines.split(/\r?\n/)) {
      const match = /^\s*(TWELVEDATA_API_KEY|TWELVEDATA_EXTERNAL_DISPLAY_LICENSE)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match || process.env[match[1]]) continue;
      const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
      process.env[match[1]] = value;
    }
  } catch {
    // Environment variables can also be supplied by the shell or deployment platform.
  }
}
await loadMarketEnvironment();
const referenceService = createReferenceService();
const twelveData = createTwelveDataProvider();
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

let currencyCache;
const historyCache = new Map();
const HISTORY_RANGES = { "1w": { days: 7 }, "1m": { months: 1 }, "3m": { months: 3 }, "6m": { months: 6 } };
const INTRADAY_HISTORY_RANGES = new Set(["5min", "24h"]);
const MARKET_HISTORY_RANGES = new Set(["5min", "24h", "1w", "1m", "3m", "6m"]);
const MARKET_HISTORY_ASSETS = new Set(["XAU", "XAG"]);

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
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
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

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${host}:${port}`);
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  if (url.pathname === "/api/rates") {
    const pairs = parsePairs(url.searchParams.get("pairs"));
    if (!pairs) {
      sendJson(response, 400, { error: "Provide up to 30 currency pairs as BASE:QUOTE entries." });
      return;
    }
    try {
      const metalPairs = pairs.filter(({ base, quote }) => base === "XAU" || base === "XAG" || quote === "XAU" || quote === "XAG");
      const currencyPairs = pairs.filter(({ base, quote }) => ![base, quote].some((code) => code === "XAU" || code === "XAG"));
      const supportedMetalPairs = metalPairs.filter(({ base, quote }) =>
        ((base === "XAU" || base === "XAG") && quote === "USD") ||
        (base === "USD" && (quote === "XAU" || quote === "XAG")));
      const unsupportedMetalPairs = metalPairs.filter((pair) => !supportedMetalPairs.includes(pair));
      const currencyPayload = currencyPairs.length ? await referenceService.getRates(currencyPairs) : null;
      const rates = { ...(currencyPayload?.rates ?? {}) };
      const errors = [...(currencyPayload?.errors ?? [])];
      if (supportedMetalPairs.length && !twelveData.isConfigured()) {
        errors.push({ code: "provider-not-configured", message: twelveData.configurationMessage() });
      } else if (supportedMetalPairs.length) {
        const metalResults = await Promise.allSettled(supportedMetalPairs.map(({ base, quote }) => twelveData.getRate(base, quote)));
        metalResults.forEach((result, index) => {
          const pair = supportedMetalPairs[index];
          const key = `${pair.base}/${pair.quote}`;
          if (result.status === "fulfilled") rates[key] = result.value;
          else errors.push({ code: "provider-request-failed", pair: key, message: "Twelve Data did not return a recent observation for this metal pair." });
        });
      }
      if (unsupportedMetalPairs.length) errors.push({ code: "unsupported-metal-pair", message: "Gold and silver are currently supported against USD only." });
      sendJson(response, 200, {
        source: supportedMetalPairs.length && twelveData.isConfigured()
          ? `${currencyPayload?.source ?? "Currency reference data"} · Twelve Data metals`
          : currencyPayload?.source ?? "Twelve Data metals",
        retrievedAt: currencyPayload?.retrievedAt ?? new Date().toISOString(),
        checkedAt: new Date().toISOString(),
        rates,
        errors,
        fallbackPairs: currencyPayload?.fallbackPairs ?? [],
        cacheStatus: currencyPayload?.cacheStatus === "stale-cache" ? "stale-cache" : errors.length ? "partial" : currencyPayload?.cacheStatus ?? "fresh",
      });
    } catch {
      sendJson(response, 503, { error: "Reference data is unavailable. Try again shortly." });
    }
    return;
  }

  if (url.pathname === "/api/markets") {
    if (!twelveData.isConfigured()) {
      sendJson(response, 200, {
        source: "Twelve Data",
        retrievedAt: null,
        rates: {},
        errors: [{ code: "provider-not-configured", message: twelveData.configurationMessage() }],
        cacheStatus: "not-configured",
      });
      return;
    }
    const result = await twelveData.getMetalQuotes(["XAU", "XAG"]);
    sendJson(response, 200, {
      source: "Twelve Data · precious metal spot reference",
      retrievedAt: new Date().toISOString(),
      rates: result.rates,
      errors: result.errors,
      cacheStatus: result.errors.length ? "partial" : "fresh",
    });
    return;
  }

  if (url.pathname === "/api/history") {
    const pairs = parsePairs(url.searchParams.get("pairs"));
    const range = url.searchParams.get("range");
    if (!pairs || (!Object.hasOwn(HISTORY_RANGES, range) && !INTRADAY_HISTORY_RANGES.has(range))) {
      sendJson(response, 400, { error: "Provide up to 30 currency pairs and a supported range." });
      return;
    }
    if (INTRADAY_HISTORY_RANGES.has(range)) {
      const rates = Object.fromEntries(pairs.map(({ base, quote }) => [`${base}/${quote}`, []]));
      if (twelveData.isConfigured()) {
        const results = await Promise.allSettled(pairs.map(({ base, quote }) => twelveData.getHistory(base, quote, range)));
        const errors = [];
        results.forEach((result, index) => {
          const key = `${pairs[index].base}/${pairs[index].quote}`;
          if (result.status === "fulfilled") rates[key] = result.value;
          else errors.push({ code: "provider-request-failed", pair: key, message: "Twelve Data did not return observations for this pair and range." });
        });
        sendJson(response, 200, {
          source: "Twelve Data intraday reference data",
          interval: range === "5min" ? "one-minute" : "hourly",
          rates,
          errors,
          cacheStatus: errors.length ? "partial" : "fresh",
        });
        return;
      }
      sendJson(response, 200, {
        source: "Twelve Data intraday reference data",
        interval: range === "5min" ? "five-minute" : "hourly",
        rates,
        errors: [{ code: "provider-not-configured", message: twelveData.configurationMessage() }],
        cacheStatus: "not-configured",
      });
      return;
    }
    const { from, to } = historyDates(range);
    const key = `${from}:${to}:${range}:${pairs.map((pair) => `${pair.base}/${pair.quote}`).sort().join("|")}`;
    const now = Date.now();
    const cached = historyCache.get(key);
    if (cached && cached.expiresAt > now) {
      sendJson(response, 200, { ...cached.payload, cacheStatus: "cached" });
      return;
    }
    try {
      const metalPairs = pairs.filter(({ base, quote }) => base === "XAU" || base === "XAG" || quote === "XAU" || quote === "XAG");
      const currencyPairs = pairs.filter(({ base, quote }) => ![base, quote].some((code) => code === "XAU" || code === "XAG"));
      const payload = currencyPairs.length
        ? await fetchFrankfurterHistory(currencyPairs, { from, to })
        : { source: "Metals history not configured", from, to, rates: {}, errors: [] };
      if (metalPairs.length && twelveData.isConfigured()) {
        const results = await Promise.allSettled(metalPairs.map(({ base, quote }) => twelveData.getHistory(base, quote, range)));
        results.forEach((result, index) => {
          const { base, quote } = metalPairs[index];
          const key = `${base}/${quote}`;
          if (result.status === "fulfilled") payload.rates[key] = result.value;
          else {
            payload.rates[key] = [];
            payload.errors.push({ code: "provider-request-failed", pair: key, message: "Twelve Data did not return observations for this metal pair." });
          }
        });
        payload.source = `${payload.source} · Twelve Data metals`;
      } else if (metalPairs.length) {
        for (const { base, quote } of metalPairs) payload.rates[`${base}/${quote}`] = [];
        payload.errors.push({ code: "provider-not-configured", message: twelveData.configurationMessage() });
      }
      if (Object.values(payload.rates).some((observations) => observations.length)) {
        historyCache.set(key, { payload, expiresAt: now + 15 * 60 * 1000 });
      }
      sendJson(response, 200, { ...payload, cacheStatus: "fresh" });
    } catch {
      sendJson(response, 503, { error: "Historical reference data is unavailable. Try again shortly." });
    }
    return;
  }

  if (url.pathname === "/api/market-history") {
    const requestedAssets = url.searchParams.get("assets")?.split("|") ?? [];
    const range = url.searchParams.get("range");
    if (
      !requestedAssets.length ||
      requestedAssets.length > 6 ||
      requestedAssets.some((asset) => !MARKET_HISTORY_ASSETS.has(asset)) ||
      !MARKET_HISTORY_RANGES.has(range)
    ) {
      sendJson(response, 400, { error: "Provide supported market assets and a supported history range." });
      return;
    }
    if (!twelveData.isConfigured()) {
      sendJson(response, 200, {
        source: "Twelve Data precious metal history",
        rates: Object.fromEntries(requestedAssets.map((asset) => [asset, []])),
        errors: [{ code: "provider-not-configured", message: twelveData.configurationMessage() }],
        cacheStatus: "not-configured",
      });
      return;
    }
    const results = await Promise.allSettled(requestedAssets.map((asset) => twelveData.getHistory(asset, "USD", range)));
    const rates = {};
    const errors = [];
    results.forEach((result, index) => {
      const code = requestedAssets[index];
      if (result.status === "fulfilled") rates[code] = result.value;
      else {
        rates[code] = [];
        errors.push({ code: "provider-request-failed", asset: code, message: "Twelve Data did not return observations for this metal and range." });
      }
    });
    sendJson(response, 200, {
      source: "Twelve Data · precious metal spot reference",
      rates,
      errors,
      cacheStatus: errors.length ? "partial" : "fresh",
    });
    return;
  }

  if (url.pathname === "/api/currencies") {
    const now = Date.now();
    if (currencyCache && currencyCache.expiresAt > now) {
      sendJson(response, 200, { currencies: currencyCache.currencies, cacheStatus: "cached" });
      return;
    }
    try {
      const currencies = await fetchFrankfurterCurrencies();
      currencyCache = { currencies, expiresAt: now + 12 * 60 * 60 * 1000 };
      sendJson(response, 200, { currencies, cacheStatus: "fresh" });
    } catch {
      if (currencyCache) {
        sendJson(response, 200, { currencies: currencyCache.currencies, cacheStatus: "stale-cache" });
      } else {
        sendJson(response, 503, { error: "Currency coverage is unavailable. Try again shortly." });
      }
    }
    return;
  }

  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = resolve(root, `.${requested}`);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin",
      "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, host, () => {
  console.log(`Counterline FX Desk running at http://${host}:${port}`);
});
