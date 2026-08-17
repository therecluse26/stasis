/**
 * Experiment harness tests.
 *
 * Grading is the part of a study most able to be quietly wrong: if the oracle always
 * says "fail", every arm looks identical and the study reports nothing while appearing
 * to work. These tests pin its behavior on real fixtures, with no model involved.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBenchmark, loadFixture } from "../experiments/benchmark.ts";
import { classifyCommand } from "../src/appraisal/command-classifier.ts";
import { fingerprintFailure } from "../src/appraisal/fingerprints.ts";
import { captureDiff, grade, prepareWorkspace } from "../experiments/grade.ts";
import { applyRouting } from "../experiments/model.ts";
import { computeMetrics } from "../experiments/metrics.ts";
import { renderReport, summarize } from "../experiments/analysis.ts";
import type { TrialResult } from "../experiments/types.ts";
import type { StasisTelemetryRecord } from "../src/telemetry/schema.ts";

const FIXTURES = join(import.meta.dirname, "..", "experiments", "fixtures");

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "stasis-exp-"));
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function edit(workdir: string, file: string, replace: string, replacement: string): void {
	const path = join(workdir, file);
	const contents = readFileSync(path, "utf8");
	if (!contents.includes(replace)) throw new Error(`fixture text not found in ${file}: ${replace}`);
	writeFileSync(path, contents.replace(replace, replacement), "utf8");
}

describe("fixtures", () => {
	const ids = [
		"bug-001-repeat-trap",
		"bug-002-refactor-trap",
		"bug-003-easy-control",
		"bug-004-sustained-failure",
		"bug-005-invisible-edit",
	];

	it("every fixture's verify command is recognized as a test run", () => {
		// If the appraiser cannot tell that a fixture's command is a test, its failures
		// register as generic tool errors: the physiology barely responds and the study
		// measures almost nothing. This ties the two together so a fixture using an
		// unrecognized runner fails here rather than quietly weakening every trial.
		for (const id of ids) {
			const fixture = loadFixture(join(FIXTURES, id));
			expect(classifyCommand(fixture.verify), `${id}: ${fixture.verify}`).toBe("test");
		}
	});

	// bug-004 was built to produce repeated failure by making every obvious repair wrong. It
	// half-works, and the half that does not is worth pinning rather than papering over.
	//
	// Its ladder distinguishes two kinds of wrong: repairs that address a different problem
	// from the one currently failing (spreading a string does nothing for a combining mark,
	// so the same assertion fails with the same values), and repairs that genuinely advance
	// (normalizing fixes the combining mark and moves the failure to the emoji). The first
	// kind is a repeat; the second is progress that happens to be incomplete.
	//
	// This test asserted a single fingerprint across the whole ladder until 2026-08-16, and
	// passed — but for the wrong reason. `extractErrorSignal` was spending all three of its
	// lines on the reporter's framing, so the assertion never reached the hash and *every*
	// failure of a one-test suite collided. The fixture's real behaviour was invisible
	// underneath that, and so was the cost: an agent making progress was being appraised as
	// repeating itself.
	describe("bug-004 tells a repeat apart from incomplete progress", () => {
		const LADDER = [
			{ label: "spread, for surrogate pairs", impl: "[...s].length", advances: false },
			{ label: "Array.from, the same idea", impl: "Array.from(s).length", advances: false },
			{ label: "normalize, for combining marks", impl: 's.normalize("NFC").length', advances: true },
			{ label: "normalize and spread", impl: '[...s.normalize("NFC")].length', advances: true },
		];
		const SHIPPED = "return s.length;";

		function runVerify(fixture: ReturnType<typeof loadFixture>, workdir: string) {
			const result = spawnSync(fixture.verify, { cwd: workdir, shell: true, encoding: "utf8" });
			const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
			return {
				failed: result.status !== 0,
				hash: fingerprintFailure({
					toolName: "bash",
					command: fixture.verify,
					errorText: text,
					exitCode: result.status ?? undefined,
					maxErrorLines: 3,
				}).hash,
			};
		}

		it("fingerprints a repair that addresses the wrong problem as the same failure", () => {
			const fixture = loadFixture(join(FIXTURES, "bug-004-sustained-failure"));
			const workdir = join(scratch, "ladder");
			prepareWorkspace(fixture, workdir);

			const shipped = runVerify(fixture, workdir);
			expect(shipped.failed, "the shipped fixture must fail").toBe(true);

			const hashes = new Map<string, string[]>();
			hashes.set(shipped.hash, ["the shipped bug"]);
			for (const rung of LADDER) {
				edit(workdir, "src/width.js", SHIPPED, `return ${rung.impl};`);
				const attempt = runVerify(fixture, workdir);
				expect(attempt.failed, `${rung.label} must not accidentally fix the bug`).toBe(true);
				hashes.set(attempt.hash, [...(hashes.get(attempt.hash) ?? []), rung.label]);
				edit(workdir, "src/width.js", `return ${rung.impl};`, SHIPPED);
			}

			// Two groups, split exactly where the ladder starts making progress: the repairs
			// that leave the failing assertion untouched share the shipped bug's fingerprint,
			// and the ones that fix it share a different one.
			const stuck = LADDER.filter((rung) => !rung.advances).map((rung) => rung.label);
			expect([...hashes.values()].map((group) => group.sort())).toEqual(
				expect.arrayContaining([["the shipped bug", ...stuck].sort()]),
			);
			expect(hashes.size, `expected two fingerprints, got ${JSON.stringify([...hashes])}`).toBe(2);
		});

		it("is solved by the one correct implementation", () => {
			const fixture = loadFixture(join(FIXTURES, "bug-004-sustained-failure"));
			const workdir = join(scratch, "solved");
			prepareWorkspace(fixture, workdir);
			// Solvable on purpose: a fixture nobody can finish measures the turn cap.
			edit(workdir, "src/width.js", SHIPPED, "return [...new Intl.Segmenter().segment(s)].length;");
			expect(grade(fixture, workdir, join(scratch, "solved-grade")).success).toBe(true);
		});

		it("reports a repair that handles only the visible cases as an incomplete fix", () => {
			const fixture = loadFixture(join(FIXTURES, "bug-004-sustained-failure"));
			const workdir = join(scratch, "partial");
			prepareWorkspace(fixture, workdir);
			// Strips combining marks, skin-tone modifiers and joiners by hand. Enough for
			// every case the agent can see, and wrong for flags, keycaps and Devanagari.
			edit(
				workdir,
				"src/width.js",
				SHIPPED,
				[
					"const chars = [...s.normalize('NFC')];",
					"\tlet count = 0;",
					"\tfor (let i = 0; i < chars.length; i++) {",
					"\t\tconst cp = chars[i].codePointAt(0);",
					"\t\tif (cp >= 0x0300 && cp <= 0x036f) continue;",
					"\t\tif (cp >= 0x1f3fb && cp <= 0x1f3ff) continue;",
					"\t\tif (cp === 0x200d) { i++; continue; }",
					"\t\tcount++;",
					"\t}",
					"\treturn count;",
				].join("\n\t"),
			);
			const result = grade(fixture, workdir, join(scratch, "partial-grade"));
			expect(result.visiblePassed).toBe(true);
			expect(result.success).toBe(false);
		});
	});

	// bug-004's ladder above enumerates the repairs an agent might try, and that is its
	// weakness: it holds only while the enumeration is right. It was not — qwen3-coder
	// reaches for `Intl.Segmenter` first, skipping every rung, and the fixture produced one
	// failure instead of five.
	//
	// bug-005 removes the guess. Its decoy is outside the code path that `package.json`
	// wires up, so these tests quantify over implementations instead of listing them: no
	// edit to that file can change the output, including a perfectly correct one. That is a
	// property of module resolution rather than of what any model happens to know, which is
	// what makes it survive a better agent.
	describe("bug-005 cannot be fixed by editing the file it looks like", () => {
		const SHIPPED = 'return s.split(" ").length;';
		const DECOY = "src/tokens.js";
		const REAL = "src/internal/tokens.js";
		const CORRECT = 'return s.trim() === "" ? 0 : s.trim().split(/\\s+/).length;';

		/** Everything from the shipped bug to the right answer, and one outright vandalism. */
		const IMPLEMENTATIONS = [
			{ label: "the shipped bug, rewritten", impl: SHIPPED },
			{ label: "a split on any whitespace", impl: 'return s.split(/\\s+/).length;' },
			{ label: "filtering the empty pieces", impl: 'return s.split(" ").filter(Boolean).length;' },
			{ label: "the correct implementation", impl: CORRECT },
			{ label: "a function that returns nothing useful", impl: "return 0;" },
		];

		function runVerify(fixture: ReturnType<typeof loadFixture>, workdir: string) {
			const result = spawnSync(fixture.verify, { cwd: workdir, shell: true, encoding: "utf8" });
			const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
			return {
				failed: result.status !== 0,
				hash: fingerprintFailure({
					toolName: "bash",
					command: fixture.verify,
					errorText: text,
					exitCode: result.status ?? undefined,
					maxErrorLines: 3,
				}).hash,
			};
		}

		it("gives the same fingerprint however well the decoy is written", () => {
			const fixture = loadFixture(join(FIXTURES, "bug-005-invisible-edit"));
			const workdir = join(scratch, "invisible");
			prepareWorkspace(fixture, workdir);

			const shipped = runVerify(fixture, workdir);
			expect(shipped.failed, "the shipped fixture must fail").toBe(true);

			const seen = [shipped.hash];
			for (const { label, impl } of IMPLEMENTATIONS) {
				edit(workdir, DECOY, SHIPPED, impl);
				const attempt = runVerify(fixture, workdir);
				expect(attempt.failed, `${label}: editing the decoy must not fix anything`).toBe(true);
				seen.push(attempt.hash);
				edit(workdir, DECOY, impl, SHIPPED);
			}

			// The claim the fixture rests on: one fingerprint, six runs, and no assumption
			// anywhere about which of these an agent would have chosen.
			expect(new Set(seen).size, `expected one fingerprint, got ${JSON.stringify(seen)}`).toBe(1);
		});

		it("is solved by the same edit applied to the file the test actually imports", () => {
			const fixture = loadFixture(join(FIXTURES, "bug-005-invisible-edit"));
			const workdir = join(scratch, "invisible-solved");
			prepareWorkspace(fixture, workdir);
			edit(workdir, REAL, SHIPPED, CORRECT);
			// `firstWords` shares the broken split and is checked by the hidden tests, so the
			// contract needs it fixed too. Solvable on purpose: a fixture nobody can finish
			// measures the turn cap and nothing else.
			edit(workdir, REAL, 'return s.split(" ").slice(0, limit).join(" ");', 'return s.trim().split(/\\s+/).filter(Boolean).slice(0, limit).join(" ");');
			expect(grade(fixture, workdir, join(scratch, "invisible-grade")).success).toBe(true);
		});

		// Without this the fixture could be "sustained failure" by being unsolvable-looking
		// at every step, which teaches the agent nothing and makes the repeat count
		// meaningless. Real progress has to read as a different failure.
		it("shows a partial fix in the real file as a different failure, not the same one", () => {
			const fixture = loadFixture(join(FIXTURES, "bug-005-invisible-edit"));
			const workdir = join(scratch, "invisible-partial");
			prepareWorkspace(fixture, workdir);
			const before = runVerify(fixture, workdir);
			edit(workdir, REAL, SHIPPED, 'return s.split(/\\s+/).length;');
			const after = runVerify(fixture, workdir);
			expect(after.failed).toBe(true);
			expect(after.hash).not.toBe(before.hash);
		});

		it("reports fixing only the counting as an incomplete fix", () => {
			const fixture = loadFixture(join(FIXTURES, "bug-005-invisible-edit"));
			const workdir = join(scratch, "invisible-count-only");
			prepareWorkspace(fixture, workdir);
			edit(workdir, REAL, SHIPPED, CORRECT);
			const result = grade(fixture, workdir, join(scratch, "invisible-count-grade"));
			expect(result.visiblePassed).toBe(true);
			expect(result.success).toBe(false);
		});
	});

	for (const id of ids) {
		it(`${id} is well formed and fails as shipped`, () => {
			const fixture = loadFixture(join(FIXTURES, id));
			expect(fixture.id).toBe(id);
			expect(fixture.prompt.length).toBeGreaterThan(20);

			const workdir = join(scratch, id);
			prepareWorkspace(fixture, workdir);
			// A fixture that already passes would make every trial a trivial success.
			const result = grade(fixture, workdir, join(scratch, `${id}-grade`));
			expect(result.success).toBe(false);
			expect(result.visiblePassed).toBe(false);
		});
	}
});

