import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/runtime/config-loader.ts";
import {
	applyEnvFiles,
	envFileCandidates,
	isCredentialKey,
	parseEnvFile,
	readEnvFiles,
} from "../src/runtime/env-file.ts";

const PACKAGE_ROOT = join(import.meta.dirname, "..");

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "stasis-env-"));
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

/** Write a file into the scratch directory and return its path. */
function write(name: string, contents: string): string {
	const path = join(scratch, name);
	writeFileSync(path, contents, "utf8");
	return path;
}

function parse(contents: string): Record<string, string> {
	return parseEnvFile(contents, ".env").values;
}

describe("parseEnvFile", () => {
	it("reads plain assignments and ignores blanks and comments", () => {
		expect(
			parse(["# a comment", "", "  ", "FOO=bar", "  BAZ = qux  ", "# trailing comment line"].join("\n")),
		).toEqual({ FOO: "bar", BAZ: "qux" });
	});

	it("accepts an export prefix", () => {
		expect(parse("export OPENROUTER_API_KEY=sk-abc")).toEqual({ OPENROUTER_API_KEY: "sk-abc" });
	});

	it("strips a trailing comment from an unquoted value but not a mid-value hash", () => {
		expect(parse("FOO=bar # not part of it")).toEqual({ FOO: "bar" });
		expect(parse("FOO=bar#still-part-of-it")).toEqual({ FOO: "bar#still-part-of-it" });
	});

	it("keeps single-quoted values literal", () => {
		expect(parse("FOO='  spaced # hash \\n not a newline  '")).toEqual({
			FOO: "  spaced # hash \\n not a newline  ",
		});
	});

	it("expands escapes in double-quoted values only", () => {
		expect(parse('FOO="line1\\nline2\\ttabbed \\"quoted\\" back\\\\slash"')).toEqual({
			FOO: 'line1\nline2\ttabbed "quoted" back\\slash',
		});
	});

	it("does not interpolate", () => {
		// A configuration channel that can compute is one that can differ between two runs
		// of the same study.
		expect(parse('A=1\nB=${A}\nC="$A"')).toEqual({ A: "1", B: "${A}", C: "$A" });
	});

	it("reads quoted values that span lines", () => {
		expect(parse('KEY="-----BEGIN-----\nmiddle\n-----END-----"\nAFTER=yes')).toEqual({
			KEY: "-----BEGIN-----\nmiddle\n-----END-----",
			AFTER: "yes",
		});
	});

	it("handles CRLF and a byte order mark", () => {
		expect(parse("\uFEFFFOO=bar\r\nBAZ=qux\r\n")).toEqual({ FOO: "bar", BAZ: "qux" });
	});

	it("takes the last assignment when a key repeats", () => {
		expect(parse("FOO=first\nFOO=second")).toEqual({ FOO: "second" });
	});

	it("allows an empty value", () => {
		expect(parse("FOO=\nBAR=''")).toEqual({ FOO: "", BAR: "" });
	});

	it("warns and skips rather than throwing on a malformed line", () => {
		const result = parseEnvFile("GOOD=yes\nnot an assignment\n=novalue\n9INVALID=x\nAFTER=still-read", ".env");
		expect(result.values).toEqual({ GOOD: "yes", AFTER: "still-read" });
		expect(result.warnings).toHaveLength(3);
		expect(result.warnings[0]).toContain(".env:2");
		expect(result.warnings[2]).toContain('invalid key "9INVALID"');
	});

	it("warns on an unterminated quote, which consumes the rest of the file", () => {
		// The scanner cannot know where the author meant the value to stop, so it reads to
		// the end looking for the close. Nothing after the open quote survives — hence the
		// warning naming the line the quote was opened on.
		const result = parseEnvFile('FOO="never closed\nBAR=unreachable', ".env");
		expect(result.warnings[0]).toContain("unterminated");
		expect(result.warnings[0]).toContain(".env:1");
		expect(result.values).toEqual({});
	});
});

