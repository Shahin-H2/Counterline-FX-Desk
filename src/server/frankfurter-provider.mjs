export const FRANKFURTER_SOURCE = "Frankfurter daily blended reference rates";
export const FRANKFURTER_API = "https://api.frankfurter.dev/v2";

function validatePair(pair) {
  const base = String(pair.base ?? "").toUpperCase();
  const quote = String(pair.quote ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote) || base === quote) return null;
  return { base, quote };
}

export async function fetchFrankfurterRates(pairs, {
  fetchImpl = globalThis.fetch,
  apiBase = FRANKFURTER_API,
  now = () => new Date(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable in this runtime.");
  const normalizedPairs = pairs.map(validatePair).filter(Boolean);
  const groups = new Map();
  for (const pair of normalizedPairs) {
    if (!groups.has(pair.base)) groups.set(pair.base, new Set());
    groups.get(pair.base).add(pair.quote);
  }

  const rates = {};
  const errors = [];
  await Promise.all([...groups].map(async ([base, quotes]) => {
    const url = new URL(`${apiBase}/rates`);
    url.searchParams.set("base", base);
    url.searchParams.set("quotes", [...quotes].sort().join(","));
    try {
      const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
      const records = await response.json();
      if (!Array.isArray(records)) throw new Error("Provider returned an unexpected response.");
      for (const record of records) {
        const recordBase = String(record.base ?? "").toUpperCase();
        const quote = String(record.quote ?? "").toUpperCase();
        const rate = Number(record.rate);
        if (recordBase !== base || !quotes.has(quote) || !Number.isFinite(rate) || rate <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) continue;
        rates[`${base}/${quote}`] = { base, quote, rate: String(record.rate), date: record.date };
      }
    } catch {
      errors.push({ base, message: "Reference provider unavailable for this base currency." });
    }
  }));

  return { source: FRANKFURTER_SOURCE, retrievedAt: now().toISOString(), rates, errors };
}

export async function fetchFrankfurterHistory(pairs, { from, to, fetchImpl = globalThis.fetch, apiBase = FRANKFURTER_API } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable in this runtime.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(to))) {
    throw new Error("A valid historical date range is required.");
  }
  const normalizedPairs = pairs.map(validatePair).filter(Boolean);
  const groups = new Map();
  const rates = {};
  for (const pair of normalizedPairs) {
    const key = `${pair.base}/${pair.quote}`;
    rates[key] = [];
    if (!groups.has(pair.base)) groups.set(pair.base, new Set());
    groups.get(pair.base).add(pair.quote);
  }

  const errors = [];
  const mergeRecords = (base, quotes, records) => {
    for (const record of records) {
      const recordBase = String(record.base ?? "").toUpperCase();
      const quote = String(record.quote ?? "").toUpperCase();
      const rate = Number(record.rate);
      if (recordBase !== base || !quotes.has(quote) || !Number.isFinite(rate) || rate <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(record.date) || record.date < from || record.date > to) continue;
      rates[`${base}/${quote}`].push({ date: record.date, rate: String(record.rate) });
    }
  };
  await Promise.all([...groups].map(async ([base, quotes]) => {
    const url = new URL(`${apiBase}/rates`);
    url.searchParams.set("base", base);
    url.searchParams.set("quotes", [...quotes].sort().join(","));
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    try {
      const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
      const records = await response.json();
      if (!Array.isArray(records)) throw new Error("Provider returned an unexpected response.");
      mergeRecords(base, quotes, records);
    } catch {
      const recovered = await Promise.all([...quotes].map(async (quote) => {
        const fallbackUrl = new URL(`${apiBase}/rates`);
        fallbackUrl.searchParams.set("base", base);
        fallbackUrl.searchParams.set("quotes", quote);
        fallbackUrl.searchParams.set("from", from);
        fallbackUrl.searchParams.set("to", to);
        try {
          const response = await fetchImpl(fallbackUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12000) });
          if (!response.ok) return false;
          const records = await response.json();
          if (!Array.isArray(records)) return false;
          mergeRecords(base, new Set([quote]), records);
          return true;
        } catch {
          return false;
        }
      }));
      if (!recovered.some(Boolean)) errors.push({ base, message: "Historical reference data unavailable for this base currency." });
    }
    for (const quote of quotes) rates[`${base}/${quote}`].sort((left, right) => left.date.localeCompare(right.date));
  }));

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
