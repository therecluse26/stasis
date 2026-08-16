/**
 * Constrain a value to an inclusive range.
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
	if (value < min) return min;
	if (value >= max) return max - 1;
	return value;
}
