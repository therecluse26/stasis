import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXTENSION_VERSION } from "../src/version.ts";

describe("extension version", () => {
	it("matches package.json", () => {
		// This value identifies which code produced a study's data, so a drift between the
		// two would make telemetry misattribute results to the wrong build.
		const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
			version: string;
		};
		expect(EXTENSION_VERSION).toBe(pkg.version);
	});
});
