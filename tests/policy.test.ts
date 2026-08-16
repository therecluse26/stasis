import { describe, expect, it } from "vitest";
import { appraisedEvent } from "../src/appraisal/events.ts";
import {
	POLICY_SIGN_CONSTRAINTS,
	baselineState,
	buildConfig,
	validateConfig,
	validateDynamics,
} from "../src/neuro/config.ts";
import { createEngine } from "../src/neuro/engine.ts";
import { interactionDelta } from "../src/neuro/interactions.ts";
import type { NeuroState } from "../src/neuro/state.ts";
import { createPolicyAdapter, derivePolicy, policyUnit } from "../src/policy/adapter.ts";
import { POLICY_FIELDS, levelWord, policiesEqual, policyDiff } from "../src/policy/policy.ts";

const { config } = buildConfig();
const adapter = createPolicyAdapter(config);
const base = () => baselineState(config);

/** Same baseline with one variable overridden. */
const at = (variable: keyof NeuroState, value: number): NeuroState => ({ ...base(), [variable]: value });

describe("policy derivation", () => {
	it("is a pure function of state", () => {
		const state = at("stress", 0.63);
		expect(adapter.derive(state)).toEqual(adapter.derive(state));
	});

	it("keeps every field inside its configured range", () => {
		const extremes: NeuroState[] = [
			{ stress: 0, confidence: 0, noveltyDrive: 0, fatigue: 0, persistence: 0 },
			{ stress: 1, confidence: 1, noveltyDrive: 1, fatigue: 1, persistence: 1 },
			{ stress: 1, confidence: 0, noveltyDrive: 1, fatigue: 1, persistence: 0 },
			{ stress: 0, confidence: 1, noveltyDrive: 0, fatigue: 0, persistence: 1 },
		];
		for (const state of extremes) {
			const policy = adapter.derive(state);
			for (const field of POLICY_FIELDS) {
				const spec = config.policy.fields[field];
				expect(policy[field]).toBeGreaterThanOrEqual(spec.min);
				expect(policy[field]).toBeLessThanOrEqual(spec.max);
			}
		}
	});

	it("leaves no field dead at baseline", () => {
		// A field clamped against a bound in the resting state stops responding to
		// physiology entirely — it looks configured but carries no signal. Requiring a
		// live baseline catches an intercept set too low or negative terms that overwhelm
		// it, which is easy to introduce by editing coefficients in isolation.
		const policy = adapter.derive(base());
		for (const field of POLICY_FIELDS) {
			const spec = config.policy.fields[field];
			expect.soft(policy[field], `${field} is pinned at its floor in the baseline state`).toBeGreaterThan(spec.min);
			expect.soft(policy[field], `${field} is pinned at its ceiling in the baseline state`).toBeLessThan(spec.max);
		}
	});

	it("gives every field a usable dynamic range across the state space", () => {
		// Each field must actually move between the extremes of state space, or the
		// coefficient set has neutralized it.
		const low = { stress: 0, confidence: 0, noveltyDrive: 0, fatigue: 0, persistence: 0 };
		const high = { stress: 1, confidence: 1, noveltyDrive: 1, fatigue: 1, persistence: 1 };
		const mixed = { stress: 1, confidence: 0, noveltyDrive: 1, fatigue: 0, persistence: 0 };
		for (const field of POLICY_FIELDS) {
			const spec = config.policy.fields[field];
			const values = [low, high, mixed].map((state) => adapter.derive(state)[field]);
			const span = Math.max(...values) - Math.min(...values);
			expect.soft(span, `${field} barely moves across the state space`).toBeGreaterThan((spec.max - spec.min) * 0.2);
		}
	});

	it("returns integers for count fields", () => {
		const policy = adapter.derive(at("stress", 0.42));
		expect(Number.isInteger(policy.maxPatchLines)).toBe(true);
		expect(Number.isInteger(policy.inspectionDepth)).toBe(true);
		expect(Number.isInteger(policy.retryTolerance)).toBe(true);
		expect(Number.isInteger(policy.strategyBranchCount)).toBe(true);
	});
});

