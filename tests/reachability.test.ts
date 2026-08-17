/**
 * What the physiology can actually reach.
 *
 * `tests/policy.test.ts` asserts every policy field has usable dynamic range by evaluating
 * the mapping at the corners of the state cube — stress 0 against stress 1. That is the
 * right test for a linear map, and it says nothing at all about whether those corners
 * occur. They do not: reaching stress 0.9 always drags confidence below 0.3, so the
 * `{stress: 0.9, confidence: 0.5}` state those tests evaluate is one the engine cannot
 * produce.
 *
 * The distance between "the mapping responds" and "the system gets there" is how this
 * project shipped an enforcement mechanism that had never once fired, across two studies
 * and two model tiers, while 258 tests passed. Trap #5 in docs/PLAN.md is the same bug one
 * level down — a policy field clamped against its bound looks configured but carries no
 * signal — caught there for a single field and missed for the system.
 *
 * So these tests do not fabricate states. They drive the real appraiser with the tool
 * outcomes a real session produces, replay the events it emits through the real engine,
 * and ask what policy comes out the other end. The severities are therefore the ones
 * `failureSeverity` and the repeat-saturation curve actually compute, not a copy of them
 * that can drift.
 *
 * The number these tests exist to pin is how much sustained failure it takes to bring
 * enforcement into contact with the edits an agent really attempts. That is the target a
 * fixture has to hit to be worth running.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFixture } from "../experiments/benchmark.ts";
import { prepareWorkspace } from "../experiments/grade.ts";
import { createAppraiser, type ToolOutcome } from "../src/appraisal/appraiser.ts";
import { createPolicyAdapter } from "../src/policy/adapter.ts";
import type { PolicySnapshot } from "../src/policy/policy.ts";
import { baselineState, buildConfig } from "../src/stasis/config.ts";
import { createEngine } from "../src/stasis/engine.ts";

const { config } = buildConfig();

/**
 * Edit sizes the open-weight agent actually attempted, from the 30-trial study of
 * 2026-08-16 (n=39 edits). Enforcement is only real once the limit crosses below these.
 */
const OBSERVED_EDIT_LINES = { median: 33, p90: 95, max: 101 };

let counter = 0;
const bash = (command: string, text: string, isError: boolean): ToolOutcome => ({
	toolName: "bash",
	toolCallId: `bash-${++counter}`,
	input: { command },
	text: isError ? `${text}\nCommand exited with code 1` : text,
	isError,
});

/** The same assertion failing the same way, which is what makes it a *repeated* failure. */
const failingTest = () => bash("npm test", "FAIL src/a.test.js\n  AssertionError: expected 200, got 401", true);
const passingTest = () => bash("npm test", "ok 12 passing", false);
const inspect = () => bash("cat src/a.js", "file contents", false);
const edit = (changedLines: number): ToolOutcome => ({
	toolName: "edit",
	toolCallId: `edit-${++counter}`,
	input: { path: "src/a.js" },
	text: "ok",
	isError: false,
	changedLines,
});

/**
 * Run a session end to end and return the policy after each tool call.
 *
 * Deliberately the whole deterministic chain — appraise, transition, derive — because the
 * question is what the system reaches, and any link mocked out here is a link where the
 * answer could be wrong.
 */
function session(outcomes: ToolOutcome[]): PolicySnapshot[] {
	const appraiser = createAppraiser(config);
	const engine = createEngine(config);
	const adapter = createPolicyAdapter(config);
	let state = baselineState(config);
	let step = 0;
	return outcomes.map((outcome) => {
		for (const event of appraiser.appraise(outcome).events) {
			state = engine.transition(state, event, { step: ++step }).after;
		}
		return adapter.derive(state);
	});
}

/** An agent editing and re-running the same test, getting the same failure every time. */
const repeatedFailure = (rounds: number): ToolOutcome[] =>
	Array.from({ length: rounds }, () => [edit(15), failingTest()]).flat();

