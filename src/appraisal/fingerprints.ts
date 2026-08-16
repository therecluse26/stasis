/**
 * Failure fingerprinting.
 *
 * Two failures are "the same" when they represent the same unsuccessful outcome, even
 * though their raw text almost never matches byte for byte: timings, temp paths, PIDs,
 * object addresses and line numbers all drift between runs. Normalizing those away and
 * hashing what remains is what lets the system notice that an agent is producing the
 * same failure over and over, which is the single most important signal for the
 * persistence variable.
 *
 * Everything here is deterministic and dependency-free so the same session replays to
 * the same fingerprints.
 */

import { createHash } from "node:crypto";

const ANSI = /\[[0-9;]*[A-Za-z]/g;

/**
 * Substitutions applied to both commands and error text. Order matters: longer, more
 * specific forms are replaced before the general ones that would swallow them.
 */
const NOISE_RULES: Array<[RegExp, string]> = [
	// Timestamps and durations
	[/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "<TIME>"],
	[/\b\d{2}:\d{2}:\d{2}(\.\d+)?\b/g, "<TIME>"],
	[/\b\d+(\.\d+)?\s?(ms|s|sec|secs|seconds|m|min|mins|minutes|h|hrs)\b/gi, "<DUR>"],
	// Identifiers that change every run
	[/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<UUID>"],
	[/\b0x[0-9a-f]+\b/gi, "<ADDR>"],
	[/\b[0-9a-f]{40}\b/gi, "<SHA>"],
	[/\b[0-9a-f]{7,12}\b/gi, "<HASH>"],
	// Filesystem noise
	[/\/(?:tmp|var\/folders|private\/var)\/[^\s:'"]+/g, "<TMP>"],
	[/(?:[A-Za-z]:)?(?:\/[\w.@-]+)*\/node_modules\/[^\s:'"]*/g, "<DEP>"],
	[/(?:file:\/\/)?\/(?:[\w.@-]+\/)+/g, "<PATH>/"],
	// Positions and counts
	[/:\d+:\d+\b/g, ":<POS>"],
	[/\bline \d+\b/gi, "line <N>"],
	[/\b(pid|PID)[= ]\d+/g, "$1=<N>"],
	[/\b(port|PORT)[= :]\d+/g, "$1=<N>"],
	// Bare numbers last, so the specific rules above win
	[/\b\d{2,}\b/g, "<N>"],
];

function stripNoise(text: string): string {
	let out = text.replace(ANSI, "");
	for (const [pattern, replacement] of NOISE_RULES) out = out.replace(pattern, replacement);
	return out;
}

/** Normalize a shell command so equivalent invocations collapse to one form. */
export function normalizeCommand(command: string): string {
	return stripNoise(command).replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Lines that usually carry the identity of a failure.
 *
 * Test runners bury the useful line inside progress output, so lines matching these are
 * preferred over simply taking the first few.
 */
const SIGNAL_PATTERNS: RegExp[] = [
	/\berror\b/i,
	/\bfail(ed|ure|ing)?\b/i,
	/\bassert(ion)?\b/i,
	/\bexpected\b/i,
	/\bexception\b/i,
	/\bpanic:/i,
	/\btraceback\b/i,
	/^\s*[✕✗×]/,
	/\bTS\d{4}\b/,
	/\berror\[E\d+\]/,
	/\bcannot\b/i,
	/\bundefined\b/i,
	/\bnot found\b/i,
	/\bunexpected\b/i,
];

const NOISE_LINE = /^\s*(at\s|\s*\.\.\.|npm ERR!\s*$|\s*$)/;

/**
 * Reduce raw failure output to the few lines that identify it.
 *
 * Prefers lines that look like a diagnosis; falls back to the first non-empty lines when
 * nothing matches, so an unrecognized tool still produces a stable fingerprint.
 */
export function extractErrorSignal(text: string, maxLines: number): string {
	const lines = stripNoise(text)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !NOISE_LINE.test(line));

	const signal = lines.filter((line) => SIGNAL_PATTERNS.some((pattern) => pattern.test(line)));
	const chosen = (signal.length > 0 ? signal : lines).slice(0, maxLines);
	return chosen.join(" | ").toLowerCase().slice(0, 600);
}

export interface FingerprintInput {
	toolName: string;
	command?: string;
	errorText: string;
	/** Grouped rather than used exactly, so 1 and 2 do not read as different failures. */
	exitCode?: number | null;
	maxErrorLines: number;
}

/** Coarse exit-code buckets: the distinction that matters is which family of failure. */
export function exitCodeClass(exitCode: number | null | undefined): string {
	if (exitCode === undefined || exitCode === null) return "none";
	if (exitCode === 0) return "ok";
	if (exitCode === 1) return "generic";
	if (exitCode === 2) return "usage";
	if (exitCode >= 128) return "signal";
	return "other";
}

export interface Fingerprint {
	hash: string;
	/** Human-readable form, recorded in telemetry so a hash is never a dead end. */
	summary: string;
}

export function fingerprintFailure(input: FingerprintInput): Fingerprint {
	const command = input.command ? normalizeCommand(input.command) : "";
	const signal = extractErrorSignal(input.errorText, input.maxErrorLines);
	const parts = [input.toolName, command, exitCodeClass(input.exitCode), signal];
	const summary = parts.filter(Boolean).join(" :: ");
	return { hash: createHash("sha1").update(summary).digest("hex").slice(0, 12), summary };
}

/**
 * Fingerprint identifying only *what was attempted*, ignoring how it failed.
 *
 * Distinguishing "ran the same command again" from "produced the same failure again"
 * matters: re-running a test after a real change is legitimate, whereas re-running it
 * and getting the identical failure is the loop worth intervening in.
 */
export function fingerprintAttempt(toolName: string, command: string | undefined): Fingerprint {
	const summary = `${toolName} :: ${command ? normalizeCommand(command) : ""}`;
	return { hash: createHash("sha1").update(summary).digest("hex").slice(0, 12), summary };
}

/** File paths mentioned in error output, used to tie a failure to what was edited. */
export function extractMentionedFiles(text: string): string[] {
	const found = new Set<string>();
	const pattern = /(?:^|[\s"'(])((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)*\.\w{1,6})(?=[\s:"')]|$)/gm;
	for (const match of text.replace(ANSI, "").matchAll(pattern)) {
		const path = match[1];
		if (!path || path.includes("node_modules")) continue;
		found.add(path.replace(/^\.\//, ""));
		if (found.size >= 20) break;
	}
	return [...found];
}