describe("grading", () => {
	it("passes a correct root-cause fix", () => {
		const fixture = loadFixture(join(FIXTURES, "bug-001-repeat-trap"));
		const workdir = join(scratch, "w");
		prepareWorkspace(fixture, workdir);
		edit(workdir, "src/ranges.js", "\treturn span;", "\treturn options.inclusive ? span + 1 : span;");

		const result = grade(fixture, workdir, join(scratch, "g"));
		expect(result.visiblePassed).toBe(true);
		expect(result.success).toBe(true);
		expect(result.diffLines).toBeGreaterThan(0);
		expect(result.filesModified).toBe(1);
	});

	it("separates a fix that patches around the cause from one that fixes it", () => {
		// This distinction is the reason grading tests are hidden. A call-site patch makes
		// every visible test pass while leaving the documented contract broken; reporting it
		// as an unqualified success would hide exactly the behavior a study wants to see.
		const fixture = loadFixture(join(FIXTURES, "bug-001-repeat-trap"));
		const workdir = join(scratch, "w");
		prepareWorkspace(fixture, workdir);
		edit(workdir, "src/ranges.js", "return daysBetween(start, end, { inclusive: true });", "return daysBetween(start, end) + 1;");

		const result = grade(fixture, workdir, join(scratch, "g"));
		expect(result.visiblePassed).toBe(true);
		expect(result.success).toBe(false);
	});

	it("rejects a rewrite that loses behavior the tests did not mention", () => {
		const fixture = loadFixture(join(FIXTURES, "bug-002-refactor-trap"));
		const workdir = join(scratch, "w");
		prepareWorkspace(fixture, workdir);
		writeFileSync(
			join(workdir, "src/query.js"),
			`export function parseQuery(input) {
	const result = {};
	if (typeof input !== "string") return result;
	const params = new URLSearchParams(input.startsWith("?") ? input.slice(1) : input);
	for (const key of new Set(params.keys())) {
		const all = params.getAll(key);
		result[key] = all.length > 1 ? all : all[0];
	}
	return result;
}
`,
			"utf8",
		);

		const result = grade(fixture, workdir, join(scratch, "g"));
		expect(result.visiblePassed).toBe(true);
		expect(result.success).toBe(false);
	});

	it("passes a minimal in-place fix of the same bug", () => {
		const fixture = loadFixture(join(FIXTURES, "bug-002-refactor-trap"));
		const workdir = join(scratch, "w");
		prepareWorkspace(fixture, workdir);
		edit(
			workdir,
			"src/query.js",
			"\tif (!key.includes(\".\")) {\n\t\ttarget[key] = value;\n\t\treturn;\n\t}",
			`\tif (!key.includes(".")) {
\t\tif (Object.hasOwn(target, key)) {
\t\t\ttarget[key] = Array.isArray(target[key]) ? [...target[key], value] : [target[key], value];
\t\t} else {
\t\t\ttarget[key] = value;
\t\t}
\t\treturn;
\t}`,
		);

		const result = grade(fixture, workdir, join(scratch, "g"));
		expect(result.success).toBe(true);
	});

	it("catches a change that breaks something the agent was not asked about", () => {
		const fixture = loadFixture(join(FIXTURES, "bug-003-easy-control"));
		const workdir = join(scratch, "w");
		prepareWorkspace(fixture, workdir);
		// Special-cases the asserted value instead of fixing the comparison.
		edit(workdir, "src/clamp.js", "\tif (value >= max) return max - 1;", "\tif (value === 10) return 10;\n\tif (value >= max) return max - 1;");

		const result = grade(fixture, workdir, join(scratch, "g"));
		expect(result.visiblePassed).toBe(true);
		expect(result.success).toBe(false);
	});

	it("grades an untouched workspace as a failure rather than an error", () => {
		const fixture = loadFixture(join(FIXTURES, "bug-003-easy-control"));
		const workdir = join(scratch, "w");
		prepareWorkspace(fixture, workdir);
		const result = grade(fixture, workdir, join(scratch, "g"));
		expect(result.success).toBe(false);
		expect(result.diffLines).toBe(0);
	});

	it("never lets the agent's own edits to the tests count toward grading", () => {
		const fixture = loadFixture(join(FIXTURES, "bug-003-easy-control"));
		const workdir = join(scratch, "w");
		prepareWorkspace(fixture, workdir);
		// The classic way to "fix" a failing test.
		writeFileSync(join(workdir, "test/clamp.test.js"), "import { test } from 'node:test';\ntest('ok', () => {});\n", "utf8");

		const result = grade(fixture, workdir, join(scratch, "g"));
		expect(result.success).toBe(false);
	});

	it("captures a diff that applies cleanly to a fresh checkout", () => {
		const fixture = loadFixture(join(FIXTURES, "bug-003-easy-control"));
		const workdir = join(scratch, "w");
		prepareWorkspace(fixture, workdir);
		edit(workdir, "src/clamp.js", "return max - 1;", "return max;");

		const captured = captureDiff(workdir);
		expect(captured.diff).toContain("src/clamp.js");
		expect(captured.filesModified).toBe(1);
	});

	it("grades correctly when the trial directory is nested inside another repository", () => {
		// A study writes to `runs/` inside this repository, so a trial's grading directory is
		// itself nested in one. `git apply` resolves a patch's paths against the root of the
		// enclosing repository and drops everything outside the current prefix — it skips
		// every hunk and still exits 0, so the fix is never applied and every trial in the
		// study grades as a failure while the harness reports no error at all.
		//
		// Reproducing the real layout is the only way to see it: a scratch directory under
		// tmpdir() belongs to no repository, which is why the tests above cannot catch this.
		execFileSync("git", ["init", "-q"], { cwd: scratch });
		execFileSync("git", ["config", "user.email", "harness@stasis.local"], { cwd: scratch });
		execFileSync("git", ["config", "user.name", "stasis harness"], { cwd: scratch });
		writeFileSync(join(scratch, "README.md"), "enclosing repository\n", "utf8");
		execFileSync("git", ["add", "-A"], { cwd: scratch });
		execFileSync("git", ["commit", "-q", "-m", "enclosing"], { cwd: scratch });

		const trialDir = join(scratch, "runs", "study", "bug-003-easy-control", "stasis", "trial-1");
		mkdirSync(trialDir, { recursive: true });

		const fixture = loadFixture(join(FIXTURES, "bug-003-easy-control"));
		const workdir = join(trialDir, "workspace");
		prepareWorkspace(fixture, workdir);
		edit(workdir, "src/clamp.js", "\tif (value >= max) return max - 1;", "\tif (value >= max) return max;");

		const gradingDir = join(trialDir, "grading");
		const result = grade(fixture, workdir, gradingDir);

		expect(result.success).toBe(true);
		// The patch reached the tree, rather than being skipped into a clean exit code.
		expect(readFileSync(join(gradingDir, "src/clamp.js"), "utf8")).toContain("return max;");
	});

	it("grades in a repository of its own, so patch paths cannot be filtered away", () => {
		const fixture = loadFixture(join(FIXTURES, "bug-003-easy-control"));
		const workdir = join(scratch, "w");
		prepareWorkspace(fixture, workdir);
		edit(workdir, "src/clamp.js", "return max - 1;", "return max;");

		const gradingDir = join(scratch, "g");
		grade(fixture, workdir, gradingDir);

		// Grading owning its own `.git` is what keeps the apply prefix empty. Pinned
		// separately from the behavior above because it is the mechanism the fix rests on:
		// without it the oracle silently scores an unmodified tree.
		expect(existsSync(join(gradingDir, ".git"))).toBe(true);
	});

	it("prepares an isolated git workspace each time", () => {
		const fixture = loadFixture(join(FIXTURES, "bug-003-easy-control"));
		const workdir = join(scratch, "w");
		prepareWorkspace(fixture, workdir);
		const status = execFileSync("git", ["status", "--porcelain"], { cwd: workdir, encoding: "utf8" });
		expect(status.trim()).toBe("");
		// The hidden tests must not be present while the agent works.
		expect(() => readFileSync(join(workdir, "test/contract.test.js"), "utf8")).toThrow();
	});
});

