const API_ROOT = "https://api.twelvedata.com";
const SOURCE_NAME = "Twelve Data";
const CACHE_TTL_MS = 5 * 60_000;
const CREDIT_WINDOW_MS = 60_000;
const API_CREDIT_LIMIT = 8;

const RANGE_OPTIONS = {
  "5min": { interval: "1min", outputsize: 5 },
  "24h": { interval: "1h", outputsize: 24 },
  "1w": { interval: "1day", outputsize: 8 },
  "1m": { interval: "1day", outputsize: 31 },
  "3m": { interval: "1day", outputsize: 93 },
  "6m": { interval: "1day", outputsize: 184 },
};
const METAL_CODES = new Set(["XAU", "XAG"]);

function validSymbol(value) {
  return /^[A-Z]{3}\/[A-Z]{3}$/.test(value);
}

function normalizeDatetime(value) {
  if (typeof value !== "string") return null;
  const isoLike = value.replace(" ", "T");
  let normalized = isoLike;
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoLike)) {
    normalized = `${isoLike}T00:00:00.000Z`;
  } else if (!/Z$/i.test(isoLike)) {
    const offset = /([+-])(\d{2}):?(\d{2})$/.exec(isoLike);
    normalized = offset
      ? isoLike.replace(/([+-])(\d{2}):?(\d{2})$/, "$1$2:$3")
      : `${isoLike}Z`;
  }
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getSeriesPayload(payload, symbol, batched) {
  if (!batched) return payload;
  const direct = payload?.[symbol];
  if (direct) return direct;
  const normalizedSymbol = symbol.toUpperCase();
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (
      key.toUpperCase() === normalizedSymbol ||
      value?.meta?.symbol?.toUpperCase() === normalizedSymbol
    ) return value;
  }
  return null;
}

function normalizeValues(payload) {
  if (!Array.isArray(payload?.values)) return [];
  return payload.values
    .map((item) => {
      const observedAt = normalizeDatetime(item?.datetime);
      const close = Number(item?.close);
      if (!observedAt || !Number.isFinite(close) || close <= 0) return null;
      return { date: observedAt.slice(0, 10), observedAt, rate: String(item.close) };
    })
    .filter(Boolean)
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
}

