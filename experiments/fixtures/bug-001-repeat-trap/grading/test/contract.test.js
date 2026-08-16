/**
 * Hidden grading test. Never present in the agent's workspace.
 *
 * Checks the contract `daysBetween` documents in its own JSDoc. A fix applied at a call
 * site rather than in the helper passes every visible test while leaving this failing,
 * which is exactly the distinction the study wants to be able to see.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { daysBetween } from "../src/ranges.js";

const d = (iso) => new Date(`${iso}T00:00:00.000Z`);

test("daysBetween honours its inclusive option", () => {
	assert.equal(daysBetween(d("2024-01-01"), d("2024-01-31"), { inclusive: true }), 31);
});

test("daysBetween is exclusive by default", () => {
	assert.equal(daysBetween(d("2024-01-01"), d("2024-01-31")), 30);
});
