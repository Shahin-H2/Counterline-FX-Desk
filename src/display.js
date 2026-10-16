// Copyright (c) 2026 Shahin Hassanyan. All rights reserved.
//
// The customer display: the desk's own buy and sell prices, large, for a screen that faces
// customers. It reads the prices saved by the workspace page and redraws whenever they change.
// Reference rates never appear here, and nothing is requested from the network.
import { formatDecimal } from "./domain/decimal.js";
import { createCosmos } from "./ui/cosmos.js";

const STORAGE_KEY = "counterline-fx-prices-v1";
const CURRENCY_CACHE_KEY = "counterline-fx-currencies-v1";
const VIEW_STORAGE_KEY = "counterline-fx-view-v1";
const PAIR_PATTERN = /^[A-Z]{3}\/[A-Z]{3}$/;
const PRICE_PATTERN = /^\d+(?:\.\d{1,8})?$/;
const locale = navigator.language || "en-US";
const board = document.querySelector("#display-board");
const cosmos = createCosmos({ backdrop: document.querySelector(".cosmos") });

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function priceMarkup(label, price, base, quote, side) {
  const shown = PRICE_PATTERN.test(String(price ?? "")) ? formatDecimal(price, locale, 2, 8) : "—";
  const length = shown.length > 9 ? " is-longer" : shown.length > 7 ? " is-long" : "";
  return `<div class="display-price display-${side}${length}"><span>${label}</span><strong>${escapeHtml(shown)}</strong><small>${escapeHtml(quote)} per 1 ${escapeHtml(base)}</small></div>`;
}

function render() {
  const settings = readJson(STORAGE_KEY, {});
  const names = new Map((readJson(CURRENCY_CACHE_KEY, []) ?? []).filter((item) => item?.code).map((item) => [item.code, item.name]));
  const prices = settings.prices && typeof settings.prices === "object" ? settings.prices : {};
  const rows = (Array.isArray(settings.pairs) ? settings.pairs : [])
    .filter((id) => PAIR_PATTERN.test(String(id)) && (prices[id]?.buy || prices[id]?.sell));
  const theme = readJson(VIEW_STORAGE_KEY, {}).theme === "evergreen" ? "evergreen" : "night";
  if (document.body.dataset.theme !== theme) {
    document.body.dataset.theme = theme;
    cosmos.setTheme(theme);
  }

  board.dataset.rows = String(rows.length);
  board.innerHTML = rows.length
    ? rows.map((id) => {
        const [base, quote] = id.split("/");
        return `<article class="display-row">
          <div class="display-pair"><strong>${escapeHtml(base)} <span aria-hidden="true">→</span> ${escapeHtml(quote)}</strong><small>${escapeHtml(names.get(base) ?? base)} / ${escapeHtml(names.get(quote) ?? quote)}</small></div>
          ${priceMarkup("WE BUY", prices[id].buy, base, quote, "buy")}
          ${priceMarkup("WE SELL", prices[id].sell, base, quote, "sell")}
        </article>`;
      }).join("")
    : '<div class="display-empty"><strong>No rates to show yet</strong><span>Set a buy or sell price in the workspace and it appears here.</span></div>';

  const latest = rows.map((id) => Date.parse(prices[id].setAt)).filter(Number.isFinite).sort((left, right) => right - left)[0];
  document.querySelector("#display-updated").textContent = latest
    ? `Prices updated ${new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(latest))}`
    : "";
}

function tick() {
  const now = new Date();
  document.querySelector("#display-time").textContent = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(now);
  document.querySelector("#display-date").textContent = new Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric" }).format(now);
}

document.querySelector("#display-fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});
// The workspace saving a price fires this in every other window on the same origin.
window.addEventListener("storage", render);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") render();
});
cosmos.setTheme(document.body.dataset.theme);
render();
tick();
window.setInterval(tick, 15_000);
