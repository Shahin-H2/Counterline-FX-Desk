// Copyright (c) 2026 Shahin Hassanyan. All rights reserved.
//
// Workspace page: the rates board, desk prices, calculator, history charts and market cards.
// Market data comes from the local /api endpoints; the desk's settings are kept in localStorage.

import {
  compareDecimals,
  decimalFromNumber,
  formatDecimal,
  isPositiveDecimal,
  multiplyAndRound,
  parseDecimal,
} from "./domain/decimal.js";
import { CARD_SORTS, sortCards } from "./domain/card-sort.js";
import { isObservationStale, observationAgeInLocalDays } from "./domain/freshness.js";
import { deskMargins, pricesFromMargin, reviewDeskPrice } from "./domain/margin.js";
import { rateSheetCsv, rateSheetRows, rateSheetText } from "./domain/rate-sheet.js";
import { createCardReorder, slide } from "./ui/card-reorder.js";
import { createChartProbe } from "./ui/chart-probe.js";
import { createCosmos } from "./ui/cosmos.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// localStorage keys. The version suffix lets a later format change start from clean storage.
const STORAGE_KEY = "counterline-fx-prices-v1";
const REFERENCE_CACHE_KEY = "counterline-fx-reference-cache-v1";
const CURRENCY_CACHE_KEY = "counterline-fx-currencies-v1";
const VIEW_STORAGE_KEY = "counterline-fx-view-v1";
const PAIR_HISTORY_ORDER_KEY = "counterline-fx-pair-history-order-v1";
const METAL_HISTORY_ORDER_KEY = "counterline-fx-metal-history-order-v1";
const DEFAULT_VIEW = {
  filter: "all",
  sort: "board",
  density: "comfortable",
  theme: "evergreen",
  pairCardSort: "custom",
  marketCardSort: "custom",
  quoteCardSort: "custom",
  marginPercent: "1.5",
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
// The reference feed quotes the metals against USD only (see isSupportedPair).
const METAL_ASSETS = [
  { code: "XAU", name: "Gold (troy ounce)", symbol: "Au" },
  { code: "XAG", name: "Silver (troy ounce)", symbol: "Ag" },
];
const METAL_CODES = new Set(METAL_ASSETS.map(({ code }) => code));
const MAX_BOARD_PAIRS = 30;
const MANUAL_RATE_PATTERN = /^\d+(?:\.\d{1,8})?$/;
const MARGIN_PATTERN = /^\d{1,2}(?:\.\d{1,2})?$/;
const locale = navigator.language || "en-US";

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const elements = {
  ratesBody: document.querySelector("#rates-body"),
  pairTotal: document.querySelector("#pair-total"),
  navPairCount: document.querySelector("#nav-pair-count"),
  feedPill: document.querySelector("#feed-pill"),
  rateDate: document.querySelector("#rate-date"),
  checkedAt: document.querySelector("#checked-at"),
  feedAlert: document.querySelector("#feed-alert"),
  sidebarFeedStatus: document.querySelector("#sidebar-feed-status"),
  refreshButton: document.querySelector("#refresh-button"),
  searchInput: document.querySelector("#search-input"),
  emptySearch: document.querySelector("#empty-search"),
  optionsToggle: document.querySelector("#display-options-toggle"),
  displayOptions: document.querySelector("#display-options"),
  pairFilter: document.querySelector("#pair-filter"),
  pairSort: document.querySelector("#pair-sort"),
  boardDensity: document.querySelector("#board-density"),
  boardTheme: document.querySelector("#board-theme"),
  themeToggle: document.querySelector("#theme-toggle"),
  themeToggleLabel: document.querySelector("#theme-toggle-label"),
  resetDisplayOptions: document.querySelector("#reset-display-options"),
  pairDialog: document.querySelector("#pair-dialog"),
  pairForm: document.querySelector("#pair-form"),
  pairBase: document.querySelector("#pair-base"),
  pairQuote: document.querySelector("#pair-quote"),
  pairPreview: document.querySelector("#pair-preview"),
  priceDialog: document.querySelector("#price-dialog"),
  priceForm: document.querySelector("#price-form"),
  pricePairId: document.querySelector("#price-pair-id"),
  priceDialogTitle: document.querySelector("#price-dialog-title"),
  priceDialogDescription: document.querySelector("#price-dialog-description"),
  priceBuy: document.querySelector("#price-buy"),
  priceSell: document.querySelector("#price-sell"),
  priceReferenceRate: document.querySelector("#price-reference-rate"),
  priceReferenceDate: document.querySelector("#price-reference-date"),
  priceValidation: document.querySelector("#price-validation"),
  calculatorBase: document.querySelector("#calculator-base"),
  calculatorQuote: document.querySelector("#calculator-quote"),
  swapCurrencies: document.querySelector("#swap-currencies"),
  calculatorBaseCode: document.querySelector("#calculator-base-code"),
  calculatorAmount: document.querySelector("#calculator-amount"),
  calculatorReferenceResult: document.querySelector(
    "#calculator-reference-result",
  ),
  calculatorReferenceMeta: document.querySelector("#calculator-reference-meta"),
  calculatorBuyResult: document.querySelector("#calculator-buy-result"),
  calculatorSellResult: document.querySelector("#calculator-sell-result"),
  calculatorAddPair: document.querySelector("#calculator-add-pair"),
  historyGrid: document.querySelector("#history-grid"),
  historyStatus: document.querySelector("#history-status"),
  historyRanges: document.querySelector(".history-controls"),
  marketHistoryGrid: document.querySelector("#market-history-grid"),
  marketHistoryStatus: document.querySelector("#market-history-status"),
  marketHistoryRanges: document.querySelector(".market-history-controls"),
  marketStatus: document.querySelector("#markets-status"),
  marketsGrid: document.querySelector("#markets-grid"),
  pairCardSort: document.querySelector("#pair-card-sort"),
  marketCardSort: document.querySelector("#market-card-sort"),
  quoteCardSort: document.querySelector("#quote-card-sort"),
  reviewChip: document.querySelector("#review-chip"),
  copyRateSheet: document.querySelector("#copy-rate-sheet"),
  downloadRateSheet: document.querySelector("#download-rate-sheet"),
  openDisplay: document.querySelector("#open-display-button"),
  priceMargin: document.querySelector("#price-margin"),
  applyMargin: document.querySelector("#apply-margin"),
  marginPreview: document.querySelector("#margin-preview"),
  announcements: document.querySelector("#announcements"),
};

// ---------------------------------------------------------------------------
// Saved settings
// ---------------------------------------------------------------------------

// Reads a JSON value from localStorage; `fallback` when it is missing, unreadable or blocked.
function readJson(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

// A saved card order, limited to the ids still shown, with any new ids appended in order.
function reconcileChartOrder(savedOrder, visibleIds) {
  const allowed = new Set(visibleIds);
  const order = Array.isArray(savedOrder)
    ? [...new Set(savedOrder.filter((id) => allowed.has(id)))]
    : [];
  return [...order, ...visibleIds.filter((id) => !order.includes(id))];
}

// "BASE/QUOTE": two different three-letter codes.
function validPairId(value) {
  return (
    typeof value === "string" &&
    /^[A-Z]{3}\/[A-Z]{3}$/.test(value) &&
    value.slice(0, 3) !== value.slice(4)
  );
}

// The saved board and desk prices. Malformed entries are dropped and the board is capped at
// MAX_BOARD_PAIRS.
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
        prices[id] = {
          buy,
          sell,
          setAt: Number.isNaN(Date.parse(value.setAt)) ? null : String(value.setAt),
          referenceAtSet: isPositiveDecimal(String(value.referenceAtSet ?? "")) ? String(value.referenceAtSet) : null,
        };
    }
  }
  return { pairs, prices };
}

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

