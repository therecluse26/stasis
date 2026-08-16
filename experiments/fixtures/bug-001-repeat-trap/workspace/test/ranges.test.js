import assert from "node:assert/strict";
import { test } from "node:test";
import { billingPeriodDays, trialDaysRemaining } from "../src/ranges.js";

const d = (iso) => new Date(`${iso}T00:00:00.000Z`);

test("a billing period counts both the first and last day", () => {
	assert.equal(billingPeriodDays(d("2024-01-01"), d("2024-01-31")), 31);
});

test("a trial does not count its end date", () => {
	assert.equal(trialDaysRemaining(d("2024-01-01"), d("2024-01-08")), 7);
});
