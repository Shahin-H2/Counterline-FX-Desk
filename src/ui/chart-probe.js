// Copyright (c) 2026 Shahin Hassanyan. All rights reserved.
//
// Hover read-out for the history charts: a crosshair, a marker on the line, and a label with the
// date and price of the point nearest to the pointer. On a touch screen a tap does the same and
// the read-out stays until the next tap elsewhere.
//
// The chart cards carry the elements (.history-chart-wrap > .history-probe); this module places
// them and fills in the label. Their look lives in styles.css.

// Index of the point nearest to `x` when `count` points are spread evenly from firstX to lastX.
export function nearestPointIndex(count, firstX, lastX, x) {
  if (count <= 1 || lastX === firstX) return 0;
  const position = ((x - firstX) / (lastX - firstX)) * (count - 1);
  return Math.max(0, Math.min(count - 1, Math.round(position)));
}

// Where to centre a label of `size` so that it stays inside 0..limit.
export function clampCentre(centre, size, limit) {
  if (size >= limit) return limit / 2;
  return Math.max(size / 2, Math.min(limit - size / 2, centre));
}

export function createChartProbe({
  grids,
  chartFor, // (card) -> { width, height, points: [{ x, y, ... }] } in the chart's own units, or null
  describe, // (chart, point) -> { tag, value, when }
  isBusy = () => false, // true while cards are being moved
}) {
  let active = null; // the card whose read-out is showing

  function hide() {
    active?.classList.remove("is-probing"); // 
    active = null;
  }

  function show(event) {
    const frame = event.target.closest?.(".history-chart-wrap");
    const card = frame?.closest("[data-history-card-id]");
    const chart = card ? chartFor(card) : null;
    // A pressed mouse button means the card is being picked up, not read.
    if (!chart?.points.length || isBusy() || (event.pointerType === "mouse" && event.buttons)) {
      hide();
      return;
    }
    const bounds = frame.getBoundingClientRect();
    const pointerX = ((event.clientX - bounds.left) / bounds.width) * chart.width;
    const index = nearestPointIndex(chart.points.length, chart.points[0].x, chart.points.at(-1).x, pointerX);
    const point = chart.points[index];
    const left = (point.x / chart.width) * bounds.width;
    const top = (point.y / chart.height) * bounds.height;

    const probe = frame.querySelector(".history-probe");
    const label = probe.querySelector(".history-probe-label");
    const { tag, value, when } = describe(chart, point);
    label.querySelector("small").textContent = tag;
    label.querySelector("strong").textContent = value;
    label.querySelector("span").textContent = when;
    probe.style.setProperty("--probe-x", `${left}px`);
    probe.style.setProperty("--probe-y", `${top}px`);
    probe.style.setProperty("--label-x", `${clampCentre(left, label.offsetWidth, bounds.width)}px`);
    // The label sits above the point, where it does not cover the line, unless that would push
    // it out of the card. (The card is the frame's offset parent.)
    label.classList.toggle("is-below", frame.offsetTop + top < label.offsetHeight + 20);

    if (active !== card) hide();
    active = card;
    card.classList.add("is-probing");
  }

  for (const grid of grids) {
    grid.addEventListener("pointermove", show);
    grid.addEventListener("pointerdown", show);
    // A finger "leaves" the moment it lifts, so only a mouse or pen hides the read-out by leaving.
    grid.addEventListener("pointerleave", (event) => {
      if (event.pointerType !== "touch") hide();
    });
  }
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest?.(".history-chart-wrap")) hide();
  });
  window.addEventListener("scroll", hide, { passive: true });

  return { hide };
}
