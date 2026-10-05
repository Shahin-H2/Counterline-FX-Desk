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

