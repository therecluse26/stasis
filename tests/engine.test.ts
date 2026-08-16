import { describe, expect, it } from "vitest";
import { appraisedEvent } from "../src/appraisal/events.ts";
import { baselineState, buildConfig, DEFAULT_CONFIG } from "../src/neuro/config.ts";
import { createEngine, replay, severityScale } from "../src/neuro/engine.ts";
import { homeostasisDelta, steadyState } from "../src/neuro/homeostasis.ts";
import { activation, interactionDelta } from "../src/neuro/interactions.ts";
import { NEURO_VARIABLES, type NeuroState, isValidState, quantize } from "../src/neuro/state.ts";

const { config } = buildConfig();
const engine = createEngine(config);
const base = () => baselineState(config);

const ev = (type: Parameters<typeof appraisedEvent>[0]["type"], extra = {}) => appraisedEvent({ type, ...extra });

/** Feed the same event repeatedly and return the resulting state. */
function drive(initial: NeuroState, type: Parameters<typeof ev>[0], times: number): NeuroState {
	let state = initial;
	for (let i = 0; i < times; i++) {
		state = engine.transition(state, ev(type), { step: i + 1 }).after;
	}
	return state;
}

describe("event transitions", () => {
	it("TEST_FAILURE increases stress and lowers confidence", () => {
		const before = base();
		const { after } = engine.transition(before, ev("TEST_FAILURE"), { step: 1 });
		expect(after.stress).toBeGreaterThan(before.stress);
		expect(after.confidence).toBeLessThan(before.confidence);
	});

	it("TEST_SUCCESS reduces stress and raises confidence", () => {
		const elevated: NeuroState = { ...base(), stress: 0.6, confidence: 0.3 };
		const { after } = engine.transition(elevated, ev("TEST_SUCCESS"), { step: 1 });
		expect(after.stress).toBeLessThan(elevated.stress);
		expect(after.confidence).toBeGreaterThan(elevated.confidence);
	});

	it("supporting evidence raises confidence across several successes", () => {
		const after = drive({ ...base(), confidence: 0.4 }, "TEST_SUCCESS", 5);
		expect(after.confidence).toBeGreaterThan(0.4);
	});

	it("contradictory evidence lowers confidence", () => {
		const before: NeuroState = { ...base(), confidence: 0.8 };
		const { after } = engine.transition(before, ev("ASSUMPTION_INVALIDATED"), { step: 1 });
		expect(after.confidence).toBeLessThan(before.confidence);
	});

	it("repeated failure decreases persistence and raises novelty drive", () => {
		const before = base();
		const { after } = engine.transition(before, ev("REPEATED_FAILURE"), { step: 1 });
		expect(after.persistence).toBeLessThan(before.persistence);
		expect(after.noveltyDrive).toBeGreaterThan(before.noveltyDrive);
		expect(after.stress).toBeGreaterThan(before.stress);
		expect(after.confidence).toBeLessThan(before.confidence);
	});

	it("sustained repeated failure drives persistence toward the floor", () => {
		const after = drive(base(), "REPEATED_FAILURE", 12);
		expect(after.persistence).toBeLessThan(0.2);
	});

	it("scales the configured delta by severity, with 0.5 as nominal", () => {
		expect(severityScale(0.5, config)).toBe(1);
		expect(severityScale(0, config)).toBeCloseTo(config.severity.minScale, 6);
		expect(severityScale(1, config)).toBeCloseTo(config.severity.maxScale, 6);

		const mild = engine.transition(base(), ev("TEST_FAILURE", { severity: 0.1 }), { step: 1 });
		const severe = engine.transition(base(), ev("TEST_FAILURE", { severity: 0.9 }), { step: 1 });
		expect(severe.after.stress).toBeGreaterThan(mild.after.stress);
	});

	it("applies uncertainty and novelty modulators", () => {
		const plain = engine.transition(base(), ev("TOOL_ERROR"), { step: 1 });
		const uncertain = engine.transition(base(), ev("TOOL_ERROR", { uncertainty: 1 }), { step: 1 });
		const novel = engine.transition(base(), ev("TOOL_ERROR", { novelty: 1 }), { step: 1 });
		expect(uncertain.after.stress).toBeGreaterThan(plain.after.stress);
		expect(novel.after.noveltyDrive).toBeGreaterThan(plain.after.noveltyDrive);
	});

	it("caps a single event's influence at maxDeltaPerEvent", () => {
		const huge = buildConfig([
			{ label: "test", data: { events: { TEST_FAILURE: { stress: 5 } }, severity: { enabled: false } } },
		]).config;
		const hugeEngine = createEngine(huge);
		const before = baselineState(huge);
		const { after, delta } = hugeEngine.transition(before, ev("TEST_FAILURE"), { step: 1 });
		expect(delta.stress).toBe(huge.variables.stress.maxDeltaPerEvent);
		// Homeostasis also acts, so the move is at most the cap.
		expect(after.stress - before.stress).toBeLessThanOrEqual(huge.variables.stress.maxDeltaPerEvent);
	});

	it("treats an event with no net effect as a pure homeostasis step", () => {
		// Overlays merge deeply, so an event is neutralized by zeroing its terms rather
		// than by supplying an empty mapping.
		const stripped = buildConfig([{ label: "test", data: { events: { TICK: { fatigue: 0 } } } }]).config;
		const strippedEngine = createEngine(stripped);
		const elevated: NeuroState = { ...baselineState(stripped), stress: 0.9 };
		const { after, delta } = strippedEngine.transition(elevated, ev("TICK"), { step: 1 });
		expect(delta).toEqual({});
		expect(after.stress).toBeLessThan(elevated.stress);
	});

	it("records an attributable reason for every contribution", () => {
		// Displaced from baseline so the homeostatic pull is non-zero and therefore reported.
		const displaced: NeuroState = { ...base(), stress: 0.6, confidence: 0.3 };
		const { reasons } = engine.transition(displaced, ev("REPEATED_FAILURE", { uncertainty: 0.5 }), { step: 1 });
		expect(reasons.some((r) => r.kind === "event")).toBe(true);
		expect(reasons.some((r) => r.kind === "modulator")).toBe(true);
		expect(reasons.some((r) => r.kind === "homeostasis")).toBe(true);
		for (const reason of reasons) {
			expect(NEURO_VARIABLES).toContain(reason.variable);
			expect(Number.isFinite(reason.amount)).toBe(true);
		}
	});
});