describe("behavioral requirements", () => {
	it("high stress reduces allowed patch size", () => {
		expect(adapter.derive(at("stress", 0.9)).maxPatchLines).toBeLessThan(
			adapter.derive(at("stress", 0.1)).maxPatchLines,
		);
	});

	it("maxPatchLines never rises with stress", () => {
		let previous = Number.POSITIVE_INFINITY;
		for (let s = 0; s <= 1.0001; s += 0.05) {
			const value = adapter.derive(at("stress", Math.min(s, 1))).maxPatchLines;
			expect(value).toBeLessThanOrEqual(previous);
			previous = value;
		}
	});

	it("high stress increases verification level", () => {
		expect(adapter.derive(at("stress", 0.9)).verificationLevel).toBeGreaterThan(
			adapter.derive(at("stress", 0.1)).verificationLevel,
		);
	});

	it("verificationLevel never falls as stress rises", () => {
		let previous = Number.NEGATIVE_INFINITY;
		for (let s = 0; s <= 1.0001; s += 0.05) {
			const value = adapter.derive(at("stress", Math.min(s, 1))).verificationLevel;
			expect(value).toBeGreaterThanOrEqual(previous);
			previous = value;
		}
	});

	it("low persistence lowers retry tolerance", () => {
		expect(adapter.derive(at("persistence", 0.05)).retryTolerance).toBeLessThan(
			adapter.derive(at("persistence", 0.95)).retryTolerance,
		);
	});

	it("fatigue reduces strategy branch count", () => {
		const rested = adapter.derive({ ...base(), noveltyDrive: 0.8, fatigue: 0.0 });
		const tired = adapter.derive({ ...base(), noveltyDrive: 0.8, fatigue: 0.9 });
		expect(tired.strategyBranchCount).toBeLessThan(rested.strategyBranchCount);
	});

	it("fatigue reduces context expansion rather than degrading everything", () => {
		const rested = adapter.derive(at("fatigue", 0.0));
		const tired = adapter.derive(at("fatigue", 0.9));
		expect(tired.contextExpansionLevel).toBeLessThan(rested.contextExpansionLevel);
		// Fatigue reallocates resources; it must not silently loosen safety limits.
		expect(tired.maxPatchLines).toBeLessThanOrEqual(rested.maxPatchLines);
	});

	it("confidence permits larger coherent changes and less redundant checking", () => {
		const unsure = adapter.derive(at("confidence", 0.1));
		const sure = adapter.derive(at("confidence", 0.9));
		expect(sure.maxPatchLines).toBeGreaterThan(unsure.maxPatchLines);
		expect(sure.verificationLevel).toBeLessThan(unsure.verificationLevel);
		expect(sure.changeRiskTolerance).toBeGreaterThan(unsure.changeRiskTolerance);
	});

	it("novelty drive increases exploration", () => {
		expect(adapter.derive(at("noveltyDrive", 0.9)).explorationLevel).toBeGreaterThan(
			adapter.derive(at("noveltyDrive", 0.1)).explorationLevel,
		);
	});

	it("low persistence broadens the search", () => {
		expect(adapter.derive(at("persistence", 0.1)).explorationLevel).toBeGreaterThan(
			adapter.derive(at("persistence", 0.9)).explorationLevel,
		);
	});
});

describe("repeated failure changes policy", () => {
	it("eventually forces a materially more conservative and exploratory policy", () => {
		const engine = createEngine(config);
		let state = base();
		const initial = adapter.derive(state);
		for (let i = 0; i < 6; i++) {
			state = engine.transition(state, appraisedEvent({ type: "REPEATED_FAILURE", severity: 0.7 }), {
				step: i + 1,
			}).after;
		}
		const evolved = adapter.derive(state);
		expect(policiesEqual(initial, evolved)).toBe(false);
		expect(evolved.maxPatchLines).toBeLessThan(initial.maxPatchLines);
		expect(evolved.verificationLevel).toBeGreaterThan(initial.verificationLevel);
		expect(evolved.retryTolerance).toBeLessThan(initial.retryTolerance);
		expect(evolved.explorationLevel).toBeGreaterThan(initial.explorationLevel);
	});

	it("drives retry tolerance to zero before the agent can loop indefinitely", () => {
		const engine = createEngine(config);
		let state = base();
		let turnsUntilZero = -1;
		for (let i = 0; i < 40; i++) {
			state = engine.transition(state, appraisedEvent({ type: "REPEATED_FAILURE", severity: 0.8 }), {
				step: i + 1,
			}).after;
			if (adapter.derive(state).retryTolerance === 0) {
				turnsUntilZero = i + 1;
				break;
			}
		}
		expect(turnsUntilZero).toBeGreaterThan(0);
		expect(turnsUntilZero).toBeLessThan(20);
	});
});

