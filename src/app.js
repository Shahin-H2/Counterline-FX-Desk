// Copyright 2024 Counterline, Inc. All rights reserved.
import { compareDecimals, formatDecimal, isPositiveDecimal, multiplyAndRound, parseDecimal } from "./domain/decimal.js";
import { isObservationStale } from "./domain/freshness.js";

// Storage keys
const STORAGE_KEY = "counterline-fx-prices-v1";
const REFERENCE_CACHE_KEY = "counterline-fx-reference-cache-v1";
const CURRENCY_CACHE_KEY = "counterline-fx-currencies-v1";
const VIEW_STORAGE_KEY = "counterline-fx-view-v1";
const DEFAULT_VIEW = { filter: "all", sort: "board", density: "comfortable", theme: "evergreen" };
const DEFAULT_PAIRS = ["USD/EUR", "USD/CAD", "USD/MXN", "USD/GBP", "USD/TRY", "USD/INR", "USD/JPY", "USD/CHF"];
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
  ratesBody: document.querySelector("#rates-body"),     // tbody for the main rate board
  pairTotal: document.querySelector("#pair-total"),     // total count of pairs on the board
  navPairCount: document.querySelector("#nav-pair-count"),  // total count of pairs in the navigation bar
  feedPill: document.querySelector("#feed-pill"),     // the status indicator in the navigation bar
  rateDate: document.querySelector("#rate-date"),       // the date of the most recent reference observation
  checkedAt: document.querySelector("#checked-at"),     // the time the reference feed was last checked
  feedAlert: document.querySelector("#feed-alert"),   // the alert box for feed issues
  sidebarFeedStatus: document.querySelector("#sidebar-feed-status"),  // the text in the sidebar showing the feed status
  refreshButton: document.querySelector("#refresh-button"), // the button to refresh the reference feed
  searchInput: document.querySelector("#search-input"),     // the input for searching pairs
  emptySearch: document.querySelector("#empty-search"),     // the empty state message when no pairs match the search/filter
  optionsToggle: document.querySelector("#display-options-toggle"), // the button to toggle the display options panel
  displayOptions: document.querySelector("#display-options"),       // the panel containing display options
  pairFilter: document.querySelector("#pair-filter"),     // the select input for filtering pairs
  pairSort: document.querySelector("#pair-sort"),         // the select input for sorting pairs
  boardDensity: document.querySelector("#board-density"), // the select input for changing the density of the board
  boardTheme: document.querySelector("#board-theme"),     // the select input for changing the theme of the board
  resetDisplayOptions: document.querySelector("#reset-display-options"),  // the button to reset display options to default
  pairDialog: document.querySelector("#pair-dialog"),     // the dialog for adding a new pair
  pairForm: document.querySelector("#pair-form"),         // the form inside the pair dialog
  pairBase: document.querySelector("#pair-base"),         // the input for the base currency in the pair dialog
  pairQuote: document.querySelector("#pair-quote"),       // the input for the quote currency in the pair dialog
  pairPreview: document.querySelector("#pair-preview"),   // the preview of the pair in the pair dialog
  priceDialog: document.querySelector("#price-dialog"),   // the dialog for setting prices
  priceForm: document.querySelector("#price-form"),       // the form inside the price dialog
  pricePairId: document.querySelector("#price-pair-id"),  // the hidden input for the pair ID in the price dialog
  priceDialogTitle: document.querySelector("#price-dialog-title"),  // the title of the price dialog
  priceDialogDescription: document.querySelector("#price-dialog-description"),  // the description of the price dialog
  priceBuy: document.querySelector("#price-buy"),         // the input for the buy price in the price dialog
  priceSell: document.querySelector("#price-sell"),       // the input for the sell price in the price dialog
  priceReferenceRate: document.querySelector("#price-reference-rate"),  // the element showing the reference rate in the price dialog
  priceReferenceDate: document.querySelector("#price-reference-date"),  // the element showing the reference date in the price dialog
  priceValidation: document.querySelector("#price-validation"), // the element showing validation messages in the price dialog
  calculatorBase: document.querySelector("#calculator-base"),   // the select input for the base currency in the calculator
  calculatorQuote: document.querySelector("#calculator-quote"), // the select input for the quote currency in the calculator
  swapCurrencies: document.querySelector("#swap-currencies"),   // the button to swap the base and quote currencies in the calculator
  calculatorBaseCode: document.querySelector("#calculator-base-code"),  // the element showing the base currency code in the calculator
  calculatorAmount: document.querySelector("#calculator-amount"),       // the input for the amount in the calculator
  calculatorReferenceResult: document.querySelector("#calculator-reference-result"),  // the element showing the reference result in the calculator
  calculatorReferenceMeta: document.querySelector("#calculator-reference-meta"),      // the element showing the reference meta information in the calculator
  calculatorBuyResult: document.querySelector("#calculator-buy-result"),    // the element showing the buy result in the calculator
  calculatorSellResult: document.querySelector("#calculator-sell-result"),  // the element showing the sell result in the calculator
  calculatorAddPair: document.querySelector("#calculator-add-pair"),  // the button to add the calculator pair to the board
  historyGrid: document.querySelector("#history-grid"),       // the container for the history charts
  historyStatus: document.querySelector("#history-status"),   // the element showing the status of the history loading
  historyRanges: document.querySelector(".history-controls"), // the container for the history range buttons
  announcements: document.querySelector("#announcements"),    // the live region for announcing changes to screen readers
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
  return typeof value === "string" && /^[A-Z]{3}\/[A-Z]{3}$/.test(value) && value.slice(0, 3) !== value.slice(4);
}

// Load settings from localStorage, ensuring that the pairs and prices are valid and within the allowed limits.
function loadSettings() {
  const saved = readJson(STORAGE_KEY, null);
  if (!saved || typeof saved !== "object") return { pairs: [...DEFAULT_PAIRS], prices: {} };
  const pairs = Array.isArray(saved.pairs)
    ? [...new Set(saved.pairs.filter(validPairId))].slice(0, MAX_BOARD_PAIRS)
    : [...DEFAULT_PAIRS];
  const prices = {};
  if (saved.prices && typeof saved.prices === "object") {
    for (const [id, value] of Object.entries(saved.prices)) {
      if (!validPairId(id) || !value || typeof value !== "object") continue;
      const buy = value.buy === "" || value.buy == null ? "" : String(value.buy);
      const sell = value.sell === "" || value.sell == null ? "" : String(value.sell);
      if ((buy === "" || (MANUAL_RATE_PATTERN.test(buy) && isPositiveDecimal(buy, { maxScale: 8 }))) && (sell === "" || (MANUAL_RATE_PATTERN.test(sell) && isPositiveDecimal(sell, { maxScale: 8 }))) && (buy || sell)) prices[id] = { buy, sell };
    }
  }
  return { pairs, prices };
}

