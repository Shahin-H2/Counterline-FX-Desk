import test from "node:test";
import assert from "node:assert/strict";
import { rateSheetCsv, rateSheetRows, rateSheetText } from "../src/domain/rate-sheet.js";

const pairs = ["USD/EUR", "USD/JPY", "USD/CAD", "XAU/USD"];
const prices = {
  "USD/EUR": { buy: "0.8780", sell: "0.9050", setAt: "2026-10-12T09:30:00.000Z" },
  "USD/JPY": { buy: "", sell: "161.40" },
  "USD/CAD": { buy: "", sell: "" },
};
const references = { "USD/EUR": { rate: "0.89154", date: "2026-10-12" }, "USD/JPY": { rate: "158.24", date: "2026-10-12" } };

test("lists only the pairs that have a desk price, in board order", () => {
  const rows = rateSheetRows(pairs, prices, references);
  assert.deepEqual(rows.map((row) => row.pair), ["USD/EUR", "USD/JPY"]);
  assert.deepEqual(rows[0], { pair: "USD/EUR", base: "USD", quote: "EUR", buy: "0.8780", sell: "0.9050", reference: "0.89154", referenceDate: "2026-10-12", setAt: "2026-10-12T09:30:00.000Z" });
  assert.deepEqual(rateSheetRows(pairs, {}), []);
});

test("the text sheet has aligned columns, shows desk prices only, and marks a missing side", () => {
  const text = rateSheetText(rateSheetRows(pairs, prices, references), { title: "Counterline FX Desk", when: "Oct 12, 2026, 9:35 AM" });
  assert.deepEqual(text.split("\n").slice(0, 5), [
    "Counterline FX Desk · Oct 12, 2026, 9:35 AM",
    "",
    "PAIR     WE BUY  WE SELL",
    "USD/EUR  0.8780   0.9050",
    "USD/JPY       -   161.40",
  ]);
  assert.equal(text.includes("0.89154"), false, "reference rates are not part of the customer sheet");
});

test("the CSV keeps the reference for the desk's records and escapes awkward fields", () => {
  const csv = rateSheetCsv(rateSheetRows(pairs, prices, references));
  assert.deepEqual(csv.split("\r\n"), [
    "pair,base,quote,we_buy,we_sell,reference_rate,reference_date,price_set_at",
    "USD/EUR,USD,EUR,0.8780,0.9050,0.89154,2026-10-12,2026-10-12T09:30:00.000Z",
    "USD/JPY,USD,JPY,,161.40,158.24,2026-10-12,",
    "",
  ]);
  assert.equal(rateSheetCsv([{ pair: 'A,"B"', base: "x\ny", quote: "", buy: "", sell: "", reference: "", referenceDate: "", setAt: "" }]).split("\r\n")[1], '"A,""B""","x\ny",,,,,,');
});