describe("readEnvFiles", () => {
	it("merges in order, with later files winning, and records where each key came from", () => {
		const base = write(".env", "SHARED=from-env\nONLY_BASE=base");
		const local = write(".env.local", "SHARED=from-local\nONLY_LOCAL=local");

		const load = readEnvFiles([base, local]);
		expect(load.values).toEqual({ SHARED: "from-local", ONLY_BASE: "base", ONLY_LOCAL: "local" });
		expect(load.sources.SHARED).toBe(local);
		expect(load.sources.ONLY_BASE).toBe(base);
		expect(load.files).toEqual([base, local]);
	});

	it("skips missing files silently", () => {
		const load = readEnvFiles([join(scratch, "nope.env")]);
		expect(load).toEqual({ values: {}, sources: {}, files: [], warnings: [] });
	});

	it("warns instead of throwing when a file cannot be read", () => {
		const path = write(".env", "FOO=bar");
		chmodSync(path, 0o000);
		const load = readEnvFiles([path]);
		chmodSync(path, 0o600);

		// Running as root defeats the permission bit; the assertion only holds otherwise.
		if (load.files.length === 0) {
			expect(load.warnings[0]).toContain(path);
			expect(load.values).toEqual({});
		}
	});

	it("never touches process.env", () => {
		write(".env", "STASIS_TEST_SENTINEL=leaked");
		readEnvFiles([join(scratch, ".env")]);
		expect(process.env.STASIS_TEST_SENTINEL).toBeUndefined();
	});
});

describe("envFileCandidates", () => {
	it("ranks .env.local above .env and later directories above earlier ones", () => {
		expect(envFileCandidates(["/pkg", "/project"])).toEqual([
			"/pkg/.env",
			"/pkg/.env.local",
			"/project/.env",
			"/project/.env.local",
		]);
	});

	it("drops duplicates when the directories coincide", () => {
		expect(envFileCandidates(["/pkg", "/pkg"])).toEqual(["/pkg/.env", "/pkg/.env.local"]);
	});
});

describe("applyEnvFiles", () => {
	it("applies values the environment does not already have", () => {
		write(".env", "FRESH=applied");
		const env = {} as NodeJS.ProcessEnv;

		const load = applyEnvFiles({ dirs: [scratch], env });
		expect(env.FRESH).toBe("applied");
		expect(load.values).toEqual({ FRESH: "applied" });
	});

	it("never overwrites what the shell already set", () => {
		// `PI_STASIS_MODE=off npm run experiment` has to keep working with a .env present.
		write(".env", "PI_STASIS_MODE=active\nPI_STASIS_PROFILE=exploratory");
		const env = { PI_STASIS_MODE: "off" } as NodeJS.ProcessEnv;

		const load = applyEnvFiles({ dirs: [scratch], env });
		expect(env.PI_STASIS_MODE).toBe("off");
		expect(env.PI_STASIS_PROFILE).toBe("exploratory");
		// Only what actually changed is reported, so a caller cannot describe a shell
		// variable as though a file had supplied it.
		expect(load.values).toEqual({ PI_STASIS_PROFILE: "exploratory" });
	});

	it("ranks .env.local above .env", () => {
		write(".env", "TOKENISH=from-env");
		write(".env.local", "TOKENISH=from-local");
		const env = {} as NodeJS.ProcessEnv;

		applyEnvFiles({ dirs: [scratch], env });
		expect(env.TOKENISH).toBe("from-local");
	});

	it("does nothing when disabled, by flag or by variable", () => {
		write(".env", "FOO=bar");

		const byFlag = {} as NodeJS.ProcessEnv;
		expect(applyEnvFiles({ dirs: [scratch], env: byFlag, disabled: true }).files).toEqual([]);
		expect(byFlag.FOO).toBeUndefined();

		const byVariable = { PI_STASIS_NO_ENV_FILE: "1" } as NodeJS.ProcessEnv;
		applyEnvFiles({ dirs: [scratch], env: byVariable });
		expect(byVariable.FOO).toBeUndefined();
	});

	it("reads an explicit file instead of the candidates, and warns when it is absent", () => {
		write(".env", "FOO=from-candidate");
		const explicit = write("other.env", "FOO=from-explicit");
		const env = {} as NodeJS.ProcessEnv;

		applyEnvFiles({ dirs: [scratch], env, file: explicit });
		expect(env.FOO).toBe("from-explicit");

		const missing = applyEnvFiles({ dirs: [scratch], env: {} as NodeJS.ProcessEnv, file: join(scratch, "gone.env") });
		expect(missing.warnings[0]).toContain("No env file at");
	});
});

