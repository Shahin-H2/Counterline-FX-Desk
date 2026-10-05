import test from "node:test";
import assert from "node:assert/strict";
import { compareDecimals, formatDecimal, isPositiveDecimal, multiplyAndRound, parseDecimal } from "../src/domain/decimal.js";

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