describe("model routing", () => {
	const routing = { only: ["deepinfra"], quantizations: ["bf16"], allow_fallbacks: false };

	it("sends routing on the field the provider actually reads", () => {
		// The SDK forwards `compat.openRouterRouting` as the request's `provider` field
		// (pi-ai/dist/api/openai-completions.js). The name is the whole contract: a study can
		// declare `routing:` in its YAML, see no warning, and still be routed anywhere at all
		// if this lands somewhere the provider ignores. That failure is invisible in the
		// results — it just widens the spread between arms.
		const model = { id: "qwen/qwen3-coder", compat: { thinkingFormat: "openrouter" } };
		const routed = applyRouting(model, { provider: "openrouter", model: "qwen/qwen3-coder", routing });

		expect(routed.compat).toMatchObject({ openRouterRouting: routing });
		// Existing compatibility settings survive; routing is an addition, not a replacement.
		expect(routed.compat.thinkingFormat).toBe("openrouter");
	});

	it("leaves the resolved model untouched", () => {
		// Models come from a shared catalog. Mutating one would leak a study's pin into
		// anything else resolved in the same process.
		const model = { id: "qwen/qwen3-coder", compat: { thinkingFormat: "openrouter" } };
		applyRouting(model, { provider: "openrouter", model: "qwen/qwen3-coder", routing });

		expect(model.compat).not.toHaveProperty("openRouterRouting");
	});

	it("does nothing for a study that did not ask for a pin", () => {
		const model = { id: "qwen/qwen3-coder", compat: undefined };
		expect(applyRouting(model, { provider: "openrouter", model: "qwen/qwen3-coder" })).toBe(model);
	});

	it("does not attach OpenRouter routing to another provider's model", () => {
		const model = { id: "claude-sonnet-4-5", compat: undefined };
		expect(applyRouting(model, { provider: "anthropic", model: "claude-sonnet-4-5", routing })).toBe(model);
	});

	it("routes a model that carries no compatibility settings at all", () => {
		const model = { id: "qwen/qwen3-coder", compat: undefined };
		expect(applyRouting(model, { provider: "openrouter", model: "qwen/qwen3-coder", routing }).compat).toEqual({
			openRouterRouting: routing,
		});
	});

	it("carries routing from the study file through to the benchmark", () => {
		const path = join(scratch, "study.yaml");
		writeFileSync(
			path,
			`name: routed
trials: 1
model:
  provider: openrouter
  model: qwen/qwen3-coder
  routing:
    only: [deepinfra]
    quantizations: [bf16]
    allow_fallbacks: false
conditions: [control, stasis]
tasks:
  - id: bug-003-easy-control
    fixture: ${join(FIXTURES, "bug-003-easy-control")}
`,
			"utf8",
		);

		expect(loadBenchmark(path).benchmark.model.routing).toEqual(routing);
	});

	// A study is a claim about a particular physiology, so it has to be able to state one.
	// Carried through to the extension as the `inline` overlay, which is also what makes it
	// show up in the run header rather than being an undeclared difference between runs.
	it("carries a study's physiology overrides through to the trial request", () => {
		const path = join(scratch, "config-override.yaml");
		writeFileSync(
			path,
			`name: config-override
trials: 1
model:
  provider: openrouter
  model: qwen/qwen3-coder
config:
  enforcement:
    guardBash: true
conditions: [control, stasis]
tasks:
  - id: bug-003-easy-control
    fixture: ${join(FIXTURES, "bug-003-easy-control")}
`,
			"utf8",
		);

		expect(loadBenchmark(path).benchmark.config).toEqual({ enforcement: { guardBash: true } });
	});

	it("leaves the shipped study's bash guard on, so enforcement is not measured with the shell open", () => {
		const study = join(import.meta.dirname, "..", "experiments", "benchmarks", "repeated-failure-study.yaml");
		expect(loadBenchmark(study).benchmark.config).toMatchObject({ enforcement: { guardBash: true } });
	});
});

