import { compareDecimals, formatDecimal, isPositiveDecimal, multiplyAndRound, parseDecimal } from "./domain/decimal.js";
import { isObservationStale } from "./domain/freshness.js";

const STORAGE_KEY = "counterline-fx-prices-v1";
const REFERENCE_CACHE_KEY = "counterline-fx-reference-cache-v1";
const CURRENCY_CACHE_KEY = "counterline-fx-currencies-v1";
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
  calculatorPair: document.querySelector("#calculator-pair"),
  calculatorBaseCode: document.querySelector("#calculator-base-code"),
  calculatorAmount: document.querySelector("#calculator-amount"),
  calculatorBuyResult: document.querySelector("#calculator-buy-result"),
  calculatorSellResult: document.querySelector("#calculator-sell-result"),
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
let referenceRates = {};
let referenceMeta = { cacheStatus: "loading", errors: [], retrievedAt: null, checkedAt: null };
let currencies = [];
let searchTerm = "";

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

function renderTable() {
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
    return text.includes(normalizedSearch);
  });
  elements.emptySearch.hidden = visiblePairs.length > 0 || normalizedSearch.length === 0;
  if (!visiblePairs.length) {
    elements.ratesBody.innerHTML = "";
  } else {
    elements.ratesBody.innerHTML = visiblePairs.map((id) => {
      const { base, quote } = pairParts(id);
      const rate = referenceRates[id];
      const pairPrices = settings.prices[id] ?? { buy: "", sell: "" };
      const stale = rate && (isObservationStale(rate.date, new Date()) || rate.cacheFallback || referenceMeta.cacheStatus === "stale-cache" || referenceMeta.cacheStatus === "error");
      const cached = rate && (rate.cacheFallback || referenceMeta.cacheStatus === "stale-cache" || referenceMeta.cacheStatus === "error" || referenceMeta.cacheStatus === "browser-cache-pending");
      const refDate = rate ? formatDate(rate.date, { month: "short", day: "numeric" }) : "—";
      const refValue = rate
        ? `<div class="reference-value ${stale ? "is-stale" : ""}"><strong>${escapeHtml(formatPairRate(rate.rate))} <small>${escapeHtml(quote)}</small></strong><small>1 ${escapeHtml(base)} · ${escapeHtml(refDate)}${cached ? " · CACHED" : stale ? " · STALE" : ""}</small></div>`
        : `<div class="reference-value is-missing"><strong>${referenceMeta.cacheStatus === "loading" ? "Loading…" : "No source rate"}</strong><small>${referenceMeta.cacheStatus === "loading" ? "" : "Coverage unavailable"}</small></div>`;
      return `<tr data-pair="${escapeHtml(id)}">
        <td><div class="pair-cell"><span class="currency-chip">${escapeHtml(base.slice(0, 2))}</span><div class="pair-names"><strong>${escapeHtml(base)} <span aria-hidden="true">→</span> ${escapeHtml(quote)}</strong><small>${escapeHtml(currencyName(base))} / ${escapeHtml(currencyName(quote))}</small></div></div></td>
        <td>${refValue}</td>
        <td><div class="customer-price">${priceText(pairPrices.buy, quote)}<button class="edit-price-button" type="button" data-edit-price="${escapeHtml(id)}" aria-label="${pairPrices.buy ? "Edit" : "Set"} desk buy price for ${escapeHtml(id)}">${pairPrices.buy ? "Edit" : "Set rate"}</button></div></td>
        <td><div class="customer-price">${priceText(pairPrices.sell, quote, "sell-price")}<button class="edit-price-button" type="button" data-edit-price="${escapeHtml(id)}" aria-label="${pairPrices.sell ? "Edit" : "Set"} desk sell price for ${escapeHtml(id)}">${pairPrices.sell ? "Edit" : "Set rate"}</button></div></td>
        <td class="action-cell"><button class="row-action" type="button" data-remove-pair="${escapeHtml(id)}" aria-label="Remove ${escapeHtml(id)} from the rate board"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 6h10M8 6V4h4v2m2 0-.6 9.5H6.6L6 6m2.5 2.5v4m3-4v4" /></svg></button></td>
      </tr>`;
    }).join("");
  }
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
    writeJson(CURRENCY_CACHE_KEY, currencies);
  } catch {
    const cached = readJson(CURRENCY_CACHE_KEY, []);
    if (Array.isArray(cached)) currencies = cached.filter((item) => item && /^[A-Z]{3}$/.test(item.code) && typeof item.name === "string");
  }
  renderCalculatorOptions();
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
    renderTable();
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
    renderTable();
    renderCalculator();
    if (announceSuccess) announce("The reference provider could not be reached.");
  } finally {
    elements.refreshButton.classList.remove("is-refreshing");
    elements.refreshButton.disabled = false;
  }
}

