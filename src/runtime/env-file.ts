/**
 * `.env` file support.
 *
 * `tsx` does not read `.env`, so without this every entry point requires the caller to
 * export credentials by hand. Two consumers, with deliberately different behaviour:
 *
 *  - **CLI entry points** own their process, so they call `applyEnvFiles()` and let the
 *    values land in `process.env`. That is what carries a provider key into the Pi SDK and
 *    into every trial subprocess, which already inherits `process.env` wholesale.
 *
 *  - **The extension** is a guest inside someone else's `pi` process and must not mutate
 *    its environment. It uses `readEnvFiles()`, which is pure, and the config loader keeps
 *    only `PI_STASIS_*` keys from the result. A project `.env` full of unrelated
 *    application secrets is parsed and discarded, never retained and never logged.
 *
 * The real environment always wins over a file, matching Node's own `--env-file`, so
 * `PI_STASIS_MODE=off npm run experiment` still does what it says with a `.env` present.
 *
 * Values are literal. There is no `${VAR}` interpolation and no shell evaluation: a
 * configuration channel that can compute is a configuration channel that can differ
 * between two runs of the same study.
 *
 * Nothing here throws. A missing file is not an error, and a malformed line costs that one
 * line and a warning — a stray character in a dotfile should not stop a session starting.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface EnvFileLoad {
	/** Values, merged across files. Later files in the candidate list win. */
	values: Record<string, string>;
	/** For each key in `values`, the file it finally came from. */
	sources: Record<string, string>;
	/** Files actually read, in the order applied. */
	files: string[];
	/** Malformed lines and unreadable files. Reported, never fatal. */
	warnings: string[];
}

/** The two names looked for in each directory, in increasing order of precedence. */
export const ENV_FILE_NAMES = [".env", ".env.local"] as const;

const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Keys whose values look like credentials.
 *
 * Used to redact printed output and to keep secrets out of subprocesses with no business
 * seeing them. Deliberately broad: a false positive costs a redacted log line, a false
 * negative leaks a key.
 */
export function isCredentialKey(key: string): boolean {
	return /(?:^|_)(?:KEY|TOKEN|SECRET|SECRETS|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|AUTH)$/i.test(key) || /^AWS_/i.test(key);
}

/** Index of the quote that closes `body`, or -1. Escaped quotes do not close. */
function closingQuote(body: string, quote: string): number {
	for (let i = 0; i < body.length; i++) {
		if (body[i] !== quote) continue;
		if (quote === "'") return i;
		let backslashes = 0;
		for (let j = i - 1; j >= 0 && body[j] === "\\"; j--) backslashes++;
		if (backslashes % 2 === 0) return i;
	}
	return -1;
}

