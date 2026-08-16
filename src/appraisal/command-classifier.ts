/**
 * Deterministic classification of shell commands and their outcomes.
 *
 * Pi does not expose bash exit codes as structured data. A non-zero exit makes the tool
 * throw, which the agent loop converts into `isError: true` with the exit code embedded
 * in the result text. So `isError` tells us reliably *whether* a command failed, and the
 * text tells us *why*. Both facts are used here and nowhere else.
 *
 * No LLM is involved. Classification is a pure function of the command string and the
 * result, which keeps appraisal reproducible across trials.
 */

import type { CommandKind } from "./events.ts";

/** Exactly the text Pi's bash tool appends on a non-zero exit. */
const EXIT_CODE_PATTERN = /Command exited with code (\d+)/;
const TIMEOUT_PATTERN = /Command timed out after ([\d.]+) seconds/;
const ABORTED_PATTERN = /Command aborted\s*$/m;

/**
 * Marker written by our own refusals.
 *
 * Kept in sync with `explain()` in policy/enforcement.ts; a test pins the two together,
 * because a drift here would silently make every refusal read as a code failure.
 */
export const BLOCK_MARKER = /BLOCKED[_ ]BY[_ ]STASIS[_ ]POLICY/i;

export type BashFailureKind = "exit" | "timeout" | "aborted" | "blocked" | "unknown" | "none";

export interface BashOutcome {
	failed: boolean;
	kind: BashFailureKind;
	/** Recovered from the result text; null when the command failed some other way. */
	exitCode: number | null;
	timeoutSeconds?: number;
}

/**
 * Interpret a bash tool result.
 *
 * `isError === false` means a clean exit 0 — Pi reports nothing else in that case.
 * Otherwise the reason is recovered from the text.
 */
export function classifyBashOutcome(text: string, isError: boolean): BashOutcome {
	if (!isError) return { failed: false, kind: "none", exitCode: 0 };

	const exit = EXIT_CODE_PATTERN.exec(text);
	if (exit) return { failed: true, kind: "exit", exitCode: Number(exit[1]) };

	const timeout = TIMEOUT_PATTERN.exec(text);
	if (timeout) return { failed: true, kind: "timeout", exitCode: null, timeoutSeconds: Number(timeout[1]) };

	if (ABORTED_PATTERN.test(text)) return { failed: true, kind: "aborted", exitCode: null };

	// Our own enforcement, or another extension's, refused the call. Recognising this is
	// load-bearing: a refusal is not evidence that the agent's hypothesis was wrong, and
	// must not be counted as a failure of it.
	if (BLOCK_MARKER.test(text) || /Tool execution was blocked/i.test(text)) {
		return { failed: true, kind: "blocked", exitCode: null };
	}

	return { failed: true, kind: "unknown", exitCode: null };
}

/** Bash output was truncated; the marker is the only reliable signal on the error path. */
export function isTruncated(text: string): boolean {
	return text.includes("Full output: ");
}

interface KindRule {
	kind: CommandKind;
	pattern: RegExp;
}

/**
 * Ordered most-specific first. `cargo test` must match test before build, and
 * `npm run typecheck` must match typecheck before the generic npm-script rules.
 */
const KIND_RULES: KindRule[] = [
	{
		kind: "test",
		pattern:
			/\b(vitest|jest|mocha|ava|tap|pytest|py\.test|phpunit|rspec|minitest|ctest|tox|nose2?|karma|playwright(\s+test)?|cypress)\b/i,
	},
	{ kind: "test", pattern: /\b(go|cargo|dotnet|swift|zig|deno|bun)\s+test\b/i },
	// Node's built-in runner: `node --test`, and `node --test-name-pattern=...`.
	{ kind: "test", pattern: /\bnode\b[^|;]*\s--test(-[\w-]+)?\b/i },
	{ kind: "test", pattern: /\b(gradle|gradlew|mvn|sbt)\s+.*\btest\b/i },
	{ kind: "test", pattern: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?tests?(:[\w-]+)?\b/i },
	{ kind: "test", pattern: /\bmake\s+(check|tests?)\b/i },

	{ kind: "typecheck", pattern: /\b(tsc|tsgo|mypy|pyright|pyre|flow)\b/i },
	{ kind: "typecheck", pattern: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(typecheck|type-check|types|tsc)\b/i },

	{
		kind: "lint",
		pattern: /\b(eslint|biome|oxlint|ruff|flake8|pylint|black|rubocop|golangci-lint|staticcheck|shellcheck)\b/i,
	},
	{ kind: "lint", pattern: /\bcargo\s+(clippy|fmt)\b/i },
	{ kind: "lint", pattern: /\bprettier\b.*--(check|list-different)\b/i },
	{ kind: "lint", pattern: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(lint|format:check|fmt)\b/i },

	{ kind: "build", pattern: /\b(webpack|rollup|vite|esbuild|tsup|parcel|cmake|ninja|bazel)\b/i },
	{ kind: "build", pattern: /\b(go|cargo|dotnet|swift|zig)\s+(build|install)\b/i },
	{ kind: "build", pattern: /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|compile|bundle)\b/i },
	{ kind: "build", pattern: /\b(gradle|gradlew|mvn)\s+(build|package|compile|assemble)\b/i },
	{ kind: "build", pattern: /^\s*make\b/i },

	{ kind: "vcs", pattern: /^\s*(git|jj|hg|svn)\b/i },

	{ kind: "inspect", pattern: /^\s*(ls|cat|bat|head|tail|less|more|wc|pwd|tree|stat|file|which|type|env|printenv)\b/i },
	{ kind: "inspect", pattern: /^\s*(grep|rg|ag|ack|find|fd|locate)\b/i },
	{ kind: "inspect", pattern: /^\s*(echo|printf|date|whoami|uname|df|du|ps|top)\b/i },
];

