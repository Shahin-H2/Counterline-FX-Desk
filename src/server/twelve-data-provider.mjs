import { decimalFromNumber, toPlainDecimal } from "../domain/decimal.js";

const API_ROOT = "https://api.twelvedata.com";
const CACHE_TTL_MS = 5 * 60_000;
const CREDIT_WINDOW_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_CREDITS_PER_MINUTE = 8;
const DEFAULT_CREDITS_PER_DAY = 800;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_ENTRIES = 400;

// maxStaleMs: how long an expired series may still be served, marked stale, when a refresh fails.
const RANGE_OPTIONS = {
  "5min": { interval: "1min", outputsize: 5, maxStaleMs: 30 * 60_000 },
  "24h": { interval: "1h", outputsize: 24, maxStaleMs: 6 * 60 * 60_000 },
  "1w": { interval: "1day", outputsize: 8, maxStaleMs: 36 * 60 * 60_000 },
  "1m": { interval: "1day", outputsize: 31, maxStaleMs: 36 * 60 * 60_000 },
  "3m": { interval: "1day", outputsize: 93, maxStaleMs: 36 * 60 * 60_000 },
  "6m": { interval: "1day", outputsize: 184, maxStaleMs: 36 * 60 * 60_000 },
};
const METAL_CODES = new Set(["XAU", "XAG"]);

const MESSAGES = {
  "no-api-key": "Twelve Data is off: no TWELVE_DATA_API_KEY is set in .env.",
  "display-license-unconfirmed": "Twelve Data is off: a key is set, but TWELVEDATA_EXTERNAL_DISPLAY_LICENSE is not \"confirmed\". The free Basic plan does not allow its data to be displayed.",
  "rate-limited": "Twelve Data's per-minute credit limit is used up.",
  "quota-exhausted": "Twelve Data's daily credit limit is used up.",
  unauthorized: "Twelve Data rejected the API key.",
  "unsupported-symbol": "Twelve Data does not offer this symbol on the current plan.",
  "provider-error": "Twelve Data did not return observations.",
  timeout: "Twelve Data did not answer in time.",
  pending: "Twelve Data is still answering.",
};
// How long a failed series is left alone before it is asked for again.
const FAILURE_TTL_MS = { "provider-error": 30_000, timeout: 30_000 };
// A symbol the plan does not include fails at every range, so it is remembered by symbol.
const UNSUPPORTED_TTL_MS = 60 * 60_000;

