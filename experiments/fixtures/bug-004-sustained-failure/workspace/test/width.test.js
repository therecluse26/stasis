import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleLength } from "../src/width.js";

// One test, on purpose. The cases run weakest first, so a partial fix gets further down
// the list before stopping.
test("counts characters the way a reader sees them", () => {
	assert.strictEqual(visibleLength("abc"), 3);
	// "e" followed by a combining acute accent: one letter, two code points.
	assert.strictEqual(visibleLength("café"), 4);
	// Outside the basic plane, so two UTF-16 code units.
	assert.strictEqual(visibleLength("\u{1F44D}"), 1);
	// A skin-tone modifier attaches to the sign before it.
	assert.strictEqual(visibleLength("\u{1F44D}\u{1F3FD}"), 1);
	// Three people joined by zero-width joiners, drawn as one glyph.
	assert.strictEqual(visibleLength("\u{1F468}‍\u{1F469}‍\u{1F467}"), 1);
});
