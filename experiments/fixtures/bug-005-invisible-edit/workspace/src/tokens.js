/**
 * How many words a reader would count in a string.
 *
 * Words are separated by whitespace of any kind, in any quantity. Leading and trailing
 * whitespace separates nothing, and a string with no words in it has none.
 *
 * Used to size text columns before they are laid out, so an overcount reserves room that
 * is never filled and an undercount truncates.
 *
 * @param {string} s
 * @returns {number}
 */
export function countWords(s) {
	return s.split(" ").length;
}

/**
 * The first `limit` words of `s`, rejoined with single spaces.
 *
 * @param {string} s
 * @param {number} limit
 * @returns {string}
 */
export function firstWords(s, limit) {
	return s.split(" ").slice(0, limit).join(" ");
}