export function createTwelveDataProvider({
  apiKey = process.env.TWELVE_DATA_API_KEY || process.env.TWELVEDATA_API_KEY || "",
  externalDisplayLicensed = process.env.TWELVEDATA_EXTERNAL_DISPLAY_LICENSE === "confirmed",
  fetchImpl = globalThis.fetch,
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const creditTimes = [];
  const configured = Boolean(apiKey && externalDisplayLicensed);
  const missingConfigurationMessage = !apiKey
    ? "Add a Twelve Data API key to the server environment."
    : "Twelve Data's free Basic tier is for internal, non-display use. Configure an eligible business plan and external-display rights before showing rates to clients.";

  function reserveCredits(symbols) {
    const now = Date.now();
    while (creditTimes.length && creditTimes[0] <= now - CREDIT_WINDOW_MS) creditTimes.shift();
    const available = Math.max(0, API_CREDIT_LIMIT - creditTimes.length);
    const accepted = symbols.slice(0, available);
    for (const _symbol of accepted) creditTimes.push(now);
    return { accepted, deferred: symbols.slice(available) };
  }

  async function fetchSeriesBatch(symbols, range) {
    if (!configured) throw new Error(missingConfigurationMessage);
    if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable in this runtime.");
    if (!Object.hasOwn(RANGE_OPTIONS, range) || symbols.some((symbol) => !validSymbol(symbol))) {
      throw new Error("Unsupported symbol or history range.");
    }

    const options = RANGE_OPTIONS[range];
    const url = new URL(`${API_ROOT}/time_series`);
    url.searchParams.set("symbol", symbols.join(","));
    url.searchParams.set("interval", options.interval);
    url.searchParams.set("outputsize", String(options.outputsize));
    url.searchParams.set("timezone", "UTC");
    url.searchParams.set("apikey", apiKey);
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Twelve Data returned an invalid response.");
    }
    if (!response.ok || payload?.status === "error") {
      throw new Error("Twelve Data could not return this symbol and range.");
    }

    const results = new Map();
    for (const symbol of symbols) {
      const series = getSeriesPayload(payload, symbol, symbols.length > 1);
      if (series?.status === "error") continue;
      const values = normalizeValues(series);
      if (values.length) results.set(symbol, values);
    }
    return results;
  }

  function providerSymbol(base, quote) {
    if (METAL_CODES.has(base) && quote === "USD") return { symbol: `${base}/USD`, invert: false };
    if (base === "USD" && METAL_CODES.has(quote)) return { symbol: `${quote}/USD`, invert: true };
    return { symbol: `${base}/${quote}`, invert: false };
  }

  function normalizeDirection(observations, invert) {
    if (!invert) return observations;
    return observations.map((observation) => ({
      ...observation,
      rate: String(1 / Number(observation.rate)),
    }));
  }

  async function getHistories(pairs, range) {
    const rates = Object.fromEntries(pairs.map(({ base, quote }) => [`${base}/${quote}`, []]));
    const errors = [];
    if (!configured) {
      return {
        rates,
        errors: pairs.map(({ base, quote }) => ({
          code: "provider-not-configured",
          pair: `${base}/${quote}`,
          message: missingConfigurationMessage,
        })),
      };
    }

    const requests = pairs.map(({ base, quote }) => {
      const direction = providerSymbol(base, quote);
      return { base, quote, pair: `${base}/${quote}`, ...direction, cacheKey: `${direction.symbol}|${range}` };
    });
    const symbols = [...new Set(requests.map(({ symbol }) => symbol))];
    const pending = new Map();
    const missing = [];

    for (const symbol of symbols) {
      const key = `${symbol}|${range}`;
      const cached = cache.get(key);
      if (cached && cached.expiresAt > Date.now()) pending.set(symbol, Promise.resolve(cached.values));
      else if (inFlight.has(key)) pending.set(symbol, inFlight.get(key));
      else missing.push(symbol);
    }

    const { accepted, deferred } = reserveCredits(missing);
    for (const symbol of deferred) {
      pending.set(symbol, Promise.reject(new Error("Twelve Data's 8-credit-per-minute Basic limit is currently full.")));
    }
    if (accepted.length) {
      const batchPromise = fetchSeriesBatch(accepted, range);
      for (const symbol of accepted) {
        const key = `${symbol}|${range}`;
        let symbolPromise;
        symbolPromise = batchPromise.then((batch) => {
          const values = batch.get(symbol);
          if (!values?.length) throw new Error("Twelve Data returned no observations for this symbol and range.");
          cache.set(key, { values, expiresAt: Date.now() + CACHE_TTL_MS });
          return values;
        }).finally(() => {
          if (inFlight.get(key) === symbolPromise) inFlight.delete(key);
        });
        inFlight.set(key, symbolPromise);
        pending.set(symbol, symbolPromise);
      }
    }

    const settled = await Promise.allSettled(symbols.map((symbol) => pending.get(symbol)));
    const bySymbol = new Map();
    settled.forEach((result, index) => {
      const symbol = symbols[index];
      if (result.status === "fulfilled") bySymbol.set(symbol, result.value);
      else errors.push({ code: "provider-request-failed", symbol, message: result.reason?.message ?? "Twelve Data did not return observations." });
    });

    for (const request of requests) {
      const observations = bySymbol.get(request.symbol);
      if (observations) rates[request.pair] = normalizeDirection(observations, request.invert);
    }
    return { rates, errors };
  }

  return {
    isConfigured: () => configured,
    configurationMessage: () => missingConfigurationMessage,
    async getHistories(pairs, range) {
      return getHistories(pairs, range);
    },
    async getHistory(base, quote, range) {
      const key = `${base}/${quote}`;
      const result = await getHistories([{ base, quote }], range);
      if (result.errors.length || !result.rates[key]?.length) {
        throw new Error(result.errors[0]?.message ?? "Twelve Data returned no recent observations.");
      }
      return result.rates[key];
    },
    async getRate(base, quote) {
      const observations = await getHistories([{ base, quote }], "5min");
      const history = observations.rates[`${base}/${quote}`];
      if (observations.errors.length || !history?.length) {
        throw new Error(observations.errors[0]?.message ?? "Twelve Data returned no recent observations.");
      }
      const latest = history.at(-1);
      return {
        base,
        quote,
        rate: latest.rate,
        date: latest.date,
        observedAt: latest.observedAt,
        source: SOURCE_NAME,
      };
    },
    async getMetalQuotes(codes = ["XAU", "XAG"]) {
      const pairs = codes.map((code) => ({ base: code, quote: "USD" }));
      const result = await getHistories(pairs, "5min");
      const rates = {};
      const errors = [];
      for (const code of codes) {
        const key = `${code}/USD`;
        const latest = result.rates[key]?.at(-1);
        if (latest) rates[code] = latest;
        else errors.push({ code, message: "Twelve Data has no recent observation for this metal." });
      }
      return { rates, errors };
    },
  };
}