/** The escapes a double-quoted value may use. Anything else stays literal. */
function unescape(value: string): string {
	return value.replace(/\\([nrt\\"])/g, (_match, char: string) => {
		if (char === "n") return "\n";
		if (char === "r") return "\r";
		if (char === "t") return "\t";
		return char;
	});
}

/** A `#` starts a comment only at the start of an unquoted value or after whitespace. */
function stripComment(value: string): string {
	for (let i = 0; i < value.length; i++) {
		if (value[i] !== "#") continue;
		if (i === 0 || /\s/.test(value[i - 1]!)) return value.slice(0, i);
	}
	return value;
}

/**
 * Parse `.env` text.
 *
 * `KEY=value`, optionally prefixed `export `. Blank lines and `#` comments are skipped.
 * Single-quoted values are literal; double-quoted values expand `\n`, `\r`, `\t`, `\\` and
 * `\"`; either may span lines. Unquoted values are trimmed and lose any trailing comment.
 * Within one file the last assignment to a key wins.
 */
export function parseEnvFile(text: string, label: string): { values: Record<string, string>; warnings: string[] } {
	const values: Record<string, string> = {};
	const warnings: string[] = [];
	const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");

	for (let index = 0; index < lines.length; index++) {
		const raw = lines[index]!.trim();
		if (raw.length === 0 || raw.startsWith("#")) continue;

		const assignment = raw.startsWith("export ") ? raw.slice("export ".length).trim() : raw;
		const separator = assignment.indexOf("=");
		if (separator <= 0) {
			warnings.push(`${label}:${index + 1}: ignoring line, expected KEY=value`);
			continue;
		}

		const key = assignment.slice(0, separator).trim();
		if (!VALID_KEY.test(key)) {
			warnings.push(`${label}:${index + 1}: ignoring invalid key "${key}"`);
			continue;
		}

		const rest = assignment.slice(separator + 1);
		const quote = rest.startsWith('"') ? '"' : rest.startsWith("'") ? "'" : "";
		if (quote === "") {
			values[key] = stripComment(rest).trim();
			continue;
		}

		// A quoted value may run past the end of this line.
		const opened = index;
		let body = rest.slice(1);
		let end = closingQuote(body, quote);
		while (end < 0 && index + 1 < lines.length) {
			body += `\n${lines[++index]!}`;
			end = closingQuote(body, quote);
		}
		if (end < 0) {
			warnings.push(`${label}:${opened + 1}: ignoring ${key}, unterminated ${quote} quote`);
			continue;
		}
		const literal = body.slice(0, end);
		values[key] = quote === '"' ? unescape(literal) : literal;
	}

	return { values, warnings };
}

/** Read and merge the files that exist, in order. Never touches `process.env`. */
export function readEnvFiles(paths: string[]): EnvFileLoad {
	const values: Record<string, string> = {};
	const sources: Record<string, string> = {};
	const files: string[] = [];
	const warnings: string[] = [];

	for (const path of paths) {
		if (!existsSync(path)) continue;
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch (error) {
			warnings.push(`Ignoring ${path}: ${(error as Error).message}`);
			continue;
		}
		const parsed = parseEnvFile(text, path);
		for (const key of Object.keys(parsed.values)) sources[key] = path;
		Object.assign(values, parsed.values);
		warnings.push(...parsed.warnings);
		files.push(path);
	}

	return { values, sources, files, warnings };
}

/**
 * Candidate paths for a list of directories, lowest precedence first.
 *
 * Passing `[packageRoot, cwd]` means a project the extension is visiting outranks the
 * files shipped alongside the extension itself. In this repository the two are the same
 * directory, and duplicates are dropped.
 */
export function envFileCandidates(dirs: string[]): string[] {
	const candidates: string[] = [];
	for (const dir of dirs) {
		for (const name of ENV_FILE_NAMES) {
			const path = join(dir, name);
			if (!candidates.includes(path)) candidates.push(path);
		}
	}
	return candidates;
}

export interface ApplyEnvFilesOptions {
	/** Directories to look in. Defaults to the current working directory. */
	dirs?: string[];
	/** An explicit file, from `--env-file` or `PI_STASIS_ENV_FILE`. Replaces the candidates. */
	file?: string;
	/** Skip loading entirely, from `--no-env-file`. */
	disabled?: boolean;
	/** The environment to read and mutate. Defaults to `process.env`; tests pass their own. */
	env?: NodeJS.ProcessEnv;
}

/**
 * Load `.env` files into the environment, for entry points that own their process.
 *
 * A variable already present is left alone, so anything set in the shell — or inherited
 * from a parent process that already did this — takes precedence over every file.
 *
 * The returned `values` are only the ones actually applied, which is what a caller wants
 * to report: a key the shell already provided was not changed by the file and should not
 * be described as though it were.
 */
export function applyEnvFiles(options: ApplyEnvFilesOptions = {}): EnvFileLoad {
	const env = options.env ?? process.env;
	if (options.disabled === true || env.PI_STASIS_NO_ENV_FILE === "1") {
		return { values: {}, sources: {}, files: [], warnings: [] };
	}

	const explicit = options.file ?? env.PI_STASIS_ENV_FILE;
	const warnings: string[] = [];
	let paths: string[];
	if (explicit) {
		const path = resolve(explicit);
		// An explicitly requested file that is not there is a mistake worth reporting; the
		// conventional candidates are optional by nature and stay silent.
		if (!existsSync(path)) warnings.push(`No env file at ${path}`);
		paths = [path];
	} else {
		paths = envFileCandidates(options.dirs ?? [process.cwd()]);
	}

	const load = readEnvFiles(paths);
	const applied: Record<string, string> = {};
	const sources: Record<string, string> = {};
	for (const [key, value] of Object.entries(load.values)) {
		if (env[key] !== undefined) continue;
		env[key] = value;
		applied[key] = value;
		sources[key] = load.sources[key]!;
	}

	return { values: applied, sources, files: load.files, warnings: [...warnings, ...load.warnings] };
}

/** `KEY=value` pairs for printed output, with credential values redacted. */
export function describeEnvValues(values: Record<string, string>): string {
	return Object.keys(values)
		.sort()
		.map((key) => `${key}=${isCredentialKey(key) ? "<redacted>" : values[key]!}`)
		.join(", ");
}
