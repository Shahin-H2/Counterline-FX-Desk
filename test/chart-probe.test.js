import test from "node:test";
import assert from "node:assert/strict";
import { clampCentre, nearestPointIndex } from "../src/ui/chart-probe.js";

test("reads out the point nearest to the pointer", () => {
  // Five points spread from x = 54 to x = 334, 70 apart.
  assert.equal(nearestPointIndex(5, 54, 334, 54), 0);
  assert.equal(nearestPointIndex(5, 54, 334, 88), 0);
  assert.equal(nearestPointIndex(5, 54, 334, 90), 1);
  assert.equal(nearestPointIndex(5, 54, 334, 194), 2);
  assert.equal(nearestPointIndex(5, 54, 334, 334), 4);
});

test("a pointer outside the plot reads the first or last point", () => {
  assert.equal(nearestPointIndex(5, 54, 334, 0), 0);
  assert.equal(nearestPointIndex(5, 54, 334, 9999), 4);
  assert.equal(nearestPointIndex(1, 194, 194, 300), 0);
  assert.equal(nearestPointIndex(3, 100, 100, 50), 0);
});

test("keeps the label inside the chart", () => {
  assert.equal(clampCentre(170, 100, 340), 170);
  assert.equal(clampCentre(10, 100, 340), 50);
  assert.equal(clampCentre(335, 100, 340), 290);
  assert.equal(clampCentre(20, 400, 340), 170, "a label wider than the chart is centred");
});