function renderCalculatorOptions() {
  const previous = elements.calculatorPair.value;
  elements.calculatorPair.innerHTML = settings.pairs.map((id) => {
    const { base, quote } = pairParts(id);
    return `<option value="${escapeHtml(id)}">${escapeHtml(base)} → ${escapeHtml(quote)}</option>`;
  }).join("");
  if (settings.pairs.includes(previous)) elements.calculatorPair.value = previous;
  renderCalculator();
}

function renderCalculator() {
  const id = elements.calculatorPair.value;
  if (!id || !settings.pairs.includes(id)) {
    elements.calculatorBaseCode.textContent = "—";
    elements.calculatorBuyResult.textContent = "Add a currency pair";
    elements.calculatorSellResult.textContent = "Add a currency pair";
    return;
  }
  const { base, quote } = pairParts(id);
  const amount = elements.calculatorAmount.value || "0";
  const prices = settings.prices[id] ?? {};
  elements.calculatorBaseCode.textContent = base;
  for (const [side, output] of [["buy", elements.calculatorBuyResult], ["sell", elements.calculatorSellResult]]) {
    const rate = prices[side];
    const amountValue = parseDecimal(amount);
    const result = rate && amountValue && amountValue.coefficient > 0n
      ? multiplyAndRound(amount, rate, amountDigits(quote))
      : null;
    output.textContent = result ? `${formatDecimal(result, locale, amountDigits(quote), amountDigits(quote))} ${quote}` : rate ? "Enter an amount" : "Set a desk rate";
  }
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
  renderTable();
  renderCalculator();
  announce(saved ? `${id} desk prices saved on this browser.` : `${id} prices are active for this session, but browser storage is unavailable.`);
}

function populateDate() {
  document.querySelector("#today-label").textContent = new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric" }).format(new Date());
}

function initializeEvents() {
  document.querySelector("#add-pair-button").addEventListener("click", openPairDialog);
  document.querySelector("#first-price-button").addEventListener("click", () => openPriceDialog(settings.pairs[0]));
  elements.refreshButton.addEventListener("click", () => loadRates({ announceSuccess: true }));
  elements.searchInput.addEventListener("input", () => { searchTerm = elements.searchInput.value; renderTable(); });
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
    renderTable();
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
    renderTable();
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
    const removeButton = event.target.closest("[data-remove-pair]");
    if (removeButton) {
      const id = removeButton.dataset.removePair;
      settings.pairs = settings.pairs.filter((pair) => pair !== id);
      delete settings.prices[id];
      const saved = saveSettings();
      renderTable();
      announce(saved ? `${id} removed from the rates board.` : `${id} removed for this session; browser storage is unavailable.`);
    }
  });
  for (const dialog of [elements.pairDialog, elements.priceDialog]) {
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  }
  elements.calculatorPair.addEventListener("change", renderCalculator);
  elements.calculatorAmount.addEventListener("input", renderCalculator);
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) && !elements.pairDialog.open && !elements.priceDialog.open) {
      event.preventDefault();
      elements.searchInput.focus();
    }
  });
}

populateDate();
initializeEvents();
renderTable();
const browserCache = readReferenceCache();
if (browserCache) {
  referenceRates = browserCache.rates;
  referenceMeta = { cacheStatus: "browser-cache-pending", errors: [], retrievedAt: browserCache.retrievedAt, checkedAt: browserCache.retrievedAt };
  renderTable();
}
loadCurrencies();
loadRates();
window.setInterval(() => { if (document.visibilityState === "visible") loadRates(); }, 30 * 60 * 1000);