/** Ordinary productive work: look, change something, see it fail, fix it, see it pass. */
const healthyWork = (rounds: number): ToolOutcome[] =>
	Array.from({ length: rounds }, () => [inspect(), edit(12), failingTest(), edit(8), passingTest()]).flat();

/** How many failing test runs before the predicate first holds. */
function failuresUntil(predicate: (policy: PolicySnapshot) => boolean, rounds = 12): number | null {
	const policies = session(repeatedFailure(rounds));
	// Two tool calls per round, the failing test second.
	for (let round = 0; round < rounds; round++) {
		const policy = policies[round * 2 + 1];
		if (policy && predicate(policy)) return round + 1;
	}
	return null;
}

describe("enforcement is reachable", () => {
	// The headline number. Fixture design targets this: a fixture that cannot produce this
	// many consecutive identical failures cannot exercise enforcement, and a study built on
	// it measures the injected text and nothing else.
	it("brings the patch limit below the largest edit an agent actually attempted", () => {
		const failures = failuresUntil((policy) => policy.maxPatchLines < OBSERVED_EDIT_LINES.max);
		expect(failures).not.toBeNull();
		expect(failures).toBeLessThanOrEqual(4);
	});

	it("brings the patch limit below a median edit, so enforcement bites in the common case", () => {
		const failures = failuresUntil((policy) => policy.maxPatchLines < OBSERVED_EDIT_LINES.median);
		expect(failures).not.toBeNull();
		expect(failures).toBeLessThanOrEqual(6);
	});

	it("withdraws retry tolerance entirely under sustained repetition", () => {
		const failures = failuresUntil((policy) => policy.retryTolerance === 0);
		expect(failures).not.toBeNull();
		expect(failures).toBeLessThanOrEqual(6);
	});

	it("reaches the configured patch floor rather than stalling above it", () => {
		const policies = session(repeatedFailure(12));
		const floor = config.policy.fields.maxPatchLines.min;
		expect(Math.min(...policies.map((p) => p.maxPatchLines))).toBe(floor);
	});
});

describe("ordinary work stays clear of enforcement", () => {
	// The other half of the claim, and the one that would make the mechanism harmful rather
	// than merely inert: an agent making steady progress must never be refused an edit.
	it("never tightens the patch limit near the size of the edits being made", () => {
		const policies = session(healthyWork(30));
		expect(Math.min(...policies.map((p) => p.maxPatchLines))).toBeGreaterThan(OBSERVED_EDIT_LINES.p90);
	});

	it("keeps retry tolerance and stays in the convergent regime", () => {
		const policies = session(healthyWork(30));
		expect(Math.min(...policies.map((p) => p.retryTolerance))).toBeGreaterThan(0);
		expect([...new Set(policies.map((p) => p.regime))]).toEqual(["CONVERGENT"]);
	});
});

