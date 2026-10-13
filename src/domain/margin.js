// How a desk's customer prices sit against the reference rate. A price is in quote units per one
// base unit, like the reference. The desk earns when it buys the base below the reference and
// sells it above; the percentages here are shares of the reference rate.

const positive = (value) => {
  const number = Number(value);
  return value !== "" && value != null && Number.isFinite(number) && number > 0 ? number : null;
};

// { buy, sell, spread } in percent, each null when it cannot be worked out.
export function deskMargins({ reference, buy, sell }) {
  const rate = positive(reference);
  if (rate === null) return { buy: null, sell: null, spread: null };
  const buyPrice = positive(buy);
  const sellPrice = positive(sell);
  return {
    buy: buyPrice === null ? null : ((rate - buyPrice) / rate) * 100,
    sell: sellPrice === null ? null : ((sellPrice - rate) / rate) * 100,
    spread: buyPrice === null || sellPrice === null ? null : ((sellPrice - buyPrice) / rate) * 100,
  };
}

// How far the reference has moved, in percent, since a desk price was set against it.
export function referenceDrift(reference, referenceAtSet) {
  const now = positive(reference);
  const then = positive(referenceAtSet);
  return now === null || then === null ? null : ((now - then) / then) * 100;
}

// What an operator should look at before quoting this pair:
//   buy-above-reference   the desk would pay more than the reference for the base
//   sell-below-reference  the desk would sell the base for less than the reference
//   reference-moved       the reference has moved by `driftLimit` percent or more since the price was set
export function reviewDeskPrice({ reference, buy, sell, referenceAtSet }, driftLimit = 0.5) {
  const margins = deskMargins({ reference, buy, sell });
  const drift = positive(buy) === null && positive(sell) === null ? null : referenceDrift(reference, referenceAtSet);
  const issues = [];
  if (margins.buy !== null && margins.buy < 0) issues.push("buy-above-reference");
  if (margins.sell !== null && margins.sell < 0) issues.push("sell-below-reference");
  if (drift !== null && Math.abs(drift) >= driftLimit) issues.push("reference-moved");
  return { margins, drift, issues };
}

// Desk prices a chosen margin either side of the reference, written with as many decimals as the
// reference itself (between 2 and 8). Null when either input is unusable.
export function pricesFromMargin(reference, marginPercent) {
  const rate = positive(reference);
  const margin = Number(marginPercent);
  if (rate === null || !Number.isFinite(margin) || margin < 0 || margin >= 100) return null;
  const decimals = Math.min(8, Math.max(2, (String(reference).split(".")[1] ?? "").length));
  const buy = (rate * (1 - margin / 100)).toFixed(decimals);
  const sell = (rate * (1 + margin / 100)).toFixed(decimals);
  return Number(buy) > 0 ? { buy, sell } : null;
}
