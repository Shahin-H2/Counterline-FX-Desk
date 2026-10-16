// Copyright (c) 2026 Shahin Hassanyan. All rights reserved.

import test from "node:test";
import assert from "node:assert/strict";
import { deskMargins, pricesFromMargin, referenceDrift, reviewDeskPrice } from "../src/domain/margin.js";

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test("margins are shares of the reference: buying below it and selling above it earn", () => {
  const margins = deskMargins({ reference: "0.9000", buy: "0.8820", sell: "0.9180" });
  near(margins.buy, 2);
  near(margins.sell, 2);
  near(margins.spread, 4);
});

test("a price on the wrong side of the reference shows as a negative margin", () => {
  const margins = deskMargins({ reference: "100", buy: "101", sell: "99.5" });
  near(margins.buy, -1);
  near(margins.sell, -0.5);
  near(margins.spread, -1.5);
});

test("missing or unusable inputs give no margin rather than a wrong one", () => {
  assert.deepEqual(deskMargins({ reference: "", buy: "1", sell: "2" }), { buy: null, sell: null, spread: null });
  assert.deepEqual(deskMargins({ reference: "0", buy: "1", sell: "2" }), { buy: null, sell: null, spread: null });
  const buyOnly = deskMargins({ reference: "2", buy: "1.9", sell: "" });
  near(buyOnly.buy, 5);
  assert.equal(buyOnly.sell, null);
  assert.equal(buyOnly.spread, null);
  assert.equal(deskMargins({ reference: "abc", buy: "1" }).buy, null);
});

test("review flags prices on the wrong side of the reference", () => {
  assert.deepEqual(reviewDeskPrice({ reference: "100", buy: "98", sell: "102", referenceAtSet: "100" }).issues, []);
  assert.deepEqual(reviewDeskPrice({ reference: "100", buy: "100.5", sell: "102" }).issues, ["buy-above-reference"]);
  assert.deepEqual(reviewDeskPrice({ reference: "100", buy: "98", sell: "99" }).issues, ["sell-below-reference"]);
});

test("review flags a reference that has moved since the price was set", () => {
  near(referenceDrift("101", "100"), 1);
  assert.equal(referenceDrift("101", ""), null);
  assert.deepEqual(reviewDeskPrice({ reference: "100.6", buy: "98", sell: "103", referenceAtSet: "100" }).issues, ["reference-moved"]);
  assert.deepEqual(reviewDeskPrice({ reference: "100.4", buy: "98", sell: "103", referenceAtSet: "100" }).issues, []);
  assert.deepEqual(reviewDeskPrice({ reference: "99.4", buy: "98", sell: "103", referenceAtSet: "100" }).issues, ["reference-moved"]);
  assert.deepEqual(reviewDeskPrice({ reference: "100.4", buy: "98", sell: "103", referenceAtSet: "100" }, 0.25).issues, ["reference-moved"]);
  assert.deepEqual(reviewDeskPrice({ reference: "150", referenceAtSet: "100" }).issues, [], "a pair without desk prices has nothing to review");
});

test("fills desk prices a margin either side of the reference, at the reference's precision", () => {
  assert.deepEqual(pricesFromMargin("0.89154", 1.5), { buy: "0.87817", sell: "0.90491" });
  assert.deepEqual(pricesFromMargin("158.24", "2"), { buy: "155.08", sell: "161.40" });
  assert.deepEqual(pricesFromMargin("4148.6", 0), { buy: "4148.60", sell: "4148.60" });
  assert.deepEqual(pricesFromMargin("0.000241042848", 1), { buy: "0.00023863", sell: "0.00024345" });
  for (const [reference, margin] of [["", 1], ["0", 1], ["1.2", -1], ["1.2", 100], ["1.2", "abc"]]) assert.equal(pricesFromMargin(reference, margin), null);
});