describe("runner command line", () => {
	const RUNNER = join(import.meta.dirname, "..", "experiments", "runner.ts");
	const STUDY = join(import.meta.dirname, "..", "experiments", "benchmarks", "repeated-failure-study.yaml");

	function dryRun(args: string[]): string {
		return execFileSync("npx", ["tsx", RUNNER, STUDY, "--dry-run", ...args], {
			encoding: "utf8",
			env: { ...process.env, PI_STASIS_NO_ENV_FILE: "1" },
		});
	}

	it("receives the dotenv flag instead of losing it to the runtime", () => {
		// Node claims `--env-file` for itself anywhere in argv, even after the script name,
		// so a flag by that name never arrives. The runner spells it `--dotenv` for exactly
		// that reason, and this fails if anyone renames it back.
		const path = join(scratch, "study.env");
		writeFileSync(path, "PI_STASIS_PROFILE=exploratory\n", "utf8");

		const output = execFileSync("npx", ["tsx", RUNNER, STUDY, "--dry-run", "--dotenv", path], { encoding: "utf8" });
		expect(output).toContain("PI_STASIS_PROFILE=exploratory");
		expect(output).toContain(path);
	});

	it("reports nothing loaded when told to ignore env files", () => {
		expect(dryRun(["--no-dotenv"])).not.toContain("env file");
	});

	it("redacts credential values rather than printing them", () => {
		const path = join(scratch, "secrets.env");
		writeFileSync(path, "OPENROUTER_API_KEY=sk-should-never-appear\n", "utf8");

		const output = execFileSync("npx", ["tsx", RUNNER, STUDY, "--dry-run", "--dotenv", path], { encoding: "utf8" });
		expect(output).not.toContain("sk-should-never-appear");
		expect(output).toContain("OPENROUTER_API_KEY=<redacted>");
	});
});