const settings = loadSettings();
const savedView = readJson(VIEW_STORAGE_KEY, {}) ?? {};
const view = {
  filter: ["all", "needs-prices", "priced", "reference-issues", "review"].includes(
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
  // How the chart cards and the market cards are ordered: as arranged by hand, or sorted.
  pairCardSort: CARD_SORTS.includes(savedView.pairCardSort) ? savedView.pairCardSort : DEFAULT_VIEW.pairCardSort,
  marketCardSort: CARD_SORTS.includes(savedView.marketCardSort) ? savedView.marketCardSort : DEFAULT_VIEW.marketCardSort,
  quoteCardSort: CARD_SORTS.includes(savedView.quoteCardSort) ? savedView.quoteCardSort : DEFAULT_VIEW.quoteCardSort,
  // The margin last used to fill desk prices from the reference, in percent.
  marginPercent: MARGIN_PATTERN.test(String(savedView.marginPercent)) ? String(savedView.marginPercent) : DEFAULT_VIEW.marginPercent,
};
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
// Per chart grid: the selected range, the series returned for it, and the server's label for
// each series (reference, stale or estimated).
const newChartState = () => ({
  range: "1m",
  data: {},
  series: {},
  loading: false,
  requestId: 0,
  renderPending: false,
  reorder: null,
});
const pairCharts = newChartState();
const marketCharts = newChartState();
const INTRADAY_HISTORY_RANGES = new Set(["5min", "24h"]);
const HISTORY_RANGE_LABELS = {
  "5min": "5 minutes",
  "24h": "24 hours",
  "1w": "1 week",
  "1m": "1 month",
  "3m": "3 months",
  "6m": "6 months",
};
const SERIES_KINDS = new Set(["reference", "stale", "estimated"]);
// How each data source is named in a status line and on a quote card. A source with `delay`
// publishes in arrears, and every price from it is marked as delayed (see delayNotice).
const SOURCE_NAMES = {
  Frankfurter: { history: "from Frankfurter's daily reference history", quote: "Frankfurter daily reference" },
  EIA: {
    history: "of EIA daily spot prices",
    quote: "EIA daily spot price",
    delay: "EIA publishes this price about once a week, a few days in arrears. It is not a live market price.",
  },
};
const renderedCardMarkup = new WeakMap(); // card element -> the markup last written into it
const chartGeometry = new WeakMap(); // card element -> its chart's points, for the hover read-out
const cosmos = createCosmos({
  backdrop: document.querySelector(".cosmos"),
  sidebar: document.querySelector(".sidebar"),
});
// The charts of the markets section, each priced in US dollars.
const MARKET_HISTORY_ASSETS = [
  { code: "XAU", name: "Gold", detail: "USD per troy ounce" },
  { code: "XAG", name: "Silver", detail: "USD per troy ounce" },
  { code: "WTI", name: "Crude oil (WTI)", detail: "USD per barrel" },
  { code: "BRENT", name: "Brent crude", detail: "USD per barrel" },
];
let marketQuotes = {}; // asset code -> the quote shown on its card
let pairHistoryOrder = reconcileChartOrder(readJson(PAIR_HISTORY_ORDER_KEY, []), settings.pairs);
let marketHistoryOrder = reconcileChartOrder(readJson(METAL_HISTORY_ORDER_KEY, []), MARKET_HISTORY_ASSETS.map(({ code }) => code));

// ---------------------------------------------------------------------------
// Currencies and formatting
// ---------------------------------------------------------------------------

function pairParts(id) {
  const [base, quote] = id.split("/");
  return { base, quote };
}

// Full currency name, or the code when the currency list has no entry for it.
function currencyName(code) {
  return currencies.find((currency) => currency.code === code)?.name ?? code;
}

// Two-letter mark for a pair's chip; the metals use their chemical symbols.
function currencyMark(code) {
  return (
    METAL_ASSETS.find((asset) => asset.code === code)?.symbol ??
    code.slice(0, 2)
  );
}

function isMetalPair(base, quote) {
  return METAL_CODES.has(base) || METAL_CODES.has(quote);
}

// The reference feed quotes gold and silver against USD only.
function isSupportedPair(base, quote) {
  if (!isMetalPair(base, quote)) return true;
  return (
    (METAL_CODES.has(base) && quote === "USD") ||
    (base === "USD" && METAL_CODES.has(quote))
  );
}

// Unit line for a metal pair.
function metalPairUnit(base, quote) {
  if (base === "USD" && quote === "XAU") return "Troy ounces of gold per USD";
  if (base === "USD" && quote === "XAG") return "Troy ounces of silver per USD";
  if (base === "XAU" && quote === "USD") return "USD per troy ounce of gold";
  if (base === "XAG" && quote === "USD") return "USD per troy ounce of silver";
  return "Gold and silver pairs use USD";
}

// USD, IRR and the metals are always selectable, whatever the currency list contains.
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

// Escapes text for interpolation into HTML markup.
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
}

// A YYYY-MM-DD date (taken as a calendar date, not a moment) or a timestamp, in the viewer's
// locale.
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

// Axis labels: dates on daily ranges, times on the intraday ones.
function formatHistoryAxis(value, range) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return formatDate(value, { month: "short", day: "numeric", timeZone: "UTC" });
  }
  const options = range === "5min"
    ? { hour: "numeric", minute: "2-digit" }
    : range === "24h"
      ? { weekday: "short", hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(locale, options).format(new Date(value));
}

