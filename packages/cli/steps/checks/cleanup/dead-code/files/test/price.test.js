import assert from "node:assert/strict";
import { test } from "node:test";
import { total, withTax } from "../src/index.js";

test("withTax adds twenty percent and rounds to the cent", () => {
  assert.equal(withTax(10), 12);
  assert.equal(withTax(0.99), 1.19);
});

test("total sums the lines with tax", () => {
  assert.equal(total([{ net: 10, quantity: 2 }, { net: 0.99, quantity: 1 }]), 25.19);
  assert.equal(total([]), 0);
});