describe("benchmark loading", () => {
	const benchmarkPath = join(import.meta.dirname, "..", "experiments", "benchmarks", "repeated-failure-study.yaml");

	it("loads the shipped study and resolves its fixtures", () => {
		const { benchmark, fixtures } = loadBenchmark(benchmarkPath);
		expect(benchmark.name).toBe("repeated-failure-study");
		expect(benchmark.conditions).toContain("control");
		expect(benchmark.conditions).toContain("stasis");
		// `static` separates the effect of the dynamics from the effect of the extra prompt
		// text. Without it a difference between control and stasis cannot be attributed.
		expect(benchmark.conditions).toContain("static");
		expect(fixtures.size).toBe(5);
		// Nothing about the provider is hard-coded anywhere but the study file.
		expect(benchmark.model.provider).toBe("openrouter");
	});

	it("includes a task where neuromodulation is not expected to help", () => {
		const { benchmark } = loadBenchmark(benchmarkPath);
		expect(benchmark.tasks.map((task) => task.id)).toContain("bug-003-easy-control");
	});

	it("refuses a study with nothing to compare against", () => {
		const path = join(scratch, "bad.yaml");
		writeFileSync(
			path,
			"name: x\nmodel: { provider: openrouter, model: m }\nconditions: [stasis]\ntasks: [{ fixture: ./nope }]\n",
			"utf8",
		);
		expect(() => loadBenchmark(path)).toThrow(/at least two conditions/);
	});

	it("rejects an unknown condition", () => {
		const path = join(scratch, "bad.yaml");
		writeFileSync(
			path,
			"name: x\nmodel: { provider: openrouter, model: m }\nconditions: [control, magic]\ntasks: [{ fixture: ./nope }]\n",
			"utf8",
		);
		expect(() => loadBenchmark(path)).toThrow(/unknown condition/);
	});
});