function failure(reason, extra = {}) {
  return { reason, message: MESSAGES[reason], retryAfterMs: null, ...extra };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function validSymbol(value) {
  return /^[A-Z]{3}\/[A-Z]{3}$/.test(value);
}

// Intraday bars carry a UTC timestamp. Daily bars carry a date only: giving them a midnight
// timestamp would show them a day early in time zones behind UTC.
function normalizeDatetime(value) {
  if (typeof value !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value, observedAt: null };
  const isoLike = value.replace(" ", "T");
  const offset = /([+-])(\d{2}):?(\d{2})$/.exec(isoLike);
  const normalized = /Z$/i.test(isoLike) ? isoLike : offset ? isoLike.replace(/([+-])(\d{2}):?(\d{2})$/, "$1$2:$3") : `${isoLike}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  const observedAt = date.toISOString();
  return { date: observedAt.slice(0, 10), observedAt };
}

function normalizeValues(payload) {
  if (!Array.isArray(payload?.values)) return [];
  const byTime = new Map();
  for (const item of payload.values) {
    const stamp = normalizeDatetime(item?.datetime);
    const close = Number(item?.close);
    if (!stamp || !Number.isFinite(close) || close <= 0) continue;
    const key = stamp.observedAt ?? stamp.date;
    // Daily series repeat a date when the exchange clock changes; the first (newest) row wins.
    if (byTime.has(key)) continue;
    const rate = toPlainDecimal(String(item.close));
    byTime.set(key, stamp.observedAt ? { date: stamp.date, observedAt: stamp.observedAt, rate } : { date: stamp.date, rate });
  }
  return [...byTime].sort(([left], [right]) => left.localeCompare(right)).map(([, observation]) => observation);
}

function failureReasonFor(code, message = "") {
  if (code === 429) return /\bday\b|daily/i.test(message) && !/minute/i.test(message) ? "quota-exhausted" : "rate-limited";
  if (code === 401) return "unauthorized";
  if (code === 400 || code === 403 || code === 404) return "unsupported-symbol";
  return "provider-error";
}

export function createTwelveDataProvider({
  apiKey = process.env.TWELVE_DATA_API_KEY || process.env.TWELVEDATA_API_KEY || "",
  externalDisplayLicensed = process.env.TWELVEDATA_EXTERNAL_DISPLAY_LICENSE === "confirmed",
  creditsPerMinute = process.env.TWELVE_DATA_CREDITS_PER_MINUTE,
  creditsPerDay = process.env.TWELVE_DATA_CREDITS_PER_DAY,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const minuteLimit = positiveInteger(creditsPerMinute, DEFAULT_CREDITS_PER_MINUTE);
  const dayLimit = positiveInteger(creditsPerDay, DEFAULT_CREDITS_PER_DAY);
  const disabledReason = !apiKey ? "no-api-key" : !externalDisplayLicensed ? "display-license-unconfirmed" : null;
  const configured = disabledReason === null;

  const cache = new Map(); // "SYMBOL|range" -> { values, fetchedAt, expiresAt }
  const failures = new Map(); // "SYMBOL|range" -> { reason, until }
  const unsupported = new Map(); // "SYMBOL" -> time until which it is not asked for
  const inFlight = new Map(); // "SYMBOL|range" -> Promise of an outcome; never rejects
  const isolated = new Set(); // symbols sent alone after a batch was rejected as a whole
  const minuteCredits = []; // spend times inside the sliding minute
  let day = { key: "", used: 0 };
  let blocked = null; // { reason, until }: no upstream calls at all until then

  function creditsLeft(at) {
    while (minuteCredits.length && minuteCredits[0] <= at - CREDIT_WINDOW_MS) minuteCredits.shift();
    const dayKey = new Date(at).toISOString().slice(0, 10);
    if (day.key !== dayKey) day = { key: dayKey, used: 0 };
    return { minute: Math.max(0, minuteLimit - minuteCredits.length), day: Math.max(0, dayLimit - day.used) };
  }

  function spendCredits(count, at) {
    for (let index = 0; index < count; index += 1) minuteCredits.push(at);
    day.used += count;
  }

  // Used when a request never reached Twelve Data, so nothing was charged.
  function refundCredits(count, at) {
    let refunded = 0;
    for (let index = minuteCredits.length - 1; index >= 0 && refunded < count; index -= 1) {
      if (minuteCredits[index] !== at) continue;
      minuteCredits.splice(index, 1);
      refunded += 1;
    }
    day.used = Math.max(0, day.used - refunded);
  }

  function block(reason, at) {
    const until = reason === "quota-exhausted"
      ? (Math.floor(at / DAY_MS) + 1) * DAY_MS // the daily quota returns at midnight UTC
      : reason === "unauthorized"
        ? at + 30 * 60_000
        : (Math.floor(at / CREDIT_WINDOW_MS) + 1) * CREDIT_WINDOW_MS + 1_000; // the minute quota returns on the clock minute
    if (!blocked || blocked.until < until) blocked = { reason, until };
  }

  function remember(map, key, value) {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
  }

  // One HTTP request. Resolves to a Map of symbol -> observations or failure; rejects with a
  // failure that applies to every symbol in the request.
  async function requestSeries(symbols, range) {
    const options = RANGE_OPTIONS[range];
    const url = new URL(`${API_ROOT}/time_series`);
    url.searchParams.set("symbol", symbols.join(","));
    url.searchParams.set("interval", options.interval);
    url.searchParams.set("outputsize", String(options.outputsize));
    url.searchParams.set("timezone", "UTC");
    let response;
    try {
      // The key travels in a header so that it never appears in a URL or a log line.
      response = await fetchImpl(url, {
        headers: { accept: "application/json", authorization: `apikey ${apiKey}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw failure(error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "provider-error", { unsent: true });
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw failure("provider-error");
    }

    const batched = symbols.length > 1;
    const wholeError = !response.ok || payload?.status === "error" || typeof payload?.code === "number";
    if (wholeError) {
      const reason = failureReasonFor(Number(payload?.code) || response.status, payload?.message);
      // A batch refused because of one symbol says nothing about the others.
      throw reason === "unsupported-symbol" && batched ? failure("provider-error", { batchRejected: true, retryAfterMs: 1_500 }) : failure(reason);
    }

    const results = new Map();
    for (const symbol of symbols) {
      const series = batched
        ? payload?.[symbol] ?? Object.entries(payload ?? {}).find(([key]) => key.toUpperCase() === symbol)?.[1]
        : payload;
      if (series?.status === "error" || typeof series?.code === "number") {
        results.set(symbol, failure(failureReasonFor(Number(series.code), series.message)));
        continue;
      }
      const values = normalizeValues(series);
      results.set(symbol, values.length ? values : failure("provider-error"));
    }
    return results;
  }

  // Starts one request for a group of symbols and registers a per-symbol outcome for it.
  function launch(group, range, at, pending) {
    const request = requestSeries(group, range).then(
      (results) => ({ results }),
      (groupFailure) => {
        if (groupFailure.unsent) refundCredits(group.length, at);
        if (groupFailure.batchRejected) for (const symbol of group) isolated.add(symbol);
        return { groupFailure: groupFailure.reason ? groupFailure : failure("provider-error") };
      },
    );
    for (const symbol of group) {
      const key = `${symbol}|${range}`;
      let outcome;
      outcome = request.then(({ results, groupFailure }) => {
        const result = groupFailure ?? results.get(symbol) ?? failure("provider-error");
        const settledAt = now();
        if (Array.isArray(result)) {
          remember(cache, key, { values: result, fetchedAt: settledAt, expiresAt: settledAt + CACHE_TTL_MS });
          failures.delete(key);
          return { values: result, fetchedAt: settledAt, status: "fresh" };
        }
        if (["rate-limited", "quota-exhausted", "unauthorized"].includes(result.reason)) {
          block(result.reason, settledAt);
          return { failure: { ...result, retryAfterMs: blocked.until - settledAt } };
        }
        if (result.reason === "unsupported-symbol") remember(unsupported, symbol, settledAt + UNSUPPORTED_TTL_MS);
        else if (FAILURE_TTL_MS[result.reason] && !result.batchRejected) remember(failures, key, { reason: result.reason, until: settledAt + FAILURE_TTL_MS[result.reason] });
        return { failure: result };
      }).finally(() => {
        if (inFlight.get(key) === outcome) inFlight.delete(key);
      });
      inFlight.set(key, outcome);
      pending.set(symbol, outcome);
    }
  }

  function providerSymbol(base, quote) {
    if (METAL_CODES.has(base) && quote === "USD") return { symbol: `${base}/USD`, invert: false };
    if (base === "USD" && METAL_CODES.has(quote)) return { symbol: `${quote}/USD`, invert: true };
    return { symbol: `${base}/${quote}`, invert: false };
  }

  function inDirection(observations, invert) {
    if (!invert) return observations;
    return observations.flatMap((observation) => {
      const rate = decimalFromNumber(1 / Number(observation.rate));
      return rate ? [{ ...observation, rate }] : [];
    });
  }

  // Never rejects. For every requested pair `details` says what was returned:
  //   fresh | cached - observations inside the 5 minute cache window
  //   stale          - the last observations Twelve Data delivered, because a refresh failed
  //   missing        - nothing to show; `reason` says why
  // With `deadlineMs`, symbols still loading at the deadline are reported as "pending" while the
  // request carries on in the background and fills the cache for the next call.
  async function getHistories(pairs, range, { deadlineMs = null } = {}) {
    const requests = pairs.map(({ base, quote }) => ({ pair: `${base}/${quote}`, ...providerSymbol(base, quote) }));
    const rates = Object.fromEntries(requests.map(({ pair }) => [pair, []]));
    const details = {};
    const errors = [];
    const options = RANGE_OPTIONS[range];
    const at = now();
    const pending = new Map();

    if (!configured || !options) {
      const reason = configured ? "provider-error" : disabledReason;
      for (const { symbol } of requests) pending.set(symbol, Promise.resolve({ failure: failure(reason) }));
    } else {
      const wanted = [];
      for (const symbol of new Set(requests.map((request) => request.symbol))) {
        const key = `${symbol}|${range}`;
        const cached = cache.get(key);
        const failed = failures.get(key);
        if (!validSymbol(symbol) || unsupported.get(symbol) > at) pending.set(symbol, Promise.resolve({ failure: failure("unsupported-symbol") }));
        else if (cached && cached.expiresAt > at) pending.set(symbol, Promise.resolve({ values: cached.values, fetchedAt: cached.fetchedAt, status: "cached" }));
        else if (inFlight.has(key)) pending.set(symbol, inFlight.get(key));
        else if (blocked && blocked.until > at) pending.set(symbol, Promise.resolve({ failure: failure(blocked.reason, { retryAfterMs: blocked.until - at }) }));
        else if (failed && failed.until > at) pending.set(symbol, Promise.resolve({ failure: failure(failed.reason, { retryAfterMs: failed.until - at }) }));
        else wanted.push(symbol);
      }

      // Spend scarce credits on charts that have nothing to show before refreshing stale ones.
      wanted.sort((left, right) => Number(cache.has(`${left}|${range}`)) - Number(cache.has(`${right}|${range}`)));
      const credits = creditsLeft(at);
      const accepted = wanted.slice(0, Math.min(credits.minute, credits.day));
      spendCredits(accepted.length, at);
      for (const symbol of wanted.slice(accepted.length)) {
        // A credit comes back when the oldest one spent leaves the sliding minute.
        const deferred = credits.day <= credits.minute
          ? failure("quota-exhausted")
          : failure("rate-limited", { retryAfterMs: Math.max(1_000, (minuteCredits[0] ?? at) + CREDIT_WINDOW_MS - at) });
        pending.set(symbol, Promise.resolve({ failure: deferred }));
      }
      // Metals travel alone: on a plan without silver, a shared request could take gold down too.
      const batch = accepted.filter((symbol) => !isolated.has(symbol) && !METAL_CODES.has(symbol.slice(0, 3)));
      if (batch.length) launch(batch, range, at, pending);
      for (const symbol of accepted) if (!batch.includes(symbol)) launch([symbol], range, at, pending);
    }

    let timer;
    const deadline = deadlineMs === null ? null : new Promise((resolve) => {
      timer = setTimeout(() => resolve({ failure: failure("pending", { retryAfterMs: 1_500 }) }), deadlineMs);
    });
    const outcomes = new Map(await Promise.all([...pending].map(async ([symbol, outcome]) => [symbol, await (deadline ? Promise.race([outcome, deadline]) : outcome)])));
    clearTimeout(timer);

    for (const request of requests) {
      const outcome = outcomes.get(request.symbol);
      if (outcome.values) {
        rates[request.pair] = inDirection(outcome.values, request.invert);
        details[request.pair] = { status: outcome.status, fetchedAt: new Date(outcome.fetchedAt).toISOString(), reason: null, message: "", retryAfterMs: null };
        continue;
      }
      const { reason, message, retryAfterMs } = outcome.failure;
      const kept = options ? cache.get(`${request.symbol}|${range}`) : null;
      if (kept && at - kept.fetchedAt <= options.maxStaleMs) {
        rates[request.pair] = inDirection(kept.values, request.invert);
        details[request.pair] = { status: "stale", fetchedAt: new Date(kept.fetchedAt).toISOString(), reason, message, retryAfterMs };
      } else {
        details[request.pair] = { status: "missing", fetchedAt: null, reason, message, retryAfterMs };
        errors.push({ code: reason, symbol: request.symbol, pair: request.pair, message });
      }
    }
    return { rates, details, errors };
  }

  return {
    isConfigured: () => configured,
    configurationMessage: () => (configured ? "" : MESSAGES[disabledReason]),
    limits: () => ({ creditsPerMinute: minuteLimit, creditsPerDay: dayLimit }),
    // One of: no-api-key | display-license-unconfirmed | active | rate-limited | quota-exhausted | unauthorized
    status() {
      const at = now();
      if (!configured) return { configured, state: disabledReason, message: MESSAGES[disabledReason], retryAfterMs: null };
      if (blocked && blocked.until > at) return { configured, state: blocked.reason, message: MESSAGES[blocked.reason], retryAfterMs: blocked.until - at };
      return { configured, state: "active", message: "", retryAfterMs: null };
    },
    getHistories,
  };
}