const KIND_PRIORITY: Record<CommandKind, number> = {
	test: 6,
	typecheck: 5,
	build: 4,
	lint: 3,
	vcs: 2,
	inspect: 1,
	other: 0,
};

/** Split a compound command into the segments that actually run something. */
export function commandSegments(command: string): string[] {
	return command
		.split(/&&|\|\||;|\|/)
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0);
}

function classifySegment(segment: string): CommandKind {
	// A leading `cd foo` or env assignment tells us nothing; look past it.
	const stripped = segment
		.replace(/^\s*(cd|pushd)\s+\S+\s*/i, "")
		.replace(/^\s*(\w+=\S*\s+)+/, "")
		.replace(/^\s*(sudo|time|nice|env|npx|pnpx|bunx)\s+/i, "");
	for (const rule of KIND_RULES) {
		if (rule.pattern.test(stripped)) return rule.kind;
	}
	return "other";
}

/**
 * Classify a whole command by its most significant segment.
 *
 * `cd packages/core && npm test` is a test run, not a directory change, and
 * `npm run build && npm test` is a test run rather than a build.
 */
export function classifyCommand(command: string): CommandKind {
	let best: CommandKind = "other";
	for (const segment of commandSegments(command)) {
		const kind = classifySegment(segment);
		if (KIND_PRIORITY[kind] > KIND_PRIORITY[best]) best = kind;
	}
	return best;
}

/** Event type pair for a command kind, or undefined when the kind carries no verdict. */
export function outcomeEventType(kind: CommandKind, failed: boolean) {
	switch (kind) {
		case "test":
			return failed ? ("TEST_FAILURE" as const) : ("TEST_SUCCESS" as const);
		case "build":
			return failed ? ("BUILD_FAILURE" as const) : ("BUILD_SUCCESS" as const);
		case "typecheck":
			return failed ? ("TYPECHECK_FAILURE" as const) : ("TYPECHECK_SUCCESS" as const);
		case "lint":
			return failed ? ("LINT_FAILURE" as const) : ("LINT_SUCCESS" as const);
		default:
			// A failing `ls` is a tool error, not evidence about the code. A succeeding one
			// is inspection, which must never raise stress.
			return failed ? ("TOOL_ERROR" as const) : ("INSPECTION" as const);
	}
}

/**
 * Shell constructs that write files, and so could be used to sidestep an edit limit.
 *
 * Pi ships no sandbox, so this is detection rather than containment. Each entry names
 * the construct so telemetry records what was seen rather than just a boolean.
 */
const MUTATION_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
	{ name: "redirect", pattern: /(^|[^0-9<>&])>{1,2}\s*[^\s|&>]/ },
	{ name: "tee", pattern: /\btee\b/ },
	{ name: "sed-in-place", pattern: /\bsed\b[^|;]*\s-[a-zA-Z]*i\b/ },
	{ name: "perl-in-place", pattern: /\bperl\b[^|;]*\s-[a-zA-Z]*i\b/ },
	{ name: "heredoc", pattern: /<<-?\s*['"]?\w+['"]?/ },
	{ name: "patch", pattern: /\b(patch|git\s+apply)\b/ },
	{ name: "git-restore", pattern: /\bgit\s+(checkout|restore|stash|reset|revert)\b/ },
	{ name: "move-copy", pattern: /^\s*(mv|cp|install|rsync)\b/m },
	{ name: "truncate", pattern: /\b(truncate|dd|shred)\b/ },
	{ name: "remove", pattern: /\brm\b/ },
	{ name: "inline-script", pattern: /\b(python3?|node|ruby|perl)\s+-[ce]\b/ },
];

export interface BypassSuspicion {
	suspected: boolean;
	constructs: string[];
}

/**
 * Detect shell commands shaped like file mutation.
 *
 * Deliberately conservative about what it ignores: a redirect into `/dev/null` or a
 * pipeline feeding a pager is not an attempt to write source.
 */
export function detectMutationBypass(command: string): BypassSuspicion {
	const constructs: string[] = [];
	for (const segment of commandSegments(command)) {
		if (/>\s*\/dev\/null/.test(segment)) continue;
		for (const { name, pattern } of MUTATION_PATTERNS) {
			if (pattern.test(segment) && !constructs.includes(name)) constructs.push(name);
		}
	}
	return { suspected: constructs.length > 0, constructs };
}
