import { compareDecimals, formatDecimal, isPositiveDecimal, multiplyAndRound, parseDecimal } from "./domain/decimal.js";
import { isObservationStale } from "./domain/freshness.js";

const STORAGE_KEY = "counterline-fx-prices-v1";
const REFERENCE_CACHE_KEY = "counterline-fx-reference-cache-v1";
const CURRENCY_CACHE_KEY = "counterline-fx-currencies-v1";
const VIEW_STORAGE_KEY = "counterline-fx-view-v1";
const DEFAULT_VIEW = { filter: "all", sort: "board", density: "comfortable", theme: "evergreen" };
const DEFAULT_PAIRS = ["USD/EUR", "USD/CAD", "USD/MXN", "USD/GBP", "USD/TRY", "USD/INR", "USD/JPY", "USD/CHF"];
const MAX_BOARD_PAIRS = 30;
const MANUAL_RATE_PATTERN = /^\d+(?:\.\d{1,8})?$/;
const locale = navigator.language || "en-US";

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
  calculatorReferenceResult: document.querySelector("#calculator-reference-result"),
  calculatorReferenceMeta: document.querySelector("#calculator-reference-meta"),
  calculatorBuyResult: document.querySelector("#calculator-buy-result"),
  calculatorSellResult: document.querySelector("#calculator-sell-result"),
  calculatorAddPair: document.querySelector("#calculator-add-pair"),
  announcements: document.querySelector("#announcements"),
};

