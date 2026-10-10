const API_ROOT = "https://api.twelvedata.com";
const SOURCE_NAME = "Twelve Data";

const RANGE_OPTIONS = {
  "5min": { interval: "1min", outputsize: 5, ttlMs: 15_000 },
  "24h": { interval: "1h", outputsize: 24, ttlMs: 60_000 },
  "1w": { interval: "1day", outputsize: 8, ttlMs: 5 * 60_000 },
  "1m": { interval: "1day", outputsize: 31, ttlMs: 5 * 60_000 },
  "3m": { interval: "1day", outputsize: 93, ttlMs: 10 * 60_000 },
  "6m": { interval: "1day", outputsize: 184, ttlMs: 10 * 60_000 },
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

export function createTwelveDataProvider({
  apiKey = process.env.TWELVEDATA_API_KEY ?? "",
  externalDisplayLicensed = process.env.TWELVEDATA_EXTERNAL_DISPLAY_LICENSE === "confirmed",
  fetchImpl = globalThis.fetch,
} = {}) {
  const cache = new Map();
  const configured = Boolean(apiKey && externalDisplayLicensed);
  const missingConfigurationMessage = !apiKey
    ? "Add a Twelve Data API key to the server environment."
    : "Twelve Data's free Basic tier is for internal use. Configure an eligible business plan and external-display rights before showing rates to clients.";

  async function fetchSeries(symbol, range) {
    if (!configured) throw new Error(missingConfigurationMessage);
    if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable in this runtime.");
    if (!validSymbol(symbol) || !Object.hasOwn(RANGE_OPTIONS, range)) throw new Error("Unsupported symbol or history range.");

    const rangeOptions = RANGE_OPTIONS[range];
    const cacheKey = `${symbol}|${range}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.values;

    const url = new URL(`${API_ROOT}/time_series`);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", rangeOptions.interval);
    url.searchParams.set("outputsize", String(rangeOptions.outputsize));
    url.searchParams.set("timezone", "UTC");
    url.searchParams.set("apikey", apiKey);
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    const payload = await response.json();
    if (!response.ok || payload?.status === "error" || !Array.isArray(payload?.values)) {
      throw new Error("Twelve Data could not return this symbol and range.");
    }

    const values = payload.values
      .map((item) => {
        const observedAt = normalizeDatetime(item?.datetime);
        const close = Number(item?.close);
        if (!observedAt || !Number.isFinite(close) || close <= 0) return null;
        return { date: observedAt.slice(0, 10), observedAt, rate: String(item.close) };
      })
      .filter(Boolean)
      .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
    cache.set(cacheKey, { values, expiresAt: Date.now() + rangeOptions.ttlMs });
    return values;
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

  return {
    isConfigured: () => configured,
    configurationMessage: () => missingConfigurationMessage,
    async getHistory(base, quote, range) {
      const { symbol, invert } = providerSymbol(base, quote);
      const observations = await fetchSeries(symbol, range);
      return normalizeDirection(observations, invert);
    },
    async getRate(base, quote) {
      const { symbol, invert } = providerSymbol(base, quote);
      const observations = await fetchSeries(symbol, "5min");
      const latest = observations.at(-1);
      if (!latest) throw new Error("Twelve Data returned no recent observation.");
      const rate = invert ? 1 / Number(latest.rate) : Number(latest.rate);
      return {
        base,
        quote,
        rate: String(rate),
        date: latest.date,
        observedAt: latest.observedAt,
        source: SOURCE_NAME,
      };
    },
    async getMetalQuotes(codes = ["XAU", "XAG"]) {
      const results = await Promise.allSettled(codes.map(async (code) => {
        if (!METAL_CODES.has(code)) throw new Error("Unsupported precious metal.");
        const observations = await fetchSeries(`${code}/USD`, "5min");
        const latest = observations.at(-1);
        if (!latest) throw new Error("Twelve Data returned no recent observation.");
        return [code, latest];
      }));
      const rates = {};
      const errors = [];
      results.forEach((result, index) => {
        const code = codes[index];
        if (result.status === "fulfilled") rates[code] = result.value[1];
        else errors.push({ code, message: "Twelve Data has no recent observation for this metal." });
      });
      return { rates, errors };
    },
  };
}
