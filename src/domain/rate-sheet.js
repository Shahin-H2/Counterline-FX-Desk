// The desk's own price list, for sharing with customers or keeping on file. Only pairs that have
// at least one desk price are listed; reference rates appear in the CSV for the desk's records
// and never in the text meant for customers.

export function rateSheetRows(pairs, prices, referenceRates = {}) {
  return pairs.flatMap((id) => {
    const price = prices[id];
    if (!price || (!price.buy && !price.sell)) return [];
    const [base, quote] = id.split("/");
    const reference = referenceRates[id];
    return [{ pair: id, base, quote, buy: price.buy || "", sell: price.sell || "", reference: reference?.rate ?? "", referenceDate: reference?.date ?? "", setAt: price.setAt ?? "" }];
  });
}

// A plain-text table with aligned columns, ready to paste into a message.
export function rateSheetText(rows, { title = "Exchange rates", when = "" } = {}) {
  const cell = (value) => value || "-";
  const widths = {
    pair: Math.max(4, ...rows.map((row) => row.pair.length)),
    buy: Math.max(6, ...rows.map((row) => cell(row.buy).length)),
    sell: Math.max(7, ...rows.map((row) => cell(row.sell).length)),
  };
  const line = (pair, buy, sell) => `${pair.padEnd(widths.pair)}  ${buy.padStart(widths.buy)}  ${sell.padStart(widths.sell)}`;
  return [
    when ? `${title} · ${when}` : title,
    "",
    line("PAIR", "WE BUY", "WE SELL"),
    ...rows.map((row) => line(row.pair, cell(row.buy), cell(row.sell))),
    "",
    "Prices are quote currency per 1 unit of the base currency and may change without notice.",
  ].join("\n");
}

const csvField = (value) => {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function rateSheetCsv(rows) {
  const header = ["pair", "base", "quote", "we_buy", "we_sell", "reference_rate", "reference_date", "price_set_at"];
  const lines = rows.map((row) => [row.pair, row.base, row.quote, row.buy, row.sell, row.reference, row.referenceDate, row.setAt]);
  return `${[header, ...lines].map((fields) => fields.map(csvField).join(",")).join("\r\n")}\r\n`;
}