function readJson(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function validPairId(value) {
  return typeof value === "string" && /^[A-Z]{3}\/[A-Z]{3}$/.test(value) && value.slice(0, 3) !== value.slice(4);
}

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

const settings = loadSettings();
const savedView = readJson(VIEW_STORAGE_KEY, {}) ?? {};
const view = {
  filter: ["all", "needs-prices", "priced", "reference-issues"].includes(savedView.filter) ? savedView.filter : DEFAULT_VIEW.filter,
  sort: ["board", "code", "name", "rate-high", "rate-low"].includes(savedView.sort) ? savedView.sort : DEFAULT_VIEW.sort,
  density: ["comfortable", "compact"].includes(savedView.density) ? savedView.density : DEFAULT_VIEW.density,
  theme: ["evergreen", "night"].includes(savedView.theme) ? savedView.theme : DEFAULT_VIEW.theme,
};
let referenceRates = {};
let referenceMeta = { cacheStatus: "loading", errors: [], retrievedAt: null, checkedAt: null };
let currencies = [];
let searchTerm = "";
let hasAnimatedRows = false;
const calculatorLookupState = new Map();
let previousCalculatorSelection = { base: "USD", quote: "EUR" };

function pairParts(id) {
  const [base, quote] = id.split("/");
  return { base, quote };
}

function currencyName(code) {
  return currencies.find((currency) => currency.code === code)?.name ?? code;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function formatDate(dateString, options = { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) {
  if (!dateString) return "Date unavailable";
  const date = new Date(`${dateString.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(locale, options).format(date);
}

function formatCheckedAt(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "Check time unavailable";
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function formatPairRate(rate) {
  return formatDecimal(rate, locale, 2, 8);
}

function amountDigits(code) {
  try {
    const digits = new Intl.NumberFormat(locale, { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
    return Number.isInteger(digits) && digits >= 0 && digits <= 8 ? digits : 2;
  } catch {
    return 2;
  }
}

function saveSettings() {
  return writeJson(STORAGE_KEY, settings);
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function announce(message) {
  elements.announcements.textContent = "";
  window.setTimeout(() => { elements.announcements.textContent = message; }, 30);
}

function setFeedPill(label, state) {
  elements.feedPill.dataset.state = state;
  elements.feedPill.innerHTML = `<span class="status-dot"></span><span>${escapeHtml(label)}</span>`;
  elements.sidebarFeedStatus.textContent = label;
}

function currentStalePairs() {
  const today = new Date();
  return settings.pairs.filter((id) => {
    const reference = referenceRates[id];
    return reference && isObservationStale(reference.date, today);
  });
}

function updateFeedStatus() {
  const boardRates = settings.pairs.map((id) => referenceRates[id]).filter(Boolean);
  const ratesAvailable = boardRates.length > 0;
  const stalePairs = currentStalePairs();
  const missingPairs = settings.pairs.filter((id) => !referenceRates[id]);
  const hasErrors = referenceMeta.errors?.length > 0;
  let label = "Live lookup";
  let state = "fresh";

  if (!ratesAvailable) {
    label = referenceMeta.cacheStatus === "error" || hasErrors ? "Unavailable" : "Waiting";
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

  setFeedPill(label, state);
  if (!ratesAvailable) {
    elements.rateDate.textContent = "No reference data";
    elements.checkedAt.textContent = referenceMeta.checkedAt ? `Last checked ${formatCheckedAt(referenceMeta.checkedAt)}` : "Waiting for the first provider response";
  } else {
    const dates = boardRates.map((rate) => rate.date).filter(Boolean).sort();
    const latestDate = dates.at(-1);
    elements.rateDate.textContent = latestDate ? formatDate(latestDate) : "Date unavailable";
    elements.checkedAt.textContent = `${referenceMeta.cacheStatus === "stale-cache" ? "Last successful fetch" : "Checked"} ${formatCheckedAt(referenceMeta.cacheStatus === "stale-cache" ? referenceMeta.retrievedAt : referenceMeta.checkedAt)} · pair dates shown below`;
  }

  let alertText = "";
  let alertKind = "warning";
  if (!ratesAvailable) {
    alertKind = "error";
    alertText = "Reference data is unavailable. Customer prices remain editable, but no reference values are being shown. Check the feed before relying on any rate.";
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
      const refDate = rate ? formatDate(rate.date, { month: "short", day: "numeric" }) : "—";
      const refValue = rate
        ? `<div class="reference-value ${stale ? "is-stale" : ""}"><strong>${escapeHtml(formatPairRate(rate.rate))} <small>${escapeHtml(quote)}</small></strong><small>1 ${escapeHtml(base)} · ${escapeHtml(refDate)}${cached ? " · CACHED" : stale ? " · STALE" : ""}</small></div>`
        : `<div class="reference-value is-missing"><strong>${referenceMeta.cacheStatus === "loading" ? "Loading…" : "No source rate"}</strong><small>${referenceMeta.cacheStatus === "loading" ? "" : "Coverage unavailable"}</small></div>`;
      return `<tr class="${rowClasses}" style="--row-delay:${Math.min(index, 6) * 45}ms" data-pair="${escapeHtml(id)}">
        <td><div class="pair-cell"><span class="currency-chip">${escapeHtml(base.slice(0, 2))}</span><div class="pair-names"><strong>${escapeHtml(base)} <span aria-hidden="true">→</span> ${escapeHtml(quote)}</strong><small>${escapeHtml(currencyName(base))} / ${escapeHtml(currencyName(quote))}</small></div></div></td>
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
    currencies = ensureIranianRial(currencies);
    writeJson(CURRENCY_CACHE_KEY, currencies);
  } catch {
    const cached = readJson(CURRENCY_CACHE_KEY, []);
    if (Array.isArray(cached)) currencies = cached.filter((item) => item && /^[A-Z]{3}$/.test(item.code) && typeof item.name === "string");
    currencies = ensureIranianRial(currencies);
  }
  renderCalculatorOptions();
  const selectedPair = currentCalculatorPair();
  if (!settings.pairs.includes(selectedPair)) refreshCalculatorReference(selectedPair);
}

function ensureIranianRial(list) {
  if (list.some((currency) => currency.code === "IRR")) return list;
  return [...list, { code: "IRR", name: "Iranian Rial", symbol: "﷼" }];
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
  if (!options.some((currency) => currency.code === "IRR")) options.push({ code: "IRR", name: "Iranian Rial", symbol: "﷼" });
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
  const amount = elements.calculatorAmount.value || "0";
  const onBoard = settings.pairs.includes(id);
  const rate = referenceRates[id];
  const prices = settings.prices[id] ?? {};
  const amountValue = parseDecimal(amount);
  elements.calculatorBaseCode.textContent = base;
  const referenceResult = rate && amountValue && amountValue.coefficient > 0n
    ? multiplyAndRound(amount, rate.rate, amountDigits(quote))
    : null;
  const lookupState = calculatorLookupState.get(id);
  elements.calculatorReferenceResult.textContent = referenceResult
    ? `${formatDecimal(referenceResult, locale, amountDigits(quote), amountDigits(quote))} ${quote}`
    : !amountValue || amountValue.coefficient <= 0n
      ? "Enter an amount"
      : lookupState === "loading" ? "Looking up reference…" : "Reference rate unavailable";
  if (rate) {
    const stale = isObservationStale(rate.date, new Date()) || rate.cacheFallback || (onBoard && ["stale-cache", "error"].includes(referenceMeta.cacheStatus));
    const cached = rate.cacheFallback || lookupState === "cached" || (onBoard && ["cached", "stale-cache", "error", "browser-cache-pending"].includes(referenceMeta.cacheStatus));
    elements.calculatorReferenceMeta.textContent = `Frankfurter daily reference · ${formatDate(rate.date)}${stale ? " · STALE" : cached ? " · CACHED" : ""} · not a customer quote`;
  } else {
    elements.calculatorReferenceMeta.textContent = lookupState === "error" || lookupState === "missing"
      ? "No Frankfurter observation is available for this pair."
      : "Frankfurter daily reference · not a customer quote";
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
  if (settings.pairs.length >= MAX_BOARD_PAIRS) {
    announce(`This board supports up to ${MAX_BOARD_PAIRS} pairs.`);
    return;
  }
  settings.pairs.push(id);
  const saved = saveSettings();
  renderTable({ animatePair: id, highlightPair: id });
  loadRates();
  announce(saved ? `${id} added to the rates board.` : `${id} added for this session; browser storage is unavailable.`);
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
  const available = currencies.length ? currencies : [];
  const optionMarkup = available.map(({ code, name }) => `<option value="${escapeHtml(code)}">${escapeHtml(code)} · ${escapeHtml(name)}</option>`).join("");
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
  elements.pairPreview.innerHTML = `<span>PAIR PREVIEW</span><strong>${escapeHtml(base || "—")} → ${escapeHtml(quote || "—")}</strong><small>${same ? "Choose two different currencies." : exists ? "This pair is already on the board." : "Reference rate will be loaded after adding."}</small>`;
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
  elements.priceReferenceDate.textContent = reference ? `Frankfurter blended reference · ${formatDate(reference.date)}` : "Reference data is not a customer price";
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
    refreshCalculatorReference(currentCalculatorPair(), { force: true });
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
    if (base === quote || settings.pairs.includes(id)) {
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
    announce(saved ? `${id} added to the rates board.` : `${id} added for this session; browser storage is unavailable.`);
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
renderTable();
const browserCache = readReferenceCache();
if (browserCache) {
  referenceRates = browserCache.rates;
  referenceMeta = { cacheStatus: "browser-cache-pending", errors: [], retrievedAt: browserCache.retrievedAt, checkedAt: browserCache.retrievedAt };
  renderTable({ animateRows: true });
}
loadCurrencies();
loadRates();
window.setInterval(() => { if (document.visibilityState === "visible") loadRates(); }, 30 * 60 * 1000);