describe("bounds", () => {
	it("keeps state within [0,1] under sustained one-sided pressure", () => {
		for (const type of ["TEST_FAILURE", "REPEATED_FAILURE", "TEST_SUCCESS", "TASK_FAILURE"] as const) {
			const after = drive(base(), type, 200);
			expect(isValidState(after)).toBe(true);
		}
	});

	it("keeps state within [0,1] across long random event sequences", () => {
		// Deterministic LCG: no Math.random, so a failure is always reproducible.
		let seed = 0x2545f491;
		const next = () => {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			return seed / 0x100000000;
		};
		const types = Object.keys(config.events) as Array<Parameters<typeof ev>[0]>;
		let state = base();
		for (let i = 0; i < 10_000; i++) {
			const type = types[Math.floor(next() * types.length)]!;
			const event = appraisedEvent({
				type,
				severity: next(),
				uncertainty: next(),
				novelty: next(),
				repeated: next() > 0.5,
			});
			state = engine.transition(state, event, { step: i + 1 }).after;
			expect(isValidState(state)).toBe(true);
		}
	});

	it("respects narrowed per-variable bounds", () => {
		const narrowed = buildConfig([
			{ label: "test", data: { variables: { stress: { min: 0.1, max: 0.4, baseline: 0.2 } } } },
		]).config;
		const narrowedEngine = createEngine(narrowed);
		let state = baselineState(narrowed);
		for (let i = 0; i < 100; i++) state = narrowedEngine.transition(state, ev("TASK_FAILURE"), { step: i }).after;
		expect(state.stress).toBeLessThanOrEqual(0.4);
		for (let i = 0; i < 200; i++) state = narrowedEngine.transition(state, ev("TASK_SUCCESS"), { step: i }).after;
		expect(state.stress).toBeGreaterThanOrEqual(0.1);
	});
});

