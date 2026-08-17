/**
 * How many characters a reader would count in a string.
 *
 * "Character" here means what somebody looking at the text would point at, not how the
 * string happens to be stored. An accented letter is one character however it was typed,
 * and an emoji is one character however many pieces it was assembled from.
 *
 * Used to lay out fixed-width columns, so an overcount pushes everything after it out of
 * alignment.
 *
 * @param {string} s
 * @returns {number}
 */
export function visibleLength(s) {
	return s.length;
}

/**
 * Pad a string to `width` visible characters, for column output.
 *
 * @param {string} s
 * @param {number} width
 * @returns {string}
 */
export function padToWidth(s, width) {
	const missing = width - visibleLength(s);
	return missing > 0 ? s + " ".repeat(missing) : s;
}