// Initialize application state
const settings = loadSettings();
const savedView = readJson(VIEW_STORAGE_KEY, {}) ?? {};
const view = {
  filter: ["all", "needs-prices", "priced", "reference-issues"].includes(savedView.filter) ? savedView.filter : DEFAULT_VIEW.filter,
  sort: ["board", "code", "name", "rate-high", "rate-low"].includes(savedView.sort) ? savedView.sort : DEFAULT_VIEW.sort,
  density: ["comfortable", "compact"].includes(savedView.density) ? savedView.density : DEFAULT_VIEW.density,
  theme: ["evergreen", "night"].includes(savedView.theme) ? savedView.theme : DEFAULT_VIEW.theme,
};  // The view settings control how the board is displayed, including filtering, sorting, density, and theme.
let referenceRates = {};
let referenceMeta = { cacheStatus: "loading", errors: [], retrievedAt: null, checkedAt: null };
let currencies = [];
let searchTerm = "";
let hasAnimatedRows = false;
const calculatorLookupState = new Map();
let previousCalculatorSelection = { base: "USD", quote: "EUR" };
let historyRange = "1m";
let pairHistory = {};
let historyRequestId = 0;
let historyLoading = false;

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
  return METAL_ASSETS.find((asset) => asset.code === code)?.symbol ?? code.slice(0, 2);
}

// Check if either the base or quote currency is a metal (gold or silver).
function isMetalPair(base, quote) {
  return METAL_CODES.has(base) || METAL_CODES.has(quote);
}

// Check if a currency pair is supported for reference rates. Gold and silver pairs must be paired with USD.
function isSupportedPair(base, quote) {
  if (!isMetalPair(base, quote)) return true;
  return (METAL_CODES.has(base) && quote === "USD") || (base === "USD" && METAL_CODES.has(quote));
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
  if (!next.some((currency) => currency.code === "USD")) next.push({ code: "USD", name: "US Dollar", symbol: "$" });
  if (!next.some((currency) => currency.code === "IRR")) next.push({ code: "IRR", name: "Iranian Rial", symbol: "﷼" });
  for (const asset of METAL_ASSETS) {
    if (!next.some((currency) => currency.code === asset.code)) next.push(asset);
  }
  return next;
}

// Escape HTML special characters in a string to prevent XSS vulnerabilities when rendering user-provided content.
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

