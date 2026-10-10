// Copyright 2024 Counterline, Inc. All rights reserved.
import {
  compareDecimals,
  formatDecimal,
  isPositiveDecimal,
  multiplyAndRound,
  parseDecimal,
} from "./domain/decimal.js";
import { isObservationStale } from "./domain/freshness.js";

// Storage keys
const STORAGE_KEY = "counterline-fx-prices-v1";
const REFERENCE_CACHE_KEY = "counterline-fx-reference-cache-v1";
const CURRENCY_CACHE_KEY = "counterline-fx-currencies-v1";
const VIEW_STORAGE_KEY = "counterline-fx-view-v1";
const DEFAULT_VIEW = {
  filter: "all",
  sort: "board",
  density: "comfortable",
  theme: "evergreen",
};
const DEFAULT_PAIRS = [
  "USD/EUR",
  "USD/CAD",
  "USD/MXN",
  "USD/GBP",
  "USD/TRY",
  "USD/INR",
  "USD/JPY",
  "USD/CHF",
];
const METAL_ASSETS = [
  { code: "XAU", name: "Gold (troy ounce)", symbol: "Au" },
  { code: "XAG", name: "Silver (troy ounce)", symbol: "Ag" },
]; // These are the only two metals supported for reference rates, and they must be paired with USD.
const METAL_CODES = new Set(METAL_ASSETS.map(({ code }) => code));
const MAX_BOARD_PAIRS = 30;
const MANUAL_RATE_PATTERN = /^\d+(?:\.\d{1,8})?$/;
const locale = navigator.language || "en-US";

// DOM elements
const elements = {
  ratesBody: document.querySelector("#rates-body"), // tbody for the main rate board
  pairTotal: document.querySelector("#pair-total"), // total count of pairs on the board
  navPairCount: document.querySelector("#nav-pair-count"), // total count of pairs in the navigation bar
  feedPill: document.querySelector("#feed-pill"), // the status indicator in the navigation bar
  rateDate: document.querySelector("#rate-date"), // the date of the most recent reference observation
  checkedAt: document.querySelector("#checked-at"), // the time the reference feed was last checked
  feedAlert: document.querySelector("#feed-alert"), // the alert box for feed issues
  sidebarFeedStatus: document.querySelector("#sidebar-feed-status"), // the text in the sidebar showing the feed status
  refreshButton: document.querySelector("#refresh-button"), // the button to refresh the reference feed
  searchInput: document.querySelector("#search-input"), // the input for searching pairs
  emptySearch: document.querySelector("#empty-search"), // the empty state message when no pairs match the search/filter
  optionsToggle: document.querySelector("#display-options-toggle"), // the button to toggle the display options panel
  displayOptions: document.querySelector("#display-options"), // the panel containing display options
  pairFilter: document.querySelector("#pair-filter"), // the select input for filtering pairs
  pairSort: document.querySelector("#pair-sort"), // the select input for sorting pairs
  boardDensity: document.querySelector("#board-density"), // the select input for changing the density of the board
  boardTheme: document.querySelector("#board-theme"), // the select input for changing the theme of the board
  themeToggle: document.querySelector("#theme-toggle"),
  themeToggleLabel: document.querySelector("#theme-toggle-label"),
  resetDisplayOptions: document.querySelector("#reset-display-options"), // the button to reset display options to default
  pairDialog: document.querySelector("#pair-dialog"), // the dialog for adding a new pair
  pairForm: document.querySelector("#pair-form"), // the form inside the pair dialog
  pairBase: document.querySelector("#pair-base"), // the input for the base currency in the pair dialog
  pairQuote: document.querySelector("#pair-quote"), // the input for the quote currency in the pair dialog
  pairPreview: document.querySelector("#pair-preview"), // the preview of the pair in the pair dialog
  priceDialog: document.querySelector("#price-dialog"), // the dialog for setting prices
  priceForm: document.querySelector("#price-form"), // the form inside the price dialog
  pricePairId: document.querySelector("#price-pair-id"), // the hidden input for the pair ID in the price dialog
  priceDialogTitle: document.querySelector("#price-dialog-title"), // the title of the price dialog
  priceDialogDescription: document.querySelector("#price-dialog-description"), // the description of the price dialog
  priceBuy: document.querySelector("#price-buy"), // the input for the buy price in the price dialog
  priceSell: document.querySelector("#price-sell"), // the input for the sell price in the price dialog
  priceReferenceRate: document.querySelector("#price-reference-rate"), // the element showing the reference rate in the price dialog
  priceReferenceDate: document.querySelector("#price-reference-date"), // the element showing the reference date in the price dialog
  priceValidation: document.querySelector("#price-validation"), // the element showing validation messages in the price dialog
  calculatorBase: document.querySelector("#calculator-base"), // the select input for the base currency in the calculator
  calculatorQuote: document.querySelector("#calculator-quote"), // the select input for the quote currency in the calculator
  swapCurrencies: document.querySelector("#swap-currencies"), // the button to swap the base and quote currencies in the calculator
  calculatorBaseCode: document.querySelector("#calculator-base-code"), // the element showing the base currency code in the calculator
  calculatorAmount: document.querySelector("#calculator-amount"), // the input for the amount in the calculator
  calculatorReferenceResult: document.querySelector(
    "#calculator-reference-result",
  ), // the element showing the reference result in the calculator
  calculatorReferenceMeta: document.querySelector("#calculator-reference-meta"), // the element showing the reference meta information in the calculator
  calculatorBuyResult: document.querySelector("#calculator-buy-result"), // the element showing the buy result in the calculator
  calculatorSellResult: document.querySelector("#calculator-sell-result"), // the element showing the sell result in the calculator
  calculatorAddPair: document.querySelector("#calculator-add-pair"), // the button to add the calculator pair to the board
  historyGrid: document.querySelector("#history-grid"), // the container for the history charts
  historyStatus: document.querySelector("#history-status"), // the element showing the status of the history loading
  historyRanges: document.querySelector(".history-controls"), // the container for the history range buttons
  marketHistoryGrid: document.querySelector("#market-history-grid"),
  marketHistoryStatus: document.querySelector("#market-history-status"),
  marketHistoryRanges: document.querySelector(".market-history-controls"),
  marketStatus: document.querySelector("#markets-status"),
  announcements: document.querySelector("#announcements"), // the live region for announcing changes to screen readers
};

// Utility functions
function readJson(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

// Validate that a pair ID is in the correct format (e.g., "USD/EUR") and that the base and quote currencies are not the same.
function validPairId(value) {
  return (
    typeof value === "string" &&
    /^[A-Z]{3}\/[A-Z]{3}$/.test(value) &&
    value.slice(0, 3) !== value.slice(4)
  );
}

// Load settings from localStorage, ensuring that the pairs and prices are valid and within the allowed limits.
function loadSettings() {
  const saved = readJson(STORAGE_KEY, null);
  if (!saved || typeof saved !== "object")
    return { pairs: [...DEFAULT_PAIRS], prices: {} };
  const pairs = Array.isArray(saved.pairs)
    ? [...new Set(saved.pairs.filter(validPairId))].slice(0, MAX_BOARD_PAIRS)
    : [...DEFAULT_PAIRS];
  const prices = {};
  if (saved.prices && typeof saved.prices === "object") {
    for (const [id, value] of Object.entries(saved.prices)) {
      if (!validPairId(id) || !value || typeof value !== "object") continue;
      const buy =
        value.buy === "" || value.buy == null ? "" : String(value.buy);
      const sell =
        value.sell === "" || value.sell == null ? "" : String(value.sell);
      if (
        (buy === "" ||
          (MANUAL_RATE_PATTERN.test(buy) &&
            isPositiveDecimal(buy, { maxScale: 8 }))) &&
        (sell === "" ||
          (MANUAL_RATE_PATTERN.test(sell) &&
            isPositiveDecimal(sell, { maxScale: 8 }))) &&
        (buy || sell)
      )
        prices[id] = { buy, sell };
    }
  }
  return { pairs, prices };
}

// Initialize application state
const settings = loadSettings();
const savedView = readJson(VIEW_STORAGE_KEY, {}) ?? {};
const view = {
  filter: ["all", "needs-prices", "priced", "reference-issues"].includes(
    savedView.filter,
  )
    ? savedView.filter
    : DEFAULT_VIEW.filter,
  sort: ["board", "code", "name", "rate-high", "rate-low"].includes(
    savedView.sort,
  )
    ? savedView.sort
    : DEFAULT_VIEW.sort,
  density: ["comfortable", "compact"].includes(savedView.density)
    ? savedView.density
    : DEFAULT_VIEW.density,
  theme: ["evergreen", "night"].includes(savedView.theme)
    ? savedView.theme
    : DEFAULT_VIEW.theme,
}; // The view settings control how the board is displayed, including filtering, sorting, density, and theme.
let referenceRates = {};
let referenceMeta = {
  cacheStatus: "loading",
  errors: [],
  retrievedAt: null,
  checkedAt: null,
};
let currencies = [];
let searchTerm = "";
let hasAnimatedRows = false;
const calculatorLookupState = new Map();
let previousCalculatorSelection = { base: "USD", quote: "EUR" };
let historyRange = "1m";
let pairHistory = {};
let historyRequestId = 0;
let historyLoading = false;
let historyUnavailableReason = "";
let marketHistoryRange = "1m";
let marketHistory = {};
let marketHistoryRequestId = 0;
let marketHistoryLoading = false;
let marketHistoryUnavailableReason = "No metals history source is configured.";
const MARKET_HISTORY_ASSETS = [
  { code: "XAU", name: "Gold", detail: "USD per troy ounce" },
  { code: "XAG", name: "Silver", detail: "USD per troy ounce" },
];
const MARKET_CODES = ["XAU", "XAG"];

// Helper functions
function pairParts(id) {
  const [base, quote] = id.split("/");
  return { base, quote };
}

// Get the full name of a currency given its code, or return the code if not found.
function currencyName(code) {
  return currencies.find((currency) => currency.code === code)?.name ?? code;
}

function currencyMark(code) {
  return (
    METAL_ASSETS.find((asset) => asset.code === code)?.symbol ??
    code.slice(0, 2)
  );
}

// Check if either the base or quote currency is a metal (gold or silver).
function isMetalPair(base, quote) {
  return METAL_CODES.has(base) || METAL_CODES.has(quote);
}

// Check if a currency pair is supported for reference rates. Gold and silver pairs must be paired with USD.
function isSupportedPair(base, quote) {
  if (!isMetalPair(base, quote)) return true;
  return (
    (METAL_CODES.has(base) && quote === "USD") ||
    (base === "USD" && METAL_CODES.has(quote))
  );
}

// Return a human-readable description of the unit for a metal pair, or a generic message if not applicable.
function metalPairUnit(base, quote) {
  if (base === "USD" && quote === "XAU") return "Troy ounces of gold per USD";
  if (base === "USD" && quote === "XAG") return "Troy ounces of silver per USD";
  if (base === "XAU" && quote === "USD") return "USD per troy ounce of gold";
  if (base === "XAG" && quote === "USD") return "USD per troy ounce of silver";
  return "Gold and silver pairs use USD";
}

// Ensure that the list of currencies includes USD, IRR, and the supported metal assets (XAU and XAG).
function ensureSpecialAssets(list) {
  const next = list.filter((currency) => !METAL_CODES.has(currency.code));
  if (!next.some((currency) => currency.code === "USD"))
    next.push({ code: "USD", name: "US Dollar", symbol: "$" });
  if (!next.some((currency) => currency.code === "IRR"))
    next.push({ code: "IRR", name: "Iranian Rial", symbol: "﷼" });
  for (const asset of METAL_ASSETS) {
    if (!next.some((currency) => currency.code === asset.code))
      next.push(asset);
  }
  return next;
}

// Escape HTML special characters in a string to prevent XSS vulnerabilities when rendering user-provided content.
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}

// Format a date string (YYYY-MM-DD) into a human-readable format based on the user's locale and specified options.
function formatDate(
  dateString,
  options = {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  },
) {
  if (!dateString) return "Date unavailable";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateString)
    ? new Date(`${dateString}T00:00:00Z`)
    : new Date(dateString);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(locale, options).format(date);
}

function formatHistoryAxis(value, range) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return formatDate(value, { month: "short", day: "numeric", timeZone: "UTC" });
  }
  const options = range === "5min"
    ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
    : range === "24h"
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(locale, options).format(new Date(value));
}

