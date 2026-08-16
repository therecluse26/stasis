import { describe, expect, it } from "vitest";
import { createAppraiser, countLines, editChangedLines } from "../src/appraisal/appraiser.ts";
import {
	BLOCK_MARKER,
	classifyBashOutcome,
	classifyCommand,
	detectMutationBypass,
	isTruncated,
} from "../src/appraisal/command-classifier.ts";
import { FailureDetector } from "../src/appraisal/failure-detector.ts";
import { baselineState } from "../src/stasis/config.ts";
import { createPolicyAdapter } from "../src/policy/adapter.ts";
import { Enforcement } from "../src/policy/enforcement.ts";
import {
	exitCodeClass,
	extractErrorSignal,
	extractMentionedFiles,
	fingerprintFailure,
	normalizeCommand,
} from "../src/appraisal/fingerprints.ts";
import { buildConfig } from "../src/stasis/config.ts";

const { config } = buildConfig();

describe("bash outcome", () => {
	it("reads a clean exit from isError alone", () => {
		// Pi reports nothing about a successful command, so isError is the only signal.
		expect(classifyBashOutcome("all good", false)).toEqual({ failed: false, kind: "none", exitCode: 0 });
	});

	it("recovers the exit code from the text Pi appends", () => {
		const outcome = classifyBashOutcome("FAIL\n\nCommand exited with code 1", true);
		expect(outcome).toMatchObject({ failed: true, kind: "exit", exitCode: 1 });
		expect(classifyBashOutcome("boom\n\nCommand exited with code 137", true).exitCode).toBe(137);
	});

	it("distinguishes timeouts and aborts from ordinary failures", () => {
		expect(classifyBashOutcome("x\n\nCommand timed out after 30 seconds", true)).toMatchObject({
			kind: "timeout",
			timeoutSeconds: 30,
		});
		expect(classifyBashOutcome("partial\n\nCommand aborted", true).kind).toBe("aborted");
	});

	it("recognizes a harness refusal, which is not evidence about the code", () => {
		expect(classifyBashOutcome("BLOCKED_BY_STASIS_POLICY (retryLimit)\n\nreason", true).kind).toBe("blocked");
	});

	it("recognizes the exact text enforcement actually emits", () => {
		// The producer and the consumer of this marker live in different modules. If they
		// drift, every refusal is silently reappraised as a failure of the agent's
		// hypothesis, and enforcement starts manufacturing the failures that justify it.
		const enforcement = new Enforcement(config);
		const decision = enforcement.review(
			{ toolName: "edit", toolCallId: "c1", input: { path: "a.ts", edits: [{ oldText: "x", newText: "y\n".repeat(500) }] } },
			{
				policy: createPolicyAdapter(config).derive(baselineState(config)),
				detector: new FailureDetector(config.appraisal),
				readSinceFailure: new Set(),
				hasFailed: false,
			},
		);
		expect(decision.block).toBe(true);
		expect(classifyBashOutcome(decision.reason!, true).kind).toBe("blocked");
		expect(BLOCK_MARKER.test(decision.reason!)).toBe(true);
	});

	it("detects truncated output", () => {
		expect(isTruncated("lots of output\n\n[Showing lines 1-10 of 900. Full output: /tmp/out.txt]")).toBe(true);
		expect(isTruncated("short output")).toBe(false);
	});
});

describe("command classification", () => {
	const cases: Array<[string, string]> = [
		["npm test", "test"],
		["npm run test:unit", "test"],
		["pnpm test -- --watch=false", "test"],
		["npx vitest run", "test"],
		["pytest -q tests/", "test"],
		["go test ./...", "test"],
		["node --test", "test"],
		["node --test --test-name-pattern=clamp", "test"],
		["cargo test --lib", "test"],
		["gradle test", "test"],
		["tsc --noEmit", "typecheck"],
		["npm run typecheck", "typecheck"],
		["mypy src", "typecheck"],
		["npm run build", "build"],
		["cargo build --release", "build"],
		["make", "build"],
		["eslint src --fix", "lint"],
		["cargo clippy", "lint"],
		["npm run lint", "lint"],
		["git status --porcelain", "vcs"],
		["ls -la src", "inspect"],
		["rg 'TODO' src", "inspect"],
		["cat package.json", "inspect"],
		["curl https://example.com", "other"],
	];

	for (const [command, expected] of cases) {
		it(`classifies "${command}" as ${expected}`, () => {
			expect(classifyCommand(command)).toBe(expected);
		});
	}

	it("looks past a leading cd or env assignment", () => {
		expect(classifyCommand("cd packages/core && npm test")).toBe("test");
		expect(classifyCommand("CI=1 npm test")).toBe("test");
	});

	it("classifies a compound command by its most significant part", () => {
		// Running the build then the tests is a test run; the verdict is about the tests.
		expect(classifyCommand("npm run build && npm test")).toBe("test");
		expect(classifyCommand("git add -A && npm run lint")).toBe("lint");
	});
});

