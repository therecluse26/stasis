import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQuery } from "../src/query.js";

test("parses simple pairs", () => {
	assert.deepEqual(parseQuery("?a=1&b=2"), { a: "1", b: "2" });
});

test("repeated keys collect into an array", () => {
	assert.deepEqual(parseQuery("?tag=a&tag=b"), { tag: ["a", "b"] });
});

test("percent-encoded values are decoded", () => {
	assert.deepEqual(parseQuery("?q=hello%20world"), { q: "hello world" });
});
