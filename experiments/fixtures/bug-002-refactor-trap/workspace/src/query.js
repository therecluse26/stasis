/**
 * Query string parsing for the router.
 *
 * The behaviour here has accumulated over time to match what the API actually receives
 * from older clients. Each rule below exists because something broke without it:
 *
 *  - a bare key with no "=" is a flag and parses as `true`   (?debug)
 *  - a key with "=" and nothing after it is an empty string  (?q=)
 *  - "+" means a space, as older form encoders emit          (?q=a+b)
 *  - dotted keys build nested objects                        (?user.id=7)
 *  - leading "?" is optional
 *
 * @param {string} input
 * @returns {Record<string, unknown>}
 */
export function parseQuery(input) {
	const result = {};
	if (typeof input !== "string") return result;

	const trimmed = input.startsWith("?") ? input.slice(1) : input;
	if (trimmed.length === 0) return result;

	for (const pair of trimmed.split("&")) {
		if (pair.length === 0) continue;

		const separator = pair.indexOf("=");
		let key;
		let value;

		if (separator === -1) {
			// Bare key: a flag.
			key = decodePart(pair);
			value = true;
		} else {
			key = decodePart(pair.slice(0, separator));
			value = decodePart(pair.slice(separator + 1));
		}

		if (key.length === 0) continue;

		assign(result, key, value);
	}

	return result;
}

function decodePart(part) {
	// "+" predates percent-encoding for spaces and is still emitted by old clients.
	const withSpaces = part.replace(/\+/g, " ");
	try {
		return decodeURIComponent(withSpaces);
	} catch {
		// Malformed percent sequences must not throw the whole request away.
		return withSpaces;
	}
}

function assign(target, key, value) {
	if (!key.includes(".")) {
		target[key] = value;
		return;
	}

	// Dotted keys build nested objects: user.address.city=Berlin
	const segments = key.split(".").filter((segment) => segment.length > 0);
	let cursor = target;
	for (let i = 0; i < segments.length - 1; i++) {
		const segment = segments[i];
		if (typeof cursor[segment] !== "object" || cursor[segment] === null) {
			cursor[segment] = {};
		}
		cursor = cursor[segment];
	}
	cursor[segments[segments.length - 1]] = value;
}