// Everything above uses synthetic tool outcomes. This closes the loop with the real thing:
// a shipped fixture, its own verify command, the output Node actually prints. The claim the
// whole study rests on is that a fixture can drive the policy into the range where
// enforcement refuses an edit, and nothing else in the suite checks it end to end.
//
// bug-005 rather than bug-004, because bug-004 does not do it. Its repairs were only ever
// indistinguishable to a fingerprint that could not see the assertion, and once that was
// fixed the ladder resolved into two failures rather than one repeated five times — which
// is the truth about it: normalizing a string really is progress on a combining mark.
// bug-005 needs no such luck. Its edits land outside the code path the test imports, so the
// output is byte-identical however good they are.
describe("the invisible-edit fixture reaches enforcement", () => {
	/** The shipped bug, then repairs of increasing quality — none of which is in the path. */
	const ATTEMPTS = [
		'return s.split(" ").length;',
		'return s.split(/\\s+/).length;',
		'return s.split(" ").filter(Boolean).length;',
		'return s.trim().split(/\\s+/).length;',
		'return s.trim() === "" ? 0 : s.trim().split(/\\s+/).length;',
	];

	/** Real `node --test` output for each attempt, captured by running the fixture. */
	function captureAttempts(): string[] {
		const fixture = loadFixture(join(import.meta.dirname, "..", "experiments", "fixtures", "bug-005-invisible-edit"));
		const workdir = mkdtempSync(join(tmpdir(), "stasis-attempts-"));
		try {
			prepareWorkspace(fixture, workdir);
			// The file an agent looking for the implementation opens, which `package.json`
			// does not wire to anything. The last attempt is a correct implementation, and it
			// has to fail here exactly like the first.
			const source = join(workdir, "src", "tokens.js");
			const original = readFileSync(source, "utf8");
			return ATTEMPTS.map((impl) => {
				writeFileSync(source, original.replace(ATTEMPTS[0]!, impl), "utf8");
				const run = spawnSync(fixture.verify, { cwd: workdir, shell: true, encoding: "utf8" });
				return `${run.stdout ?? ""}${run.stderr ?? ""}\nCommand exited with code ${run.status}`;
			});
		} finally {
			rmSync(workdir, { recursive: true, force: true });
		}
	}

	it("drives the policy below the largest edit an agent attempted, and withdraws retries", () => {
		const outputs = captureAttempts();
		const appraiser = createAppraiser(config);
		const engine = createEngine(config);
		const adapter = createPolicyAdapter(config);
		let state = baselineState(config);
		let step = 0;
		let repeats = 0;

		const policies = outputs.map((text, index) => {
			// An edit between attempts, as an agent working the problem would make.
			appraiser.appraise({
				toolName: "edit",
				toolCallId: `edit-${index}`,
				input: { path: "src/tokens.js" },
				text: "ok",
				isError: false,
				changedLines: 4,
			});
			const result = appraiser.appraise({
				toolName: "bash",
				toolCallId: `bash-${index}`,
				input: { command: "node --test" },
				text,
				isError: true,
			});
			repeats += result.events.filter((event) => event.type === "REPEATED_FAILURE").length;
			for (const event of result.events) state = engine.transition(state, event, { step: ++step }).after;
			return adapter.derive(state);
		});

		// Every attempt after the first is the same failure recurring — including the last,
		// which is a correct implementation of the function put in a file nothing imports.
		expect(repeats).toBe(ATTEMPTS.length - 1);
		expect(Math.min(...policies.map((policy) => policy.maxPatchLines))).toBeLessThan(OBSERVED_EDIT_LINES.max);
		expect(Math.min(...policies.map((policy) => policy.retryTolerance))).toBe(0);
	});
});

describe("reachable policy range", () => {
	/** Sessions chosen to span what an agent plausibly does, not the corners of the cube. */
	const explored = [healthyWork(30), repeatedFailure(12), Array.from({ length: 40 }, passingTest), Array.from({ length: 20 }, inspect)]
		.flatMap(session);

	// A field that barely moves under any real session is carrying no signal, whatever the
	// mapping does at stress 1. This is the system-level form of the "no dead field at
	// baseline" test in policy.test.ts.
	it("moves every policy field over a usable part of its configured range", () => {
		for (const [field, spec] of Object.entries(config.policy.fields)) {
			const values = explored.map((policy) => policy[field as keyof PolicySnapshot] as number);
			const span = Math.max(...values) - Math.min(...values);
			expect
				.soft(span / (spec.max - spec.min), `${field} barely moves across realistic sessions`)
				.toBeGreaterThan(0.3);
		}
	});

	// Not a defect, but it should be visible rather than assumed away: intercept and
	// coefficient arithmetic means several fields cannot attain their configured bounds at
	// any state at all, so the YAML range overstates what a study can observe.
	it("records that the configured bounds are wider than anything attainable", () => {
		const patch = explored.map((p) => p.maxPatchLines);
		expect(Math.max(...patch)).toBeLessThan(config.policy.fields.maxPatchLines.max);
		expect(Math.max(...explored.map((p) => p.verificationLevel))).toBeLessThan(1);
	});

	it("reaches the regimes a study would compare", () => {
		expect(new Set(explored.map((p) => p.regime))).toEqual(new Set(["CONVERGENT", "CAUTIOUS", "EXPLORATORY"]));
	});
});