describe("isCredentialKey", () => {
	it("catches the provider keys this project can load", () => {
		for (const key of [
			"OPENROUTER_API_KEY",
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
			"HF_TOKEN",
			"AWS_SECRET_ACCESS_KEY",
			"AWS_SESSION_TOKEN",
			"GOOGLE_APPLICATION_CREDENTIALS",
			"NPM_TOKEN",
		]) {
			expect(isCredentialKey(key), key).toBe(true);
		}
	});

	it("leaves ordinary configuration alone", () => {
		for (const key of ["PI_STASIS_MODE", "PI_STASIS_PROFILE", "PATH", "HOME", "CI", "NO_COLOR", "KEYBOARD"]) {
			expect(isCredentialKey(key), key).toBe(false);
		}
	});
});

describe("resolveConfig and .env", () => {
	it("takes PI_STASIS_* from a file and names it in the config sources", () => {
		const path = write(".env", "PI_STASIS_MODE=off");

		const resolution = resolveConfig({ cwd: scratch, packageRoot: PACKAGE_ROOT, envFiles: [path], env: {} as NodeJS.ProcessEnv });
		expect(resolution.loaded.config.runtime.mode).toBe("off");
		expect(resolution.envFiles).toEqual([path]);
		expect(resolution.loaded.sources.some((source) => source.includes(path))).toBe(true);
	});

	it("lets the real environment win over the file", () => {
		const path = write(".env", "PI_STASIS_MODE=off");

		const resolution = resolveConfig({
			cwd: scratch,
			packageRoot: PACKAGE_ROOT,
			envFiles: [path],
			env: { PI_STASIS_MODE: "observer" } as NodeJS.ProcessEnv,
		});
		expect(resolution.loaded.config.runtime.mode).toBe("observer");
	});

	it("ignores a .env sitting in the cwd when an explicit env is supplied", () => {
		// This is the firewall experiments/trial.ts depends on: it passes `env: {}` so that
		// no ambient variable can change one arm of a study. It is also what keeps this test
		// suite from depending on whichever .env happens to sit in the checkout.
		write(".env", "PI_STASIS_MODE=off");
		write(".env.local", "PI_STASIS_MODE=off");

		const resolution = resolveConfig({ cwd: scratch, packageRoot: scratch, env: {} as NodeJS.ProcessEnv });
		expect(resolution.loaded.config.runtime.mode).not.toBe("off");
		expect(resolution.envFiles).toEqual([]);
		expect(resolution.loaded.sources.some((source) => source.startsWith("env ("))).toBe(false);
	});

	it("does not name a file that contributed nothing", () => {
		// A .env holding only a provider key did not shape this configuration, and listing
		// it as a source would misreport where the physiology came from.
		const path = write(".env", "OPENROUTER_API_KEY=sk-abc");

		const resolution = resolveConfig({ cwd: scratch, packageRoot: PACKAGE_ROOT, envFiles: [path], env: {} as NodeJS.ProcessEnv });
		expect(resolution.envFiles).toEqual([]);
		expect(resolution.loaded.sources).toContain("env");
	});

	it("keeps non-PI_STASIS values out of configuration entirely", () => {
		const path = write(".env", "OPENROUTER_API_KEY=sk-secret\nDATABASE_URL=postgres://user:pw@host/db");

		const resolution = resolveConfig({ cwd: scratch, packageRoot: PACKAGE_ROOT, envFiles: [path], env: {} as NodeJS.ProcessEnv });
		const serialized = JSON.stringify(resolution);
		expect(serialized).not.toContain("sk-secret");
		expect(serialized).not.toContain("postgres://");
	});

	it("surfaces a malformed line as a startup warning without failing to load", () => {
		const path = write(".env", "this is not an assignment\nPI_STASIS_MODE=off");

		const resolution = resolveConfig({ cwd: scratch, packageRoot: PACKAGE_ROOT, envFiles: [path], env: {} as NodeJS.ProcessEnv });
		expect(resolution.warnings.some((warning) => warning.includes("expected KEY=value"))).toBe(true);
		expect(resolution.loaded.config.runtime.mode).toBe("off");
	});
});
