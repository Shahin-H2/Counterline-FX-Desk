// Copyright (c) 2026 Shahin Hassanyan. All rights reserved.
//
// Frankfurter API client (api.frankfurter.dev): latest and historical reference rates and the
// currency list, returned as exact decimal strings in the requested pair direction.

import { decimalFromNumber, toPlainDecimal } from "../domain/decimal.js";

export const FRANKFURTER_SOURCE = "Frankfurter daily blended reference rates";
export const FRANKFURTER_API = "https://api.frankfurter.dev/v2";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PRECIOUS_METALS = new Set(["XAU", "XAG", "XPT", "XPD"]);
// Frankfurter rounds every rate to a band set by its size, so a small rate keeps only one to
// three significant digits: USD to XAU arrives as 0.00024 and IRR to USD as 0.000001. Below this
// value the opposite direction is requested and inverted here instead.
const LOW_PRECISION_BELOW = 0.01;

function validatePair(pair) {
  const base = String(pair.base ?? "").toUpperCase();
  const quote = String(pair.quote ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote) || base === quote) return null;
  return { base, quote };
}

// One entry per requested pair. A pair quoted in a metal is always fetched metal-first.
function planRequests(pairs) {
  const entries = new Map();
  for (const candidate of pairs) {
    const pair = validatePair(candidate);
    if (!pair) continue;
    const key = `${pair.base}/${pair.quote}`;
    if (entries.has(key)) continue;
    entries.set(key, { ...pair, key, inverse: PRECIOUS_METALS.has(pair.quote) && !PRECIOUS_METALS.has(pair.base) });
  }
  return [...entries.values()];
}

function groupByFetchBase(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const fetchBase = entry.inverse ? entry.quote : entry.base;
    const fetchQuote = entry.inverse ? entry.base : entry.quote;
    if (!groups.has(fetchBase)) groups.set(fetchBase, new Map());
    const byQuote = groups.get(fetchBase);
    if (!byQuote.has(fetchQuote)) byQuote.set(fetchQuote, []);
    byQuote.get(fetchQuote).push(entry);
  }
  return groups;
}

async function requestRecords({ fetchImpl, apiBase, base, quotes, from, to }) {
  const url = new URL(`${apiBase}/rates`);
  url.searchParams.set("base", base);
  url.searchParams.set("quotes", [...quotes].sort().join(","));
  if (from) url.searchParams.set("from", from);
  if (to) url.searchParams.set("to", to);
  const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
  const records = await response.json();
  if (!Array.isArray(records)) throw new Error("Provider returned an unexpected response.");
  return records;
}

// Fetches every entry, one request per base. Returns the observations per requested pair in
// date order, already turned back into the requested direction, and the bases that failed.
async function loadObservations(entries, { fetchImpl, apiBase, from, to, recoverPerQuote = false }) {
  const observations = new Map(entries.map((entry) => [entry.key, []]));
  const failedBases = [];
  const accept = (fetchBase, byQuote, records) => {
    for (const record of records) {
      const recordBase = String(record.base ?? "").toUpperCase();
      const quote = String(record.quote ?? "").toUpperCase();
      const rate = Number(record.rate);
      if (recordBase !== fetchBase || !byQuote.has(quote) || !Number.isFinite(rate) || rate <= 0 || !DATE_PATTERN.test(record.date)) continue;
      if (from && (record.date < from || record.date > to)) continue;
      for (const entry of byQuote.get(quote)) {
        const text = entry.inverse ? decimalFromNumber(1 / rate) : toPlainDecimal(String(record.rate));
        if (text) observations.get(entry.key).push({ date: record.date, rate: text });
      }
    }
  };

  await Promise.all([...groupByFetchBase(entries)].map(async ([fetchBase, byQuote]) => {
    try {
      accept(fetchBase, byQuote, await requestRecords({ fetchImpl, apiBase, base: fetchBase, quotes: byQuote.keys(), from, to }));
    } catch {
      // One unknown quote makes Frankfurter reject the whole base, so retry the quotes one by one.
      const recovered = recoverPerQuote && (await Promise.all([...byQuote].map(async ([quote, quoteEntries]) => {
        try {
          accept(fetchBase, new Map([[quote, quoteEntries]]), await requestRecords({ fetchImpl, apiBase, base: fetchBase, quotes: [quote], from, to }));
          return true;
        } catch {
          return false;
        }
      }))).some(Boolean);
      if (!recovered) failedBases.push(fetchBase);
    }
  }));

  for (const list of observations.values()) list.sort((left, right) => left.date.localeCompare(right.date));
  return { observations, failedBases };
}

// Second pass for directions whose rate came back too small to carry enough digits.
async function loadPreciseObservations(entries, options) {
  const result = await loadObservations(entries, options);
  const coarse = entries.filter((entry) => !entry.inverse && Number(result.observations.get(entry.key).at(-1)?.rate) < LOW_PRECISION_BELOW);
  if (coarse.length) {
    const inverted = await loadObservations(coarse.map((entry) => ({ ...entry, inverse: true })), options);
    for (const entry of coarse) {
      const precise = inverted.observations.get(entry.key);
      if (precise.length) result.observations.set(entry.key, precise);
    }
  }
  return result;
}

export async function fetchFrankfurterRates(pairs, {
  fetchImpl = globalThis.fetch,
  apiBase = FRANKFURTER_API,
  now = () => new Date(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable in this runtime.");
  const entries = planRequests(pairs);
  const { observations, failedBases } = await loadPreciseObservations(entries, { fetchImpl, apiBase, recoverPerQuote: true });
  const rates = {};
  for (const { key, base, quote } of entries) {
    const latest = observations.get(key).at(-1);
    if (latest) rates[key] = { base, quote, rate: latest.rate, date: latest.date };
  }
  const errors = failedBases.map((base) => ({ base, message: "Reference provider unavailable for this base currency." }));
  return { source: FRANKFURTER_SOURCE, retrievedAt: now().toISOString(), rates, errors };
}

export async function fetchFrankfurterHistory(pairs, { from, to, fetchImpl = globalThis.fetch, apiBase = FRANKFURTER_API } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable in this runtime.");
  if (!DATE_PATTERN.test(String(from)) || !DATE_PATTERN.test(String(to))) {
    throw new Error("A valid historical date range is required.");
  }
  const entries = planRequests(pairs);
  const { observations, failedBases } = await loadPreciseObservations(entries, { fetchImpl, apiBase, from, to, recoverPerQuote: true });
  const rates = Object.fromEntries(entries.map(({ key }) => [key, observations.get(key)]));
  const errors = failedBases.map((base) => ({ base, message: "Historical reference data unavailable for this base currency." }));
  return { source: FRANKFURTER_SOURCE, from, to, rates, errors };
}

export async function fetchFrankfurterCurrencies({ fetchImpl = globalThis.fetch, apiBase = FRANKFURTER_API } = {}) {
  const response = await fetchImpl(`${apiBase}/currencies`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
  const currencies = await response.json();
  if (!Array.isArray(currencies)) throw new Error("Provider returned an unexpected currency list.");
  return currencies
    .filter((currency) => /^[A-Z]{3}$/.test(currency.iso_code) && typeof currency.name === "string")
    .map(({ iso_code, name, symbol }) => ({ code: iso_code, name, symbol: symbol ?? null }))
    .sort((left, right) => left.code.localeCompare(right.code));
}