describe("regime labelling", () => {
	it("labels a stressed, unexploratory state as cautious", () => {
		const policy = adapter.derive({ ...base(), stress: 0.9, noveltyDrive: 0.05, persistence: 0.95 });
		expect(policy.regime).toBe("CAUTIOUS");
	});

	it("labels a calm, confident state as convergent", () => {
		const policy = adapter.derive({ ...base(), stress: 0.0, confidence: 0.95, noveltyDrive: 0.0 });
		expect(policy.regime).toBe("CONVERGENT");
	});

	it("labels a stressed, novelty-seeking state as exploratory", () => {
		const policy = adapter.derive({ ...base(), stress: 0.9, noveltyDrive: 0.95, persistence: 0.1, fatigue: 0 });
		expect(policy.regime).toBe("EXPLORATORY");
	});
});

describe("config validation", () => {
	it("accepts the shipped defaults", () => {
		expect(validateConfig(config)).toEqual([]);
	});

	it("rejects a flipped sign that would invert a behavioral requirement", () => {
		for (const constraint of POLICY_SIGN_CONSTRAINTS) {
			const flipped = structuredClone(config);
			const terms = flipped.policy.fields[constraint.field].terms;
			terms[constraint.variable] = -(terms[constraint.variable] as number);
			const issues = validateConfig(flipped);
			expect(issues.join("\n")).toContain(`policy.fields.${constraint.field}.terms.${constraint.variable}`);
		}
	});

	it("rejects a baseline outside its own bounds", () => {
		const broken = structuredClone(config);
		broken.variables.stress.baseline = 1.5;
		expect(validateConfig(broken).length).toBeGreaterThan(0);
	});

	it("rejects an unknown event type and an unknown variable", () => {
		expect(validateConfig({ ...config, events: { NOT_A_THING: { stress: 0.1 } } as never }).length).toBeGreaterThan(0);
		expect(
			validateConfig({ ...config, events: { TEST_FAILURE: { mood: 0.1 } } as never }).length,
		).toBeGreaterThan(0);
	});

	it("rejects a duplicate interaction rule id", () => {
		const broken = structuredClone(config);
		broken.interactions.rules.push({ ...broken.interactions.rules[0]! });
		expect(validateConfig(broken).join("\n")).toContain("duplicate id");
	});
});