describe("bypass detection", () => {
	const bypasses = [
		"echo 'x' > src/app.ts",
		"cat >> src/app.ts",
		"sed -i 's/a/b/' src/app.ts",
		"cat > f.ts <<'EOF'\nbody\nEOF",
		"git checkout -- src/app.ts",
		"patch -p1 < fix.diff",
		"python3 -c \"open('a.ts','w').write('x')\"",
		"mv new.ts src/app.ts",
	];
	for (const command of bypasses) {
		it(`flags ${command.split("\n")[0]}`, () => {
			expect(detectMutationBypass(command).suspected).toBe(true);
		});
	}

	it("does not flag ordinary reads, tests or discarded output", () => {
		for (const command of ["npm test", "cat src/app.ts", "grep -r TODO src", "npm test > /dev/null", "ls -la"]) {
			expect(detectMutationBypass(command).suspected, command).toBe(false);
		}
	});

	it("names the construct it matched, so telemetry is specific", () => {
		expect(detectMutationBypass("sed -i 's/a/b/' f.ts").constructs).toContain("sed-in-place");
	});
});

describe("fingerprints", () => {
	it("normalizes away run-to-run noise", () => {
		const a = "FAIL in 1.23s at 0x7ffd (pid 1234) /tmp/xyz/foo.ts:12:5";
		const b = "FAIL in 9.99s at 0x55e9 (pid 9876) /tmp/abc/foo.ts:44:9";
		expect(extractErrorSignal(a, 3)).toBe(extractErrorSignal(b, 3));
	});

	it("treats equivalent invocations of a command as the same", () => {
		expect(normalizeCommand("NPM   test  ")).toBe(normalizeCommand("npm test"));
	});

	it("prefers diagnostic lines over progress output", () => {
		const output = [
			"> project@1.0.0 test",
			"RUN v3.0.0",
			"  ✓ passes.test.ts",
			"  ✕ auth.test.ts > logs in",
			"    AssertionError: expected 200 to be 401",
		].join("\n");
		const signal = extractErrorSignal(output, 3);
		expect(signal).toContain("assertionerror");
		expect(signal).not.toContain("run v");
	});

	it("gives the same hash for the same failure and different hashes for different ones", () => {
		const make = (error: string) =>
			fingerprintFailure({ toolName: "bash", command: "npm test", errorText: error, exitCode: 1, maxErrorLines: 3 }).hash;
		expect(make("AssertionError: expected 200 to be 401")).toBe(make("AssertionError: expected 200 to be 401"));
		expect(make("AssertionError: expected 200 to be 401")).not.toBe(make("TypeError: undefined is not a function"));
	});

	it("groups exit codes into families rather than exact values", () => {
		expect(exitCodeClass(1)).toBe("generic");
		expect(exitCodeClass(2)).toBe("usage");
		expect(exitCodeClass(139)).toBe("signal");
		expect(exitCodeClass(null)).toBe("none");
	});

	it("extracts implicated source files but ignores dependencies", () => {
		const files = extractMentionedFiles("at src/auth/login.ts:12:4\n at node_modules/lib/index.js:9:1");
		expect(files).toContain("src/auth/login.ts");
		expect(files.some((file) => file.includes("node_modules"))).toBe(false);
	});
});

describe("failure detector", () => {
	const record = (fingerprint: string, files: string[] = [], step = 1) => ({
		fingerprint,
		attempt: "attempt-a",
		summary: `summary ${fingerprint}`,
		kind: "test" as const,
		files,
		step,
	});

	it("counts repeats and reports severity that saturates", () => {
		const detector = new FailureDetector(config.appraisal);
		expect(detector.observeFailure(record("f1")).repeated).toBe(false);
		expect(detector.observeFailure(record("f1")).repeated).toBe(true);
		const third = detector.observeFailure(record("f1"));
		const tenth = [...Array(7)].map(() => detector.observeFailure(record("f1"))).at(-1)!;
		expect(tenth.severity).toBeGreaterThan(third.severity);
		expect(tenth.severity).toBeLessThanOrEqual(1);
	});

	it("flags an invalidated assumption when the same failure survives an edit", () => {
		const detector = new FailureDetector(config.appraisal);
		detector.observeFailure(record("f1", ["src/auth.ts"]));
		detector.recordEdit("src/auth.ts");
		expect(detector.observeFailure(record("f1", ["src/auth.ts"])).assumptionInvalidated).toBe(true);
	});

	it("does not flag an invalidated assumption on a first failure", () => {
		const detector = new FailureDetector(config.appraisal);
		detector.recordEdit("src/auth.ts");
		expect(detector.observeFailure(record("f1", ["src/auth.ts"])).assumptionInvalidated).toBe(false);
	});

	it("forgets a failure once that kind of check passes", () => {
		const detector = new FailureDetector(config.appraisal);
		detector.observeFailure(record("f1"));
		detector.observeSuccess("test");
		expect(detector.observeFailure(record("f1")).repeated).toBe(false);
	});

	it("bounds the window rather than growing without limit", () => {
		const detector = new FailureDetector({ ...config.appraisal, failureWindow: 5 });
		for (let i = 0; i < 50; i++) detector.observeFailure(record(`f${i}`));
		expect(detector.snapshot().records.length).toBe(5);
	});

	it("round-trips through a snapshot", () => {
		const detector = new FailureDetector(config.appraisal);
		detector.observeFailure(record("f1"));
		detector.observeFailure(record("f1"));
		const snapshot = JSON.parse(JSON.stringify(detector.snapshot()));

		const restored = new FailureDetector(config.appraisal);
		restored.restore(snapshot);
		expect(restored.countOf("f1")).toBe(2);
		expect(restored.observeFailure(record("f1")).count).toBe(3);
	});

	it("detects a change of approach", () => {
		const detector = new FailureDetector(config.appraisal);
		detector.observeFailure(record("f1", ["src/auth.ts"]));
		expect(detector.detectStrategyChange("attempt-b", "test", ["src/session.ts"])).toBe(true);
		expect(detector.currentEpoch).toBe(1);
	});

	it("does not call an identical repeat a change of approach", () => {
		const detector = new FailureDetector(config.appraisal);
		detector.observeFailure(record("f1", ["src/auth.ts"]));
		expect(detector.detectStrategyChange("attempt-a", "test", ["src/auth.ts"])).toBe(false);
	});
});