// Read-out label: the date for a daily point, date and time for an intraday one.
function formatHistoryTooltip(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? formatDate(value, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    : new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function formatCheckedAt(value) {
  if (!value || Number.isNaN(new Date(value).getTime()))
    return "Check time unavailable";
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

// Observation time when the source gives one, otherwise the observation date.
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

// Rates are shown with 2 to 8 decimals.
function formatPairRate(rate) {
  return formatDecimal(rate, locale, 2, 8);
}

// Formats a value computed for a chart: an axis tick, a low or a high. Computed numbers carry
// binary-float noise such as 1.4292799999999998, which the decimal parser rejects, so they are
// rounded to a plain decimal string first.
function formatChartValue(value) {
  return formatPairRate(decimalFromNumber(value, 6) ?? "");
}

// ---------------------------------------------------------------------------
// History charts
// ---------------------------------------------------------------------------

// Builds one chart card: its state, its classes and the markup that goes inside it. The card
// element itself is kept between renders (see renderHistoryCards).
function historyCardView(id, observations, series, cardIndex, { market = false, loading = false, range }) {
  const { base, quote } = market ? { base: id, quote: "USD" } : pairParts(id);
  const asset = MARKET_HISTORY_ASSETS.find(({ code }) => code === id);
  const name = market ? (asset?.name ?? id) : `${base} to ${quote}`;
  const title = market ? escapeHtml(asset?.name ?? id) : `${escapeHtml(base)} <span aria-hidden="true">→</span> ${escapeHtml(quote)}`;
  const subtitle = market ? `${id} · ${asset?.detail ?? "USD"}` : `${currencyName(base)} / ${currencyName(quote)}`;
  const heading = `<div><h3>${title}</h3><p>${escapeHtml(subtitle)}</p></div>`;
  const points = (Array.isArray(observations) ? observations : [])
    .filter((item) => {
      const date = item?.observedAt ?? item?.date;
      return date && !Number.isNaN(new Date(date).getTime()) && Number.isFinite(Number(item.rate)) && Number(item.rate) > 0;
    })
    .map((item) => ({ date: item.observedAt ?? item.date, rate: String(item.rate), value: Number(item.rate) }));

  if (!points.length) {
    if (loading) {
      return {
        kind: "loading",
        name,
        className: "history-card history-card-loading",
        html: '<div class="history-loading-line"></div><div class="history-loading-rate"></div><div class="history-loading-chart"></div>',
      };
    }
    const reason = series?.message || "No source returned data for this range. Press Refresh to try again.";
    return {
      kind: "unavailable",
      name,
      className: "history-card history-card-empty",
      html: `<div class="history-card-title">${heading}</div><div class="history-empty-state"><span class="history-empty-icon" aria-hidden="true">⌁</span><strong>Chart unavailable</strong><span>${escapeHtml(reason)}</span></div>`,
    };
  }

  const kind = SERIES_KINDS.has(series?.kind) ? series.kind : "reference";
  const estimated = kind === "estimated";
  const stale = kind === "stale";
  // Geometry: the observed range, padded, scaled into the plot area of a 340 x 155 viewBox.
  const width = 340;
  const height = 155;
  const plot = { left: 54, right: 334, top: 10, bottom: 121 };
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
  const coords = points.map((point, index) => ({
    x:
      points.length === 1
        ? (plot.left + plot.right) / 2
        : plot.left + ((plot.right - plot.left) * index) / (points.length - 1),
    y: plot.bottom - ((point.value - low) / span) * (plot.bottom - plot.top),
  }));
  const line = coords
    .map(
      (point, index) =>
        `${index ? "L" : "M"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
    )
    .join(" ");
  const area = `${line} L${coords.at(-1).x.toFixed(2)} ${plot.bottom} L${coords[0].x.toFixed(2)} ${plot.bottom} Z`;
  const gradientId = `history-area-${market ? "metal" : "pair"}-${cardIndex}-${id.replace(/[^A-Z0-9-]/g, "-")}`;
  const grid = [high, (high + low) / 2, low]
    .map((value, index) => {
      const y = plot.top + ((plot.bottom - plot.top) * index) / 2;
      return `<g class="history-gridline"><line x1="${plot.left}" y1="${y.toFixed(2)}" x2="${plot.right}" y2="${y.toFixed(2)}"/><text x="${plot.left - 7}" y="${(y + 3.5).toFixed(2)}" text-anchor="end">${escapeHtml(formatChartValue(value))}</text></g>`;
    })
    .join("");
  // A short series gets a marker on every point; on a long one they would merge into a band.
  const dots = points.length > 40
    ? ""
    : coords
        .map((point) => `<circle class="history-point" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="1.9"/>`)
        .join("");
  const latest = points.at(-1);
  // An estimate is never drawn for a source that publishes in arrears, so it needs no notice.
  const delay = estimated ? null : delayNotice(series?.source, latest.date);
  const delayText = delay ? [stale ? "Last observed" : "Delayed", delay.age].filter(Boolean).join(" · ") : "";
  const subject = market ? `${asset?.name ?? id} USD reference price` : `${base} to ${quote} reference rate`;
  const ariaLabel = `${estimated ? "Illustrative interpolated estimate of " : stale ? "Last observed " : ""}${subject} from ${formatHistoryTooltip(points[0].date)} to ${formatHistoryTooltip(latest.date)}${series?.source ? `. Source: ${series.source}` : ""}${delay ? `. Delayed${delay.age ? `, ${delay.age}` : ""}` : ""}`;
  const latestValue = market ? formatUsdPrice(latest.rate) : formatPairRate(latest.rate);
  const latestPrefix = market ? "USD price" : `1 ${escapeHtml(base)} <span aria-hidden="true">=</span>`;
  // An estimate ends on the reference price it is anchored to, so the headline names that reference.
  const latestMeta = estimated
    ? `${escapeHtml(series?.baseline?.source ?? "Latest")} reference${series?.baseline?.date ? ` · ${escapeHtml(formatHistoryTooltip(series.baseline.date))}` : ""}`
    : `${escapeHtml(market ? id : quote)} · ${stale ? "last observed " : ""}${escapeHtml(formatHistoryTooltip(latest.date))}`;
  const chip = estimated ? "INTERPOLATED ESTIMATE" : delay ? delayText.toUpperCase() : stale ? "LAST OBSERVED" : `${points.length} ${points.length === 1 ? "point" : "points"}`;
  const chipTitle = [series?.source, series?.message, delay?.explanation].filter(Boolean).join(" · ");
  const strokeId = `${gradientId}-stroke`;
  const percent = (value) => `${((value / height) * 100).toFixed(2)}%`;
  return {
    kind,
    name,
    className: `history-card${estimated ? " history-card-interpolated" : ""}${stale ? " history-card-stale" : ""}${delay ? " history-card-delayed" : ""}`,
    // For the hover read-out: where each point sits in the chart's own units, with its date and rate.
    chart: {
      width,
      height,
      market,
      quote,
      kind,
      points: coords.map((point, index) => ({ x: point.x, y: point.y, date: points[index].date, rate: points[index].rate })),
    },
    html: `<div class="history-card-title">${heading}<span class="history-observation-count"${chipTitle ? ` title="${escapeHtml(chipTitle)}"` : ""}>${chip}</span></div>
    <div class="history-latest"><span>${latestPrefix}</span><strong>${escapeHtml(latestValue)}</strong><small>${latestMeta}</small></div>
    <div class="history-chart-wrap">
      <svg class="history-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(ariaLabel)}">
        <defs>
          <linearGradient id="${gradientId}" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="var(--chart-line)" stop-opacity=".2"/><stop offset="100%" stop-color="var(--chart-line)" stop-opacity="0"/></linearGradient>
          <linearGradient id="${strokeId}" gradientUnits="userSpaceOnUse" x1="${plot.left}" y1="0" x2="${plot.right}" y2="0"><stop offset="0%" stop-color="var(--chart-line)"/><stop offset="100%" stop-color="var(--chart-line-end, var(--chart-line))"/></linearGradient>
        </defs>
        ${grid}<g class="history-plot"><path class="history-area" d="${area}" fill="url(#${gradientId})"/><path class="history-line" d="${line}" style="stroke:url(#${strokeId})"/>${dots}</g>
        <text class="history-axis-label" x="${plot.left}" y="${height - 5}">${escapeHtml(formatHistoryAxis(points[0].date, range))}</text><text class="history-axis-label" x="${plot.right}" y="${height - 5}" text-anchor="end">${escapeHtml(formatHistoryAxis(latest.date, range))}</text>
      </svg>
      <div class="history-probe" aria-hidden="true" style="--plot-top:${percent(plot.top)};--plot-bottom:${percent(height - plot.bottom)}"><i class="history-probe-line"></i><i class="history-probe-dot"></i><div class="history-probe-label"><small></small><strong></strong><span></span></div></div>
    </div>
    <div class="history-card-footer"><span><i class="history-stat-dot history-stat-low"></i>${estimated ? "Est. low" : "Low"} <strong>${escapeHtml(formatChartValue(observedMin))}</strong></span><span><i class="history-stat-dot"></i>${estimated ? "Est. high" : "High"} <strong>${escapeHtml(formatChartValue(observedMax))}</strong></span></div>`,
  };
}

// Updates a chart grid in place. Card elements are matched by id and reused, so a card that is
// being dragged or is mid-transition is never replaced, and only a new card plays the entrance.
function renderHistoryCards(grid, ids, viewFor) {
  const existing = new Map(
    [...grid.querySelectorAll(":scope > [data-history-card-id]")].map((card) => [card.dataset.historyCardId, card]),
  );
  grid.querySelectorAll(":scope > :not([data-history-card-id])").forEach((node) => node.remove());
  // When the cards that stay change places, for example after sorting, they slide there.
  const staying = ids.filter((id) => existing.has(id));
  const reordered = [...existing.keys()].filter((id) => staying.includes(id)).some((id, index) => id !== staying[index]);
  if (reordered) {
    slide([...existing.values()], () => staying.forEach((id) => grid.append(existing.get(id))));
  }
  let previous = null;
  ids.forEach((id, index) => {
    const view = viewFor(id, index);
    let card = existing.get(id);
    if (card) {
      existing.delete(id);
    } else {
      card = document.createElement("article");
      card.dataset.historyCardId = id;
      card.setAttribute("role", "listitem");
      card.setAttribute("aria-describedby", "chart-reorder-help");
      card.tabIndex = 0;
      card.classList.add("is-entering");
    }
    // Classes that describe a moment, not the data, survive the re-render.
    const momentary = ["is-entering", "is-drawing", "is-probing"].filter((name) => card.classList.contains(name));
    card.className = [view.className, ...momentary].join(" ");
    card.dataset.seriesKind = view.kind;
    card.dataset.cardName = view.name;
    card.dataset.pointCount = String(view.chart?.points.length ?? 0);
    chartGeometry.set(card, view.chart ?? null);
    if (renderedCardMarkup.get(card) !== view.html) {
      card.innerHTML = view.html;
      renderedCardMarkup.set(card, view.html);
      // A chart that has just changed draws itself in, and any read-out belonged to the old one.
      card.classList.toggle("is-drawing", Boolean(view.chart));
      card.classList.remove("is-probing");
    }
    const expected = previous ? previous.nextElementSibling : grid.firstElementChild;
    if (expected !== card) grid.insertBefore(card, expected);
    previous = card;
  });
  for (const card of existing.values()) card.remove();
}

function renderChartGrid(charts, grid, order, market) {
  // A card that is being moved must keep its element: the render waits until the move is over.
  if (charts.reorder?.isActive()) {
    charts.renderPending = true;
    return;
  }
  charts.renderPending = false;
  grid.setAttribute("aria-busy", String(charts.loading));
  renderHistoryCards(grid, order, (id, index) =>
    historyCardView(id, charts.data[id], charts.series[id], index, { market, loading: charts.loading, range: charts.range }),
  );
}

// The price a card is sorted by: its reference price, or failing that the last point of its chart.
function cardPrice(reference, chart) {
  return Number(reference?.rate) || Number(chart?.at(-1)?.rate) || Number.NaN;
}

// Render the currency pair chart grid: in the order arranged by hand, or sorted by name or price.
function renderPairHistory() {
  if (!elements.historyGrid) return;
  pairHistoryOrder = reconcileChartOrder(pairHistoryOrder, settings.pairs);
  if (!settings.pairs.length && !pairCharts.reorder?.isActive()) {
    elements.historyGrid.setAttribute("aria-busy", "false");
    elements.historyGrid.innerHTML =
      '<div class="history-board-empty" role="listitem"><strong>No currency pairs yet</strong><span>Add a pair to see its rate history here.</span></div>';
    return;
  }
  const cards = pairHistoryOrder.map((id) => ({ id, name: id.replace("/", " "), price: cardPrice(referenceRates[id], pairCharts.data[id]) }));
  renderChartGrid(pairCharts, elements.historyGrid, sortCards(cards, view.pairCardSort, locale), false);
}

function renderMarketHistory() {
  if (!elements.marketHistoryGrid) return;
  marketHistoryOrder = reconcileChartOrder(marketHistoryOrder, MARKET_HISTORY_ASSETS.map(({ code }) => code));
  const cards = marketHistoryOrder.map((code) => ({
    id: code,
    name: MARKET_HISTORY_ASSETS.find((asset) => asset.code === code).name,
    price: cardPrice(marketQuotes[code], marketCharts.data[code]),
  }));
  renderChartGrid(marketCharts, elements.marketHistoryGrid, sortCards(cards, view.marketCardSort, locale), true);
}

// Puts the quote cards of the markets section in their default order, or sorted by name or price.
function renderMarketCardOrder() {
  const cards = [...elements.marketsGrid.querySelectorAll("[data-market-code]")];
  const byCode = new Map(cards.map((card) => [card.dataset.marketCode, card]));
  const listed = MARKET_HISTORY_ASSETS.filter(({ code }) => byCode.has(code)).map(({ code }) => ({
    id: code,
    name: byCode.get(code).querySelector("h3").textContent,
    price: Number(marketQuotes[code]?.rate),
  }));
  const order = sortCards(listed, view.quoteCardSort, locale);
  if (order.every((code, index) => cards[index]?.dataset.marketCode === code)) return;
  slide(cards, () => order.forEach((code) => elements.marketsGrid.append(byCode.get(code))));
}

// One line saying what the charts in a grid are made of, and why when it is not observed data.
function describeHistory(ids, series, range) {
  const observed = new Map(); // source -> number of series it supplied
  let stale = 0;
  let estimated = 0;
  let unavailable = 0;
  for (const id of ids) {
    const item = series[id];
    if (item?.kind === "reference") observed.set(item.source, (observed.get(item.source) ?? 0) + 1);
    else if (item?.kind === "stale") stale += 1;
    else if (item?.kind === "estimated") estimated += 1;
    else unavailable += 1;
  }
  const parts = [...observed].map(([source, count]) => `${count} series ${SOURCE_NAMES[source]?.history ?? `from ${source}`}`);
  if (stale) parts.push(`${stale} series last observed earlier`);
  if (estimated) parts.push(`${estimated} interpolated estimate${estimated === 1 ? "" : "s"}, not observed market history`);
  if (unavailable) parts.push(`${unavailable} unavailable`);
  const reason = ids.map((id) => series[id]).find((item) => item?.kind !== "reference" && item?.message)?.message;
  return `${HISTORY_RANGE_LABELS[range]} · ${parts.join(" · ")}${reason ? ` · ${reason}` : ""}`;
}

// Loads one chart grid. The server answers with a series for every id: observed daily data where
// a source has it, otherwise a labelled estimate, or nothing when there is no basis for one.
async function loadCharts(charts, { ids, url, statusElement, render, emptyMessage }) {
  const requestId = ++charts.requestId;
  if (!ids.length) {
    charts.data = {};
    charts.series = {};
    charts.loading = false;
    render();
    statusElement.textContent = emptyMessage;
    return;
  }
  const range = charts.range;
  charts.loading = true;
  render();
  statusElement.textContent = `Loading ${HISTORY_RANGE_LABELS[range]} of history…`;
  try {
    const response = await fetch(url(ids, range), { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("History unavailable");
    const body = await response.json();
    if (requestId !== charts.requestId) return;
    charts.data = body.rates && typeof body.rates === "object" ? body.rates : {};
    charts.series = body.series && typeof body.series === "object" ? body.series : {};
    charts.loading = false;
    statusElement.textContent = describeHistory(ids, charts.series, range);
    render();
  } catch {
    if (requestId !== charts.requestId) return;
    charts.loading = false;
    statusElement.textContent = Object.keys(charts.data).length
      ? "The history service could not be reached · showing the charts loaded earlier"
      : "The history service could not be reached. Press Refresh to try again.";
    render();
  }
}

// Load the history charts for the pairs on the board.
function loadPairHistory() {
  return loadCharts(pairCharts, {
    ids: [...settings.pairs],
    url: (ids, range) =>
      `/api/history?pairs=${encodeURIComponent(ids.map((id) => id.replace("/", ":")).join("|"))}&range=${encodeURIComponent(range)}`,
    statusElement: elements.historyStatus,
    render: renderPairHistory,
    emptyMessage: "Add currency pairs to view their history.",
  });
}

// Load the history charts for gold, silver, WTI and Brent.
function loadMarketHistory() {
  return loadCharts(marketCharts, {
    ids: MARKET_HISTORY_ASSETS.map(({ code }) => code),
    url: (ids, range) =>
      `/api/market-history?assets=${encodeURIComponent(ids.join("|"))}&range=${encodeURIComponent(range)}`,
    statusElement: elements.marketHistoryStatus,
    render: renderMarketHistory,
    emptyMessage: "",
  });
}

// ---------------------------------------------------------------------------
// Market cards
// ---------------------------------------------------------------------------

function formatUsdPrice(value) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value));
}

function formatSignedPercent(value) {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(2)}%`;
}

// The warning carried by a price from a source that publishes in arrears: how old the price is
// today, and why. Null for a source that does not.
function delayNotice(source, date) {
  const explanation = SOURCE_NAMES[source]?.delay;
  if (!explanation) return null;
  const days = observationAgeInLocalDays(String(date).slice(0, 10));
  return { age: days > 0 ? `${days} day${days === 1 ? "" : "s"} old` : "", explanation };
}

// Fills the quote cards of the markets section. Each card names its source and the date its
// price was observed, and shows the move since the observation before it. A price from a source
// that publishes in arrears also carries a tag saying that it is delayed and how old it is.
async function loadMarketQuotes() {
  const cards = [...document.querySelectorAll("[data-market-code]")];
  const statusText = elements.marketStatus.querySelector("span:last-child");
  const dayLabel = (date) => formatDate(date, { month: "short", day: "numeric", timeZone: "UTC" });
  const show = (card, { value, available, change, observation, delay = null }) => {
    const valueNode = card.querySelector("[data-market-value]");
    valueNode.textContent = value;
    valueNode.classList.toggle("market-value-unavailable", !available);
    const changeNode = card.querySelector(".market-change");
    changeNode.textContent = change;
    changeNode.classList.toggle("market-change-pending", !available);
    card.querySelector(".market-observation").textContent = observation;
    const delayTag = card.querySelector(".delay-tag");
    delayTag.hidden = !delay;
    delayTag.textContent = delay ? ["Delayed", delay.age].filter(Boolean).join(" · ") : "";
    delayTag.title = delay?.explanation ?? "";
  };
  try {
    const response = await fetch("/api/markets", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("Market prices unavailable");
    const body = await response.json();
    marketQuotes = body.rates && typeof body.rates === "object" ? body.rates : {};
    const sources = new Set();
    for (const card of cards) {
      const quote = marketQuotes[card.dataset.marketCode];
      if (!quote || !isPositiveDecimal(String(quote.rate))) {
        show(card, { value: "Unavailable", available: false, change: "No price loaded", observation: "Press Refresh to try again" });
        continue;
      }
      sources.add(SOURCE_NAMES[quote.source]?.quote ?? quote.source);
      const previous = Number(quote.previous?.rate);
      const change = previous > 0
        ? `${formatSignedPercent((Number(quote.rate) / previous - 1) * 100)} since ${dayLabel(quote.previous.date)}`
        : "Daily reference";
      // A stale quote is the last one the source delivered; its refresh failed.
      show(card, {
        value: formatUsdPrice(quote.rate),
        available: true,
        change,
        observation: `${quote.source} · ${dayLabel(quote.date)}${quote.kind === "stale" ? " · not refreshed" : ""}`,
        delay: delayNotice(quote.source, quote.date),
      });
    }
    elements.marketStatus.dataset.state = sources.size ? "ready" : "error";
    statusText.textContent = sources.size ? [...sources].join(" · ") : "Market prices are not available right now";
  } catch {
    marketQuotes = {};
    for (const card of cards) {
      show(card, { value: "Unavailable", available: false, change: "Feed unavailable", observation: "Press Refresh to try again" });
    }
    elements.marketStatus.dataset.state = "error";
    statusText.textContent = "Market prices could not be loaded";
  }
  // Prices decide the order when the cards are sorted by price.
  renderMarketCardOrder();
  renderMarketHistory();
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Fraction digits for an amount in a currency, as Intl reports them; metals use 8.
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

function saveSettings() {
  return writeJson(STORAGE_KEY, settings);
}

// Returns false when localStorage is full or blocked, so that callers can say a change only
// lasts for this session.
function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// Screen reader announcement. The live region is cleared first so that a repeated message is
// read again.
function announce(message) {
  elements.announcements.textContent = "";
  window.setTimeout(() => {
    elements.announcements.textContent = message;
  }, 30);
}

// Lets a band of light cross the page title once; used when fresh reference rates arrive.
function catchLight() {
  const title = document.querySelector("h1");
  if (!title) return;
  title.classList.remove("is-catching-light");
  void title.offsetWidth; // Reflow, so that re-adding the class restarts the animation.
  title.classList.add("is-catching-light");
}

// ---------------------------------------------------------------------------
// Reference feed status
// ---------------------------------------------------------------------------

// The feed pill in the header and its copy in the sidebar.
function setFeedPill(label, state) {
  elements.feedPill.dataset.state = state;
  elements.feedPill.innerHTML = `<span class="status-dot"></span><span>${escapeHtml(label)}</span>`;
  elements.sidebarFeedStatus.textContent = label;
}

// Board pairs whose reference observation is past the stale threshold (domain/freshness.js).
function currentStalePairs() {
  const today = new Date();
  return settings.pairs.filter((id) => {
    const reference = referenceRates[id];
    return reference && isObservationStale(reference.date, today);
  });
}

// Updates the feed pill, the rate date line and the alert banner from the reference data.
function updateFeedStatus() {
  const boardRates = settings.pairs
    .map((id) => referenceRates[id])
    .filter(Boolean);
  const ratesAvailable = boardRates.length > 0;
  const stalePairs = currentStalePairs();
  const missingPairs = settings.pairs.filter((id) => !referenceRates[id]);
  const hasErrors = referenceMeta.errors?.length > 0;
  let label = "Live lookup";
  let state = "fresh";

  // Pill label and state, most serious condition first.
  if (!ratesAvailable) {
    label =
      referenceMeta.cacheStatus === "error" || hasErrors
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

  setFeedPill(label, state);
  if (!ratesAvailable) {
    elements.rateDate.textContent = "No reference data";
    elements.checkedAt.textContent = referenceMeta.checkedAt
      ? `Last checked ${formatCheckedAt(referenceMeta.checkedAt)}`
      : "Waiting for the first provider response";
  } else {
    // The newest observation date among the board's rates.
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

  // Alert banner text for the current condition, if any.
  let alertText = "";
  let alertKind = "warning";
  if (!ratesAvailable) {
    alertKind = "error";
    alertText =
      "Reference data is unavailable. Customer prices remain editable, but no reference values are being shown. Check the feed before relying on any rate.";
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
    alertText = `Partial reference coverage: ${missingPairs.length} pair${missingPairs.length === 1 ? " has" : "s have"} no returned rate. Missing rows are labeled individually.`;
  }
  elements.feedAlert.hidden = !alertText;
  elements.feedAlert.dataset.kind = alertKind;
  elements.feedAlert.textContent = alertText;
}

// ---------------------------------------------------------------------------
// Rates board
// ---------------------------------------------------------------------------

// Markup for a desk price and its margin badge. `margin` is in percent of the reference; a
// negative margin means the price is on the losing side, which `warning` explains on hover.
function priceText(price, quote, className = "", margin = null, warning = "") {
  if (!price) return `<span class="price-readout ${className}">—</span>`;
  const badge = margin === null
    ? ""
    : `<small class="margin-badge${margin < 0 ? " is-negative" : ""}" title="${escapeHtml(margin < 0 ? warning : "Margin against the reference rate")}">${escapeHtml(formatSignedPercent(margin))}${margin < 0 ? " !" : ""}</small>`;
  return `<span class="price-stack"><span class="price-readout ${className}">${escapeHtml(formatPairRate(price))} <small>${escapeHtml(quote)}</small></span>${badge}</span>`;
}

// Margins of a pair's desk prices against its reference rate, and any issues to review.
function reviewFor(id) {
  return reviewDeskPrice({ reference: referenceRates[id]?.rate, ...(settings.prices[id] ?? {}) });
}

// Renders the rates board: filters and sorts the pairs, then writes one row per visible pair.
function renderTable({
  animateRows = false,
  animatePair = null,
  highlightPair = null,
} = {}) {
  elements.pairTotal.textContent = `${settings.pairs.length} pair${settings.pairs.length === 1 ? "" : "s"}`;
  const toReview = settings.pairs.filter((id) => reviewFor(id).issues.length).length;
  elements.reviewChip.hidden = toReview === 0 && view.filter !== "review";
  elements.reviewChip.textContent = view.filter === "review" ? "Show all pairs" : `${toReview} to review`;
  elements.reviewChip.title = "Desk prices on the wrong side of the reference rate, or set before the reference moved";
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

  // Search text and the selected filter.
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
    if (view.filter === "review" && !reviewFor(id).issues.length) return false;
    return true;
  });
  // "board" keeps the saved order; the other sorts work on a copy.
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
    });
  if (view.sort === "rate-high" || view.sort === "rate-low")
    sortedPairs.sort((a, b) => {
      const aRate = referenceRates[a]?.rate;
      const bRate = referenceRates[b]?.rate;
      if (!aRate && !bRate) return 0;
      if (!aRate) return 1;
      if (!bRate) return -1;
      const order = compareDecimals(aRate, bRate);
      return view.sort === "rate-high" ? -order : order;
    });
  // Empty state, worded for a search or for a filter.
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
  }
  if (!visiblePairs.length) {
    elements.ratesBody.innerHTML = "";
  } else {
    // One row per pair: reference rate, desk prices with their margins, and the row actions.
    elements.ratesBody.innerHTML = sortedPairs
      .map((id, index) => {
        const { base, quote } = pairParts(id);
        const rate = referenceRates[id];
        const pairPrices = settings.prices[id] ?? { buy: "", sell: "" };
        const boardIndex = settings.pairs.indexOf(id);
        const review = reviewFor(id);
        const rowClasses = [
          review.issues.length ? "needs-review" : "",
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
          ? `<div class="reference-value ${stale ? "is-stale" : ""}"><strong>${escapeHtml(formatPairRate(rate.rate))} <small>${escapeHtml(quote)}</small></strong><small>1 ${escapeHtml(base)} · ${escapeHtml(refDate)}${cached ? " · CACHED" : stale ? " · STALE" : ""}</small>${review.issues.includes("reference-moved") ? `<small class="reference-moved">Moved ${escapeHtml(formatSignedPercent(review.drift))} since your prices were set</small>` : ""}</div>`
          : `<div class="reference-value is-missing"><strong>${referenceMeta.cacheStatus === "loading" ? "Loading…" : "No source rate"}</strong><small>${referenceMeta.cacheStatus === "loading" ? "" : !isSupportedPair(base, quote) ? "Use USD with gold or silver" : "Coverage unavailable"}</small></div>`;
        return `<tr class="${rowClasses}" style="--row-delay:${Math.min(index, 6) * 45}ms" data-pair="${escapeHtml(id)}">
        <td><div class="pair-cell"><span class="currency-chip">${escapeHtml(currencyMark(base))}</span><div class="pair-names"><strong>${escapeHtml(base)} <span aria-hidden="true">→</span> ${escapeHtml(quote)}</strong><small>${escapeHtml(currencyName(base))} / ${escapeHtml(currencyName(quote))}</small></div></div></td>
        <td>${refValue}</td>
        <td><div class="customer-price">${priceText(pairPrices.buy, quote, "", review.margins.buy, "You would pay more than the reference rate")}<button class="edit-price-button" type="button" data-edit-price="${escapeHtml(id)}" aria-label="${pairPrices.buy ? "Edit" : "Set"} desk buy price for ${escapeHtml(id)}">${pairPrices.buy ? "Edit" : "Set rate"}</button></div></td>
        <td><div class="customer-price">${priceText(pairPrices.sell, quote, "sell-price", review.margins.sell, "You would sell for less than the reference rate")}<button class="edit-price-button" type="button" data-edit-price="${escapeHtml(id)}" aria-label="${pairPrices.sell ? "Edit" : "Set"} desk sell price for ${escapeHtml(id)}">${pairPrices.sell ? "Edit" : "Set rate"}</button></div></td>
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
  if (animateRows) hasAnimatedRows = true;
  updateFeedStatus();
  renderCalculatorOptions();
  renderPairHistory();
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

// The last reference rates saved in this browser, validated, or null.
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

// Loads the currency list, falling back to the copy saved after the last successful load.
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

// Loads reference rates for the board. A pair the server leaves out keeps its previous rate,
// flagged as a cache fallback, and the board then reports partial coverage.
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
    const nextRates = { ...referenceRates };
    for (const [id, rate] of Object.entries(returnedRates))
      nextRates[id] = { ...rate, cacheFallback: Boolean(rate.cacheFallback) };
    const fallbackPairs = [];
    for (const id of settings.pairs) {
      if (!returnedRates[id] && nextRates[id]) {
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
    if (Object.keys(returnedRates).length) {
      writeJson(REFERENCE_CACHE_KEY, {
        rates: referenceRates,
        retrievedAt: referenceMeta.retrievedAt,
        source: body.source,
      });
    }
    renderTable({ animateRows: !hasAnimatedRows });
    renderCalculator();
    catchLight();
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

// ---------------------------------------------------------------------------
// Calculator
// ---------------------------------------------------------------------------

// Fills both calculator selects, keeping the current selection while it is still available.
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

// The calculator's pair as "BASE/QUOTE", or "" unless base and quote are two different codes.
function currentCalculatorPair() {
  const base = elements.calculatorBase.value;
  const quote = elements.calculatorQuote.value;
  return base && quote && base !== quote ? `${base}/${quote}` : "";
}

// Reference conversion and, for a pair on the board, the amounts at the desk's prices.
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
    elements.calculatorReferenceMeta.textContent = `${rate.source ?? "Frankfurter daily reference"} · ${formatRateObservation(rate)}${stale ? " · STALE" : cached ? " · CACHED" : ""} · not a customer quote`;
  } else {
    elements.calculatorReferenceMeta.textContent =
      lookupState === "error" || lookupState === "missing"
        ? "No Frankfurter observation is available for this pair."
        : metalPair
          ? `${metalPairUnit(base, quote)} · Frankfurter daily reference`
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

// Looks up the reference rate for a calculator pair; each pair is fetched once unless `force`
// is set.
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
  fetch(`/api/rates?pairs=${query}`, {
    headers: { accept: "application/json" },
  })
    .then(async (response) => {
      if (!response.ok) throw new Error("Reference lookup failed");
      return response.json();
    })
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
    })
    .catch(() => {
      calculatorLookupState.set(id, referenceRates[id] ? "cached" : "error");
      if (currentCalculatorPair() === id) renderCalculator();
    });
}

// Keeps base and quote different: choosing the code already on the other side moves that side
// to its previous code, or to the first other code.
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
  }
  previousCalculatorSelection = {
    base: elements.calculatorBase.value,
    quote: elements.calculatorQuote.value,
  };
  const id = currentCalculatorPair();
  renderCalculator();
  refreshCalculatorReference(id);
}

// ---------------------------------------------------------------------------
// Board editing
// ---------------------------------------------------------------------------

// Adds the calculator's pair to the board.
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
  announce(
    saved
      ? `${id} added to the rates board.`
      : `${id} added for this session; browser storage is unavailable.`,
  );
}

// Moves a pair before or after another one and switches the board to its saved order.
function reorderPair(
  sourceId,
  targetId,
  afterTarget = false,
  { restoreFocus = true } = {},
) {
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
  // Keyboard users keep focus on the moved pair.
  if (restoreFocus) {
    const controls = [
      ...elements.ratesBody.querySelectorAll("[data-move-pair]"),
    ].filter((button) => button.dataset.movePair === sourceId);
    (controls.find((button) => !button.disabled) ?? controls[0])?.focus();
  }
  announce(
    saved
      ? "Currency pair order saved."
      : "Currency pair order changed for this session; browser storage is unavailable.",
  );
}

// Moves a pair one place up or down the board.
function movePairInBoard(id, direction) {
  const index = settings.pairs.indexOf(id);
  const targetIndex = index + (direction === "up" ? -1 : 1);
  if (index < 0 || targetIndex < 0 || targetIndex >= settings.pairs.length)
    return;
  reorderPair(id, settings.pairs[targetIndex], direction === "down");
}

// Reverses a pair in place (USD/EUR becomes EUR/USD). Desk prices are never converted; they
// stay with the direction they were entered for.
function flipPairDirection(id) {
  const index = settings.pairs.indexOf(id);
  if (index < 0) return;
  const { base, quote } = pairParts(id);
  const flippedId = `${quote}/${base}`;
  if (settings.pairs.includes(flippedId)) {
    announce(`${flippedId} is already on the board.`);
    return;
  }
  // The reversed pair keeps the original's place among the history charts.
  const historyPosition = pairHistoryOrder.indexOf(id);
  if (historyPosition >= 0) {
    pairHistoryOrder[historyPosition] = flippedId;
    writeJson(PAIR_HISTORY_ORDER_KEY, pairHistoryOrder);
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
  announce(
    saved
      ? `${id} direction changed to ${flippedId}. Desk prices remain separate for each direction.`
      : `${id} direction changed for this session. Desk prices remain separate for each direction.`,
  );
}

// ---------------------------------------------------------------------------
// View preferences
// ---------------------------------------------------------------------------

// Applies theme, density and the board controls, and saves them unless `persist` is false.
function applyViewPreferences({ persist = true } = {}) {
  document.body.dataset.theme = view.theme;
  cosmos.setTheme(view.theme); // The star fields are painted in the theme's colours.
  document.body.dataset.density = view.density;
  elements.pairFilter.value = view.filter;
  elements.pairSort.value = view.sort;
  elements.boardDensity.value = view.density;
  elements.pairCardSort.value = view.pairCardSort;
  elements.marketCardSort.value = view.marketCardSort;
  elements.quoteCardSort.value = view.quoteCardSort;
  elements.boardTheme.value = view.theme;
  const themeAction = view.theme === "night" ? "Switch to bright mode" : "Switch to night mode";
  elements.themeToggle.setAttribute("title", themeAction);
  elements.themeToggle.setAttribute("aria-pressed", String(view.theme === "night"));
  elements.themeToggleLabel.textContent = view.theme === "night" ? "Day mode" : "Night mode";
  if (persist) writeJson(VIEW_STORAGE_KEY, view);
}

// ---------------------------------------------------------------------------
// Add pair dialog
// ---------------------------------------------------------------------------

// Opens the add pair dialog with currencies and metals in separate groups, USD/EUR preselected.
function openPairDialog() {
  if (settings.pairs.length >= MAX_BOARD_PAIRS) {
    announce(`This board supports up to ${MAX_BOARD_PAIRS} pairs.`);
    return;
  }
  const available = ensureSpecialAssets(currencies);
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
  elements.pairBase.innerHTML = optionMarkup;
  elements.pairQuote.innerHTML = optionMarkup;
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
    elements.pairBase.disabled = true;
    elements.pairQuote.disabled = true;
    elements.pairPreview.innerHTML =
      "<span>PAIR PREVIEW</span><strong>Coverage unavailable</strong><small>Refresh the reference feed and try again.</small>";
  } else {
    elements.pairBase.disabled = false;
    elements.pairQuote.disabled = false;
    elements.pairBase.value = preferredBase;
    elements.pairQuote.value = preferredQuote;
    updatePairPreview();
  }
  elements.pairDialog.showModal();
}

// Says whether the selected pair can be added, and if not, why.
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
          ? `${metalPairUnit(base, quote)}. Reference rate will be loaded after adding.`
          : "Reference rate will be loaded after adding.";
  elements.pairPreview.innerHTML = `<span>PAIR PREVIEW</span><strong>${escapeHtml(base || "—")} → ${escapeHtml(quote || "—")}</strong><small>${escapeHtml(detail)}</small>`;
}

// ---------------------------------------------------------------------------
// Desk price dialog
// ---------------------------------------------------------------------------

// Opens the desk price dialog for a pair on the board.
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
  document.querySelectorAll(".price-quote-code").forEach((node) => {
    node.textContent = quote;
  });
  elements.priceReferenceRate.textContent = reference
    ? `1 ${base} = ${formatPairRate(reference.rate)} ${quote}`
    : "No reference rate available";
  elements.priceReferenceDate.textContent = reference
    ? `${reference.source ?? "Frankfurter blended reference"} · ${formatRateObservation(reference)}`
    : "Reference data is not a customer price";
  elements.priceValidation.hidden = true;
  elements.priceValidation.textContent = "";
  elements.priceMargin.value = view.marginPercent;
  elements.applyMargin.disabled = !reference;
  updateMarginPreview();
  elements.priceDialog.showModal();
}

// Under the price fields: what the prices now in the dialog would earn against the reference.
function updateMarginPreview() {
  const reference = referenceRates[elements.pricePairId.value];
  const margins = deskMargins({ reference: reference?.rate, buy: elements.priceBuy.value.trim(), sell: elements.priceSell.value.trim() });
  const parts = [];
  if (margins.buy !== null) parts.push(margins.buy < 0 ? `Buying ${formatSignedPercent(-margins.buy).slice(1)} above the reference` : `Buy margin ${formatSignedPercent(margins.buy)}`);
  if (margins.sell !== null) parts.push(margins.sell < 0 ? `Selling ${formatSignedPercent(-margins.sell).slice(1)} below the reference` : `Sell margin ${formatSignedPercent(margins.sell)}`);
  if (margins.spread !== null) parts.push(`Spread ${margins.spread.toFixed(2)}%`);
  elements.marginPreview.dataset.state = (margins.buy ?? 0) < 0 || (margins.sell ?? 0) < 0 ? "warning" : "ok";
  elements.marginPreview.textContent = !reference
    ? "No reference rate to compare these prices with."
    : parts.length ? parts.join(" · ") : "Enter a price to see its margin against the reference.";
}

// Fills both price fields a chosen margin either side of the reference. Nothing is saved until
// the operator presses Save.
function fillPricesFromMargin() {
  const reference = referenceRates[elements.pricePairId.value];
  const margin = elements.priceMargin.value.trim();
  const prices = MARGIN_PATTERN.test(margin) ? pricesFromMargin(reference?.rate, margin) : null;
  if (!prices) {
    elements.priceValidation.textContent = reference
      ? "Enter a margin between 0 and 99.99 percent, using a decimal point."
      : "There is no reference rate to work from for this pair.";
    elements.priceValidation.hidden = false;
    return;
  }
  elements.priceValidation.hidden = true;
  elements.priceBuy.value = prices.buy;
  elements.priceSell.value = prices.sell;
  view.marginPercent = margin;
  writeJson(VIEW_STORAGE_KEY, view);
  updateMarginPreview();
}

// ---------------------------------------------------------------------------
// Rate sheet
// ---------------------------------------------------------------------------

// The desk's own price list as rows, for copying or downloading.
function currentRateSheet() {
  return rateSheetRows(settings.pairs, settings.prices, referenceRates);
}

async function copyRateSheet() {
  const rows = currentRateSheet();
  if (!rows.length) {
    announce("Set at least one desk price before copying a rate sheet.");
    return;
  }
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date());
  const text = rateSheetText(rows, { title: "Exchange rates", when });
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Without clipboard permission, fall back to a selection the browser can copy.
    const holder = document.createElement("textarea");
    holder.value = text;
    holder.setAttribute("readonly", "");
    holder.style.cssText = "position: fixed; top: 0; left: 0; opacity: 0; white-space: pre;";
    document.body.append(holder);
    holder.select();
    document.execCommand("copy");
    holder.remove();
  }
  elements.copyRateSheet.textContent = "Copied";
  window.setTimeout(() => { elements.copyRateSheet.textContent = "Copy rate sheet"; }, 1600);
  announce(`Rate sheet with ${rows.length} pair${rows.length === 1 ? "" : "s"} copied.`);
}

function downloadRateSheet() {
  const rows = currentRateSheet();
  if (!rows.length) {
    announce("Set at least one desk price before downloading a rate sheet.");
    return;
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([rateSheetCsv(rows)], { type: "text/csv;charset=utf-8" }));
  // Named for the desk's own calendar day, which around midnight is not the UTC one.
  const today = new Date();
  const day = [today.getFullYear(), today.getMonth() + 1, today.getDate()].map((part) => String(part).padStart(2, "0")).join("-");
  link.download = `counterline-rates-${day}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  announce(`Rate sheet with ${rows.length} pair${rows.length === 1 ? "" : "s"} downloaded.`);
}

// ---------------------------------------------------------------------------
// Dialog actions
// ---------------------------------------------------------------------------

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}

// Saves the desk prices entered in the price dialog. Clearing both fields removes the pair's
// prices.
function handlePriceSave(event) {
  event.preventDefault();
  const id = elements.pricePairId.value;
  const buy = elements.priceBuy.value.trim();
  const sell = elements.priceSell.value.trim();
  const { quote } = pairParts(id);
  const options = { maxScale: 8, maxDigits: 30 };
  if (!id || !settings.pairs.includes(id)) return;
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
  }
  if (buy && sell && compareDecimals(buy, sell) > 0) {
    elements.priceValidation.textContent =
      "The buy rate must be less than or equal to the sell rate for this pair direction.";
    elements.priceValidation.hidden = false;
    return;
  }
  if (buy || sell)
    // When the price was set, and against which reference, so the board can flag later moves.
    settings.prices[id] = { buy, sell, setAt: new Date().toISOString(), referenceAtSet: referenceRates[id]?.rate ?? null };
  else delete settings.prices[id];
  const saved = saveSettings();
  closeDialog(elements.priceDialog);
  renderTable({ highlightPair: id });
  renderCalculator();
  announce(
    saved
      ? `${id} desk prices saved on this device.`
      : `${id} prices are active for this session, but could not be saved on this device.`,
  );
}

// ---------------------------------------------------------------------------
// Header and navigation
// ---------------------------------------------------------------------------

// Today's date in the header.
function populateDate() {
  document.querySelector("#today-label").textContent = new Intl.DateTimeFormat(
    locale,
    { weekday: "short", month: "short", day: "numeric" },
  ).format(new Date());
}

// Highlights the sidebar link of the section under a reading line 40% down the viewport.
function initializeWorkspaceNavigation() {
  const links = [...document.querySelectorAll(".nav-item[href^='#']")];
  const destinations = links
    .map((link) => ({
      link,
      section: document.querySelector(link.getAttribute("href")),
    }))
    .filter(({ section }) => section);
  if (!destinations.length) return;

  const activate = (activeLink) => {
    for (const { link } of destinations) {
      const isActive = link === activeLink;
      link.classList.toggle("is-active", isActive);
      if (isActive)
        link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  };
  const syncToScrollPosition = () => {
    const readingLine = window.innerHeight * 0.4;
    const current = [...destinations]
      .reverse()
      .find(
        ({ section }) => section.getBoundingClientRect().top <= readingLine,
      );
    activate((current ?? destinations[0]).link);
  };

  destinations.forEach(({ link }) =>
    link.addEventListener("click", () => activate(link)),
  );
  window.addEventListener("hashchange", syncToScrollPosition);
  // Scroll handling is batched to one update per animation frame.
  let scrollFrame = 0;
  window.addEventListener(
    "scroll",
    () => {
      if (scrollFrame) return;
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = 0;
        syncToScrollPosition();
      });
    },
    { passive: true },
  );
  syncToScrollPosition();
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

// Wires up the page's controls.
function initializeEvents() {
  // Chart cards are reordered by dragging (or with the keyboard). Each grid saves its own order.
  const saveCardOrder = (label, storageKey, order) => {
    announce(
      writeJson(storageKey, order)
        ? `${label} card order saved.`
        : `${label} card order changed for this session; browser storage is unavailable.`,
    );
  };
  // Hovering a chart (or tapping it) reads out the date and price of the nearest point.
  const chartProbe = createChartProbe({
    grids: [elements.historyGrid, elements.marketHistoryGrid],
    chartFor: (card) => chartGeometry.get(card),
    describe: (chart, point) => ({
      tag: chart.kind === "estimated" ? "Estimate" : chart.kind === "stale" ? "Last observed" : "",
      value: chart.market ? formatUsdPrice(point.rate) : `${formatPairRate(point.rate)} ${chart.quote}`,
      when: formatHistoryTooltip(point.date),
    }),
    isBusy: () => Boolean(pairCharts.reorder?.isActive() || marketCharts.reorder?.isActive()),
  });
  // Moving a card in the DOM replays its running animations, so they end when a card is picked up.
  const settleCards = (cards) => {
    chartProbe.hide();
    for (const card of cards) card.classList.remove("is-entering", "is-drawing", "is-probing");
  };
  pairCharts.reorder = createCardReorder(elements.historyGrid, {
    onPickUp: settleCards,
    onReorder: (order) => {
      // An order arranged by hand replaces whatever sort was on.
      pairHistoryOrder = reconcileChartOrder(order, settings.pairs);
      view.pairCardSort = "custom";
      applyViewPreferences();
      saveCardOrder("Currency history", PAIR_HISTORY_ORDER_KEY, pairHistoryOrder);
    },
    onIdle: () => {
      if (pairCharts.renderPending) renderPairHistory();
    },
    announce,
  });
  marketCharts.reorder = createCardReorder(elements.marketHistoryGrid, {
    onPickUp: settleCards,
    onReorder: (order) => {
      marketHistoryOrder = reconcileChartOrder(order, MARKET_HISTORY_ASSETS.map(({ code }) => code));
      view.marketCardSort = "custom";
      applyViewPreferences();
      saveCardOrder("Metals and oil history", METAL_HISTORY_ORDER_KEY, marketHistoryOrder);
    },
    onIdle: () => {
      if (marketCharts.renderPending) renderMarketHistory();
    },
    announce,
  });
  for (const grid of [elements.historyGrid, elements.marketHistoryGrid]) {
    grid.addEventListener("animationend", (event) => {
      if (event.animationName === "enter-up") event.target.classList.remove("is-entering");
      if (event.animationName === "chart-reveal") event.target.closest("[data-history-card-id]")?.classList.remove("is-drawing");
    });
  }
  // Sorting the chart cards and the market cards by name or price.
  const sortLabels = { custom: "in your own order", "name-asc": "by name, A to Z", "name-desc": "by name, Z to A", "price-asc": "by price, lowest first", "price-desc": "by price, highest first" };
  for (const [control, key, render, label] of [
    [elements.pairCardSort, "pairCardSort", renderPairHistory, "Currency charts"],
    [elements.marketCardSort, "marketCardSort", renderMarketHistory, "Metal and oil charts"],
    [elements.quoteCardSort, "quoteCardSort", renderMarketCardOrder, "Market cards"],
  ]) {
    control.addEventListener("change", () => {
      view[key] = CARD_SORTS.includes(control.value) ? control.value : "custom";
      applyViewPreferences();
      render();
      announce(`${label} shown ${sortLabels[view[key]]}.`);
    });
  }
  // Cards carry a soft light that follows the mouse; styles.css reads the position from here.
  document.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse") return;
    const card = event.target.closest?.(".history-card, .market-card, .status-card");
    if (!card) return;
    const bounds = card.getBoundingClientRect();
    card.style.setProperty("--spot-x", `${event.clientX - bounds.left}px`);
    card.style.setProperty("--spot-y", `${event.clientY - bounds.top}px`);
  }, { passive: true });
  // The board row being dragged by its handle (see the drag handlers below).
  let draggedPairId = null;
  // Press feedback on buttons, unless the system asks for reduced motion.
  document.addEventListener("pointerdown", (event) => {
    const button = event.target.closest(".button");
    if (
      !button ||
      button.disabled ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    button.classList.remove("is-tapped");
    void button.offsetWidth; // Reflow, so that re-adding the class restarts the animation.
    button.classList.add("is-tapped");
    window.setTimeout(() => button.classList.remove("is-tapped"), 440);
  });
  document
    .querySelector("#add-pair-button")
    .addEventListener("click", openPairDialog);
  document
    .querySelector("#first-price-button")
    .addEventListener("click", () => openPriceDialog(settings.pairs[0]));
  // Refresh reloads every data set on the page.
  elements.refreshButton.addEventListener("click", () => {
    loadRates({ announceSuccess: true });
    loadPairHistory();
    loadMarketHistory();
    loadMarketQuotes();
    refreshCalculatorReference(currentCalculatorPair(), { force: true });
  });
  // Range buttons of the currency charts; the metals and oil charts have their own below.
  elements.historyRanges.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-history-range]");
    if (
      !button ||
      !elements.historyRanges.contains(button) ||
      button.disabled ||
      pairCharts.range === button.dataset.historyRange
    )
      return;
    // Clear the old range's charts so that they are not shown under the new range's label.
    pairCharts.range = button.dataset.historyRange;
    pairCharts.data = {};
    pairCharts.series = {};
    elements.historyRanges
      .querySelectorAll("[data-history-range]")
      .forEach((rangeButton) => {
        rangeButton.setAttribute(
          "aria-pressed",
          String(rangeButton === button),
        );
      });
    loadPairHistory();
  });
  elements.marketHistoryRanges.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-market-history-range]");
    if (!button || !elements.marketHistoryRanges.contains(button) || button.disabled || marketCharts.range === button.dataset.marketHistoryRange) return;
    marketCharts.range = button.dataset.marketHistoryRange;
    marketCharts.data = {};
    marketCharts.series = {};
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
    const opening = elements.displayOptions.hidden;
    elements.displayOptions.hidden = !opening;
    elements.optionsToggle.setAttribute("aria-expanded", String(opening));
    if (opening) elements.pairFilter.focus();
  });
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
    Object.assign(view, DEFAULT_VIEW);
    applyViewPreferences();
    renderTable();
    renderMarketHistory();
    renderMarketCardOrder();
    announce("Board view options reset.");
  });
  elements.pairBase.addEventListener("change", updatePairPreview);
  elements.pairQuote.addEventListener("change", updatePairPreview);
  // Adds the pair chosen in the add pair dialog.
  elements.pairForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const base = elements.pairBase.value;
    const quote = elements.pairQuote.value;
    const id = `${base}/${quote}`;
    if (
      base === quote ||
      !isSupportedPair(base, quote) ||
      settings.pairs.includes(id)
    ) {
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
    announce(
      saved
        ? `${id} added to the rates board.`
        : `${id} added for this session; browser storage is unavailable.`,
    );
  });
  elements.priceForm.addEventListener("submit", handlePriceSave);
  elements.priceBuy.addEventListener("input", updateMarginPreview);
  elements.priceSell.addEventListener("input", updateMarginPreview);
  elements.applyMargin.addEventListener("click", fillPricesFromMargin);
  elements.priceMargin.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault(); // Enter in the margin field fills the prices; it does not save them.
    fillPricesFromMargin();
  });
  elements.copyRateSheet.addEventListener("click", copyRateSheet);
  elements.downloadRateSheet.addEventListener("click", downloadRateSheet);
  elements.reviewChip.addEventListener("click", () => {
    view.filter = view.filter === "review" ? "all" : "review";
    applyViewPreferences();
    renderTable();
  });
  // The customer display is a separate page that reads the desk prices saved by this one.
  elements.openDisplay.addEventListener("click", () => {
    window.open("/display.html", "counterline-display", "popup=yes,width=1280,height=800");
  });
  // Clear removes both desk prices of the pair.
  document
    .querySelector("#clear-price-button")
    .addEventListener("click", () => {
      const id = elements.pricePairId.value;
      delete settings.prices[id];
      const saved = saveSettings();
      closeDialog(elements.priceDialog);
      renderTable({ highlightPair: id });
      renderCalculator();
      announce(
        saved
          ? `${id} customer prices cleared.`
          : `${id} prices cleared for this session; browser storage is unavailable.`,
      );
    });
  // Row and dialog buttons, delegated because the board's rows are re-rendered.
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
      movePairInBoard(
        moveButton.dataset.movePair,
        moveButton.dataset.moveDirection,
      );
      return;
    }
    const removeButton = event.target.closest("[data-remove-pair]");
    if (removeButton) {
      const id = removeButton.dataset.removePair;
      if (removeButton.disabled) return;
      removeButton.disabled = true;
      removeButton.closest("tr")?.classList.add("row-leaving");
      // Let the row's exit animation play before the board re-renders.
      const delay = window.matchMedia("(prefers-reduced-motion: reduce)")
        .matches
        ? 0
        : 180;
      window.setTimeout(() => {
        settings.pairs = settings.pairs.filter((pair) => pair !== id);
        delete settings.prices[id];
        const saved = saveSettings();
        renderTable();
        loadPairHistory();
        announce(
          saved
            ? `${id} removed from the rates board.`
            : `${id} removed for this session; browser storage is unavailable.`,
        );
      }, delay);
    }
  });
  // Board rows can also be dragged by their handle (HTML drag and drop).
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
    elements.ratesBody
      .querySelectorAll(".drop-before, .drop-after")
      .forEach((row) => row.classList.remove("drop-before", "drop-after"));
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
    elements.ratesBody
      .querySelectorAll(".is-dragging, .drop-before, .drop-after")
      .forEach((row) =>
        row.classList.remove("is-dragging", "drop-before", "drop-after"),
      );
  });
  // A click on the backdrop closes a dialog.
  for (const dialog of [elements.pairDialog, elements.priceDialog]) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  }
  // Calculator controls.
  elements.calculatorBase.addEventListener("change", () =>
    changeCalculatorCurrencies("base"),
  );
  elements.calculatorQuote.addEventListener("change", () =>
    changeCalculatorCurrencies("quote"),
  );
  elements.swapCurrencies.addEventListener("click", () => {
    const base = elements.calculatorBase.value;
    elements.calculatorBase.value = elements.calculatorQuote.value;
    elements.calculatorQuote.value = base;
    changeCalculatorCurrencies("quote");
  });
  elements.calculatorAddPair.addEventListener(
    "click",
    addCalculatorPairToBoard,
  );
  elements.calculatorAmount.addEventListener("input", renderCalculator);
  // "/" focuses the search field unless the user is typing or a dialog is open.
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "/" &&
      !["INPUT", "TEXTAREA", "SELECT"].includes(
        document.activeElement.tagName,
      ) &&
      !elements.pairDialog.open &&
      !elements.priceDialog.open
    ) {
      event.preventDefault();
      elements.searchInput.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

// Render straight away from the rates this browser saved last time, then fetch fresh data.
applyViewPreferences({ persist: false });
populateDate();
initializeEvents();
initializeWorkspaceNavigation();
renderTable();
const browserCache = readReferenceCache();
if (browserCache) {
  referenceRates = browserCache.rates;
  referenceMeta = {
    cacheStatus: "browser-cache-pending",
    errors: [],
    retrievedAt: browserCache.retrievedAt,
    checkedAt: browserCache.retrievedAt,
  };
  renderTable({ animateRows: true });
}
loadCurrencies();
loadRates();
loadPairHistory();
loadMarketHistory();
loadMarketQuotes();
// Reference rates refresh every 30 minutes and market quotes every 5, while the page is visible.
window.setInterval(
  () => {
    if (document.visibilityState !== "visible") return;
    loadRates();
    // The intraday views are redrawn so that their time axis keeps up; daily ones wait for Refresh.
    if (INTRADAY_HISTORY_RANGES.has(pairCharts.range)) loadPairHistory();
    if (INTRADAY_HISTORY_RANGES.has(marketCharts.range)) loadMarketHistory();
  },
  30 * 60 * 1000,
);
window.setInterval(
  () => {
    if (document.visibilityState === "visible") loadMarketQuotes();
  },
  5 * 60 * 1000,
);