describe("homeostasis", () => {
	it("pulls every variable back toward its baseline", () => {
		const displaced: NeuroState = {
			stress: 0.9,
			confidence: 0.1,
			noveltyDrive: 0.9,
			fatigue: 0.9,
			persistence: 0.1,
		};
		const delta = homeostasisDelta(displaced, config);
		expect(delta.stress!).toBeLessThan(0);
		expect(delta.confidence!).toBeGreaterThan(0);
		expect(delta.fatigue!).toBeLessThan(0);
		expect(delta.persistence!).toBeGreaterThan(0);
	});

	it("contributes nothing at baseline", () => {
		expect(homeostasisDelta(base(), config)).toEqual({});
	});

	it("returns a displaced state to baseline given only neutral ticks", () => {
		const displaced: NeuroState = { ...base(), stress: 0.95, confidence: 0.05, persistence: 0.05 };
		const tickOnly = buildConfig([{ label: "test", data: { events: { TICK: { fatigue: 0 } } } }]).config;
		const tickEngine = createEngine(tickOnly);
		let state = displaced;
		for (let i = 0; i < 500; i++) state = tickEngine.transition(state, ev("TICK"), { step: i }).after;
		expect(state.stress).toBeCloseTo(config.variables.stress.baseline, 3);
		expect(state.confidence).toBeCloseTo(config.variables.confidence.baseline, 3);
		expect(state.persistence).toBeCloseTo(config.variables.persistence.baseline, 3);
	});

	it("converges to the predicted fixed point under a constant event", () => {
		// No interactions, so the analytic steady state applies exactly.
		const plain = buildConfig([{ label: "test", data: { interactions: { rules: [] } } }]).config;
		const plainEngine = createEngine(plain);
		let state = baselineState(plain);
		for (let i = 0; i < 2000; i++) state = plainEngine.transition(state, ev("TEST_FAILURE"), { step: i }).after;
		const perEvent = plain.events.TEST_FAILURE!.stress!;
		expect(state.stress).toBeCloseTo(steadyState("stress", perEvent, plain), 3);
	});

	it("does not oscillate: a repeated event converges monotonically", () => {
		const plain = buildConfig([{ label: "test", data: { interactions: { rules: [] } } }]).config;
		const plainEngine = createEngine(plain);
		let state = baselineState(plain);
		let previous = state.stress;
		for (let i = 0; i < 300; i++) {
			state = plainEngine.transition(state, ev("TEST_FAILURE"), { step: i }).after;
			expect(state.stress).toBeGreaterThanOrEqual(previous - 1e-9);
			previous = state.stress;
		}
	});
});

