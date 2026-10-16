// Copyright (c) 2026 Shahin Hassanyan. All rights reserved.

import test from "node:test";
import assert from "node:assert/strict";
import { CARD_SORTS, sortCards } from "../src/domain/card-sort.js";

const cards = [
  { id: "USD/JPY", name: "USD JPY", price: 158.24 },
  { id: "USD/EUR", name: "USD EUR", price: 0.89154 },
  { id: "USD/TRY", name: "USD TRY", price: Number.NaN },
  { id: "USD/CAD", name: "USD CAD", price: 1.4229 },
];

test("custom order leaves the cards as they were arranged", () => {
  assert.deepEqual(sortCards(cards, "custom"), ["USD/JPY", "USD/EUR", "USD/TRY", "USD/CAD"]);
  assert.deepEqual(sortCards(cards, "nonsense"), ["USD/JPY", "USD/EUR", "USD/TRY", "USD/CAD"]);
  assert.ok(CARD_SORTS.includes("custom"));
});

test("sorts by name in both directions", () => {
  assert.deepEqual(sortCards(cards, "name-asc"), ["USD/CAD", "USD/EUR", "USD/JPY", "USD/TRY"]);
  assert.deepEqual(sortCards(cards, "name-desc"), ["USD/TRY", "USD/JPY", "USD/EUR", "USD/CAD"]);
  assert.deepEqual(sortCards([{ id: "b", name: "brent crude" }, { id: "g", name: "Gold" }, { id: "c", name: "Crude oil" }], "name-asc"), ["b", "c", "g"]);
});

test("sorts by price in both directions and keeps cards without a price last", () => {
  assert.deepEqual(sortCards(cards, "price-asc"), ["USD/EUR", "USD/CAD", "USD/JPY", "USD/TRY"]);
  assert.deepEqual(sortCards(cards, "price-desc"), ["USD/JPY", "USD/CAD", "USD/EUR", "USD/TRY"]);
});

test("equal cards keep their custom order, and the input is not changed", () => {
  const tied = [{ id: "a", name: "Same", price: 5 }, { id: "b", name: "Same", price: 5 }, { id: "c", name: "Same", price: 5 }];
  for (const sort of CARD_SORTS) assert.deepEqual(sortCards(tied, sort), ["a", "b", "c"], sort);
  assert.deepEqual(cards.map((card) => card.id), ["USD/JPY", "USD/EUR", "USD/TRY", "USD/CAD"]);
});