describe("patch sizing", () => {
	it("counts both sides of an edit, as a reviewer reads a diff", () => {
		expect(editChangedLines({ edits: [{ oldText: "a\nb", newText: "c\nd\ne" }] })).toBe(5);
	});

	it("sums across multiple edits in one call", () => {
		expect(editChangedLines({ edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] })).toBe(4);
	});

	it("handles the legacy single-edit form Pi still accepts", () => {
		expect(editChangedLines({ oldText: "a\nb", newText: "c" })).toBe(3);
	});

	it("survives malformed input", () => {
		expect(editChangedLines({})).toBe(0);
		expect(editChangedLines({ edits: "nope" as never })).toBe(0);
		expect(editChangedLines({ edits: [null, 42] as never })).toBe(0);
		expect(countLines("")).toBe(0);
	});
});

describe("appraiser", () => {
	it("maps a failing test run to TEST_FAILURE with useful evidence", () => {
		const appraiser = createAppraiser(config);
		const { events } = appraiser.appraise({
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "npm test" },
			text: "FAIL src/auth.test.ts\n  AssertionError\n\nCommand exited with code 1",
			isError: true,
		});
		expect(events[0]!.type).toBe("TEST_FAILURE");
		expect(events[0]!.evidence.commandKind).toBe("test");
		expect(events[0]!.evidence.exitCode).toBe(1);
		expect(events[0]!.evidence.fingerprint).toBeTruthy();
	});

	it("emits REPEATED_FAILURE alongside the failure once it repeats", () => {
		const appraiser = createAppraiser(config);
		const outcome = {
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "npm test" },
			text: "AssertionError: nope\n\nCommand exited with code 1",
			isError: true,
		};
		appraiser.appraise(outcome);
		const types = appraiser.appraise(outcome).events.map((event) => event.type);
		expect(types).toContain("TEST_FAILURE");
		expect(types).toContain("REPEATED_FAILURE");
	});

	it("treats a successful read as inspection, never as pressure", () => {
		const appraiser = createAppraiser(config);
		const { events } = appraiser.appraise({
			toolName: "read",
			toolCallId: "c1",
			input: { path: "src/auth.ts" },
			text: "file contents",
			isError: false,
		});
		expect(events[0]!.type).toBe("INSPECTION");
	});

	it("emits LARGE_CHANGE only past the configured threshold", () => {
		const appraiser = createAppraiser(config);
		const apply = (changedLines: number) =>
			appraiser
				.appraise({
					toolName: "edit",
					toolCallId: "c1",
					input: { path: "src/app.ts" },
					text: "ok",
					isError: false,
					changedLines,
				})
				.events.map((event) => event.type);
		expect(apply(10)).toEqual(["PATCH_APPLIED"]);
		expect(apply(config.enforcement.largeChangeLines + 50)).toContain("LARGE_CHANGE");
	});

	it("does not appraise a harness refusal as a failure of the agent's hypothesis", () => {
		const appraiser = createAppraiser(config);
		const { events } = appraiser.appraise({
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "npm test" },
			text: "BLOCKED_BY_STASIS_POLICY (retryLimit)\n\nchange approach",
			isError: true,
		});
		expect(events).toEqual([]);
	});

	it("reports a suspected bypass separately from the events", () => {
		const appraiser = createAppraiser(config);
		const result = appraiser.appraise({
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "sed -i 's/a/b/' src/app.ts" },
			text: "",
			isError: false,
		});
		expect(result.bypass?.constructs).toContain("sed-in-place");
	});
});
