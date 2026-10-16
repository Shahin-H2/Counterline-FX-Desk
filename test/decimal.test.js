// Copyright (c) 2026 Shahin Hassanyan. All rights reserved.

import test from "node:test";
import assert from "node:assert/strict";
import { compareDecimals, decimalFromNumber, formatDecimal, isPositiveDecimal, multiplyAndRound, parseDecimal } from "../src/domain/decimal.js";

test("multiplies decimal amounts without binary floating point errors", () => {
  assert.equal(multiplyAndRound("100.10", "0.9259", 2), "92.68");
  assert.equal(multiplyAndRound("0.01", "0.5", 2), "0.01");
  assert.equal(multiplyAndRound("0.01", "0.49", 2), "0.00");
});

test("uses exact quote direction and supports zero minor-unit currencies", () => {
  assert.equal(multiplyAndRound("100", "148.2501", 0), "14825");
  assert.equal(multiplyAndRound("100", "0.008", 2), "0.80");
});

test("validates positive decimal desk rates and compares decimal spreads", () => {
  assert.equal(isPositiveDecimal("0.000001", { maxScale: 8 }), true);
  assert.equal(isPositiveDecimal("0", { maxScale: 8 }), false);
  assert.equal(isPositiveDecimal("1,25", { maxScale: 8 }), false);
  assert.equal(isPositiveDecimal("1.123456789", { maxScale: 8 }), false);
  assert.equal(compareDecimals("0.93", "0.9300"), 0);
  assert.equal(compareDecimals("0.9299", "0.93"), -1);
  assert.equal(parseDecimal("1e-7").coefficient, 1n);
});

test("formats rates with grouping and preserves useful precision", () => {
  assert.equal(formatDecimal("12345.670000", "en-US"), "12,345.67");
  assert.equal(formatDecimal("0.00001234", "en-US"), "0.00001234");
});

test("turns computed numbers into plain decimal strings the parser accepts", () => {
  assert.equal(decimalFromNumber(1.4292799999999998), "1.42928");
  assert.equal(decimalFromNumber(4148.64), "4148.64");
  assert.equal(decimalFromNumber(1739580), "1739580");
  assert.equal(decimalFromNumber(0.1 + 0.2), "0.3");
  assert.equal(decimalFromNumber(1 / 4000, 10), "0.00025");
  assert.equal(decimalFromNumber(5.7485e-7, 10), "0.00000057485");
  for (const value of [1e-9, 0.000241042847, 0.89154, 96.65, 158.2417, 59.597, 1e12]) {
    const text = decimalFromNumber(value);
    assert.notEqual(parseDecimal(text), null, `${value} -> ${text}`);
    assert.ok(Math.abs(Number(text) - value) / value < 1e-3, `${value} -> ${text}`);
    assert.notEqual(formatDecimal(text, "en-US"), "—");
  }
});

test("refuses values that are not positive finite numbers", () => {
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "abc", 1e-15, 1e21]) {
    assert.equal(decimalFromNumber(value), null);
  }
});
