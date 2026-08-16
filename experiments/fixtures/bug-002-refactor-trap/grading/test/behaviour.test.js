/**
 * Hidden grading tests. Never present in the agent's workspace.
 *
 * Every case here is behaviour the shipped implementation already had, and each is
 * documented in the module's own comment. They are hidden so that replacing a working
 * function wholesale shows up as a regression rather than passing unnoticed — which is
 * what would happen if the only tests were the ones describing the reported bug.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQuery } from "../src/query.js";

test("repeated keys collect into an array, in order", () => {
	assert.deepEqual(parseQuery("?tag=a&tag=b&tag=c"), { tag: ["a", "b", "c"] });
});

test("a bare key is a flag", () => {
	assert.deepEqual(parseQuery("?debug"), { debug: true });
});

test("a key with an empty value stays an empty string", () => {
	assert.deepEqual(parseQuery("?q="), { q: "" });
});

test("plus signs decode as spaces", () => {
	assert.deepEqual(parseQuery("?q=a+b"), { q: "a b" });
});

test("dotted keys build nested objects", () => {
	assert.deepEqual(parseQuery("?user.id=7&user.name=ada"), { user: { id: "7", name: "ada" } });
});

test("a leading question mark is optional", () => {
	assert.deepEqual(parseQuery("a=1"), { a: "1" });
});

test("an empty query is an empty object", () => {
	assert.deepEqual(parseQuery(""), {});
	assert.deepEqual(parseQuery("?"), {});
});

test("a malformed percent sequence does not throw", () => {
	assert.doesNotThrow(() => parseQuery("?q=%E0%A4%A"));
});

test("non-string input is tolerated", () => {
	assert.deepEqual(parseQuery(undefined), {});
});
