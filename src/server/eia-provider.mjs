// Daily crude oil spot prices from the U.S. Energy Information Administration (EIA).
//
// EIA publishes them about once a week, a few days in arrears, in US dollars per barrel. Two
// routes lead to the same series:
//   - the EIA API, when an API key is configured (free registration at eia.gov/opendata);
//   - otherwise EIA's public history pages, which need no key.
// Either way the result is kept for six hours, shared between callers, and the last series that
// did arrive is served, marked stale, while a refresh keeps failing.

export const EIA_SOURCE = "EIA";
export const OIL_SERIES = {
  WTI: { series: "RWTC", page: "RWTCD", name: "WTI crude oil (Cushing, Oklahoma)" },
  BRENT: { series: "RBRTE", page: "RBRTED", name: "Brent crude oil (Europe)" },
};

const API_ROOT = "https://api.eia.gov/v2/petroleum/pri/spt/data/";
const PAGE_ROOT = "https://www.eia.gov/dnav/pet/hist";
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const KEEP_MS = 14 * DAY_MS; // a failed refresh may fall back on a series this old
const HISTORY_DAYS = 400; // enough for the six month chart
const REQUEST_TIMEOUT_MS = 15_000;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const isoDay = (time) => new Date(time).toISOString().slice(0, 10);

// Reads a history page such as https://www.eia.gov/dnav/pet/hist/RWTCD.htm. Each table row is a
// week, labelled with its Monday ("2026 Sep-28 to Oct- 2"), followed by the Monday to Friday prices.
export function parseEiaHistoryPage(html) {
  const observations = [];
  const weekRow = /<td[^>]*class=['"]B6['"][^>]*>([\s\S]*?)<\/td>((?:\s*<td[^>]*class=['"]B3['"][^>]*>[\s\S]*?<\/td>){5})/g;
  for (const [, label, cells] of String(html).matchAll(weekRow)) {
    const week = /(\d{4})\s+([A-Z][a-z]{2})-\s*(\d{1,2})\s+to/.exec(label.replace(/&nbsp;/g, " "));
    if (!week || !(week[2] in MONTHS)) continue;
    const monday = Date.UTC(Number(week[1]), MONTHS[week[2]], Number(week[3]));
    [...cells.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].forEach(([, cell], weekday) => {
      const text = cell.replace(/&nbsp;/g, " ").trim();
      if (/^\d+(?:\.\d+)?$/.test(text) && Number(text) > 0) observations.push({ date: isoDay(monday + weekday * DAY_MS), rate: text });
    });
  }
  return observations.sort((left, right) => left.date.localeCompare(right.date));
}

export function createEiaSpotPrices({ apiKey = "", fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const cache = new Map(); // "WTI" -> { observations, fetchedAt }
  const loads = new Map(); // "WTI" -> the request that is refreshing it

  async function request(url, headers = {}) {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`EIA returned HTTP ${response.status}`);
    return response;
  }

  // One API request covers every code. The key travels in a header, never in the URL.
  async function loadFromApi(codes, since) {
    const url = new URL(API_ROOT);
    url.searchParams.set("frequency", "daily");
    url.searchParams.set("data[0]", "value");
    for (const code of codes) url.searchParams.append("facets[series][]", OIL_SERIES[code].series);
    url.searchParams.set("start", since);
    url.searchParams.set("sort[0][column]", "period");
    url.searchParams.set("sort[0][direction]", "asc");
    url.searchParams.set("length", "5000");
    const body = await (await request(url, { accept: "application/json", "x-api-key": apiKey })).json();
    if (!Array.isArray(body?.response?.data)) throw new Error("EIA returned an unexpected response.");
    const bySeries = new Map(codes.map((code) => [OIL_SERIES[code].series, []]));
    for (const row of body.response.data) {
      const value = Number(row?.value);
      if (!bySeries.has(row?.series) || !/^\d{4}-\d{2}-\d{2}$/.test(row?.period) || !Number.isFinite(value) || value <= 0) continue;
      bySeries.get(row.series).push({ date: row.period, rate: String(row.value) });
    }
    return new Map(codes.map((code) => [code, bySeries.get(OIL_SERIES[code].series)]));
  }

  async function loadFromPages(codes, since) {
    const results = await Promise.allSettled(codes.map(async (code) => {
      const page = await (await request(`${PAGE_ROOT}/${OIL_SERIES[code].page}.htm`, { accept: "text/html" })).text();
      return parseEiaHistoryPage(page).filter((observation) => observation.date >= since);
    }));
    return new Map(codes.map((code, index) => [code, results[index].status === "fulfilled" ? results[index].value : []]));
  }

  function refresh(codes) {
    const at = now();
    const since = isoDay(at - HISTORY_DAYS * DAY_MS);
    const batch = (apiKey ? loadFromApi(codes, since) : loadFromPages(codes, since)).then(
      (loaded) => {
        for (const [code, observations] of loaded) {
          if (observations.length) cache.set(code, { observations, fetchedAt: at });
        }
      },
      () => {
        // The last series that did arrive stays in place.
      },
    );
    for (const code of codes) {
      let load;
      load = batch.finally(() => {
        if (loads.get(code) === load) loads.delete(code);
      });
      loads.set(code, load);
    }
  }

  return {
    usesApiKey: () => Boolean(apiKey),
    // Never rejects. Resolves to { CODE: { observations, stale, fetchedAt } }; a code with no
    // usable series is left out. `stale` means the latest refresh failed and this is an older copy.
    async getSeries(codes) {
      const known = [...new Set(codes)].filter((code) => Object.hasOwn(OIL_SERIES, code));
      const at = now();
      const due = known.filter((code) => !(cache.has(code) && at - cache.get(code).fetchedAt < CACHE_TTL_MS) && !loads.has(code));
      if (due.length) refresh(due);
      await Promise.all(known.map((code) => loads.get(code)));
      const series = {};
      for (const code of known) {
        const entry = cache.get(code);
        if (!entry || at - entry.fetchedAt > KEEP_MS) continue;
        series[code] = { observations: entry.observations, stale: at - entry.fetchedAt >= CACHE_TTL_MS, fetchedAt: new Date(entry.fetchedAt).toISOString() };
      }
      return series;
    },
  };
}