function formatHistoryTooltip(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? formatDate(value, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    : new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

// Format the time when the reference feed was last checked, or return a default message if unavailable.
function formatCheckedAt(value) {
  if (!value || Number.isNaN(new Date(value).getTime()))
    return "Check time unavailable";
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

// Format the observed date and time of a reference rate, or fall back to the date if the observed time is unavailable.
function formatRateObservation(
  rate,
  dateOptions = { month: "short", day: "numeric", timeZone: "UTC" },
) {
  const options = {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
    ...dateOptions,
  };
  if (rate?.observedAt && !Number.isNaN(new Date(rate.observedAt).getTime())) {
    return new Intl.DateTimeFormat(locale, {
      ...options,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(rate.observedAt));
  }
  return formatDate(rate?.date, options);
}

// Format a currency pair rate to a string with a specified number of decimal places, ensuring that it is displayed in a user-friendly format.
function formatPairRate(rate) {
  return formatDecimal(rate, locale, 2, 8);
}

// Render the historical chart for a currency pair, including the line graph, area fill, grid lines, and data points. If no observations are available, display an appropriate message or loading state.
function historyChartMarkup(id, observations, cardIndex, options = {}) {
  const marketChart = options.kind === "market";
  const { base, quote } = marketChart ? { base: id, quote: "USD" } : pairParts(id);
  const asset = MARKET_HISTORY_ASSETS.find(({ code }) => code === id);
  const points = (Array.isArray(observations) ? observations : [])
    .filter((item) => {
      const date = item?.observedAt ?? item?.timestamp ?? item?.date;
      return item && date && !Number.isNaN(new Date(date).getTime()) && Number.isFinite(Number(item.rate ?? item.value)) && Number(item.rate ?? item.value) > 0;
    })
    .map((item) => ({
      date: item.observedAt ?? item.timestamp ?? item.date,
      rate: String(item.rate ?? item.value),
      value: Number(item.rate ?? item.value),
    }));
  const currencyLabel = marketChart ? `${id} · ${asset?.detail ?? "USD"}` : `${currencyName(base)} / ${currencyName(quote)}`;
  if (!points.length) {
    if (marketChart ? marketHistoryLoading : historyLoading) {
      return `<article class="history-card history-card-loading" role="listitem" aria-hidden="true"><div class="history-loading-line"></div><div class="history-loading-rate"></div><div class="history-loading-chart"></div></article>`;
    }
    const reason = options.unavailableReason || historyUnavailableReason || "The source may not publish on these dates or cover this currency.";
    const title = marketChart ? (asset?.name ?? id) : `${base} → ${quote}`;
    return `<article class="history-card history-card-empty" role="listitem"><div class="history-card-title"><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(currencyLabel)}</p></div></div><div class="history-empty-state"><span class="history-empty-icon" aria-hidden="true">⌁</span><strong>${marketChart ? "Price history unavailable" : "No history in this range"}</strong><span>${escapeHtml(reason)}</span></div></article>`;
  }
  // Calculate the dimensions and coordinates for the chart, including the min/max values, padding, and scaling for the SVG elements.
  const width = 680;
  const height = 190;
  const plot = { left: 64, right: 666, top: 16, bottom: 143 };
  const values = points.map((point) => point.value);
  const observedMin = Math.min(...values);
  const observedMax = Math.max(...values);
  const padding =
    observedMax === observedMin
      ? Math.max(Math.abs(observedMax) * 0.035, 0.00000001)
      : (observedMax - observedMin) * 0.12;
  const low = Math.max(0, observedMin - padding);
  const high = observedMax + padding;
  const span = high - low || 1;
  const coordinate = (point, index) => ({
    x:
      points.length === 1
        ? (plot.left + plot.right) / 2
        : plot.left + ((plot.right - plot.left) * index) / (points.length - 1),
    y: plot.bottom - ((point.value - low) / span) * (plot.bottom - plot.top),
  }); // Map each data point to its corresponding x and y coordinates within the SVG plot area.
  const coords = points.map(coordinate);
  const line = coords
    .map(
      (point, index) =>
        `${index ? "L" : "M"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
    )
    .join(" ");
  const area = `${line} L${coords.at(-1).x.toFixed(2)} ${plot.bottom} L${coords[0].x.toFixed(2)} ${plot.bottom} Z`;
  const gradientId = `history-area-${cardIndex}`;
  const yLabels = [high, (high + low) / 2, low];
  const grid = yLabels
    .map((value, index) => {
      const y = plot.top + ((plot.bottom - plot.top) * index) / 2;
      return `<g class="history-gridline"><line x1="${plot.left}" y1="${y.toFixed(2)}" x2="${plot.right}" y2="${y.toFixed(2)}"/><text x="${plot.left - 10}" y="${(y + 4).toFixed(2)}" text-anchor="end">${escapeHtml(formatPairRate(String(value)))}</text></g>`;
    })
    .join(""); // Render the horizontal grid lines and their corresponding labels for the min, mid, and max values of the chart.
  const dots = coords
    .map(
      (point, index) =>
        `<circle class="history-point" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="2.35"><title>${escapeHtml(formatHistoryTooltip(points[index].date))}: ${escapeHtml(formatPairRate(points[index].rate))} ${escapeHtml(quote)}</title></circle>`,
    )
    .join("");
  const range = marketChart ? marketHistoryRange : historyRange;
  const firstDate = formatHistoryAxis(points[0].date, range);
  const lastDate = formatHistoryAxis(points.at(-1).date, range);
  const latest = points.at(-1);
  const ariaLabel = marketChart
    ? `${asset?.name ?? id} USD reference price from ${formatHistoryTooltip(points[0].date)} to ${formatHistoryTooltip(latest.date)}`
    : `${base} to ${quote} reference rate from ${formatHistoryTooltip(points[0].date)} to ${formatHistoryTooltip(latest.date)}`;
  const title = marketChart ? (asset?.name ?? id) : `${base} <span aria-hidden="true">→</span> ${quote}`;
  const latestValue = marketChart
    ? new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(latest.rate))
    : formatPairRate(latest.rate);
  const latestPrefix = marketChart ? "USD price" : `1 ${escapeHtml(base)} <span aria-hidden="true">=</span>`;
  const latestMeta = marketChart ? `${escapeHtml(id)} · ${escapeHtml(formatHistoryTooltip(latest.date))}` : `${escapeHtml(quote)} · ${escapeHtml(formatHistoryTooltip(latest.date))}`;
  // Return the complete HTML markup for the history card, including the title, latest rate, chart, and footer with low/high values.
  return `<article class="history-card" role="listitem"> 
    <div class="history-card-title"><div><h3>${title}</h3><p>${escapeHtml(currencyLabel)}</p></div><span class="history-observation-count">${points.length} ${points.length === 1 ? "point" : "points"}</span></div>
    <div class="history-latest"><span>${latestPrefix}</span><strong>${escapeHtml(latestValue)}</strong><small>${latestMeta}</small></div>
    <svg class="history-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(ariaLabel)}">
      <defs><linearGradient id="${gradientId}" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="var(--chart-line)" stop-opacity=".2"/><stop offset="100%" stop-color="var(--chart-line)" stop-opacity="0"/></linearGradient></defs>
      ${grid}<path class="history-area" d="${area}" fill="url(#${gradientId})"/><path class="history-line" d="${line}"/>${dots}
      <text class="history-axis-label" x="${plot.left}" y="${height - 5}">${escapeHtml(firstDate)}</text><text class="history-axis-label" x="${plot.right}" y="${height - 5}" text-anchor="end">${escapeHtml(lastDate)}</text>
    </svg>
    <div class="history-card-footer"><span><i class="history-stat-dot history-stat-low"></i>Low <strong>${escapeHtml(formatPairRate(String(observedMin)))}</strong></span><span><i class="history-stat-dot"></i>High <strong>${escapeHtml(formatPairRate(String(observedMax)))}</strong></span></div>
  </article>`;
}

// Render the history grid with the current pair history data, showing loading states or empty messages as appropriate.
function renderPairHistory() {
  if (!elements.historyGrid) return;
  elements.historyGrid.setAttribute("aria-busy", String(historyLoading));
  elements.historyGrid.innerHTML = settings.pairs.length
    ? settings.pairs
        .map((id, index) => historyChartMarkup(id, pairHistory[id], index))
        .join("")
    : '<div class="history-board-empty" role="listitem"><strong>No currency pairs yet</strong><span>Add a pair to see its rate history here.</span></div>';
}

function renderMarketHistory() {
  if (!elements.marketHistoryGrid) return;
  elements.marketHistoryGrid.setAttribute("aria-busy", String(marketHistoryLoading));
  const metalCards = MARKET_HISTORY_ASSETS.map((asset, index) =>
    historyChartMarkup(asset.code, marketHistory[asset.code], index, {
      kind: "market",
      unavailableReason: marketHistoryUnavailableReason,
    }),
  );
  elements.marketHistoryGrid.innerHTML = metalCards.join("");
}

async function loadMarketHistory() {
  const requestId = ++marketHistoryRequestId;
  marketHistory = {};
  marketHistoryLoading = true;
  renderMarketHistory();
  elements.marketHistoryStatus.textContent = "Loading metal price history…";
  const assets = MARKET_HISTORY_ASSETS.map(({ code }) => code).join("|");
  try {
    const response = await fetch(
      `/api/market-history?assets=${encodeURIComponent(assets)}&range=${encodeURIComponent(marketHistoryRange)}`,
      { headers: { accept: "application/json" } },
    );
    if (!response.ok) throw new Error("Metal history unavailable");
    const body = await response.json();
    if (requestId !== marketHistoryRequestId) return;
    marketHistoryLoading = false;
    marketHistory = body.rates && typeof body.rates === "object" ? body.rates : {};
    marketHistoryUnavailableReason = Array.isArray(body.errors) && body.errors.length
      ? body.errors[0].message
      : "No observations were returned for this range.";
    const coverage = MARKET_HISTORY_ASSETS.filter(({ code }) => Array.isArray(marketHistory[code]) && marketHistory[code].length).length;
    elements.marketHistoryStatus.textContent = coverage
      ? `Metal reference history · ${coverage} of ${MARKET_HISTORY_ASSETS.length} series have observations · ${marketHistoryRange.toUpperCase()} view`
      : `${body.source ?? "Metals history"} · ${marketHistoryUnavailableReason}`;
    renderMarketHistory();
  } catch {
    if (requestId !== marketHistoryRequestId) return;
    marketHistoryLoading = false;
    marketHistory = {};
    marketHistoryUnavailableReason = "Metal history could not be loaded. Try selecting the range again.";
    elements.marketHistoryStatus.textContent = marketHistoryUnavailableReason;
    renderMarketHistory();
  }
}

function formatUsdMetalPrice(value) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value));
}

async function loadMarketQuotes() {
  try {
    const response = await fetch("/api/markets", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Market prices unavailable");
    const body = await response.json();
    const cards = new Map([...document.querySelectorAll("[data-market-code]")].map((card) => [card.dataset.marketCode, card]));
    const available = [];
    for (const code of MARKET_CODES) {
      const card = cards.get(code);
      if (!card) continue;
      const rate = body.rates?.[code];
      const value = card.querySelector("[data-market-value]");
      const change = card.querySelector(".market-change");
      const observation = card.querySelector(".market-observation");
      if (rate && Number.isFinite(Number(rate.rate))) {
        value.textContent = formatUsdMetalPrice(rate.rate);
        value.classList.remove("market-value-unavailable");
        change.textContent = "Spot reference";
        observation.textContent = rate.observedAt ? formatHistoryTooltip(rate.observedAt) : "Observation time unavailable";
        available.push(code);
      } else {
        value.textContent = "Access needed";
        value.classList.add("market-value-unavailable");
        change.textContent = "Feed required";
        observation.textContent = body.errors?.some((error) => error.code === "provider-not-configured")
          ? "Key and rights needed"
          : "No recent observation";
      }
    }
    const needsKey = body.errors?.some((error) => error.code === "provider-not-configured");
    elements.marketStatus.textContent = available.length
      ? `Twelve Data · ${available.length} of ${MARKET_CODES.length} spot prices available`
      : needsKey
        ? "Twelve Data access not configured"
        : "Twelve Data has no recent metal observations";
  } catch {
    elements.marketStatus.textContent = "Twelve Data metal prices could not be loaded";
  }
}

// Load the historical reference rates for the current pairs and range, updating the UI with loading states, errors, and the resulting data.
async function loadPairHistory() {
  const requestId = ++historyRequestId;
  if (!settings.pairs.length) {
    pairHistory = {};
    historyLoading = false;
    renderPairHistory();
    elements.historyStatus.textContent =
      "Add currency pairs to view daily history.";
    return;
  } // If there are no pairs on the board, clear the history and show a message indicating that pairs need to be added.
  pairHistory = {};
  historyUnavailableReason = "";
  historyLoading = true;
  renderPairHistory();
  elements.historyStatus.textContent = historyRange === "5min" || historyRange === "24h"
    ? "Checking intraday reference history…"
    : "Loading daily reference history…";
  const pairs = [...settings.pairs];
  const query = encodeURIComponent(
    pairs.map((id) => id.replace("/", ":")).join("|"),
  );
  try {
    const response = await fetch(
      `/api/history?pairs=${query}&range=${encodeURIComponent(historyRange)}`,
      { headers: { accept: "application/json" } },
    );
    if (!response.ok) throw new Error("Historical data unavailable");
    const body = await response.json();
    if (requestId !== historyRequestId) return;
    historyLoading = false;
    pairHistory =
      body.rates && typeof body.rates === "object" ? body.rates : {};
    const coveredPairs = pairs.filter(
      (id) => Array.isArray(pairHistory[id]) && pairHistory[id].length,
    ).length;
    const hasErrors = Array.isArray(body.errors) && body.errors.length > 0;
    historyUnavailableReason = hasErrors ? body.errors[0]?.message ?? "The selected data source has no observations at this resolution." : "The source has no observations for this pair in the selected range.";
    elements.historyStatus.textContent = hasErrors || coveredPairs < pairs.length
      ? `${historyRange === "5min" || historyRange === "24h" ? "Intraday" : "Daily"} history · ${coveredPairs} of ${pairs.length} pairs have observations. ${historyUnavailableReason}`
      : `${historyRange === "5min" || historyRange === "24h" ? "Intraday" : "Daily reference"} history · ${pairs.length} ${pairs.length === 1 ? "pair" : "pairs"} · ${historyRange.toUpperCase()} view`;
    renderPairHistory();
  } catch {
    if (requestId !== historyRequestId) return;
    historyLoading = false;
    pairHistory = {};
    elements.historyStatus.textContent =
      "Historical rates could not be loaded. Try selecting the range again.";
    renderPairHistory();
  }
}

// Determine the number of decimal places to display for a given currency code, using the Intl.NumberFormat API to get the maximum fraction digits for that currency. If the currency is a metal (gold or silver), return 8 decimal places. If the currency code is invalid or not supported, default to 2 decimal places.
function amountDigits(code) {
  if (METAL_CODES.has(code)) return 8;
  try {
    const digits = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
    }).resolvedOptions().maximumFractionDigits;
    return Number.isInteger(digits) && digits >= 0 && digits <= 8 ? digits : 2;
  } catch {
    return 2;
  }
}

// Save the current settings (pairs and prices) to localStorage, returning true if successful or false if an error occurs.
function saveSettings() {
  return writeJson(STORAGE_KEY, settings);
}

// Save the current reference cache to localStorage, returning true if successful or false if an error occurs.
function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// Announce a message to screen readers by clearing the live region and then setting the text content after a short delay, ensuring that the message is read aloud.
function announce(message) {
  elements.announcements.textContent = "";
  window.setTimeout(() => {
    elements.announcements.textContent = message;
  }, 30);
}

// Update the feed status pill in the navigation bar and sidebar with the given label and state, reflecting the current status of the reference feed.
function setFeedPill(label, state) {
  elements.feedPill.dataset.state = state;
  elements.feedPill.innerHTML = `<span class="status-dot"></span><span>${escapeHtml(label)}</span>`;
  elements.sidebarFeedStatus.textContent = label;
}

// Get the list of currency pairs that have stale reference observations, defined as being older than 3 calendar days from today.
function currentStalePairs() {
  const today = new Date();
  return settings.pairs.filter((id) => {
    const reference = referenceRates[id];
    return reference && isObservationStale(reference.date, today);
  });
}

// Update the feed status based on the current reference rates, cache status, and any errors or missing pairs. This function determines the appropriate label and state for the feed pill, updates the rate date and checked at information, and displays any relevant alerts to the user.
function updateFeedStatus() {
  const boardRates = settings.pairs
    .map((id) => referenceRates[id])
    .filter(Boolean);
  const ratesAvailable = boardRates.length > 0;
  const stalePairs = currentStalePairs();
  const missingPairs = settings.pairs.filter((id) => !referenceRates[id]);
  const hasErrors = referenceMeta.errors?.length > 0;
  const metalProviderNeeded = referenceMeta.errors?.some(
    (error) => error.code === "provider-not-configured",
  );
  let label = "Live lookup";
  let state = "fresh";

  // Determine the appropriate label and state for the feed pill based on the availability of rates, cache status, and any errors or missing pairs.
  if (!ratesAvailable) {
    label = metalProviderNeeded
      ? "Source needed"
      : referenceMeta.cacheStatus === "error" || hasErrors
        ? "Unavailable"
        : "Waiting";
    state = "error";
  } else if (referenceMeta.cacheStatus === "browser-cache-pending") {
    label = "Saved browser cache";
    state = "cached";
  } else if (referenceMeta.cacheStatus === "stale-cache") {
    label = "Cached after error";
    state = "cached";
  } else if (referenceMeta.cacheStatus === "error") {
    label = "Browser cache";
    state = "cached";
  } else if (stalePairs.length) {
    label = "Stale reference";
    state = "stale";
  } else if (
    hasErrors ||
    missingPairs.length ||
    referenceMeta.cacheStatus === "partial" ||
    referenceMeta.cacheStatus === "partial-cache"
  ) {
    label = "Partial coverage";
    state = "partial";
  } else if (referenceMeta.cacheStatus === "cached") {
    label = "Server cache";
    state = "fresh";
  }

  // Update the feed pill in the navigation bar and sidebar with the determined label and state.
  setFeedPill(label, state);
  if (!ratesAvailable) {
    elements.rateDate.textContent = "No reference data";
    elements.checkedAt.textContent = referenceMeta.checkedAt
      ? `Last checked ${formatCheckedAt(referenceMeta.checkedAt)}`
      : "Waiting for the first provider response";
  } else {
    // If rates are available, determine the latest observation date and update the rate date and checked at information accordingly.
    const dates = boardRates
      .map((rate) => rate.date)
      .filter(Boolean)
      .sort();
    const latestDate = dates.at(-1);
    elements.rateDate.textContent = latestDate
      ? formatDate(latestDate)
      : "Date unavailable";
    elements.checkedAt.textContent = `${referenceMeta.cacheStatus === "stale-cache" ? "Last successful fetch" : "Checked"} ${formatCheckedAt(referenceMeta.cacheStatus === "stale-cache" ? referenceMeta.retrievedAt : referenceMeta.checkedAt)} · pair dates shown below`;
  }

  // Determine the appropriate alert message and kind based on the current state of the reference rates, cache status, and any errors or missing pairs. This message will be displayed to the user in the feed alert area.
  let alertText = "";
  let alertKind = "warning";
  if (!ratesAvailable) {
    alertKind = "error";
    alertText = metalProviderNeeded
      ? "Gold and silver rows are ready, but no metals data source is configured yet. Their reference prices will stay blank until a provider is selected."
      : "Reference data is unavailable. Customer prices remain editable, but no reference values are being shown. Check the feed before relying on any rate.";
  } else if (referenceMeta.cacheStatus === "stale-cache") {
    alertText = `The reference provider could not be reached. Showing the last successful server cache from ${formatCheckedAt(referenceMeta.retrievedAt)}; each observation date remains attached to its pair.`;
  } else if (referenceMeta.cacheStatus === "browser-cache-pending") {
    alertText = `Showing the last browser cache from ${formatCheckedAt(referenceMeta.retrievedAt)} while checking the reference provider. Pair observation dates are shown in the table.`;
  } else if (referenceMeta.cacheStatus === "error") {
    alertText = `The reference provider could not be reached. Showing the last browser cache from ${formatCheckedAt(referenceMeta.retrievedAt)}; each observation date remains attached to its pair. Check the feed before using these values.`;
  } else if (referenceMeta.cacheStatus === "partial-cache") {
    alertText = `Some reference pairs could not be refreshed and are using the last successful server cache. Their observation dates are shown in the table.`;
  } else if (stalePairs.length) {
    alertText = `One or more reference observations are more than ${3} calendar days old. Stale pairs are marked in the table; do not present them as current.`;
  } else if (hasErrors || missingPairs.length) {
    alertText = metalProviderNeeded
      ? `Currency references loaded, but ${missingPairs.length} gold/silver pair${missingPairs.length === 1 ? " is" : "s are"} still need a metals source. Missing rows are labeled individually.`
      : `Partial reference coverage: ${missingPairs.length} pair${missingPairs.length === 1 ? " has" : "s have"} no returned rate. Missing rows are labeled individually.`;
  } // Update the feed alert area with the determined alert message and kind, showing or hiding it based on whether there is an alert to display.
  elements.feedAlert.hidden = !alertText;
  elements.feedAlert.dataset.kind = alertKind;
  elements.feedAlert.textContent = alertText;
}

// Render the price text for a given price and quote currency, returning a span element with the formatted price or a placeholder if the price is not available.
function priceText(price, quote, className = "") {
  if (!price) return `<span class="price-readout ${className}">—</span>`;
  return `<span class="price-readout ${className}">${escapeHtml(formatPairRate(price))} <small>${escapeHtml(quote)}</small></span>`;
}

// Render the main table of currency pairs, including their reference rates, customer prices, and any relevant status indicators. This function handles filtering, sorting, and displaying the appropriate messages when no pairs match the current search or filter criteria.
function renderTable({
  animateRows = false,
  animatePair = null,
  highlightPair = null,
} = {}) {
  elements.pairTotal.textContent = `${settings.pairs.length} pair${settings.pairs.length === 1 ? "" : "s"}`;
  elements.navPairCount.textContent = String(settings.pairs.length).padStart(
    2,
    "0",
  );
  if (!settings.pairs.length) {
    elements.ratesBody.innerHTML = `<tr class="loading-row"><td colspan="5">No currency pairs on this board yet. Add one to begin.</td></tr>`;
    elements.emptySearch.hidden = true;
    renderCalculatorOptions();
    updateFeedStatus();
    renderPairHistory();
    return;
  }

  // Filter the list of currency pairs based on the current search term and view filter, returning only those pairs that match the criteria.
  const normalizedSearch = searchTerm.trim().toLocaleLowerCase(locale);
  const visiblePairs = settings.pairs.filter((id) => {
    const { base, quote } = pairParts(id);
    const text =
      `${base} ${quote} ${currencyName(base)} ${currencyName(quote)}`.toLocaleLowerCase(
        locale,
      );
    if (!text.includes(normalizedSearch)) return false;
    const prices = settings.prices[id] ?? {};
    if (view.filter === "needs-prices" && prices.buy && prices.sell)
      return false;
    if (view.filter === "priced" && !(prices.buy && prices.sell)) return false;
    if (view.filter === "reference-issues") {
      const rate = referenceRates[id];
      const hasReferenceIssue =
        !rate ||
        isObservationStale(rate.date, new Date()) ||
        rate.cacheFallback ||
        ["stale-cache", "error"].includes(referenceMeta.cacheStatus);
      if (!hasReferenceIssue) return false;
    }
    return true;
  }); // Sort the visible pairs based on the current view sort option, using different criteria for code, name, and rate sorting.
  const sortedPairs = [...visiblePairs];
  if (view.sort === "code") sortedPairs.sort((a, b) => a.localeCompare(b));
  if (view.sort === "name")
    sortedPairs.sort((a, b) => {
      const aParts = pairParts(a);
      const bParts = pairParts(b);
      return `${currencyName(aParts.base)} ${currencyName(aParts.quote)}`.localeCompare(
        `${currencyName(bParts.base)} ${currencyName(bParts.quote)}`,
        locale,
      );
    }); // Sort by the full currency names for the base and quote currencies.
  if (view.sort === "rate-high" || view.sort === "rate-low")
    sortedPairs.sort((a, b) => {
      const aRate = referenceRates[a]?.rate;
      const bRate = referenceRates[b]?.rate;
      if (!aRate && !bRate) return 0;
      if (!aRate) return 1;
      if (!bRate) return -1;
      const order = compareDecimals(aRate, bRate);
      return view.sort === "rate-high" ? -order : order;
    }); // Sort by the reference rate, handling cases where one or both rates may be missing.
  elements.emptySearch.hidden = sortedPairs.length > 0;
  if (!sortedPairs.length) {
    const title = elements.emptySearch.querySelector("strong");
    const message = elements.emptySearch.querySelector("span");
    if (title && message) {
      const filtered = view.filter !== "all";
      title.textContent = normalizedSearch
        ? "No pairs found"
        : "No pairs match these options";
      message.textContent = normalizedSearch
        ? "Try another code, name, or board filter."
        : filtered
          ? "Adjust the filter or add prices to see more pairs."
          : "Try a currency code or name.";
    }
  } // If there are no visible pairs after filtering and sorting, clear the rates table. Otherwise, generate the HTML for each visible pair, including its reference rate, customer prices, and action buttons for editing, moving, flipping, or removing the pair.
  if (!visiblePairs.length) {
    elements.ratesBody.innerHTML = "";
  } else {
    // Generate the HTML for each visible pair, including its reference rate, customer prices, and action buttons for editing, moving, flipping, or removing the pair.
    elements.ratesBody.innerHTML = sortedPairs
      .map((id, index) => {
        const { base, quote } = pairParts(id);
        const rate = referenceRates[id];
        const pairPrices = settings.prices[id] ?? { buy: "", sell: "" };
        const boardIndex = settings.pairs.indexOf(id);
        const rowClasses = [
          animateRows || animatePair === id ? "row-enter" : "",
          highlightPair === id ? "row-highlight" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const stale =
          rate &&
          (isObservationStale(rate.date, new Date()) ||
            rate.cacheFallback ||
            referenceMeta.cacheStatus === "stale-cache" ||
            referenceMeta.cacheStatus === "error");
        const cached =
          rate &&
          (rate.cacheFallback ||
            referenceMeta.cacheStatus === "stale-cache" ||
            referenceMeta.cacheStatus === "error" ||
            referenceMeta.cacheStatus === "browser-cache-pending");
        const refDate = rate
          ? formatRateObservation(rate, { month: "short", day: "numeric" })
          : "—";
        const refValue = rate
          ? `<div class="reference-value ${stale ? "is-stale" : ""}"><strong>${escapeHtml(formatPairRate(rate.rate))} <small>${escapeHtml(quote)}</small></strong><small>1 ${escapeHtml(base)} · ${escapeHtml(refDate)}${cached ? " · CACHED" : stale ? " · STALE" : ""}</small></div>`
          : `<div class="reference-value is-missing"><strong>${referenceMeta.cacheStatus === "loading" ? "Loading…" : isMetalPair(base, quote) ? "Metal source needed" : "No source rate"}</strong><small>${referenceMeta.cacheStatus === "loading" ? "" : !isSupportedPair(base, quote) ? "Use USD with gold or silver" : isMetalPair(base, quote) ? "Troy ounce · USD reference" : "Coverage unavailable"}</small></div>`;
        return `<tr class="${rowClasses}" style="--row-delay:${Math.min(index, 6) * 45}ms" data-pair="${escapeHtml(id)}">
        <td><div class="pair-cell"><span class="currency-chip">${escapeHtml(currencyMark(base))}</span><div class="pair-names"><strong>${escapeHtml(base)} <span aria-hidden="true">→</span> ${escapeHtml(quote)}</strong><small>${escapeHtml(currencyName(base))} / ${escapeHtml(currencyName(quote))}</small></div></div></td>
        <td>${refValue}</td>
        <td><div class="customer-price">${priceText(pairPrices.buy, quote)}<button class="edit-price-button" type="button" data-edit-price="${escapeHtml(id)}" aria-label="${pairPrices.buy ? "Edit" : "Set"} desk buy price for ${escapeHtml(id)}">${pairPrices.buy ? "Edit" : "Set rate"}</button></div></td>
        <td><div class="customer-price">${priceText(pairPrices.sell, quote, "sell-price")}<button class="edit-price-button" type="button" data-edit-price="${escapeHtml(id)}" aria-label="${pairPrices.sell ? "Edit" : "Set"} desk sell price for ${escapeHtml(id)}">${pairPrices.sell ? "Edit" : "Set rate"}</button></div></td>
        <td class="action-cell"><div class="row-actions">
          <button class="row-action row-drag-handle" type="button" draggable="true" data-drag-pair="${escapeHtml(id)}" aria-label="Drag ${escapeHtml(id)} to reorder it" title="Drag to reorder">⠿</button>
          <button class="row-action" type="button" data-move-pair="${escapeHtml(id)}" data-move-direction="up" aria-label="Move ${escapeHtml(id)} earlier in board order" title="Move earlier" ${boardIndex === 0 ? "disabled" : ""}>↑</button>
          <button class="row-action" type="button" data-move-pair="${escapeHtml(id)}" data-move-direction="down" aria-label="Move ${escapeHtml(id)} later in board order" title="Move later" ${boardIndex === settings.pairs.length - 1 ? "disabled" : ""}>↓</button>
          <button class="row-action row-flip" type="button" data-flip-pair="${escapeHtml(id)}" aria-label="Reverse ${escapeHtml(id)} to ${escapeHtml(quote)}/${escapeHtml(base)}" title="Reverse pair direction">↔</button>
          <button class="row-action" type="button" data-remove-pair="${escapeHtml(id)}" aria-label="Remove ${escapeHtml(id)} from the rate board" title="Remove pair"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 6h10M8 6V4h4v2m2 0-.6 9.5H6.6L6 6m2.5 2.5v4m3-4v4" /></svg></button>
        </div></td>
      </tr>`;
      })
      .join("");
  }
  if (animateRows) hasAnimatedRows = true; // Mark that the initial row animation has completed to prevent re-animating rows on subsequent renders.
  updateFeedStatus();
  renderCalculatorOptions();
  renderPairHistory();
}

// Read the reference cache from localStorage, validating its structure and contents. If the cache is valid, return an object containing the cached rates and metadata; otherwise, return null.
function readReferenceCache() {
  const cached = readJson(REFERENCE_CACHE_KEY, null);
  if (
    !cached ||
    typeof cached !== "object" ||
    !cached.rates ||
    typeof cached.rates !== "object"
  )
    return null;
  const rates = {};
  for (const [id, rate] of Object.entries(cached.rates)) {
    if (
      validPairId(id) &&
      rate &&
      isPositiveDecimal(String(rate.rate)) &&
      /^\d{4}-\d{2}-\d{2}$/.test(String(rate.date))
    )
      rates[id] = rate;
  }
  return Object.keys(rates).length ? { ...cached, rates } : null;
}

// Load the list of supported currencies from the server, filtering out any invalid entries and ensuring that special assets (like gold and silver) are included. If the fetch fails, fall back to a cached version if available.
async function loadCurrencies() {
  try {
    const response = await fetch("/api/currencies");
    if (!response.ok) throw new Error("Currency list unavailable");
    const body = await response.json();
    if (!Array.isArray(body.currencies))
      throw new Error("Unexpected currency list");
    currencies = body.currencies.filter(
      (item) => /^[A-Z]{3}$/.test(item.code) && typeof item.name === "string",
    );
    currencies = ensureSpecialAssets(currencies);
    writeJson(CURRENCY_CACHE_KEY, currencies);
  } catch {
    const cached = readJson(CURRENCY_CACHE_KEY, []);
    if (Array.isArray(cached))
      currencies = cached.filter(
        (item) =>
          item && /^[A-Z]{3}$/.test(item.code) && typeof item.name === "string",
      );
    currencies = ensureSpecialAssets(currencies);
  }
  renderTable();
  const selectedPair = currentCalculatorPair();
  if (!settings.pairs.includes(selectedPair))
    refreshCalculatorReference(selectedPair);
}

// Load the reference rates for the current pairs from the server, updating the UI with loading states, errors, and the resulting data. If the fetch fails, fall back to a cached version if available.
async function loadRates({ announceSuccess = false } = {}) {
  const pairs = settings.pairs.map(pairParts);
  if (!pairs.length) return;
  elements.refreshButton.classList.add("is-refreshing");
  elements.refreshButton.disabled = true;
  const query = encodeURIComponent(
    settings.pairs.map((id) => id.replace("/", ":")).join("|"),
  );
  try {
    const response = await fetch(`/api/rates?pairs=${query}`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error("Reference feed unavailable");
    const body = await response.json();
    if (!body.rates || typeof body.rates !== "object")
      throw new Error("Unexpected reference data");
    const returnedRates = body.rates;
    const errors = Array.isArray(body.errors) ? [...body.errors] : [];
    const metalSourceUnavailable = errors.some((error) => error.code === "provider-not-configured");
    const nextRates = { ...referenceRates };
    for (const [id, rate] of Object.entries(returnedRates))
      nextRates[id] = { ...rate, cacheFallback: Boolean(rate.cacheFallback) };
    const fallbackPairs = [];
    for (const id of settings.pairs) {
      if (!returnedRates[id] && nextRates[id]) {
        const { base, quote } = pairParts(id);
        if (metalSourceUnavailable && isMetalPair(base, quote)) {
          delete nextRates[id];
          continue;
        }
        nextRates[id] = { ...nextRates[id], cacheFallback: true };
        fallbackPairs.push(id);
      }
    }
    referenceRates = nextRates;
    const bodyCacheStatus = body.cacheStatus ?? "fresh";
    const cacheStatus =
      fallbackPairs.length && bodyCacheStatus !== "stale-cache"
        ? "partial-cache"
        : bodyCacheStatus;
    if (fallbackPairs.length && !errors.length)
      errors.push({
        message:
          "Some currency pairs are using a previous browser reference cache.",
      });
    referenceMeta = {
      cacheStatus,
      errors,
      retrievedAt: body.retrievedAt ?? null,
      checkedAt: body.checkedAt ?? body.retrievedAt ?? null,
    };
    if (Object.keys(returnedRates).length || metalSourceUnavailable) {
      writeJson(REFERENCE_CACHE_KEY, {
        rates: referenceRates,
        retrievedAt: referenceMeta.retrievedAt,
        source: body.source,
      });
    }
    renderTable({ animateRows: !hasAnimatedRows });
    renderCalculator();
    if (announceSuccess) announce("Reference rates refreshed.");
  } catch {
    const cached = readReferenceCache();
    if (!Object.keys(referenceRates).length && cached)
      referenceRates = cached.rates;
    referenceMeta = {
      cacheStatus: "error",
      errors: [{ message: "Reference feed unavailable." }],
      retrievedAt: cached?.retrievedAt ?? null,
      checkedAt: new Date().toISOString(),
    };
    renderTable({ animateRows: !hasAnimatedRows });
    renderCalculator();
    if (announceSuccess)
      announce("The reference provider could not be reached.");
  } finally {
    elements.refreshButton.classList.remove("is-refreshing");
    elements.refreshButton.disabled = false;
  }
}

// Render the options for the calculator's base and quote currency selectors, ensuring that all currencies in the current pairs and any special assets are included. The previously selected currencies are preserved if still available; otherwise, defaults are chosen based on the first pair or the first available option.
function renderCalculatorOptions() {
  const previousBase = elements.calculatorBase.value;
  const previousQuote = elements.calculatorQuote.value;
  const options = [...currencies];
  for (const id of settings.pairs) {
    for (const code of id.split("/")) {
      if (!options.some((currency) => currency.code === code))
        options.push({ code, name: code });
    }
  }
  for (const currency of ensureSpecialAssets([])) {
    if (!options.some((option) => option.code === currency.code))
      options.push(currency);
  }
  options.sort((a, b) => a.code.localeCompare(b.code));
  const markup = options
    .map(
      ({ code, name }) =>
        `<option value="${escapeHtml(code)}">${escapeHtml(code)} · ${escapeHtml(name)}</option>`,
    )
    .join("");
  elements.calculatorBase.innerHTML = markup;
  elements.calculatorQuote.innerHTML = markup;
  const preferred = pairParts(settings.pairs[0] ?? "USD/EUR");
  elements.calculatorBase.value = options.some(
    (currency) => currency.code === previousBase,
  )
    ? previousBase
    : options.some((currency) => currency.code === preferred.base)
      ? preferred.base
      : (options[0]?.code ?? "");
  elements.calculatorQuote.value = options.some(
    (currency) =>
      currency.code === previousQuote &&
      currency.code !== elements.calculatorBase.value,
  )
    ? previousQuote
    : options.some(
          (currency) =>
            currency.code === preferred.quote &&
            currency.code !== elements.calculatorBase.value,
        )
      ? preferred.quote
      : (options.find(
          (currency) => currency.code !== elements.calculatorBase.value,
        )?.code ?? "");
  previousCalculatorSelection = {
    base: elements.calculatorBase.value,
    quote: elements.calculatorQuote.value,
  };
  renderCalculator();
}

// Get the currently selected calculator pair as a string in the format "BASE/QUOTE", or return an empty string if the selection is invalid (e.g., if the base and quote are the same or not selected).
function currentCalculatorPair() {
  const base = elements.calculatorBase.value;
  const quote = elements.calculatorQuote.value;
  return base && quote && base !== quote ? `${base}/${quote}` : "";
}

// Render the calculator results based on the currently selected base and quote currencies, the entered amount, and the available reference rates and customer prices. This function updates the UI with the calculated results or appropriate messages if data is missing or invalid.
function renderCalculator() {
  const id = currentCalculatorPair();
  if (!id) {
    elements.calculatorBaseCode.textContent =
      elements.calculatorBase.value || "—";
    elements.calculatorReferenceResult.textContent =
      "Choose two different currencies";
    elements.calculatorReferenceMeta.textContent =
      "Select a base and quote currency to continue.";
    elements.calculatorBuyResult.textContent = "Choose a pair";
    elements.calculatorSellResult.textContent = "Choose a pair";
    elements.calculatorAddPair.hidden = true;
    return;
  } // If the selected pair is invalid (e.g., base and quote are the same), display a message prompting the user to choose two different currencies.
  const { base, quote } = pairParts(id);
  const metalPair = isMetalPair(base, quote);
  const metalDirectionSupported = isSupportedPair(base, quote);
  const amount = elements.calculatorAmount.value || "0";
  const onBoard = settings.pairs.includes(id);
  const rate = referenceRates[id];
  const prices = settings.prices[id] ?? {};
  const amountValue = parseDecimal(amount);
  elements.calculatorBaseCode.textContent = base;
  const referenceResult =
    metalDirectionSupported &&
    rate &&
    amountValue &&
    amountValue.coefficient > 0n
      ? multiplyAndRound(amount, rate.rate, amountDigits(quote))
      : null;
  const lookupState = calculatorLookupState.get(id);
  elements.calculatorReferenceResult.textContent = referenceResult
    ? `${formatDecimal(referenceResult, locale, amountDigits(quote), amountDigits(quote))} ${quote}`
    : !amountValue || amountValue.coefficient <= 0n
      ? "Enter an amount"
      : !metalDirectionSupported
        ? "Use USD with gold or silver"
        : lookupState === "loading"
          ? "Looking up reference…"
          : "Reference rate unavailable";
  if (rate) {
    const stale =
      isObservationStale(rate.date, new Date()) ||
      rate.cacheFallback ||
      (onBoard && ["stale-cache", "error"].includes(referenceMeta.cacheStatus));
    const cached =
      rate.cacheFallback ||
      lookupState === "cached" ||
      (onBoard &&
        ["cached", "stale-cache", "error", "browser-cache-pending"].includes(
          referenceMeta.cacheStatus,
        ));
    elements.calculatorReferenceMeta.textContent = `${rate.source ?? (metalPair ? "Metal reference" : "Frankfurter daily reference")} · ${formatRateObservation(rate)}${stale ? " · STALE" : cached ? " · CACHED" : ""} · not a customer quote`;
  } else {
    elements.calculatorReferenceMeta.textContent =
      lookupState === "error" || lookupState === "missing"
        ? metalPair
          ? "Gold and silver quotes need a metals data source."
          : "No Frankfurter observation is available for this pair."
        : metalPair
          ? `Pair convention: ${metalPairUnit(base, quote)}; metals feed not configured.`
          : "Frankfurter daily reference · not a customer quote";
  }
  for (const [side, output] of [
    ["buy", elements.calculatorBuyResult],
    ["sell", elements.calculatorSellResult],
  ]) {
    const rate = prices[side];
    const result =
      rate && amountValue && amountValue.coefficient > 0n
        ? multiplyAndRound(amount, rate, amountDigits(quote))
        : null;
    output.textContent = result
      ? `${formatDecimal(result, locale, amountDigits(quote), amountDigits(quote))} ${quote}`
      : rate
        ? "Enter an amount"
        : onBoard
          ? "Set a desk rate"
          : "Pair is not on board";
  }
  elements.calculatorAddPair.hidden = onBoard;
}

// Refresh the reference rate for a given currency pair, fetching it from the server if it is not already cached or if a forced refresh is requested. This function updates the lookup state and re-renders the calculator as needed.
function refreshCalculatorReference(id, { force = false } = {}) {
  if (!id || (!force && calculatorLookupState.has(id))) return;
  const { base, quote } = pairParts(id);
  if (!isSupportedPair(base, quote)) {
    calculatorLookupState.set(id, "missing");
    renderCalculator();
    return;
  } // If the pair is not supported (e.g., gold or silver without USD), mark it as missing and re-render the calculator.
  calculatorLookupState.set(id, "loading");
  renderCalculator();
  const pair = pairParts(id);
  const query = encodeURIComponent(`${pair.base}:${pair.quote}`);
  fetch(`/api/rates?pairs=${query}`, {
    headers: { accept: "application/json" },
  })
    .then(async (response) => {
      if (!response.ok) throw new Error("Reference lookup failed");
      return response.json();
    }) // Validate the response body to ensure it contains the expected structure and data for the requested currency pair.
    .then((body) => {
      const rate = body.rates?.[id];
      if (rate) {
        const cacheFallback =
          Boolean(rate.cacheFallback) || body.cacheStatus === "stale-cache";
        referenceRates[id] = { ...rate, cacheFallback };
        calculatorLookupState.set(
          id,
          cacheFallback ||
            ["cached", "partial-cache", "browser-cache-pending"].includes(
              body.cacheStatus,
            )
            ? "cached"
            : "ready",
        );
        writeJson(REFERENCE_CACHE_KEY, {
          rates: referenceRates,
          retrievedAt: body.retrievedAt ?? new Date().toISOString(),
          source: body.source,
        });
      } else {
        calculatorLookupState.set(
          id,
          referenceRates[id] ? "cached" : "missing",
        );
      }
      if (currentCalculatorPair() === id) renderCalculator();
    }) // Handle any errors that occur during the fetch or response processing, marking the lookup state as "cached" or "error" as appropriate, and re-rendering the calculator if the current pair matches the requested pair.
    .catch(() => {
      calculatorLookupState.set(id, referenceRates[id] ? "cached" : "error");
      if (currentCalculatorPair() === id) renderCalculator();
    });
}

// Handle changes to the calculator's base or quote currency selectors, ensuring that the two currencies are not the same and updating the calculator results accordingly. If the user selects the same currency for both base and quote, automatically switch the other selector to a different available currency.
function changeCalculatorCurrencies(changed) {
  if (elements.calculatorBase.value === elements.calculatorQuote.value) {
    const currenciesAvailable = [...elements.calculatorBase.options].map(
      (option) => option.value,
    );
    const currentCode =
      changed === "base"
        ? elements.calculatorBase.value
        : elements.calculatorQuote.value;
    const previousAlternate =
      changed === "base"
        ? previousCalculatorSelection.base
        : previousCalculatorSelection.quote;
    const alternate =
      previousAlternate !== currentCode &&
      currenciesAvailable.includes(previousAlternate)
        ? previousAlternate
        : currenciesAvailable.find((code) => code !== currentCode);
    if (changed === "base") elements.calculatorQuote.value = alternate ?? "";
    else elements.calculatorBase.value = alternate ?? "";
  } // If the user selects the same currency for both base and quote, automatically switch the other selector to a different available currency.
  previousCalculatorSelection = {
    base: elements.calculatorBase.value,
    quote: elements.calculatorQuote.value,
  };
  const id = currentCalculatorPair(); // Get the currently selected calculator pair as a string in the format "BASE/QUOTE". If the selection is invalid (e.g., base and quote are the same), exit the function early to prevent further processing.
  renderCalculator(); // Re-render the calculator results based on the updated base and quote currencies, ensuring that the displayed results reflect the current selection.
  refreshCalculatorReference(id); // Refresh the reference rate for the currently selected calculator pair, fetching it from the server if it is not already cached or if a forced refresh is requested. This ensures that the calculator displays up-to-date reference rates for the selected pair.
}

// Add the currently selected calculator pair to the rates board, validating that it is a supported pair and that the board has not reached its maximum capacity. If the pair is successfully added, save the settings and update the UI accordingly.
function addCalculatorPairToBoard() {
  const id = currentCalculatorPair(); // Get the currently selected calculator pair as a string in the format "BASE/QUOTE". If the selection is invalid (e.g., base and quote are the same), exit the function early to prevent adding an invalid pair to the board.
  if (!id || settings.pairs.includes(id)) return; // If the selected pair is invalid or already exists on the board, exit the function early to prevent adding a duplicate or invalid pair.
  const { base, quote } = pairParts(id); // Extract the base and quote currencies from the selected pair for validation purposes.
  if (!isSupportedPair(base, quote)) {
    announce("Gold and silver pairs can only be added against USD."); // Announce an error message if the selected pair is not supported.
    return;
  } // Validate that the selected pair is supported (e.g., gold and silver must be paired with USD) before adding it to the board.
  if (settings.pairs.length >= MAX_BOARD_PAIRS) {
    announce(`This board supports up to ${MAX_BOARD_PAIRS} pairs.`); // Check if the board has reached its maximum capacity before adding the new pair, and announce a message if it has.
    return;
  } // Check if the board has reached its maximum capacity before adding the new pair.
  settings.pairs.push(id); // Add the new pair to the end of the settings.pairs array, which represents the current order of pairs on the board.
  const saved = saveSettings(); // Save the updated settings to localStorage, returning a boolean indicating whether the save was successful.
  renderTable({ animatePair: id, highlightPair: id }); // Re-render the table to include the newly added pair, highlighting it for visibility and animating its entry into the board.
  loadRates(); // Fetch the latest reference rates for the newly added pair, ensuring that the board displays up-to-date information for all pairs, including the one just added.
  loadPairHistory(); // Refresh the pair history to include the newly added pair, ensuring that the history is up-to-date and reflects the current state of the board.
  announce(
    isMetalPair(base, quote)
      ? `${id} added. The reference quote will appear after a metals source is configured.`
      : saved
        ? `${id} added to the rates board.`
        : `${id} added for this session; browser storage is unavailable.`,
  );
}
// Reorder a currency pair on the board by moving it before or after another specified pair. This function updates the settings, applies view preferences, saves the changes, and re-renders the table. It also manages focus restoration for accessibility.
function reorderPair(
  sourceId,
  targetId,
  afterTarget = false,
  { restoreFocus = true } = {},
) {
  if (sourceId === targetId) return; // If the source and target pairs are the same, exit the function early to prevent unnecessary reordering.
  const sourceIndex = settings.pairs.indexOf(sourceId); // Find the index of the source pair in the settings.pairs array. If the source pair is not found, exit the function early to prevent invalid reordering.
  if (sourceIndex < 0 || !settings.pairs.includes(targetId)) return; // If the source pair is not found or the target pair is not in the current settings, exit the function early to prevent invalid reordering.
  const [source] = settings.pairs.splice(sourceIndex, 1); // Remove the source pair from its current position in the settings.pairs array, storing it in a variable for later insertion at the new position.
  let targetIndex = settings.pairs.indexOf(targetId); // Find the index of the target pair in the settings.pairs array. If the target pair is not found, exit the function early to prevent invalid reordering.
  if (afterTarget) targetIndex += 1; // If the afterTarget flag is true, increment the target index to insert the source pair after the target pair; otherwise, it will be inserted before the target pair.
  settings.pairs.splice(targetIndex, 0, source); // Move the source pair to the new position in the settings.pairs array, either before or after the target pair based on the afterTarget flag.
  view.sort = "board"; // Set the view sort order to "board" to reflect the new order of currency pairs after reordering.
  applyViewPreferences(); // Apply the current view preferences to the document body and relevant UI elements, ensuring that the sort order is set to "board" to reflect the new order of currency pairs after reordering.
  const saved = saveSettings(); // Save the updated settings to localStorage, returning a boolean indicating whether the save was successful.
  renderTable(); // Re-render the table to reflect the new order of currency pairs after reordering.
  if (restoreFocus) {
    const controls = [
      ...elements.ratesBody.querySelectorAll("[data-move-pair]"),
    ].filter((button) => button.dataset.movePair === sourceId);
    (controls.find((button) => !button.disabled) ?? controls[0])?.focus(); // Restore focus to the first available move control for the moved pair, prioritizing enabled buttons for accessibility.
  }
  announce(
    saved
      ? "Currency pair order saved."
      : "Currency pair order changed for this session; browser storage is unavailable.",
  );
}

// Move a currency pair up or down in the board order, ensuring that the move is valid and within the bounds of the current pairs. This function calls reorderPair to perform the actual reordering.
function movePairInBoard(id, direction) {
  const index = settings.pairs.indexOf(id); // Find the index of the pair to move in the current settings. If the pair is not found, exit the function early.
  const targetIndex = index + (direction === "up" ? -1 : 1); // Calculate the target index based on the specified direction (up or down). If the target index is out of bounds, exit the function early.
  if (index < 0 || targetIndex < 0 || targetIndex >= settings.pairs.length)
    return; // If the pair is not found or the target index is out of bounds, exit the function early to prevent invalid reordering.
  reorderPair(id, settings.pairs[targetIndex], direction === "down"); // Call reorderPair to move the specified pair before or after the target pair, depending on the direction. This will update the settings, save the changes, and re-render the table.
}

// Flip the direction of a currency pair on the board, changing it from "BASE/QUOTE" to "QUOTE/BASE". This function checks for existing pairs, updates the settings, saves the changes, and re-renders the table. It also updates the calculator if the flipped pair is currently selected.
function flipPairDirection(id) {
  const index = settings.pairs.indexOf(id); // Find the index of the pair to flip in the current settings. If the pair is not found, exit the function early.
  if (index < 0) return; // If the pair is not found in the current settings, exit the function early to prevent further processing.
  const { base, quote } = pairParts(id); // Extract the base and quote currencies from the pair ID, which is in the format "BASE/QUOTE". This allows us to construct the flipped pair.
  const flippedId = `${quote}/${base}`; // Construct the flipped pair ID by reversing the base and quote currencies. This will be used to check for duplicates and update the settings.
  if (settings.pairs.includes(flippedId)) {
    announce(`${flippedId} is already on the board.`); // If the flipped pair already exists on the board, announce that it cannot be added again and exit the function early to prevent duplicates.
    return;
  } // Check if the flipped pair already exists on the board to prevent duplicates.
  settings.pairs[index] = flippedId; // Replace the original pair with the flipped pair in the settings.
  const saved = saveSettings(); // Save the updated settings to localStorage, returning a boolean indicating whether the save was successful.
  if (currentCalculatorPair() === id) {
    elements.calculatorBase.value = quote; // If the flipped pair is currently selected in the calculator, update the calculator selectors to reflect the new base and quote currencies.
    elements.calculatorQuote.value = base; // Update the calculator selectors to reflect the new base and quote currencies after flipping the pair direction.
    previousCalculatorSelection = { base: quote, quote: base }; // Update the previous calculator selection to reflect the new base and quote currencies after flipping the pair direction.
  } // If the flipped pair is currently selected in the calculator, update the calculator selectors to reflect the new base and quote currencies.
  renderTable({ highlightPair: flippedId });
  loadRates(); // Refresh the reference rates for the updated pair direction, ensuring that the calculator and table display the correct rates for the new pair.
  loadPairHistory(); // Refresh the pair history for the updated pair direction, ensuring that any historical data displayed in the UI reflects the new pair configuration.
  announce(
    saved
      ? `${id} direction changed to ${flippedId}. Desk prices remain separate for each direction.`
      : `${id} direction changed for this session. Desk prices remain separate for each direction.`,
  );
}

// Apply the current view preferences (theme, density, filter, sort) to the document body and relevant UI elements. Optionally persist the preferences to localStorage for future sessions.
function applyViewPreferences({ persist = true } = {}) {
  document.body.dataset.theme = view.theme; // Apply the selected theme (light or dark) to the document body, allowing CSS to style the application accordingly.
  document.body.dataset.density = view.density; // Apply the selected density (comfortable or compact) to the document body, allowing CSS to adjust spacing and layout for the rates table and other UI elements.
  elements.pairFilter.value = view.filter; // Set the filter dropdown in the UI to reflect the current view filter (e.g., all, priced, needs-prices, reference-issues), allowing users to see which filter is active.
  elements.pairSort.value = view.sort; // Set the sort dropdown in the UI to reflect the current view sort option (e.g., code, name, rate-high, rate-low, board), allowing users to see which sorting method is active.
  elements.boardDensity.value = view.density; // Set the density dropdown in the UI to reflect the current view density (comfortable or compact), allowing users to see which density setting is active.
  elements.boardTheme.value = view.theme; // Set the theme dropdown in the UI to reflect the current view theme (light or dark), allowing users to see which theme setting is active.
  const themeAction = view.theme === "night" ? "Switch to bright mode" : "Switch to night mode";
  elements.themeToggle.setAttribute("title", themeAction);
  elements.themeToggle.setAttribute("aria-pressed", String(view.theme === "night"));
  elements.themeToggleLabel.textContent = view.theme === "night" ? "Day mode" : "Night mode";
  if (persist) writeJson(VIEW_STORAGE_KEY, view); // Persist the current view preferences to localStorage, allowing the application to remember the user's settings across sessions.
}

// Open the dialog for adding a new currency pair, populating the base and quote selectors with available currencies and metals. This function also sets default selections based on preferred currencies and updates the pair preview accordingly.
function openPairDialog() {
  if (settings.pairs.length >= MAX_BOARD_PAIRS) {
    announce(`This board supports up to ${MAX_BOARD_PAIRS} pairs.`); // If the board has reached its maximum capacity, announce that no more pairs can be added and exit the function early to prevent opening the add pair dialog.
    return;
  } // Check if the board has reached its maximum capacity before opening the dialog for adding a new pair.
  const available = ensureSpecialAssets(currencies); // Ensure that special assets (like gold and silver) are included in the list of available currencies for the pair selection dialog.
  const currenciesMarkup = available
    .filter(({ code }) => !METAL_CODES.has(code))
    .map(
      ({ code, name }) =>
        `<option value="${escapeHtml(code)}">${escapeHtml(code)} · ${escapeHtml(name)}</option>`,
    )
    .join("");
  const metalsMarkup = available
    .filter(({ code }) => METAL_CODES.has(code))
    .map(
      ({ code, name }) =>
        `<option value="${escapeHtml(code)}">${escapeHtml(code)} · ${escapeHtml(name)}</option>`,
    )
    .join("");
  const optionMarkup = `<optgroup label="Currencies">${currenciesMarkup}</optgroup><optgroup label="Precious metals">${metalsMarkup}</optgroup>`;
  elements.pairBase.innerHTML = optionMarkup; // Populate the base currency selector with available currencies and metals, grouped into separate optgroups for clarity.
  elements.pairQuote.innerHTML = optionMarkup; // Populate the quote currency selector with available currencies and metals, grouped into separate optgroups for clarity.
  const preferredBase = available.some((currency) => currency.code === "USD")
    ? "USD"
    : available[0]?.code;
  const preferredQuote = available.some((currency) => currency.code === "EUR")
    ? "EUR"
    : available.find((currency) => currency.code !== preferredBase)?.code;
  if (!available.length) {
    elements.pairBase.innerHTML =
      '<option value="">Currency list unavailable</option>';
    elements.pairQuote.innerHTML =
      '<option value="">Currency list unavailable</option>';
    elements.pairBase.disabled = true; // Disable the base currency selector if the currency list is unavailable, preventing user interaction with an empty or invalid selection.
    elements.pairQuote.disabled = true; // Disable the quote currency selector if the currency list is unavailable, preventing user interaction with an empty or invalid selection.
    elements.pairPreview.innerHTML =
      "<span>PAIR PREVIEW</span><strong>Coverage unavailable</strong><small>Refresh the reference feed and try again.</small>";
  } else {
    elements.pairBase.disabled = false; // Enable the base currency selector if the currency list is available, allowing the user to select a base currency for the new pair.
    elements.pairQuote.disabled = false; // Enable the quote currency selector if the currency list is available, allowing the user to select a quote currency for the new pair.
    elements.pairBase.value = preferredBase; // Set the default selections for the base and quote currency selectors based on preferred currencies (USD for base, EUR for quote) or the first available options if the preferred currencies are not present.
    elements.pairQuote.value = preferredQuote; // Set the default selections for the base and quote currency selectors based on preferred currencies (USD for base, EUR for quote) or the first available options if the preferred currencies are not present.
    updatePairPreview(); // Update the pair preview section in the add pair dialog to reflect the currently selected base and quote currencies, providing guidance on valid combinations and existing pairs.
  }
  elements.pairDialog.showModal();
}

// Update the pair preview section in the add pair dialog based on the currently selected base and quote currencies. This function checks for existing pairs, unsupported combinations, and provides appropriate guidance to the user.
function updatePairPreview() {
  const base = elements.pairBase.value; // Get the currently selected base currency from the add pair dialog.
  const quote = elements.pairQuote.value; // Get the currently selected quote currency from the add pair dialog.
  const id = `${base}/${quote}`; // Construct the currency pair ID in the format "BASE/QUOTE" for validation and display purposes.
  const exists = settings.pairs.includes(id); // Check if the constructed pair ID already exists in the current settings to prevent duplicates on the board.
  const same = base === quote; // Check if the selected base and quote currencies are the same, which is not allowed for a valid currency pair.
  const unsupported = !isSupportedPair(base, quote); // Check if the selected base and quote currencies form an unsupported pair (e.g., gold or silver without USD) to provide appropriate guidance to the user.
  const detail = same
    ? "Choose two different currencies."
    : unsupported
      ? "Gold and silver can only be quoted against USD."
      : exists
        ? "This pair is already on the board."
        : isMetalPair(base, quote)
          ? `${metalPairUnit(base, quote)}. A metals source is required for the quote.`
          : "Reference rate will be loaded after adding.";
  elements.pairPreview.innerHTML = `<span>PAIR PREVIEW</span><strong>${escapeHtml(base || "—")} → ${escapeHtml(quote || "—")}</strong><small>${escapeHtml(detail)}</small>`;
}

// Open the dialog for setting desk prices for a specific currency pair, populating the fields with any existing prices and displaying reference rate information. This function also validates the pair and updates the UI accordingly.
function openPriceDialog(id) {
  if (!settings.pairs.includes(id)) return; // If the specified pair is not part of the current settings, exit the function early to prevent opening the price dialog for an invalid or unrecognized pair.
  const { base, quote } = pairParts(id); // Extract the base and quote currencies from the pair ID for use in the dialog title, description, and reference rate display.
  const prices = settings.prices[id] ?? { buy: "", sell: "" }; // Retrieve any existing desk prices for the specified pair from the settings, defaulting to empty strings if no prices are set.
  const reference = referenceRates[id]; // Retrieve the reference rate for the specified pair from the cached reference rates, if available, to display it in the dialog.
  elements.pricePairId.value = id; // Set the hidden input field in the price dialog form to the specified pair ID, allowing the form submission handler to know which pair's prices are being edited.
  elements.priceDialogTitle.textContent = `Set ${base} / ${quote} prices`; // Update the dialog title to indicate that the user is setting desk prices for the specified currency pair, providing clear context for the action being performed.
  elements.priceDialogDescription.textContent = `Enter quote currency units per 1 ${base}. Desk prices are separate from the reference feed.`;
  elements.priceBuy.value = prices.buy ?? ""; // Populate the buy price input field with the existing buy price for the specified pair, defaulting to an empty string if no price is set, allowing the user to edit or set a new buy price.
  elements.priceSell.value = prices.sell ?? ""; // Populate the sell price input field with the existing sell price for the specified pair, defaulting to an empty string if no price is set, allowing the user to edit or set a new sell price.
  document.querySelectorAll(".price-quote-code").forEach((node) => {
    node.textContent = quote;
  }); // Update all elements in the dialog that display the quote currency code to reflect the currently selected quote currency, ensuring consistency in the UI and providing clear context for the user when entering desk prices.
  elements.priceReferenceRate.textContent = reference
    ? `1 ${base} = ${formatPairRate(reference.rate)} ${quote}`
    : "No reference rate available";
  elements.priceReferenceDate.textContent = reference
    ? `${reference.source ?? (isMetalPair(base, quote) ? "Metal reference" : "Frankfurter blended reference")} · ${formatRateObservation(reference)}`
    : isMetalPair(base, quote)
      ? "A metals data source is needed for this reference quote"
      : "Reference data is not a customer price";
  elements.priceValidation.hidden = true;
  elements.priceValidation.textContent = "";
  elements.priceDialog.showModal(); // Open the price dialog modal to allow the user to set or edit desk prices for the selected currency pair.
}

// Close a given dialog if it is currently open. This function checks the dialog's open state and calls the close method if necessary.
function closeDialog(dialog) {
  if (dialog.open) dialog.close(); // Close the dialog only if it is currently open to avoid unnecessary operations or errors.
}

// Handle the submission of the price dialog form, validating the entered buy and sell rates, updating the settings, saving them, and re-rendering the table and calculator. This function also provides user feedback for validation errors.
function handlePriceSave(event) {
  event.preventDefault(); // Prevent the default form submission behavior to handle the save operation via JavaScript.
  const id = elements.pricePairId.value; // Retrieve the currency pair ID from the hidden input field in the price dialog form.
  const buy = elements.priceBuy.value.trim(); // Retrieve and trim the entered buy rate from the form input, preparing it for validation and storage.
  const sell = elements.priceSell.value.trim(); // Retrieve and trim the entered sell rate from the form input, preparing it for validation and storage.
  const { quote } = pairParts(id); // Extract the quote currency from the pair ID for use in validation messages and display.
  const options = { maxScale: 8, maxDigits: 30 }; // Define validation options for decimal numbers, specifying a maximum of 8 decimal places and a maximum of 30 total digits to ensure that rates are within acceptable bounds.
  if (!id || !settings.pairs.includes(id)) return; // If the pair ID is missing or not part of the current settings, exit the function early to prevent saving prices for an invalid or unrecognized pair.
  if (
    (buy &&
      (!MANUAL_RATE_PATTERN.test(buy) || !isPositiveDecimal(buy, options))) ||
    (sell &&
      (!MANUAL_RATE_PATTERN.test(sell) || !isPositiveDecimal(sell, options)))
  ) {
    elements.priceValidation.textContent =
      "Enter a positive rate using a decimal point and up to 8 decimal places.";
    elements.priceValidation.hidden = false;
    return;
  } // Validate that the entered buy and sell rates are positive decimals with up to 8 decimal places, providing feedback if they are invalid.
  if (buy && sell && compareDecimals(buy, sell) > 0) {
    elements.priceValidation.textContent =
      "The buy rate must be less than or equal to the sell rate for this pair direction.";
    elements.priceValidation.hidden = false; // Ensure that the buy rate is less than or equal to the sell rate, providing feedback if this condition is not met.
    return;
  } // Ensure that the buy rate is less than or equal to the sell rate, providing feedback if this condition is not met.
  if (buy || sell)
    settings.prices[id] = { buy, sell }; // If either buy or sell rate is provided, store them in the settings for the specified pair.
  else delete settings.prices[id]; // If both buy and sell rates are empty, remove any existing prices for the specified pair from the settings.
  const saved = saveSettings(); // Persist the updated settings to localStorage, returning a boolean indicating whether the save was successful.
  closeDialog(elements.priceDialog); // Close the price dialog after saving the prices.
  renderTable({ highlightPair: id }); // Re-render the rates table, highlighting the pair for which prices were just saved.
  renderCalculator(); // Re-render the calculator to reflect any changes in desk prices for the selected pair.
  announce(
    saved
      ? `${id} desk prices saved on this browser.`
      : `${id} prices are active for this session, but browser storage is unavailable.`,
  );
}

// Update the displayed date in the UI to reflect the current date, formatted according to the user's locale. This function uses the Intl.DateTimeFormat API for localization.
function populateDate() {
  document.querySelector("#today-label").textContent = new Intl.DateTimeFormat(
    locale,
    { weekday: "short", month: "short", day: "numeric" },
  ).format(new Date());
}

// Initialize the workspace navigation by setting up event listeners for navigation links, synchronizing the active link with the scroll position, and handling hash changes. This function ensures that the correct navigation item is highlighted based on the user's current scroll position in the document.
function initializeWorkspaceNavigation() {
  const links = [...document.querySelectorAll(".nav-item[href^='#']")]; // Select all navigation links that point to sections within the page (i.e., those with href attributes starting with "#").
  const destinations = links
    .map((link) => ({
      link,
      section: document.querySelector(link.getAttribute("href")),
    }))
    .filter(({ section }) => section);
  if (!destinations.length) return; // If there are no valid destination sections corresponding to the navigation links, exit the function early to avoid unnecessary processing.

  // Activate a specific navigation link by adding the "is-active" class and setting the "aria-current" attribute, while deactivating all other links.
  const activate = (activeLink) => {
    for (const { link } of destinations) {
      const isActive = link === activeLink; // Determine if the current link is the one to be activated.
      link.classList.toggle("is-active", isActive); // Toggle the "is-active" class on the link based on whether it is the active link, providing visual feedback to the user about which section is currently selected.
      if (isActive)
        link.setAttribute("aria-current", "location"); // Set the "aria-current" attribute to "location" for the active link to improve accessibility, indicating to assistive technologies that this link represents the current location in the document.
      else link.removeAttribute("aria-current"); // Remove the "aria-current" attribute from non-active links to ensure that only the active link is marked as representing the current location, maintaining clarity for users relying on assistive technologies.
    }
  }; // This function updates the active state of navigation links based on the currently active link.
  const syncToScrollPosition = () => {
    const readingLine = window.innerHeight * 0.4; // Define a "reading line" at 40% of the viewport height to determine which section is currently in view for activating the corresponding navigation link.
    const current = [...destinations]
      .reverse()
      .find(
        ({ section }) => section.getBoundingClientRect().top <= readingLine,
      );
    activate((current ?? destinations[0]).link); // Activate the navigation link corresponding to the section that is currently in view, or default to the first link if no sections are above the reading line.
  };

  // Add click event listeners to each navigation link to activate the corresponding section when clicked, and synchronize the active state with the scroll position.
  destinations.forEach(({ link }) =>
    link.addEventListener("click", () => activate(link)),
  ); // Add click event listeners to each navigation link to activate the corresponding section when clicked, and synchronize the active state with the scroll position.
  window.addEventListener("hashchange", syncToScrollPosition); // Add a hashchange event listener to synchronize the active navigation link with the current scroll position when the URL hash changes.
  let scrollFrame = 0; // Initialize a variable to track the requestAnimationFrame ID for scroll events, allowing for efficient synchronization of the active navigation link with the scroll position.
  window.addEventListener(
    "scroll",
    () => {
      if (scrollFrame) return; // If a scroll event is already being processed, skip additional events to avoid redundant updates and improve performance.
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = 0; // Reset the scrollFrame variable to allow for future scroll events to be processed, ensuring that the active navigation link is updated in response to user scrolling.
        syncToScrollPosition(); // Synchronize the active navigation link with the current scroll position, ensuring that the correct section is highlighted based on the user's viewport.
      });
    },
    { passive: true },
  ); // Add a passive scroll event listener to improve performance by allowing the browser to handle scrolling without blocking, while still synchronizing the active navigation link with the current scroll position.
  syncToScrollPosition(); // Perform an initial synchronization of the active navigation link with the current scroll position when the page loads, ensuring that the correct section is highlighted based on the user's initial viewport.
}

// Initialize event listeners for various UI interactions, including button taps, adding pairs, refreshing rates, changing history ranges, searching, toggling display options, and handling pair management actions. This function sets up the necessary event handlers to ensure a responsive and interactive user experience.
function initializeEvents() {
  let draggedPairId = null; // Track the ID of the currency pair currently being dragged for reordering on the board, allowing the application to manage drag-and-drop interactions and update the order of pairs accordingly.
  document.addEventListener("pointerdown", (event) => {
    const button = event.target.closest(".button"); // Add a visual "tapped" effect to buttons when they are pressed, unless the user has requested reduced motion.
    if (
      !button ||
      button.disabled ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    button.classList.remove("is-tapped"); // Remove the "is-tapped" class from the button to reset any previous tap effect, ensuring that the visual feedback is applied correctly for each new tap interaction.
    void button.offsetWidth; // Trigger a reflow to ensure that the "is-tapped" class removal is processed before adding it back, allowing the tap effect to be visually noticeable.
    button.classList.add("is-tapped"); // Add the "is-tapped" class to the button to apply the visual tap effect, providing immediate feedback to the user that the button has been pressed.
    window.setTimeout(() => button.classList.remove("is-tapped"), 440); // Remove the "is-tapped" class after a short delay (440 milliseconds) to allow the tap effect to be visible for a brief moment, enhancing the user experience without lingering too long.
  }); // Add a visual "tapped" effect to buttons when they are pressed, unless the user has requested reduced motion.
  document
    .querySelector("#add-pair-button")
    .addEventListener("click", openPairDialog);
  document
    .querySelector("#first-price-button")
    .addEventListener("click", () => openPriceDialog(settings.pairs[0]));
  elements.refreshButton.addEventListener("click", () => {
    loadRates({ announceSuccess: true }); // Refresh the reference rates when the refresh button is clicked, providing user feedback upon successful completion.
    loadPairHistory(); // Refresh the pair history for the currently selected pair when the refresh button is clicked, ensuring that the displayed historical data is up to date.
    loadMarketHistory();
    loadMarketQuotes();
    refreshCalculatorReference(currentCalculatorPair(), { force: true });
  }); // Refresh the reference rates, pair history, and calculator reference for the currently selected pair when the refresh button is clicked.
  elements.historyRanges.addEventListener("click", (event) => {
    const button = event.target.closest("[data-history-range]"); // Handle clicks on history range buttons to update the selected range and load the corresponding pair history data.
    if (
      !button ||
      button.disabled ||
      historyRange === button.dataset.historyRange
    )
      return; // Ignore clicks on disabled buttons or if the selected range is already active.
    historyRange = button.dataset.historyRange; // Update the global historyRange variable to reflect the newly selected range, which will be used to fetch and display the corresponding pair history data.
    elements.historyRanges
      .querySelectorAll("[data-history-range]")
      .forEach((rangeButton) => {
        rangeButton.setAttribute(
          "aria-pressed",
          String(rangeButton === button),
        );
      }); // Update the active state of history range buttons and load the corresponding pair history when a new range is selected.
    loadPairHistory();
  }); // Handle clicks on history range buttons to update the selected range and load the corresponding pair history data.
  elements.marketHistoryRanges.addEventListener("click", (event) => {
    const button = event.target.closest("[data-market-history-range]");
    if (!button || marketHistoryRange === button.dataset.marketHistoryRange) return;
    marketHistoryRange = button.dataset.marketHistoryRange;
    elements.marketHistoryRanges.querySelectorAll("[data-market-history-range]").forEach((rangeButton) => {
      rangeButton.setAttribute("aria-pressed", String(rangeButton === button));
    });
    loadMarketHistory();
  });
  elements.searchInput.addEventListener("input", () => {
    searchTerm = elements.searchInput.value;
    renderTable();
  });
  elements.optionsToggle.addEventListener("click", () => {
    const opening = elements.displayOptions.hidden; // Determine whether the display options are currently hidden and will be opened.
    elements.displayOptions.hidden = !opening; // Toggle the visibility of the display options section based on the current state.
    elements.optionsToggle.setAttribute("aria-expanded", String(opening)); // Update the "aria-expanded" attribute of the options toggle button to reflect the new state, improving accessibility for screen readers.
    if (opening) elements.pairFilter.focus(); // If the display options are being opened, set focus to the pair filter input for immediate user interaction.
  }); // Toggle the visibility of display options when the options toggle button is clicked, and set focus to the pair filter input if the options are being opened.
  elements.pairFilter.addEventListener("change", () => {
    view.filter = elements.pairFilter.value;
    applyViewPreferences();
    renderTable();
  });
  elements.pairSort.addEventListener("change", () => {
    view.sort = elements.pairSort.value;
    applyViewPreferences();
    renderTable();
  });
  elements.boardDensity.addEventListener("change", () => {
    view.density = elements.boardDensity.value;
    applyViewPreferences();
  });
  elements.boardTheme.addEventListener("change", () => {
    view.theme = elements.boardTheme.value;
    applyViewPreferences();
  });
  elements.themeToggle.addEventListener("click", () => {
    view.theme = view.theme === "night" ? "evergreen" : "night";
    applyViewPreferences();
    announce(view.theme === "night" ? "Night mode on." : "Bright mode on.");
  });
  elements.resetDisplayOptions.addEventListener("click", () => {
    Object.assign(view, DEFAULT_VIEW); // Reset the view preferences to their default values, including theme, density, filter, and sort options.
    applyViewPreferences(); // Apply the default view preferences to the document body and relevant UI elements, ensuring that the display reflects the reset state.
    renderTable(); // Re-render the rates table to reflect the reset display options, ensuring that the table layout and content are updated accordingly.
    announce("Board view options reset."); // Announce to the user that the board view options have been reset to their default values, providing feedback on the action taken.
  }); // Reset the display options to their default values when the reset button is clicked, and re-render the table to reflect the changes.
  elements.pairBase.addEventListener("change", updatePairPreview); // Update the pair preview in the add pair dialog whenever the base currency selection changes, providing immediate feedback to the user.
  elements.pairQuote.addEventListener("change", updatePairPreview); // Update the pair preview in the add pair dialog whenever the quote currency selection changes, providing immediate feedback to the user.
  elements.pairForm.addEventListener("submit", (event) => {
    event.preventDefault(); // Prevent the default form submission behavior to handle the pair addition logic manually.
    const base = elements.pairBase.value; // Store the selected base currency from the add pair form for validation and processing.
    const quote = elements.pairQuote.value; // Store the selected quote currency from the add pair form for validation and processing.
    const id = `${base}/${quote}`; // Construct the currency pair ID in the format "BASE/QUOTE" for validation and processing.
    if (
      base === quote ||
      !isSupportedPair(base, quote) ||
      settings.pairs.includes(id)
    ) {
      updatePairPreview(); // Update the pair preview to reflect the current selections and provide feedback if the selected pair is invalid (e.g., same base and quote, unsupported pair, or already on the board).
      return;
    } // Validate that the selected base and quote currencies are different, supported, and not already on the board before proceeding to add the new pair.
    if (settings.pairs.length >= MAX_BOARD_PAIRS) return; // Check if the board has reached its maximum capacity before adding the new pair.
    settings.pairs.push(id); // Add the new currency pair to the settings.pairs array, effectively adding it to the rates board.
    const saved = saveSettings(); // Save the updated settings to localStorage or session storage, depending on availability, and store the result of the save operation in the "saved" variable.
    closeDialog(elements.pairDialog); // Close the add pair dialog after successfully adding the new pair to the board, providing a seamless user experience.
    renderTable({ animatePair: id, highlightPair: id }); // Re-render the rates table to reflect the addition of the new pair, applying an animation to the newly added row and highlighting it for visual feedback.
    renderCalculatorOptions(); // Re-render the calculator options to include the newly added pair, ensuring that the base and quote selectors are updated with the available currencies and metals.
    loadRates(); // Load the latest reference rates for all pairs, including the newly added pair, to ensure that the rates board displays up-to-date information.
    loadPairHistory(); // Load the historical data for all pairs, including the newly added pair, to provide users with access to past rate information and trends.
    announce(
      isMetalPair(base, quote) // If the newly added pair is a metal pair, announce that it has been added and that the reference quote will appear after a metals source is configured. Otherwise, announce that the pair has been added to the rates board or for this session if browser storage is unavailable.
        ? `${id} added. The reference quote will appear after a metals source is configured.`
        : saved
          ? `${id} added to the rates board.`
          : `${id} added for this session; browser storage is unavailable.`,
    );
  }); // Handle the submission of the add pair form, validating the selected currencies and adding the new pair to the board if valid. This includes saving settings, closing the dialog, re-rendering the table and calculator options, and announcing the result to the user.
  elements.priceForm.addEventListener("submit", handlePriceSave);
  document
    .querySelector("#clear-price-button")
    .addEventListener("click", () => {
      const id = elements.pricePairId.value; // Store the ID of the currency pair for which desk prices are being cleared, as specified in the hidden input field of the price dialog.
      delete settings.prices[id]; // Remove any associated desk prices for the specified currency pair from the settings.prices object, effectively clearing the prices for that pair.
      const saved = saveSettings(); // Save the updated settings to localStorage or session storage, returning a boolean indicating whether the save operation was successful.
      closeDialog(elements.priceDialog); // Close the price dialog after clearing the desk prices for the specified currency pair, providing a seamless user experience.
      renderTable({ highlightPair: id }); // Re-render the rates table to reflect the clearing of desk prices for the specified currency pair, highlighting the row for visual feedback.
      renderCalculator(); // Re-render the calculator to ensure that any displayed results for the cleared pair are updated accordingly, reflecting the absence of desk prices.
      announce(
        saved
          ? `${id} customer prices cleared.`
          : `${id} prices cleared for this session; browser storage is unavailable.`,
      );
    }); // Handle the clearing of desk prices for a specific currency pair, updating the settings, saving them, closing the price dialog, re-rendering the table and calculator, and announcing the result to the user.
  document.body.addEventListener("click", (event) => {
    const closeButton = event.target.closest("[data-close-dialog]"); // Find the closest element with the "data-close-dialog" attribute, which indicates a request to close the nearest dialog.
    if (closeButton) {
      closeDialog(closeButton.closest("dialog")); // Handle clicks on elements with the "data-close-dialog" attribute to close the nearest dialog when clicked.
      return;
    } // Handle clicks on elements with the "data-close-dialog" attribute to close the nearest dialog when clicked.
    const editButton = event.target.closest("[data-edit-price]"); // Find the closest element with the "data-edit-price" attribute, which indicates a request to edit desk prices for a specific currency pair.
    if (editButton) {
      openPriceDialog(editButton.dataset.editPrice); // Handle clicks on elements with the "data-edit-price" attribute to open the price dialog for the specified currency pair when clicked.
      return;
    } // Handle clicks on elements with the "data-edit-price" attribute to open the price dialog for the specified currency pair when clicked.
    const flipButton = event.target.closest("[data-flip-pair]"); // Find the closest element with the "data-flip-pair" attribute, which indicates a request to flip the direction of a currency pair.
    if (flipButton) {
      flipPairDirection(flipButton.dataset.flipPair); // Handle clicks on elements with the "data-flip-pair" attribute to flip the direction of the specified currency pair when clicked.
      return;
    } // Handle clicks on elements with the "data-flip-pair" attribute to flip the direction of the specified currency pair when clicked.
    const moveButton = event.target.closest("[data-move-pair]"); // Find the closest element with the "data-move-pair" attribute, which indicates a request to move a currency pair up or down in the board order.
    if (moveButton) {
      movePairInBoard(
        moveButton.dataset.movePair,
        moveButton.dataset.moveDirection,
      ); // Handle clicks on elements with the "data-move-pair" attribute to move the specified currency pair up or down in the board order when clicked.
      return;
    } // Handle clicks on elements with the "data-move-pair" attribute to move the specified currency pair within the board when clicked.
    const removeButton = event.target.closest("[data-remove-pair]"); // Find the closest element with the "data-remove-pair" attribute, which indicates a request to remove a currency pair from the board.
    if (removeButton) {
      const id = removeButton.dataset.removePair; // Store the ID of the currency pair to be removed from the board, as specified in the "data-remove-pair" attribute of the clicked element.
      if (removeButton.disabled) return; // If the remove button is already disabled, exit the function early to prevent multiple removal actions for the same pair.
      removeButton.disabled = true; // Disable the remove button to prevent further clicks while the removal process is underway, ensuring that the user cannot trigger multiple removal actions for the same pair.
      removeButton.closest("tr")?.classList.add("row-leaving"); // Add a visual feedback class to the closest table row of the removed pair to indicate that it is being removed from the board, providing a visual cue to the user that the removal action is in progress.
      const delay = window.matchMedia("(prefers-reduced-motion: reduce)")
        .matches
        ? 0
        : 180; // Determine the delay before actually removing the pair from the settings and re-rendering the table, based on whether the user has requested reduced motion. If reduced motion is preferred, set the delay to 0; otherwise, set it to 180 milliseconds to allow for a brief visual transition effect.
      window.setTimeout(() => {
        settings.pairs = settings.pairs.filter((pair) => pair !== id); // Remove the specified currency pair from the settings.pairs array, effectively removing it from the rates board.
        delete settings.prices[id]; // Remove any associated desk prices for the specified currency pair from the settings.prices object, ensuring that no residual data remains for the removed pair.
        const saved = saveSettings(); // Save the updated settings to localStorage or session storage, returning a boolean indicating whether the save operation was successful.
        renderTable(); // Re-render the rates table to reflect the removal of the specified currency pair, updating the UI accordingly.
        loadPairHistory(); // Load the pair history data to ensure that any historical data for the removed pair is no longer displayed or accessible in the UI.
        announce(
          saved
            ? `${id} removed from the rates board.`
            : `${id} removed for this session; browser storage is unavailable.`,
        ); // Announce the result of the removal operation to the user, indicating whether the pair was successfully removed and whether the changes were saved to persistent storage or only applied for the current session.
      }, delay);
    }
  }); // Handle clicks on elements with the "data-remove-pair" attribute to remove the specified currency pair from the board when clicked, including updating settings, saving them, re-rendering the table, and announcing the result to the user.
  elements.ratesBody.addEventListener("dragstart", (event) => {
    const handle = event.target.closest("[data-drag-pair]"); // Find the closest element with the "data-drag-pair" attribute, which serves as the drag handle for a currency pair row.
    if (!handle) return; // If there is no valid drag handle, exit the function early to prevent any further processing of the dragstart event.
    draggedPairId = handle.dataset.dragPair; // Store the ID of the dragged currency pair in a variable for later use during the drag-and-drop operation.
    event.dataTransfer.effectAllowed = "move"; // Set the allowed effect for the drag operation to "move", indicating that the dragged item can be moved to a new location.
    event.dataTransfer.setData("text/plain", draggedPairId); // Set the data being transferred during the drag operation to the ID of the dragged currency pair, allowing it to be accessed during the drop event.
    handle.closest("tr")?.classList.add("is-dragging"); // Add a visual feedback class to the closest table row of the dragged element to indicate that it is currently being dragged.
  }); // Handle the start of a drag operation on a currency pair row, storing the dragged pair ID and applying visual feedback to indicate that the row is being dragged.
  elements.ratesBody.addEventListener("dragover", (event) => {
    if (!draggedPairId) return; // If there is no dragged pair ID, exit the function early to prevent any further processing of the dragover event.
    const targetRow = event.target.closest("tr[data-pair]"); // Find the closest table row element that has a "data-pair" attribute, which represents the target currency pair for the dragover operation.
    if (!targetRow || targetRow.dataset.pair === draggedPairId) return; // If there is no valid target row or if the target row is the same as the dragged pair, exit the function early to prevent any further processing of the dragover event.
    event.preventDefault(); // Prevent the default behavior of the dragover event to allow for custom handling of the drag-and-drop operation, enabling the drop effect to be applied.
    event.dataTransfer.dropEffect = "move"; // Set the drop effect for the dragover event to "move", indicating that the dragged item can be moved to a new location.
    elements.ratesBody
      .querySelectorAll(".drop-before, .drop-after")
      .forEach((row) => row.classList.remove("drop-before", "drop-after"));
    const bounds = targetRow.getBoundingClientRect(); // Get the bounding rectangle of the target row to determine its position and dimensions on the screen, which will be used to calculate whether the dragged pair should be placed before or after the target row based on the cursor position.
    const afterTarget = event.clientY > bounds.top + bounds.height / 2; // Determine whether the dragged pair should be placed after the target row based on the vertical position of the cursor relative to the midpoint of the target row's bounding rectangle.
    targetRow.classList.add(afterTarget ? "drop-after" : "drop-before"); // Add a visual feedback class to the target row to indicate whether the dragged pair will be placed before or after it, providing immediate visual feedback to the user during the drag-and-drop operation.
  }); // Handle the dragover event on the rates table body, providing visual feedback for potential drop targets and determining whether the dragged pair should be placed before or after the target row based on the cursor position.
  elements.ratesBody.addEventListener("drop", (event) => {
    if (!draggedPairId) return; // If there is no dragged pair ID, exit the function early to prevent any further processing of the drop event.
    const targetRow = event.target.closest("tr[data-pair]"); // Find the closest table row element that has a "data-pair" attribute, which represents the target currency pair for the drop operation.
    if (!targetRow) return; // If there is no valid target row, exit the function early to prevent any further processing of the drop event.
    event.preventDefault(); // Prevent the default behavior of the drop event to allow for custom handling of the drop operation.
    const sourceId = draggedPairId; // Store the ID of the dragged currency pair for reordering.
    const targetId = targetRow.dataset.pair; // Store the ID of the target currency pair where the dragged pair will be dropped.
    const afterTarget = targetRow.classList.contains("drop-after"); // Determine whether the dragged pair should be placed after the target based on the presence of the "drop-after" class on the target row.
    draggedPairId = null; // Reset the dragged pair ID to null after the drop operation is complete.
    reorderPair(sourceId, targetId, afterTarget, { restoreFocus: false });
  }); // Handle the drop event on the rates table body, reordering the dragged currency pair based on the target row and whether it should be placed before or after the target. This function also prevents the default behavior and resets the dragged pair ID.
  elements.ratesBody.addEventListener("dragend", () => {
    draggedPairId = null;
    elements.ratesBody
      .querySelectorAll(".is-dragging, .drop-before, .drop-after")
      .forEach((row) =>
        row.classList.remove("is-dragging", "drop-before", "drop-after"),
      );
  }); // Handle the end of a drag operation on the rates table body, resetting the dragged pair ID and removing any visual feedback classes from the rows.
  for (const dialog of [elements.pairDialog, elements.priceDialog]) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  } // Allow users to close the pair and price dialogs by clicking outside the dialog content area, while preventing accidental closure when interacting with the dialog's content.
  elements.calculatorBase.addEventListener("change", () =>
    changeCalculatorCurrencies("base"),
  ); // Handle changes to the calculator's base currency selector, ensuring that the two currencies are not the same and updating the calculator results accordingly.
  elements.calculatorQuote.addEventListener("change", () =>
    changeCalculatorCurrencies("quote"),
  ); // Handle changes to the calculator's quote currency selector, ensuring that the two currencies are not the same and updating the calculator results accordingly.
  elements.swapCurrencies.addEventListener("click", () => {
    const base = elements.calculatorBase.value; // Store the current base currency value before swapping.
    elements.calculatorBase.value = elements.calculatorQuote.value; // Swap the base currency value with the current quote currency value.
    elements.calculatorQuote.value = base; // Swap the quote currency value with the previously stored base currency value.
    changeCalculatorCurrencies("quote"); // Call the function to handle the change in calculator currencies, passing "quote" as the changed selector to ensure that the two currencies are not the same and updating the calculator results accordingly.
  }); // Handle the swapping of the calculator's base and quote currencies when the swap button is clicked, updating the selectors and re-rendering the calculator results accordingly.
  elements.calculatorAddPair.addEventListener(
    "click",
    addCalculatorPairToBoard,
  ); // Handle the addition of the currently selected calculator pair to the rates board when the add pair button is clicked, validating the pair and updating the settings and UI accordingly.
  elements.calculatorAmount.addEventListener("input", renderCalculator); // Handle input changes to the calculator's amount field, re-rendering the calculator results based on the entered amount and the selected currencies.
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "/" &&
      !["INPUT", "TEXTAREA", "SELECT"].includes(
        document.activeElement.tagName,
      ) &&
      !elements.pairDialog.open &&
      !elements.priceDialog.open
    ) {
      event.preventDefault(); // Prevent the default browser behavior for the "/" key to avoid conflicts with search functionality.
      elements.searchInput.focus(); // Focus the search input field when the "/" key is pressed, allowing users to quickly start searching for currency pairs without manually clicking on the input field.
    }
  });
}

/* Initialize the application by applying view preferences, populating the current date, setting up event listeners, initializing workspace navigation, 
rendering the rates table, loading cached reference rates if available, and fetching the latest currencies, rates, and pair history. Additionally, 
set up a periodic refresh of rates every 30 minutes when the document is visible.*/
applyViewPreferences({ persist: false }); // Apply the user's view preferences (theme, density, filter, sort) to the document body and relevant UI elements without persisting them to localStorage.
populateDate(); // Update the displayed date in the UI to reflect the current date, formatted according to the user's locale.
initializeEvents(); // Set up event listeners for various UI interactions, including button taps, adding pairs, refreshing rates, changing history ranges, searching, toggling display options, and handling pair management actions.
initializeWorkspaceNavigation(); // Set up the workspace navigation by synchronizing the active link with the scroll position and handling hash changes, ensuring that the correct navigation item is highlighted based on the user's current scroll position in the document.
renderTable(); // Render the rates table based on the current settings, view preferences, and available reference rates, applying any necessary animations or highlights for updated pairs.
const browserCache = readReferenceCache(); // Read cached reference rates from localStorage to provide a fallback in case the network request fails or is delayed.
if (browserCache) {
  // If cached reference rates are available in localStorage, use them to populate the reference rates and metadata, and render the table with a pending cache status.
  referenceRates = browserCache.rates; // Populate the reference rates from the cached data in localStorage.
  referenceMeta = {
    cacheStatus: "browser-cache-pending",
    errors: [],
    retrievedAt: browserCache.retrievedAt,
    checkedAt: browserCache.retrievedAt,
  }; // Populate the reference metadata with a pending cache status and the retrieved timestamp from the cached data.
  renderTable({ animateRows: true }); // Render the rates table with an animation to indicate that the data is being loaded from the browser cache, providing a visual cue to the user that the rates are being updated.
} // If cached reference rates are not available, the application will proceed to fetch the latest currencies, rates, and pair history from the network.
loadCurrencies(); // Fetch the latest list of available currencies and metals from the network, updating the internal state and UI accordingly.
loadRates(); // Fetch the latest reference rates for the selected currency pairs from the network, updating the internal state and UI accordingly.
loadPairHistory(); // Fetch the historical data for the selected currency pairs from the network, updating the internal state and UI accordingly.
renderMarketHistory();
loadMarketHistory();
loadMarketQuotes();
window.setInterval(
  () => {
    if (document.visibilityState === "visible") {
      loadRates();
      loadMarketQuotes();
    }
  },
  30 * 60 * 1000,
); // Set up a periodic refresh of reference rates every 30 minutes, but only when the document is visible to the user, to avoid unnecessary network requests when the application is not in use.
window.setInterval(
  () => {
    if (document.visibilityState === "visible") loadMarketQuotes();
  },
  5 * 60 * 1000,
);