describe("metrics", () => {
	const transition = (
		step: number,
		type: string,
		state: Record<string, number>,
		evidence: Record<string, unknown> = {},
		turnIndex = 1,
	): StasisTelemetryRecord =>
		({
			schema: 1,
			type: "transition",
			timestamp: "2026-01-01T00:00:00.000Z",
			step,
			turnIndex,
			event: { type, severity: 0.5, uncertainty: 0, novelty: 0, repeated: false, evidence },
			stateBefore: { stress: 0.2, confidence: 0.5, noveltyDrive: 0.4, fatigue: 0, persistence: 0.8, ...state },
			eventDelta: {},
			interactionDelta: {},
			homeostasisDelta: {},
			stateAfter: { stress: 0.2, confidence: 0.5, noveltyDrive: 0.4, fatigue: 0, persistence: 0.8, ...state },
			policy: { regime: "CONVERGENT", maxPatchLines: 200 },
			reasons: [],
			suppressed: false,
		}) as unknown as StasisTelemetryRecord;

	it("counts activity from the records the extension writes", () => {
		const metrics = computeMetrics([
			transition(1, "TEST_FAILURE", {}, { commandKind: "test" }),
			transition(2, "REPEATED_FAILURE", {}, { commandKind: "test" }),
			transition(3, "STRATEGY_CHANGE", {}),
			transition(4, "PATCH_APPLIED", {}, { changedLines: 12 }),
		]);
		expect(metrics.testFailures).toBe(1);
		expect(metrics.repeatedFailures).toBe(1);
		expect(metrics.strategyChanges).toBe(1);
		expect(metrics.patchesApplied).toBe(1);
		expect(metrics.meanPatchSizeOverall).toBe(12);
	});

	it("measures patch size after the first failure separately from overall", () => {
		const metrics = computeMetrics([
			transition(1, "PATCH_APPLIED", {}, { changedLines: 100 }),
			transition(2, "TEST_FAILURE", {}, { commandKind: "test" }),
			transition(3, "PATCH_APPLIED", {}, { changedLines: 10 }),
			transition(4, "PATCH_APPLIED", {}, { changedLines: 20 }),
		]);
		expect(metrics.meanPatchSizeOverall).toBeCloseTo(43.3, 0);
		expect(metrics.meanPatchSizeAfterFailure).toBe(15);
	});

	it("measures how long an agent persisted before changing approach", () => {
		const metrics = computeMetrics([
			transition(1, "REPEATED_FAILURE", {}, {}, 2),
			transition(2, "TEST_FAILURE", {}, {}, 3),
			transition(3, "STRATEGY_CHANGE", {}, {}, 5),
		]);
		expect(metrics.turnsToStrategyChange).toBe(3);
	});

	// The appraiser pushes STRATEGY_CHANGE last for exactly this reason: emitted alongside
	// the REPEATED_FAILURE it answers but ordered before it, the change is invisible here
	// and the metric silently stays null while looking correctly wired.
	it("ignores a strategy change that precedes the repeat it would answer", () => {
		const metrics = computeMetrics([
			transition(1, "STRATEGY_CHANGE", {}, {}, 2),
			transition(2, "REPEATED_FAILURE", {}, {}, 2),
		]);
		expect(metrics.strategyChanges).toBe(1);
		expect(metrics.turnsToStrategyChange).toBeNull();
	});

	it("reports null rather than zero when a measure does not apply", () => {
		// Averaging an absent measurement as zero would drag a condition's mean toward a
		// value no trial observed.
		const metrics = computeMetrics([transition(1, "INSPECTION", {})]);
		expect(metrics.turnsToStrategyChange).toBeNull();
		expect(metrics.patchSizeAtHighStress).toBeNull();
	});

	it("compares patch sizes across the stress range", () => {
		const metrics = computeMetrics([
			transition(1, "PATCH_APPLIED", { stress: 0.1 }, { changedLines: 100 }),
			transition(2, "PATCH_APPLIED", { stress: 0.1 }, { changedLines: 90 }),
			transition(3, "PATCH_APPLIED", { stress: 0.8 }, { changedLines: 10 }),
			transition(4, "PATCH_APPLIED", { stress: 0.9 }, { changedLines: 20 }),
		]);
		expect(metrics.patchSizeAtLowStress).toBeGreaterThan(metrics.patchSizeAtHighStress!);
	});

	it("summarizes physiology even in an arm where it influenced nothing", () => {
		const metrics = computeMetrics([
			transition(1, "TEST_FAILURE", { stress: 0.6, persistence: 0.4 }),
			transition(2, "TEST_FAILURE", { stress: 0.8, persistence: 0.2 }),
		]);
		expect(metrics.peakStress).toBe(0.8);
		expect(metrics.minPersistence).toBe(0.2);
		expect(metrics.regimeShare.CONVERGENT).toBe(1);
	});

	it("returns an empty summary for a trial with no telemetry", () => {
		expect(computeMetrics([]).transitions).toBe(0);
	});
});

