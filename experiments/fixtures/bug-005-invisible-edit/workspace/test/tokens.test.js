import assert from "node:assert/strict";
import { test } from "node:test";
import { countWords } from "#tokens";

// One test, on purpose. The cases run weakest first, so a partial fix gets further down
// the list before stopping.
test("counts words the way a reader counts them", () => {
	assert.strictEqual(countWords("one two three"), 3);
	assert.strictEqual(countWords("tabs\tand\nnewlines too"), 4);
	assert.strictEqual(countWords("double  spaced"), 2);
	assert.strictEqual(countWords("  padded  "), 1);
	assert.strictEqual(countWords("   "), 0);
});
