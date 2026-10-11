import test from "node:test";
import assert from "node:assert/strict";
import { moveItem, slotAt } from "../src/ui/card-reorder.js";

// Three columns of 100 x 80 cards with a 12 px gap, two rows; the last row is not full.
const slots = [0, 1, 2, 3, 4].map((index) => ({ left: (index % 3) * 112, top: Math.floor(index / 3) * 92, width: 100, height: 80 }));

test("moving a card keeps every other card in its relative order", () => {
  const order = ["a", "b", "c", "d", "e"];
  assert.deepEqual(moveItem(order, 0, 3), ["b", "c", "d", "a", "e"]);
  assert.deepEqual(moveItem(order, 4, 0), ["e", "a", "b", "c", "d"]);
  assert.deepEqual(moveItem(order, 2, 2), order);
  assert.deepEqual(order, ["a", "b", "c", "d", "e"], "the input is left alone");
});

test("finds the slot under the pointer, across rows", () => {
  assert.equal(slotAt(slots, { x: 50, y: 40 }), 0);
  assert.equal(slotAt(slots, { x: 162, y: 40 }), 1);
  assert.equal(slotAt(slots, { x: 300, y: 79 }), 2);
  assert.equal(slotAt(slots, { x: 50, y: 130 }), 3);
  assert.equal(slotAt(slots, { x: 200, y: 172 }), 4);
});

test("a point in a gap or outside the grid belongs to no slot unless the slots are widened", () => {
  assert.equal(slotAt(slots, { x: 106, y: 40 }), -1);
  assert.equal(slotAt(slots, { x: 104, y: 40 }, 6), 0);
  assert.equal(slotAt(slots, { x: 108, y: 40 }, 6), 1);
  assert.equal(slotAt(slots, { x: 300, y: 130 }, 6), -1, "the empty cell of the last row");
  assert.equal(slotAt(slots, { x: -40, y: 40 }, 6), -1);
  assert.equal(slotAt([], { x: 0, y: 0 }), -1);
});