describe("pathological dynamics", () => {
	// These guard the failure mode the property tests originally exposed: a coupling
	// term strong enough to overwhelm its target's restoring force pins the target at a
	// bound, and the variable stops carrying information. The check compares sustained
	// forcing against decay rather than inspecting any single number.

	it("accepts the shipped interaction gains", () => {
		expect(validateDynamics(config)).toEqual([]);
	});

	it("rejects an interaction that would dominate its target's restoring force", () => {
		const broken = structuredClone(config);
		broken.interactions.rules[0] = {
			id: "overpowered",
			source: "fatigue",
			target: "persistence",
			displacement: -0.9,
			threshold: 0.5,
			direction: "above",
		};
		expect(validateDynamics(broken).join("\n")).toContain("maxDisplacementPerRule");
	});

	it("caps the summed displacement acting on one target at runtime", () => {
		const broken = structuredClone(config);
		const shared = { target: "persistence" as const, threshold: 0.5, direction: "above" as const, displacement: -0.3 };
		broken.interactions.maxDisplacementPerTarget = 0.5;
		broken.interactions.rules = [
			{ id: "a", source: "fatigue", ...shared },
			{ id: "b", source: "stress", ...shared },
			{ id: "c", source: "noveltyDrive", ...shared },
		];
		// Each rule is individually acceptable, so load-time validation passes...
		expect(validateDynamics(broken)).toEqual([]);
		// ...and the per-target cap keeps their combined pull bounded.
		const saturated = { stress: 1, confidence: 0.5, noveltyDrive: 1, fatigue: 1, persistence: 0.5 };
		const result = interactionDelta(saturated, broken);
		expect(result.capped).toContain("persistence");
		const maxAmount = broken.interactions.maxDisplacementPerTarget * broken.variables.persistence.decayRate;
		expect(Math.abs(result.delta.persistence!)).toBeLessThanOrEqual(maxAmount + 1e-9);
	});

	it("rejects a TICK that would peg a variable through the passage of turns alone", () => {
		const broken = structuredClone(config);
		broken.events.TICK = { fatigue: 0.05 };
		expect(validateDynamics(broken).join("\n")).toContain("peg fatigue");
	});

	it("rejects any forcing term aimed at a variable with no restoring force", () => {
		const broken = structuredClone(config);
		broken.variables.persistence.decayRate = 0;
		broken.interactions.rules = [
			{
				id: "unopposed",
				source: "fatigue",
				target: "persistence",
				displacement: -0.1,
				threshold: 0.5,
				direction: "above",
			},
		];
		expect(validateDynamics(broken).join("\n")).toContain("no restoring force");
	});

	it("rejects a config still written against the removed gain field", () => {
		const broken = structuredClone(config);
		(broken.interactions.rules[0] as unknown as { gain: number }).gain = -0.01;
		expect(validateConfig(broken).join("\n")).toContain("no longer supported");
	});

	it("keeps a coupling proportionate when a profile slows the target's decay", () => {
		// The failure this representation exists to prevent: a profile that halves a decay
		// rate would double a raw per-step gain's reach. Stated as displacement, the
		// coupling's effect on where the variable rests is unchanged.
		const slowed = structuredClone(config);
		slowed.variables.noveltyDrive.decayRate = config.variables.noveltyDrive.decayRate / 2;
		// Fatigue at its ceiling so the rule fires at full activation and no other rule
		// targeting noveltyDrive is above its own threshold.
		const state = { stress: 0.2, confidence: 0.5, noveltyDrive: 0.4, fatigue: 1, persistence: 0.8 };
		const rule = config.interactions.rules.find((r) => r.id === "fatigue-suppresses-novelty")!;
		const ratio = (cfg: typeof config) =>
			interactionDelta(state, cfg).delta.noveltyDrive! / cfg.variables.noveltyDrive.decayRate;
		expect(ratio(slowed)).toBeCloseTo(ratio(config), 6);
		expect(ratio(config)).toBeCloseTo(rule.displacement, 2);
	});

	it("leaves fatigue informative rather than saturated after a long quiet session", () => {
		const engine = createEngine(config);
		let state = baselineState(config);
		for (let i = 0; i < 500; i++) {
			state = engine.transition(state, appraisedEvent({ type: "TICK" }), { step: i + 1 }).after;
		}
		// The passage of turns alone must not exhaust the agent, or fatigue would stop
		// distinguishing heavy work from a long conversation.
		expect(state.fatigue).toBeLessThan(0.55);
		expect(state.persistence).toBeCloseTo(config.variables.persistence.baseline, 2);
		expect(adapter.derive(state).strategyBranchCount).toBeGreaterThan(1);
	});

	it("keeps a long heavy session away from the bounds", () => {
		const engine = createEngine(config);
		let state = baselineState(config);
		const cycle = ["TEST_FAILURE", "INSPECTION", "PATCH_APPLIED", "TEST_SUCCESS", "TICK"] as const;
		for (let i = 0; i < 400; i++) {
			state = engine.transition(state, appraisedEvent({ type: cycle[i % cycle.length]! }), { step: i + 1 }).after;
		}
		for (const value of Object.values(state)) {
			expect(value).toBeGreaterThan(0);
			expect(value).toBeLessThan(1);
		}
	});
});

describe("helpers", () => {
	it("reports which fields changed", () => {
		const a = adapter.derive(at("stress", 0.1));
		const b = adapter.derive(at("stress", 0.9));
		const diff = policyDiff(a, b);
		expect(diff.maxPatchLines).toBeDefined();
		expect(diff.verificationLevel).toBeDefined();
	});

	it("computes the unit value used to place a field in its range", () => {
		const spec = config.policy.fields.verificationLevel;
		expect(policyUnit(spec, { stress: 0, confidence: 0, noveltyDrive: 0, fatigue: 0, persistence: 0 })).toBeCloseTo(
			spec.intercept,
			6,
		);
	});

	it("names levels operationally", () => {
		expect(levelWord(0.05)).toBe("MINIMAL");
		expect(levelWord(0.5)).toBe("MODERATE");
		expect(levelWord(0.95)).toBe("MAXIMAL");
	});

	it("derivePolicy and the adapter agree", () => {
		const state = at("fatigue", 0.4);
		expect(adapter.derive(state)).toEqual(derivePolicy(state, config));
	});
});
