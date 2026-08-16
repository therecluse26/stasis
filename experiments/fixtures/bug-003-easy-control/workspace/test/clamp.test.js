import assert from "node:assert/strict";
import { test } from "node:test";
import { clamp } from "../src/clamp.js";

test("passes through a value inside the range", () => {
	assert.equal(clamp(5, 0, 10), 5);
});

test("clamps below the minimum", () => {
	assert.equal(clamp(-3, 0, 10), 0);
});

test("the maximum is inclusive", () => {
	assert.equal(clamp(10, 0, 10), 10);
});
