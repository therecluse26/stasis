/**
 * Experiment harness tests.
 *
 * Grading is the part of a study most able to be quietly wrong: if the oracle always
 * says "fail", every arm looks identical and the study reports nothing while appearing
 * to work. These tests pin its behavior on real fixtures, with no model involved.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBenchmark, loadFixture } from "../experiments/benchmark.ts";
import { classifyCommand } from "../src/appraisal/command-classifier.ts";
import { captureDiff, grade, prepareWorkspace } from "../experiments/grade.ts";
import { computeMetrics } from "../experiments/metrics.ts";
import { summarize } from "../experiments/analysis.ts";
import type { TrialResult } from "../experiments/types.ts";
import type { NeuroTelemetryRecord } from "../src/telemetry/schema.ts";

const FIXTURES = join(import.meta.dirname, "..", "experiments", "fixtures");

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "neuro-exp-"));
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
	const ids = ["bug-001-repeat-trap", "bug-002-refactor-trap", "bug-003-easy-control"];

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

describe("benchmark loading", () => {
	const benchmarkPath = join(import.meta.dirname, "..", "experiments", "benchmarks", "repeated-failure-study.yaml");

	it("loads the shipped study and resolves its fixtures", () => {
		const { benchmark, fixtures } = loadBenchmark(benchmarkPath);
		expect(benchmark.name).toBe("repeated-failure-study");
		expect(benchmark.conditions).toContain("control");
		expect(benchmark.conditions).toContain("neuro");
		expect(fixtures.size).toBe(3);
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
			"name: x\nmodel: { provider: openrouter, model: m }\nconditions: [neuro]\ntasks: [{ fixture: ./nope }]\n",
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
	): NeuroTelemetryRecord =>
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
		}) as unknown as NeuroTelemetryRecord;

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
			trial("neuro", true),
			trial("neuro", true),
		]);
		const control = summary.byCondition.find((entry) => entry.condition === "control")!;
		const neuro = summary.byCondition.find((entry) => entry.condition === "neuro")!;
		expect(control.successRate).toBe(0.5);
		expect(neuro.successRate).toBe(1);
	});

	it("distinguishes patching around the cause from failing outright", () => {
		const summary = summarize([trial("neuro", false, { visiblePassed: true })]);
		expect(summary.byCondition[0]!.visibleOnly).toBe(1);
	});

	it("reports spread alongside every mean", () => {
		const summary = summarize([trial("neuro", true, { turns: 2 }), trial("neuro", true, { turns: 20 })]);
		expect(summary.byCondition[0]!.stdev.turns).toBeGreaterThan(0);
	});
});