describe("no runaway feedback", () => {
	it("verification does not manufacture the stress that demanded it", () => {
		// The spec's explicit anti-pathology requirement: inspecting must not itself
		// raise stress, or a cautious policy would escalate its own caution forever.
		const stressed: NeuroState = { ...base(), stress: 0.75 };
		let state = stressed;
		for (let i = 0; i < 50; i++) state = engine.transition(state, ev("INSPECTION"), { step: i }).after;
		expect(state.stress).toBeLessThan(stressed.stress);
	});

	it("a successful verification loop returns stress to baseline", () => {
		let state: NeuroState = { ...base(), stress: 0.85, confidence: 0.2 };
		for (let i = 0; i < 40; i++) {
			state = engine.transition(state, ev("INSPECTION"), { step: i * 2 }).after;
			state = engine.transition(state, ev("TEST_SUCCESS"), { step: i * 2 + 1 }).after;
		}
		expect(state.stress).toBeLessThan(0.3);
		expect(state.confidence).toBeGreaterThan(0.5);
	});

	it("caps the summed displacement acting on any one variable", () => {
		const stacked = buildConfig([
			{
				label: "test",
				data: {
					interactions: {
						maxDisplacementPerTarget: 0.2,
						rules: [
							{ id: "a", source: "fatigue", target: "stress", displacement: 0.3, threshold: 0.1, direction: "above" },
							{ id: "b", source: "stress", target: "stress", displacement: 0.3, threshold: 0.1, direction: "above" },
						],
					},
				},
			},
		]).config;
		const result = interactionDelta({ ...baselineState(stacked), fatigue: 0.9, stress: 0.9 }, stacked);
		const maxAmount = 0.2 * stacked.variables.stress.decayRate;
		expect(Math.abs(result.delta.stress!)).toBeLessThanOrEqual(maxAmount + 1e-9);
		expect(result.capped).toContain("stress");
	});

	it("interaction activation is zero on the silent side of the threshold", () => {
		const rule = config.interactions.rules.find((r) => r.id === "fatigue-suppresses-novelty")!;
		expect(activation(rule, { ...base(), fatigue: rule.threshold })).toBe(0);
		expect(activation(rule, { ...base(), fatigue: rule.threshold - 0.1 })).toBe(0);
		expect(activation(rule, { ...base(), fatigue: 1 })).toBe(1);
	});

	it("interactions read only the pre-transition state, so rule order is irrelevant", () => {
		const forward = config.interactions.rules;
		const reversed = buildConfig([
			{ label: "test", data: { interactions: { rules: [...forward].reverse() } } },
		]).config;
		const state: NeuroState = { stress: 0.85, confidence: 0.8, noveltyDrive: 0.5, fatigue: 0.75, persistence: 0.2 };
		expect(interactionDelta(state, reversed).delta).toEqual(interactionDelta(state, config).delta);
	});
});

describe("determinism", () => {
	const sequence = [
		ev("TEST_FAILURE", { severity: 0.7 }),
		ev("TEST_FAILURE", { severity: 0.8, repeated: true }),
		ev("REPEATED_FAILURE", { severity: 0.9, repeated: true }),
		ev("INSPECTION"),
		ev("STRATEGY_CHANGE", { novelty: 0.8 }),
		ev("PATCH_APPLIED"),
		ev("TEST_SUCCESS", { severity: 0.6 }),
		ev("TICK"),
	];

	it("produces an identical state history for identical inputs", () => {
		const first = replay(engine, base(), sequence);
		const second = replay(engine, base(), sequence);
		expect(JSON.stringify(second.states)).toBe(JSON.stringify(first.states));
	});

	it("survives a JSON round trip of the state", () => {
		const direct = replay(engine, base(), sequence);
		let state = base();
		for (const [index, event] of sequence.entries()) {
			state = JSON.parse(JSON.stringify(engine.transition(state, event, { step: index + 1 }).after));
		}
		expect(state).toEqual(direct.states.at(-1));
	});

	it("keeps every value at the declared precision", () => {
		const { states } = replay(engine, base(), sequence);
		for (const state of states) {
			for (const variable of NEURO_VARIABLES) {
				expect(state[variable]).toBe(quantize(state[variable]));
			}
		}
	});

	it("is independent of the step counter", () => {
		const a = engine.transition(base(), ev("TEST_FAILURE"), { step: 1 });
		const b = engine.transition(base(), ev("TEST_FAILURE"), { step: 9999, turnIndex: 42 });
		expect(b.after).toEqual(a.after);
	});
});

describe("suppression", () => {
	it("computes the transition but leaves state unchanged when mutate is false", () => {
		const before = base();
		const transition = engine.transition(before, ev("REPEATED_FAILURE"), { step: 1, mutate: false });
		expect(transition.suppressed).toBe(true);
		expect(transition.after).toEqual(before);
		// The would-be delta is still reported, so observer runs record what *would* have happened.
		expect(transition.delta.stress).toBeGreaterThan(0);
	});
});

describe("reset", () => {
	it("returns exactly to the configured baselines", () => {
		expect(engine.baseline()).toEqual({
			stress: DEFAULT_CONFIG.variables.stress.baseline,
			confidence: DEFAULT_CONFIG.variables.confidence.baseline,
			noveltyDrive: DEFAULT_CONFIG.variables.noveltyDrive.baseline,
			fatigue: DEFAULT_CONFIG.variables.fatigue.baseline,
			persistence: DEFAULT_CONFIG.variables.persistence.baseline,
		});
	});
});