// Format a date string (YYYY-MM-DD) into a human-readable format based on the user's locale and specified options.
function formatDate(dateString, options = { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) {
  if (!dateString) return "Date unavailable";
  const date = new Date(`${dateString.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(locale, options).format(date);
}

// Format the time when the reference feed was last checked, or return a default message if unavailable.
function formatCheckedAt(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "Check time unavailable";
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

// Format the observed date and time of a reference rate, or fall back to the date if the observed time is unavailable.
function formatRateObservation(rate, dateOptions = { month: "short", day: "numeric", timeZone: "UTC" }) {
  const options = { month: "short", day: "numeric", timeZone: "UTC", ...dateOptions };
  if (rate?.observedAt && !Number.isNaN(new Date(rate.observedAt).getTime())) {
    return new Intl.DateTimeFormat(locale, { ...options, hour: "numeric", minute: "2-digit" }).format(new Date(rate.observedAt));
  }
  return formatDate(rate?.date, options);
}

// Format a currency pair rate to a string with a specified number of decimal places, ensuring that it is displayed in a user-friendly format.
function formatPairRate(rate) {
  return formatDecimal(rate, locale, 2, 8);
}

// Render the historical chart for a currency pair, including the line graph, area fill, grid lines, and data points. If no observations are available, display an appropriate message or loading state.
function historyChartMarkup(id, observations, cardIndex) {
  const { base, quote } = pairParts(id);
  const points = (Array.isArray(observations) ? observations : [])
    .filter((item) => item && /^\d{4}-\d{2}-\d{2}$/.test(item.date) && Number.isFinite(Number(item.rate)) && Number(item.rate) > 0)
    .map((item) => ({ date: item.date, rate: String(item.rate), value: Number(item.rate) }));
  const currencyLabel = `${currencyName(base)} / ${currencyName(quote)}`;
  if (!points.length) {
    if (historyLoading) {
      return `<article class="history-card history-card-loading" role="listitem" aria-hidden="true"><div class="history-loading-line"></div><div class="history-loading-rate"></div><div class="history-loading-chart"></div></article>`;
    }
    return `<article class="history-card history-card-empty" role="listitem"><div class="history-card-title"><div><h3>${escapeHtml(base)} <span aria-hidden="true">→</span> ${escapeHtml(quote)}</h3><p>${escapeHtml(currencyLabel)}</p></div></div><div class="history-empty-state"><span class="history-empty-icon" aria-hidden="true">⌁</span><strong>No history in this range</strong><span>The source may not publish on these dates or cover this currency.</span></div></article>`;
  }
  // Calculate the dimensions and coordinates for the chart, including the min/max values, padding, and scaling for the SVG elements.
  const width = 680;
  const height = 190;
  const plot = { left: 64, right: 666, top: 16, bottom: 143 };
  const values = points.map((point) => point.value);
  const observedMin = Math.min(...values);
  const observedMax = Math.max(...values);
  const padding = observedMax === observedMin ? Math.max(Math.abs(observedMax) * 0.035, 0.00000001) : (observedMax - observedMin) * 0.12;
  const low = Math.max(0, observedMin - padding);
  const high = observedMax + padding;
  const span = high - low || 1;
  const coordinate = (point, index) => ({
    x: points.length === 1 ? (plot.left + plot.right) / 2 : plot.left + (plot.right - plot.left) * index / (points.length - 1),
    y: plot.bottom - (point.value - low) / span * (plot.bottom - plot.top),
  }); // Map each data point to its corresponding x and y coordinates within the SVG plot area.
  const coords = points.map(coordinate);
  const line = coords.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
  const area = `${line} L${coords.at(-1).x.toFixed(2)} ${plot.bottom} L${coords[0].x.toFixed(2)} ${plot.bottom} Z`;
  const gradientId = `history-area-${cardIndex}`;
  const yLabels = [high, (high + low) / 2, low];
  const grid = yLabels.map((value, index) => {
    const y = plot.top + (plot.bottom - plot.top) * index / 2;
    return `<g class="history-gridline"><line x1="${plot.left}" y1="${y.toFixed(2)}" x2="${plot.right}" y2="${y.toFixed(2)}"/><text x="${plot.left - 10}" y="${(y + 4).toFixed(2)}" text-anchor="end">${escapeHtml(formatPairRate(String(value)))}</text></g>`;
  }).join("");  // Render the horizontal grid lines and their corresponding labels for the min, mid, and max values of the chart.
  const dots = coords.map((point, index) => `<circle class="history-point" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="2.35"><title>${escapeHtml(formatDate(points[index].date))}: ${escapeHtml(formatPairRate(points[index].rate))} ${escapeHtml(quote)}</title></circle>`).join("");
  const firstDate = formatDate(points[0].date, { month: "short", day: "numeric" });
  const lastDate = formatDate(points.at(-1).date, { month: "short", day: "numeric" });
  const latest = points.at(-1);
  const ariaLabel = `${base} to ${quote} daily reference rate from ${formatDate(points[0].date)} to ${formatDate(latest.date)}`;
  // Return the complete HTML markup for the history card, including the title, latest rate, chart, and footer with low/high values.
  return `<article class="history-card" role="listitem"> 
    <div class="history-card-title"><div><h3>${escapeHtml(base)} <span aria-hidden="true">→</span> ${escapeHtml(quote)}</h3><p>${escapeHtml(currencyLabel)}</p></div><span class="history-observation-count">${points.length} ${points.length === 1 ? "point" : "points"}</span></div>
    <div class="history-latest"><span>1 ${escapeHtml(base)} <span aria-hidden="true">=</span></span><strong>${escapeHtml(formatPairRate(latest.rate))}</strong><small>${escapeHtml(quote)} · ${escapeHtml(formatDate(latest.date))}</small></div>
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
    ? settings.pairs.map((id, index) => historyChartMarkup(id, pairHistory[id], index)).join("")
    : '<div class="history-board-empty" role="listitem"><strong>No currency pairs yet</strong><span>Add a pair to see its rate history here.</span></div>';
}

// Load the historical reference rates for the current pairs and range, updating the UI with loading states, errors, and the resulting data.
async function loadPairHistory() {
  const requestId = ++historyRequestId;
  if (!settings.pairs.length) {
    pairHistory = {};
    historyLoading = false;
    renderPairHistory();
    elements.historyStatus.textContent = "Add currency pairs to view daily history.";
    return;
  } // If there are no pairs on the board, clear the history and show a message indicating that pairs need to be added.
  pairHistory = {};
  historyLoading = true;
  renderPairHistory();
  elements.historyStatus.textContent = "Loading daily reference history…";
  const pairs = [...settings.pairs];
  const query = encodeURIComponent(pairs.map((id) => id.replace("/", ":")).join("|"));
  try {
    const response = await fetch(`/api/history?pairs=${query}&range=${encodeURIComponent(historyRange)}`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Historical data unavailable");
    const body = await response.json();
    if (requestId !== historyRequestId) return;
    historyLoading = false;
    pairHistory = body.rates && typeof body.rates === "object" ? body.rates : {};
    const coveredPairs = pairs.filter((id) => Array.isArray(pairHistory[id]) && pairHistory[id].length).length;
    const hasErrors = Array.isArray(body.errors) && body.errors.length > 0;
    elements.historyStatus.textContent = hasErrors || coveredPairs < pairs.length
      ? `Daily history · ${coveredPairs} of ${pairs.length} pairs have observations in this range. Gaps or unsupported currencies may leave some charts empty.`
      : `Daily reference history · ${pairs.length} ${pairs.length === 1 ? "pair" : "pairs"} · ${historyRange.toUpperCase()} view`;
    renderPairHistory();
  } catch {
    if (requestId !== historyRequestId) return;
    historyLoading = false;
    pairHistory = {};
    elements.historyStatus.textContent = "Historical rates could not be loaded. Try selecting the range again.";
    renderPairHistory();
  }
}

// Determine the number of decimal places to display for a given currency code, using the Intl.NumberFormat API to get the maximum fraction digits for that currency. If the currency is a metal (gold or silver), return 8 decimal places. If the currency code is invalid or not supported, default to 2 decimal places.
function amountDigits(code) {
  if (METAL_CODES.has(code)) return 8;
  try {
    const digits = new Intl.NumberFormat(locale, { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
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
  window.setTimeout(() => { elements.announcements.textContent = message; }, 30);
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
  const boardRates = settings.pairs.map((id) => referenceRates[id]).filter(Boolean);
  const ratesAvailable = boardRates.length > 0;
  const stalePairs = currentStalePairs();
  const missingPairs = settings.pairs.filter((id) => !referenceRates[id]);
  const hasErrors = referenceMeta.errors?.length > 0;
  const metalProviderNeeded = referenceMeta.errors?.some((error) => error.code === "provider-not-configured");
  let label = "Live lookup";
  let state = "fresh";

  // Determine the appropriate label and state for the feed pill based on the availability of rates, cache status, and any errors or missing pairs.
  if (!ratesAvailable) {
    label = metalProviderNeeded ? "Source needed" : referenceMeta.cacheStatus === "error" || hasErrors ? "Unavailable" : "Waiting";
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
  } else if (hasErrors || missingPairs.length || referenceMeta.cacheStatus === "partial" || referenceMeta.cacheStatus === "partial-cache") {
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
    elements.checkedAt.textContent = referenceMeta.checkedAt ? `Last checked ${formatCheckedAt(referenceMeta.checkedAt)}` : "Waiting for the first provider response";
  } else {  // If rates are available, determine the latest observation date and update the rate date and checked at information accordingly.
    const dates = boardRates.map((rate) => rate.date).filter(Boolean).sort();
    const latestDate = dates.at(-1);
    elements.rateDate.textContent = latestDate ? formatDate(latestDate) : "Date unavailable";
    elements.checkedAt.textContent = `${referenceMeta.cacheStatus === "stale-cache" ? "Last successful fetch" : "Checked"} ${formatCheckedAt(referenceMeta.cacheStatus === "stale-cache" ? referenceMeta.retrievedAt : referenceMeta.checkedAt)} · pair dates shown below`;
  }

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
  }
  elements.feedAlert.hidden = !alertText;
  elements.feedAlert.dataset.kind = alertKind;
  elements.feedAlert.textContent = alertText;
}

function priceText(price, quote, className = "") {
  if (!price) return `<span class="price-readout ${className}">—</span>`;
  return `<span class="price-readout ${className}">${escapeHtml(formatPairRate(price))} <small>${escapeHtml(quote)}</small></span>`;
}

function renderTable({ animateRows = false, animatePair = null, highlightPair = null } = {}) {
  elements.pairTotal.textContent = `${settings.pairs.length} pair${settings.pairs.length === 1 ? "" : "s"}`;
  elements.navPairCount.textContent = String(settings.pairs.length).padStart(2, "0");
  if (!settings.pairs.length) {
    elements.ratesBody.innerHTML = `<tr class="loading-row"><td colspan="5">No currency pairs on this board yet. Add one to begin.</td></tr>`;
    elements.emptySearch.hidden = true;
    renderCalculatorOptions();
    updateFeedStatus();
    renderPairHistory();
    return;
  }

  const normalizedSearch = searchTerm.trim().toLocaleLowerCase(locale);
  const visiblePairs = settings.pairs.filter((id) => {
    const { base, quote } = pairParts(id);
    const text = `${base} ${quote} ${currencyName(base)} ${currencyName(quote)}`.toLocaleLowerCase(locale);
    if (!text.includes(normalizedSearch)) return false;
    const prices = settings.prices[id] ?? {};
    if (view.filter === "needs-prices" && prices.buy && prices.sell) return false;
    if (view.filter === "priced" && !(prices.buy && prices.sell)) return false;
    if (view.filter === "reference-issues") {
      const rate = referenceRates[id];
      const hasReferenceIssue = !rate || isObservationStale(rate.date, new Date()) || rate.cacheFallback || ["stale-cache", "error"].includes(referenceMeta.cacheStatus);
      if (!hasReferenceIssue) return false;
    }
    return true;
  });
  const sortedPairs = [...visiblePairs];
  if (view.sort === "code") sortedPairs.sort((a, b) => a.localeCompare(b));
  if (view.sort === "name") sortedPairs.sort((a, b) => {
    const aParts = pairParts(a); const bParts = pairParts(b);
    return `${currencyName(aParts.base)} ${currencyName(aParts.quote)}`.localeCompare(`${currencyName(bParts.base)} ${currencyName(bParts.quote)}`, locale);
  });
  if (view.sort === "rate-high" || view.sort === "rate-low") sortedPairs.sort((a, b) => {
    const aRate = referenceRates[a]?.rate; const bRate = referenceRates[b]?.rate;
    if (!aRate && !bRate) return 0;
    if (!aRate) return 1;
    if (!bRate) return -1;
    const order = compareDecimals(aRate, bRate);
    return view.sort === "rate-high" ? -order : order;
  });
  elements.emptySearch.hidden = sortedPairs.length > 0;
  if (!sortedPairs.length) {
    const title = elements.emptySearch.querySelector("strong");
    const message = elements.emptySearch.querySelector("span");
    if (title && message) {
      const filtered = view.filter !== "all";
      title.textContent = normalizedSearch ? "No pairs found" : "No pairs match these options";
      message.textContent = normalizedSearch ? "Try another code, name, or board filter." : filtered ? "Adjust the filter or add prices to see more pairs." : "Try a currency code or name.";
    }
  }
  if (!visiblePairs.length) {
    elements.ratesBody.innerHTML = "";
  } else {
    elements.ratesBody.innerHTML = sortedPairs.map((id, index) => {
      const { base, quote } = pairParts(id);
      const rate = referenceRates[id];
      const pairPrices = settings.prices[id] ?? { buy: "", sell: "" };
      const boardIndex = settings.pairs.indexOf(id);
      const rowClasses = [animateRows || animatePair === id ? "row-enter" : "", highlightPair === id ? "row-highlight" : ""].filter(Boolean).join(" ");
      const stale = rate && (isObservationStale(rate.date, new Date()) || rate.cacheFallback || referenceMeta.cacheStatus === "stale-cache" || referenceMeta.cacheStatus === "error");
      const cached = rate && (rate.cacheFallback || referenceMeta.cacheStatus === "stale-cache" || referenceMeta.cacheStatus === "error" || referenceMeta.cacheStatus === "browser-cache-pending");
      const refDate = rate ? formatRateObservation(rate, { month: "short", day: "numeric" }) : "—";
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
    }).join("");
  }
  if (animateRows) hasAnimatedRows = true;
  updateFeedStatus();
  renderCalculatorOptions();
  renderPairHistory();
}

function readReferenceCache() {
  const cached = readJson(REFERENCE_CACHE_KEY, null);
  if (!cached || typeof cached !== "object" || !cached.rates || typeof cached.rates !== "object") return null;
  const rates = {};
  for (const [id, rate] of Object.entries(cached.rates)) {
    if (validPairId(id) && rate && isPositiveDecimal(String(rate.rate)) && /^\d{4}-\d{2}-\d{2}$/.test(String(rate.date))) rates[id] = rate;
  }
  return Object.keys(rates).length ? { ...cached, rates } : null;
}

async function loadCurrencies() {
  try {
    const response = await fetch("/api/currencies");
    if (!response.ok) throw new Error("Currency list unavailable");
    const body = await response.json();
    if (!Array.isArray(body.currencies)) throw new Error("Unexpected currency list");
    currencies = body.currencies.filter((item) => /^[A-Z]{3}$/.test(item.code) && typeof item.name === "string");
    currencies = ensureSpecialAssets(currencies);
    writeJson(CURRENCY_CACHE_KEY, currencies);
  } catch {
    const cached = readJson(CURRENCY_CACHE_KEY, []);
    if (Array.isArray(cached)) currencies = cached.filter((item) => item && /^[A-Z]{3}$/.test(item.code) && typeof item.name === "string");
    currencies = ensureSpecialAssets(currencies);
  }
  renderTable();
  const selectedPair = currentCalculatorPair();
  if (!settings.pairs.includes(selectedPair)) refreshCalculatorReference(selectedPair);
}

async function loadRates({ announceSuccess = false } = {}) {
  const pairs = settings.pairs.map(pairParts);
  if (!pairs.length) return;
  elements.refreshButton.classList.add("is-refreshing");
  elements.refreshButton.disabled = true;
  const query = encodeURIComponent(settings.pairs.map((id) => id.replace("/", ":")).join("|"));
  try {
    const response = await fetch(`/api/rates?pairs=${query}`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Reference feed unavailable");
    const body = await response.json();
    if (!body.rates || typeof body.rates !== "object") throw new Error("Unexpected reference data");
    const returnedRates = body.rates;
    const nextRates = { ...referenceRates };
    for (const [id, rate] of Object.entries(returnedRates)) nextRates[id] = { ...rate, cacheFallback: Boolean(rate.cacheFallback) };
    const fallbackPairs = [];
    for (const id of settings.pairs) {
      if (!returnedRates[id] && nextRates[id]) {
        nextRates[id] = { ...nextRates[id], cacheFallback: true };
        fallbackPairs.push(id);
      }
    }
    referenceRates = nextRates;
    const bodyCacheStatus = body.cacheStatus ?? "fresh";
    const cacheStatus = fallbackPairs.length && bodyCacheStatus !== "stale-cache" ? "partial-cache" : bodyCacheStatus;
    const errors = Array.isArray(body.errors) ? [...body.errors] : [];
    if (fallbackPairs.length && !errors.length) errors.push({ message: "Some currency pairs are using a previous browser reference cache." });
    referenceMeta = {
      cacheStatus,
      errors,
      retrievedAt: body.retrievedAt ?? null,
      checkedAt: body.checkedAt ?? body.retrievedAt ?? null,
    };
    if (Object.keys(returnedRates).length) {
      writeJson(REFERENCE_CACHE_KEY, { rates: referenceRates, retrievedAt: referenceMeta.retrievedAt, source: body.source });
    }
    renderTable({ animateRows: !hasAnimatedRows });
    renderCalculator();
    if (announceSuccess) announce("Reference rates refreshed.");
  } catch {
    const cached = readReferenceCache();
    if (!Object.keys(referenceRates).length && cached) referenceRates = cached.rates;
    referenceMeta = {
      cacheStatus: "error",
      errors: [{ message: "Reference feed unavailable." }],
      retrievedAt: cached?.retrievedAt ?? null,
      checkedAt: new Date().toISOString(),
    };
    renderTable({ animateRows: !hasAnimatedRows });
    renderCalculator();
    if (announceSuccess) announce("The reference provider could not be reached.");
  } finally {
    elements.refreshButton.classList.remove("is-refreshing");
    elements.refreshButton.disabled = false;
  }
}

function renderCalculatorOptions() {
  const previousBase = elements.calculatorBase.value;
  const previousQuote = elements.calculatorQuote.value;
  const options = [...currencies];
  for (const id of settings.pairs) {
    for (const code of id.split("/")) {
      if (!options.some((currency) => currency.code === code)) options.push({ code, name: code });
    }
  }
  for (const currency of ensureSpecialAssets([])) {
    if (!options.some((option) => option.code === currency.code)) options.push(currency);
  }
  options.sort((a, b) => a.code.localeCompare(b.code));
  const markup = options.map(({ code, name }) => `<option value="${escapeHtml(code)}">${escapeHtml(code)} · ${escapeHtml(name)}</option>`).join("");
  elements.calculatorBase.innerHTML = markup;
  elements.calculatorQuote.innerHTML = markup;
  const preferred = pairParts(settings.pairs[0] ?? "USD/EUR");
  elements.calculatorBase.value = options.some((currency) => currency.code === previousBase) ? previousBase : options.some((currency) => currency.code === preferred.base) ? preferred.base : options[0]?.code ?? "";
  elements.calculatorQuote.value = options.some((currency) => currency.code === previousQuote && currency.code !== elements.calculatorBase.value)
    ? previousQuote
    : options.some((currency) => currency.code === preferred.quote && currency.code !== elements.calculatorBase.value)
      ? preferred.quote
      : options.find((currency) => currency.code !== elements.calculatorBase.value)?.code ?? "";
  previousCalculatorSelection = { base: elements.calculatorBase.value, quote: elements.calculatorQuote.value };
  renderCalculator();
}

function currentCalculatorPair() {
  const base = elements.calculatorBase.value;
  const quote = elements.calculatorQuote.value;
  return base && quote && base !== quote ? `${base}/${quote}` : "";
}

function renderCalculator() {
  const id = currentCalculatorPair();
  if (!id) {
    elements.calculatorBaseCode.textContent = elements.calculatorBase.value || "—";
    elements.calculatorReferenceResult.textContent = "Choose two different currencies";
    elements.calculatorReferenceMeta.textContent = "Select a base and quote currency to continue.";
    elements.calculatorBuyResult.textContent = "Choose a pair";
    elements.calculatorSellResult.textContent = "Choose a pair";
    elements.calculatorAddPair.hidden = true;
    return;
  }
  const { base, quote } = pairParts(id);
  const metalPair = isMetalPair(base, quote);
  const metalDirectionSupported = isSupportedPair(base, quote);
  const amount = elements.calculatorAmount.value || "0";
  const onBoard = settings.pairs.includes(id);
  const rate = referenceRates[id];
  const prices = settings.prices[id] ?? {};
  const amountValue = parseDecimal(amount);
  elements.calculatorBaseCode.textContent = base;
  const referenceResult = metalDirectionSupported && rate && amountValue && amountValue.coefficient > 0n
    ? multiplyAndRound(amount, rate.rate, amountDigits(quote))
    : null;
  const lookupState = calculatorLookupState.get(id);
  elements.calculatorReferenceResult.textContent = referenceResult
    ? `${formatDecimal(referenceResult, locale, amountDigits(quote), amountDigits(quote))} ${quote}`
    : !amountValue || amountValue.coefficient <= 0n
      ? "Enter an amount"
      : !metalDirectionSupported ? "Use USD with gold or silver" : lookupState === "loading" ? "Looking up reference…" : "Reference rate unavailable";
  if (rate) {
    const stale = isObservationStale(rate.date, new Date()) || rate.cacheFallback || (onBoard && ["stale-cache", "error"].includes(referenceMeta.cacheStatus));
    const cached = rate.cacheFallback || lookupState === "cached" || (onBoard && ["cached", "stale-cache", "error", "browser-cache-pending"].includes(referenceMeta.cacheStatus));
    elements.calculatorReferenceMeta.textContent = `${rate.source ?? (metalPair ? "Metal reference" : "Frankfurter daily reference")} · ${formatRateObservation(rate)}${stale ? " · STALE" : cached ? " · CACHED" : ""} · not a customer quote`;
  } else {
    elements.calculatorReferenceMeta.textContent = lookupState === "error" || lookupState === "missing"
      ? metalPair ? "Gold and silver quotes need a metals data source." : "No Frankfurter observation is available for this pair."
      : metalPair ? `Pair convention: ${metalPairUnit(base, quote)}; metals feed not configured.` : "Frankfurter daily reference · not a customer quote";
  }
  for (const [side, output] of [["buy", elements.calculatorBuyResult], ["sell", elements.calculatorSellResult]]) {
    const rate = prices[side];
    const result = rate && amountValue && amountValue.coefficient > 0n
      ? multiplyAndRound(amount, rate, amountDigits(quote))
      : null;
    output.textContent = result ? `${formatDecimal(result, locale, amountDigits(quote), amountDigits(quote))} ${quote}` : rate ? "Enter an amount" : onBoard ? "Set a desk rate" : "Pair is not on board";
  }
  elements.calculatorAddPair.hidden = onBoard;
}

function refreshCalculatorReference(id, { force = false } = {}) {
  if (!id || (!force && calculatorLookupState.has(id))) return;
  const { base, quote } = pairParts(id);
  if (!isSupportedPair(base, quote)) {
    calculatorLookupState.set(id, "missing");
    renderCalculator();
    return;
  }
  calculatorLookupState.set(id, "loading");
  renderCalculator();
  const pair = pairParts(id);
  const query = encodeURIComponent(`${pair.base}:${pair.quote}`);
  fetch(`/api/rates?pairs=${query}`, { headers: { accept: "application/json" } })
    .then(async (response) => {
      if (!response.ok) throw new Error("Reference lookup failed");
      return response.json();
    })
    .then((body) => {
      const rate = body.rates?.[id];
      if (rate) {
        const cacheFallback = Boolean(rate.cacheFallback) || body.cacheStatus === "stale-cache";
        referenceRates[id] = { ...rate, cacheFallback };
        calculatorLookupState.set(id, cacheFallback || ["cached", "partial-cache", "browser-cache-pending"].includes(body.cacheStatus) ? "cached" : "ready");
        writeJson(REFERENCE_CACHE_KEY, { rates: referenceRates, retrievedAt: body.retrievedAt ?? new Date().toISOString(), source: body.source });
      } else {
        calculatorLookupState.set(id, referenceRates[id] ? "cached" : "missing");
      }
      if (currentCalculatorPair() === id) renderCalculator();
    })
    .catch(() => {
      calculatorLookupState.set(id, referenceRates[id] ? "cached" : "error");
      if (currentCalculatorPair() === id) renderCalculator();
    });
}

function changeCalculatorCurrencies(changed) {
  if (elements.calculatorBase.value === elements.calculatorQuote.value) {
    const currenciesAvailable = [...elements.calculatorBase.options].map((option) => option.value);
    const currentCode = changed === "base" ? elements.calculatorBase.value : elements.calculatorQuote.value;
    const previousAlternate = changed === "base" ? previousCalculatorSelection.base : previousCalculatorSelection.quote;
    const alternate = previousAlternate !== currentCode && currenciesAvailable.includes(previousAlternate)
      ? previousAlternate
      : currenciesAvailable.find((code) => code !== currentCode);
    if (changed === "base") elements.calculatorQuote.value = alternate ?? "";
    else elements.calculatorBase.value = alternate ?? "";
  }
  previousCalculatorSelection = { base: elements.calculatorBase.value, quote: elements.calculatorQuote.value };
  const id = currentCalculatorPair();
  renderCalculator();
  refreshCalculatorReference(id);
}

function addCalculatorPairToBoard() {
  const id = currentCalculatorPair();
  if (!id || settings.pairs.includes(id)) return;
  const { base, quote } = pairParts(id);
  if (!isSupportedPair(base, quote)) {
    announce("Gold and silver pairs can only be added against USD.");
    return;
  }
  if (settings.pairs.length >= MAX_BOARD_PAIRS) {
    announce(`This board supports up to ${MAX_BOARD_PAIRS} pairs.`);
    return;
  }
  settings.pairs.push(id);
  const saved = saveSettings();
  renderTable({ animatePair: id, highlightPair: id });
  loadRates();
  loadPairHistory();
  announce(isMetalPair(base, quote)
    ? `${id} added. The reference quote will appear after a metals source is configured.`
    : saved ? `${id} added to the rates board.` : `${id} added for this session; browser storage is unavailable.`);
}

function reorderPair(sourceId, targetId, afterTarget = false, { restoreFocus = true } = {}) {
  if (sourceId === targetId) return;
  const sourceIndex = settings.pairs.indexOf(sourceId);
  if (sourceIndex < 0 || !settings.pairs.includes(targetId)) return;
  const [source] = settings.pairs.splice(sourceIndex, 1);
  let targetIndex = settings.pairs.indexOf(targetId);
  if (afterTarget) targetIndex += 1;
  settings.pairs.splice(targetIndex, 0, source);
  view.sort = "board";
  applyViewPreferences();
  const saved = saveSettings();
  renderTable();
  if (restoreFocus) {
    const controls = [...elements.ratesBody.querySelectorAll("[data-move-pair]")].filter((button) => button.dataset.movePair === sourceId);
    (controls.find((button) => !button.disabled) ?? controls[0])?.focus();
  }
  announce(saved ? "Currency pair order saved." : "Currency pair order changed for this session; browser storage is unavailable.");
}

function movePairInBoard(id, direction) {
  const index = settings.pairs.indexOf(id);
  const targetIndex = index + (direction === "up" ? -1 : 1);
  if (index < 0 || targetIndex < 0 || targetIndex >= settings.pairs.length) return;
  reorderPair(id, settings.pairs[targetIndex], direction === "down");
}

function flipPairDirection(id) {
  const index = settings.pairs.indexOf(id);
  if (index < 0) return;
  const { base, quote } = pairParts(id);
  const flippedId = `${quote}/${base}`;
  if (settings.pairs.includes(flippedId)) {
    announce(`${flippedId} is already on the board.`);
    return;
  }
  settings.pairs[index] = flippedId;
  const saved = saveSettings();
  if (currentCalculatorPair() === id) {
    elements.calculatorBase.value = quote;
    elements.calculatorQuote.value = base;
    previousCalculatorSelection = { base: quote, quote: base };
  }
  renderTable({ highlightPair: flippedId });
  loadRates();
  loadPairHistory();
  announce(saved
    ? `${id} direction changed to ${flippedId}. Desk prices remain separate for each direction.`
    : `${id} direction changed for this session. Desk prices remain separate for each direction.`);
}

function applyViewPreferences({ persist = true } = {}) {
  document.body.dataset.theme = view.theme;
  document.body.dataset.density = view.density;
  elements.pairFilter.value = view.filter;
  elements.pairSort.value = view.sort;
  elements.boardDensity.value = view.density;
  elements.boardTheme.value = view.theme;
  if (persist) writeJson(VIEW_STORAGE_KEY, view);
}

function openPairDialog() {
  if (settings.pairs.length >= MAX_BOARD_PAIRS) {
    announce(`This board supports up to ${MAX_BOARD_PAIRS} pairs.`);
    return;
  }
  const available = ensureSpecialAssets(currencies);
  const currenciesMarkup = available.filter(({ code }) => !METAL_CODES.has(code))
    .map(({ code, name }) => `<option value="${escapeHtml(code)}">${escapeHtml(code)} · ${escapeHtml(name)}</option>`).join("");
  const metalsMarkup = available.filter(({ code }) => METAL_CODES.has(code))
    .map(({ code, name }) => `<option value="${escapeHtml(code)}">${escapeHtml(code)} · ${escapeHtml(name)}</option>`).join("");
  const optionMarkup = `<optgroup label="Currencies">${currenciesMarkup}</optgroup><optgroup label="Precious metals">${metalsMarkup}</optgroup>`;
  elements.pairBase.innerHTML = optionMarkup;
  elements.pairQuote.innerHTML = optionMarkup;
  const preferredBase = available.some((currency) => currency.code === "USD") ? "USD" : available[0]?.code;
  const preferredQuote = available.some((currency) => currency.code === "EUR") ? "EUR" : available.find((currency) => currency.code !== preferredBase)?.code;
  if (!available.length) {
    elements.pairBase.innerHTML = '<option value="">Currency list unavailable</option>';
    elements.pairQuote.innerHTML = '<option value="">Currency list unavailable</option>';
    elements.pairBase.disabled = true;
    elements.pairQuote.disabled = true;
    elements.pairPreview.innerHTML = "<span>PAIR PREVIEW</span><strong>Coverage unavailable</strong><small>Refresh the reference feed and try again.</small>";
  } else {
    elements.pairBase.disabled = false;
    elements.pairQuote.disabled = false;
    elements.pairBase.value = preferredBase;
    elements.pairQuote.value = preferredQuote;
    updatePairPreview();
  }
  elements.pairDialog.showModal();
}

function updatePairPreview() {
  const base = elements.pairBase.value;
  const quote = elements.pairQuote.value;
  const id = `${base}/${quote}`;
  const exists = settings.pairs.includes(id);
  const same = base === quote;
  const unsupported = !isSupportedPair(base, quote);
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

function openPriceDialog(id) {
  if (!settings.pairs.includes(id)) return;
  const { base, quote } = pairParts(id);
  const prices = settings.prices[id] ?? { buy: "", sell: "" };
  const reference = referenceRates[id];
  elements.pricePairId.value = id;
  elements.priceDialogTitle.textContent = `Set ${base} / ${quote} prices`;
  elements.priceDialogDescription.textContent = `Enter quote currency units per 1 ${base}. Desk prices are separate from the reference feed.`;
  elements.priceBuy.value = prices.buy ?? "";
  elements.priceSell.value = prices.sell ?? "";
  document.querySelectorAll(".price-quote-code").forEach((node) => { node.textContent = quote; });
  elements.priceReferenceRate.textContent = reference ? `1 ${base} = ${formatPairRate(reference.rate)} ${quote}` : "No reference rate available";
  elements.priceReferenceDate.textContent = reference
    ? `${reference.source ?? (isMetalPair(base, quote) ? "Metal reference" : "Frankfurter blended reference")} · ${formatRateObservation(reference)}`
    : isMetalPair(base, quote) ? "A metals data source is needed for this reference quote" : "Reference data is not a customer price";
  elements.priceValidation.hidden = true;
  elements.priceValidation.textContent = "";
  elements.priceDialog.showModal();
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}

function handlePriceSave(event) {
  event.preventDefault();
  const id = elements.pricePairId.value;
  const buy = elements.priceBuy.value.trim();
  const sell = elements.priceSell.value.trim();
  const { quote } = pairParts(id);
  const options = { maxScale: 8, maxDigits: 30 };
  if (!id || !settings.pairs.includes(id)) return;
  if ((buy && (!MANUAL_RATE_PATTERN.test(buy) || !isPositiveDecimal(buy, options))) || (sell && (!MANUAL_RATE_PATTERN.test(sell) || !isPositiveDecimal(sell, options)))) {
    elements.priceValidation.textContent = "Enter a positive rate using a decimal point and up to 8 decimal places.";
    elements.priceValidation.hidden = false;
    return;
  }
  if (buy && sell && compareDecimals(buy, sell) > 0) {
    elements.priceValidation.textContent = "The buy rate must be less than or equal to the sell rate for this pair direction.";
    elements.priceValidation.hidden = false;
    return;
  }
  if (buy || sell) settings.prices[id] = { buy, sell };
  else delete settings.prices[id];
  const saved = saveSettings();
  closeDialog(elements.priceDialog);
  renderTable({ highlightPair: id });
  renderCalculator();
  announce(saved ? `${id} desk prices saved on this browser.` : `${id} prices are active for this session, but browser storage is unavailable.`);
}

function populateDate() {
  document.querySelector("#today-label").textContent = new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric" }).format(new Date());
}

function initializeWorkspaceNavigation() {
  const links = [...document.querySelectorAll(".nav-item[href^='#']")];
  const destinations = links.map((link) => ({ link, section: document.querySelector(link.getAttribute("href")) })).filter(({ section }) => section);
  if (!destinations.length) return;

  const activate = (activeLink) => {
    for (const { link } of destinations) {
      const isActive = link === activeLink;
      link.classList.toggle("is-active", isActive);
      if (isActive) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  };
  const syncToScrollPosition = () => {
    const readingLine = window.innerHeight * 0.4;
    const current = [...destinations].reverse().find(({ section }) => section.getBoundingClientRect().top <= readingLine);
    activate((current ?? destinations[0]).link);
  };

  destinations.forEach(({ link }) => link.addEventListener("click", () => activate(link)));
  window.addEventListener("hashchange", syncToScrollPosition);
  let scrollFrame = 0;
  window.addEventListener("scroll", () => {
    if (scrollFrame) return;
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = 0;
      syncToScrollPosition();
    });
  }, { passive: true });
  syncToScrollPosition();
}

function initializeEvents() {
  let draggedPairId = null;
  document.addEventListener("pointerdown", (event) => {
    const button = event.target.closest(".button");
    if (!button || button.disabled || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    button.classList.remove("is-tapped");
    void button.offsetWidth;
    button.classList.add("is-tapped");
    window.setTimeout(() => button.classList.remove("is-tapped"), 440);
  });
  document.querySelector("#add-pair-button").addEventListener("click", openPairDialog);
  document.querySelector("#first-price-button").addEventListener("click", () => openPriceDialog(settings.pairs[0]));
  elements.refreshButton.addEventListener("click", () => {
    loadRates({ announceSuccess: true });
    loadPairHistory();
    refreshCalculatorReference(currentCalculatorPair(), { force: true });
  });
  elements.historyRanges.addEventListener("click", (event) => {
    const button = event.target.closest("[data-history-range]");
    if (!button || button.disabled || historyRange === button.dataset.historyRange) return;
    historyRange = button.dataset.historyRange;
    elements.historyRanges.querySelectorAll("[data-history-range]").forEach((rangeButton) => {
      rangeButton.setAttribute("aria-pressed", String(rangeButton === button));
    });
    loadPairHistory();
  });
  elements.searchInput.addEventListener("input", () => { searchTerm = elements.searchInput.value; renderTable(); });
  elements.optionsToggle.addEventListener("click", () => {
    const opening = elements.displayOptions.hidden;
    elements.displayOptions.hidden = !opening;
    elements.optionsToggle.setAttribute("aria-expanded", String(opening));
    if (opening) elements.pairFilter.focus();
  });
  elements.pairFilter.addEventListener("change", () => { view.filter = elements.pairFilter.value; applyViewPreferences(); renderTable(); });
  elements.pairSort.addEventListener("change", () => { view.sort = elements.pairSort.value; applyViewPreferences(); renderTable(); });
  elements.boardDensity.addEventListener("change", () => { view.density = elements.boardDensity.value; applyViewPreferences(); });
  elements.boardTheme.addEventListener("change", () => { view.theme = elements.boardTheme.value; applyViewPreferences(); });
  elements.resetDisplayOptions.addEventListener("click", () => {
    Object.assign(view, DEFAULT_VIEW);
    applyViewPreferences();
    renderTable();
    announce("Board view options reset.");
  });
  elements.pairBase.addEventListener("change", updatePairPreview);
  elements.pairQuote.addEventListener("change", updatePairPreview);
  elements.pairForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const base = elements.pairBase.value;
    const quote = elements.pairQuote.value;
    const id = `${base}/${quote}`;
    if (base === quote || !isSupportedPair(base, quote) || settings.pairs.includes(id)) {
      updatePairPreview();
      return;
    }
    if (settings.pairs.length >= MAX_BOARD_PAIRS) return;
    settings.pairs.push(id);
    const saved = saveSettings();
    closeDialog(elements.pairDialog);
    renderTable({ animatePair: id, highlightPair: id });
    renderCalculatorOptions();
    loadRates();
    loadPairHistory();
    announce(isMetalPair(base, quote)
      ? `${id} added. The reference quote will appear after a metals source is configured.`
      : saved ? `${id} added to the rates board.` : `${id} added for this session; browser storage is unavailable.`);
  });
  elements.priceForm.addEventListener("submit", handlePriceSave);
  document.querySelector("#clear-price-button").addEventListener("click", () => {
    const id = elements.pricePairId.value;
    delete settings.prices[id];
    const saved = saveSettings();
    closeDialog(elements.priceDialog);
    renderTable({ highlightPair: id });
    renderCalculator();
    announce(saved ? `${id} customer prices cleared.` : `${id} prices cleared for this session; browser storage is unavailable.`);
  });
  document.body.addEventListener("click", (event) => {
    const closeButton = event.target.closest("[data-close-dialog]");
    if (closeButton) {
      closeDialog(closeButton.closest("dialog"));
      return;
    }
    const editButton = event.target.closest("[data-edit-price]");
    if (editButton) {
      openPriceDialog(editButton.dataset.editPrice);
      return;
    }
    const flipButton = event.target.closest("[data-flip-pair]");
    if (flipButton) {
      flipPairDirection(flipButton.dataset.flipPair);
      return;
    }
    const moveButton = event.target.closest("[data-move-pair]");
    if (moveButton) {
      movePairInBoard(moveButton.dataset.movePair, moveButton.dataset.moveDirection);
      return;
    }
    const removeButton = event.target.closest("[data-remove-pair]");
    if (removeButton) {
      const id = removeButton.dataset.removePair;
      if (removeButton.disabled) return;
      removeButton.disabled = true;
      removeButton.closest("tr")?.classList.add("row-leaving");
      const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180;
      window.setTimeout(() => {
        settings.pairs = settings.pairs.filter((pair) => pair !== id);
        delete settings.prices[id];
        const saved = saveSettings();
        renderTable();
        loadPairHistory();
        announce(saved ? `${id} removed from the rates board.` : `${id} removed for this session; browser storage is unavailable.`);
      }, delay);
    }
  });
  elements.ratesBody.addEventListener("dragstart", (event) => {
    const handle = event.target.closest("[data-drag-pair]");
    if (!handle) return;
    draggedPairId = handle.dataset.dragPair;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedPairId);
    handle.closest("tr")?.classList.add("is-dragging");
  });
  elements.ratesBody.addEventListener("dragover", (event) => {
    if (!draggedPairId) return;
    const targetRow = event.target.closest("tr[data-pair]");
    if (!targetRow || targetRow.dataset.pair === draggedPairId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    elements.ratesBody.querySelectorAll(".drop-before, .drop-after").forEach((row) => row.classList.remove("drop-before", "drop-after"));
    const bounds = targetRow.getBoundingClientRect();
    const afterTarget = event.clientY > bounds.top + bounds.height / 2;
    targetRow.classList.add(afterTarget ? "drop-after" : "drop-before");
  });
  elements.ratesBody.addEventListener("drop", (event) => {
    if (!draggedPairId) return;
    const targetRow = event.target.closest("tr[data-pair]");
    if (!targetRow) return;
    event.preventDefault();
    const sourceId = draggedPairId;
    const targetId = targetRow.dataset.pair;
    const afterTarget = targetRow.classList.contains("drop-after");
    draggedPairId = null;
    reorderPair(sourceId, targetId, afterTarget, { restoreFocus: false });
  });
  elements.ratesBody.addEventListener("dragend", () => {
    draggedPairId = null;
    elements.ratesBody.querySelectorAll(".is-dragging, .drop-before, .drop-after").forEach((row) => row.classList.remove("is-dragging", "drop-before", "drop-after"));
  });
  for (const dialog of [elements.pairDialog, elements.priceDialog]) {
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  }
  elements.calculatorBase.addEventListener("change", () => changeCalculatorCurrencies("base"));
  elements.calculatorQuote.addEventListener("change", () => changeCalculatorCurrencies("quote"));
  elements.swapCurrencies.addEventListener("click", () => {
    const base = elements.calculatorBase.value;
    elements.calculatorBase.value = elements.calculatorQuote.value;
    elements.calculatorQuote.value = base;
    changeCalculatorCurrencies("quote");
  });
  elements.calculatorAddPair.addEventListener("click", addCalculatorPairToBoard);
  elements.calculatorAmount.addEventListener("input", renderCalculator);
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) && !elements.pairDialog.open && !elements.priceDialog.open) {
      event.preventDefault();
      elements.searchInput.focus();
    }
  });
}

applyViewPreferences({ persist: false });
populateDate();
initializeEvents();
initializeWorkspaceNavigation();
renderTable();
const browserCache = readReferenceCache();
if (browserCache) {
  referenceRates = browserCache.rates;
  referenceMeta = { cacheStatus: "browser-cache-pending", errors: [], retrievedAt: browserCache.retrievedAt, checkedAt: browserCache.retrievedAt };
  renderTable({ animateRows: true });
}
loadCurrencies();
loadRates();
loadPairHistory();
window.setInterval(() => { if (document.visibilityState === "visible") loadRates(); }, 30 * 60 * 1000);