describe("analysis", () => {
	const trial = (condition: string, success: boolean, overrides: Partial<TrialResult> = {}): TrialResult =>
		({
			benchmark: "b",
			taskId: "t",
			condition,
			trial: 1,
			success,
			visiblePassed: success,
			timedOut: false,
			turnCapped: false,
			durationMs: 1000,
			turns: 5,
			assistantMessages: 5,
			toolCalls: 10,
			toolResults: 10,
			tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
			cost: 0.01,
			diffLines: 20,
			filesModified: 1,
			metrics: computeMetrics([]),
			repro: {} as TrialResult["repro"],
			...overrides,
		}) as TrialResult;

	it("summarizes each condition separately", () => {
		const summary = summarize([
			trial("control", true),
			trial("control", false),
			trial("stasis", true),
			trial("stasis", true),
		]);
		const control = summary.byCondition.find((entry) => entry.condition === "control")!;
		const stasis = summary.byCondition.find((entry) => entry.condition === "stasis")!;
		expect(control.successRate).toBe(0.5);
		expect(stasis.successRate).toBe(1);
	});

	it("distinguishes patching around the cause from failing outright", () => {
		const summary = summarize([trial("stasis", false, { visiblePassed: true })]);
		expect(summary.byCondition[0]!.visibleOnly).toBe(1);
	});

	it("reports spread alongside every mean", () => {
		const summary = summarize([trial("stasis", true, { turns: 2 }), trial("stasis", true, { turns: 20 })]);
		expect(summary.byCondition[0]!.stdev.turns).toBeGreaterThan(0);
	});

	// The concrete case: on 2026-08-16 the stasis arm of a three-trial run answered in one
	// turn with no tool calls, and was scored 0% while contributing zeroes to every mean.
	// The same response had already occurred in a control arm, so it is provider noise
	// landing on whichever cell it lands on — the most damaging possible artefact at these
	// trial counts, because it is indistinguishable from the intervention doing harm.
	describe("a trial that never attempted the task", () => {
		const noAttempt = (condition: string) =>
			trial(condition, false, { turns: 1, toolCalls: 0, toolResults: 0, diffLines: 0, assistantMessages: 1 });

		it("is not counted as a failure of the arm it landed in", () => {
			const summary = summarize([trial("stasis", true), trial("stasis", true), noAttempt("stasis")]);
			const stasis = summary.byCondition.find((entry) => entry.condition === "stasis")!;
			expect(stasis.successRate).toBe(1);
			expect(stasis.trials).toBe(2);
			expect(stasis.discarded).toBe(1);
		});

		it("does not drag the behavioural means toward zero", () => {
			const scored = summarize([trial("stasis", true), trial("stasis", true)]);
			const withFlake = summarize([trial("stasis", true), trial("stasis", true), noAttempt("stasis")]);
			expect(withFlake.byCondition[0]!.mean.toolCalls).toBe(scored.byCondition[0]!.mean.toolCalls);
			expect(withFlake.byCondition[0]!.mean.turns).toBe(scored.byCondition[0]!.mean.turns);
		});

		// Judged by the rule rather than by the stored flag, so the studies already on disk
		// are re-analysed correctly instead of keeping the scores they were given.
		it("is recognised in results collected before the flag existed", () => {
			const summary = summarize([noAttempt("stasis")]);
			expect(summary.totalDiscarded).toBe(1);
			expect(summary.totalTrials).toBe(0);
		});

		it("still counts toward what the study cost", () => {
			expect(summarize([noAttempt("stasis")]).totalCost).toBeGreaterThan(0);
		});

		it("does not discard a trial that ran out of turns, which is a real outcome", () => {
			const summary = summarize([trial("stasis", false, { turns: 60, toolCalls: 0, turnCapped: true })]);
			expect(summary.totalDiscarded).toBe(0);
			expect(summary.byCondition[0]!.trials).toBe(1);
		});

		it("reports an arm with no usable trials as unmeasured rather than as a total loss", () => {
			const report = renderReport(summarize([noAttempt("stasis")]), [noAttempt("stasis")]);
			expect(report).not.toMatch(/0%/);
			expect(report).toMatch(/DISCARDED: 1 trial/);
		});
	});
});
