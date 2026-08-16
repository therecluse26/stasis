/**
 * Deterministic state -> policy derivation.
 *
 * Every field uses the same bounded linear form:
 *
 *     unit  = clamp01(intercept + sum over variables of coeff * state[variable])
 *     value = min + unit * (max - min)        (rounded when the field is a count)
 *
 * One shape for all ten fields buys three things: the whole policy layer is a pure
 * function testable without any harness; coefficient *signs* encode the spec's
 * behavioral requirements and are validated at config load; and an experiment can
 * reshape agent behavior by editing YAML rather than source.
 */

import type { NeuroConfig, PolicyFieldConfig, PolicyFieldName } from "../neuro/config.ts";
import { NEURO_VARIABLES, type NeuroState, clamp, clamp01, quantize } from "../neuro/state.ts";
import { type AgentPolicy, type PolicyRegime, type PolicySnapshot } from "./policy.ts";

export interface PolicyAdapter {
	derive(state: NeuroState): PolicySnapshot;
	readonly config: NeuroConfig;
}

/** The unit-interval value of a policy field before it is mapped onto its range. */
export function policyUnit(spec: PolicyFieldConfig, state: NeuroState): number {
	let sum = spec.intercept;
	for (const variable of NEURO_VARIABLES) {
		const coefficient = spec.terms[variable];
		if (coefficient === undefined || coefficient === 0) continue;
		sum += coefficient * state[variable];
	}
	return clamp01(sum);
}

export function policyField(spec: PolicyFieldConfig, state: NeuroState): number {
	const unit = policyUnit(spec, state);
	const value = spec.min + unit * (spec.max - spec.min);
	const bounded = clamp(value, spec.min, spec.max);
	return spec.round ? Math.round(bounded) : quantize(bounded);
}

export function deriveRegime(policy: AgentPolicy, config: NeuroConfig): PolicyRegime {
	const cautious = policy.verificationLevel >= config.policy.regime.cautiousVerification;
	const exploratory = policy.explorationLevel >= config.policy.regime.exploratoryExploration;
	if (cautious && exploratory) return "EXPLORATORY";
	if (cautious) return "CAUTIOUS";
	if (exploratory) return "DECISIVE";
	return "CONVERGENT";
}

export function derivePolicy(state: NeuroState, config: NeuroConfig): PolicySnapshot {
	const fields = config.policy.fields;
	const read = (name: PolicyFieldName) => policyField(fields[name], state);
	const policy: AgentPolicy = {
		maxPatchLines: read("maxPatchLines"),
		verificationLevel: read("verificationLevel"),
		explorationLevel: read("explorationLevel"),
		inspectionDepth: read("inspectionDepth"),
		retryTolerance: read("retryTolerance"),
		strategyBranchCount: read("strategyBranchCount"),
		assumptionVerificationLevel: read("assumptionVerificationLevel"),
		testFrequency: read("testFrequency"),
		contextExpansionLevel: read("contextExpansionLevel"),
		changeRiskTolerance: read("changeRiskTolerance"),
	};
	return { ...policy, regime: deriveRegime(policy, config) };
}

export function createPolicyAdapter(config: NeuroConfig): PolicyAdapter {
	return {
		config,
		derive: (state) => derivePolicy(state, config),
	};
}
