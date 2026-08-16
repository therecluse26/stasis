/**
 * Cross-variable coupling.
 *
 * Interactions let one variable shape another — fatigue narrowing exploration, low
 * persistence opening the search, confidence damping stress. They are the part of the
 * system most capable of producing pathological feedback, so three properties are
 * enforced structurally rather than by careful authoring:
 *
 *  1. Activation is computed from the *pre-transition* state only. No rule can observe
 *     another rule's output, so the result does not depend on declaration order.
 *  2. Strength is stated as a *displacement*: how far the rule may shift its target's
 *     resting point, in units of the target's range. The per-step contribution is
 *     `displacement * decayRate(target)`, so a rule is always weighed against the
 *     restoring force it works against and can never overpower it. This also survives
 *     profiles that change decay rates, which a raw per-step gain would not.
 *  3. The summed displacement on any one variable is capped by
 *     `interactions.maxDisplacementPerTarget`, so adding rules cannot compound.
 */

import type { InteractionRule, StasisConfig } from "./config.ts";
import { STASIS_VARIABLES, type StasisState, type StasisStateDelta, clampMagnitude, quantize } from "./state.ts";

/**
 * How strongly a rule fires, in [0,1].
 *
 * "above" ramps from 0 at the threshold to 1 at the variable's ceiling; "below" ramps
 * from 0 at the threshold to 1 at zero. Below the (or above, respectively) threshold
 * the rule is entirely silent — interactions are a regime effect, not a constant tax.
 */
export function activation(rule: InteractionRule, state: StasisState): number {
	const value = state[rule.source];
	if (rule.direction === "above") {
		if (value <= rule.threshold) return 0;
		const span = 1 - rule.threshold;
		return span <= 0 ? 1 : Math.min(1, (value - rule.threshold) / span);
	}
	if (value >= rule.threshold) return 0;
	const span = rule.threshold;
	return span <= 0 ? 1 : Math.min(1, (rule.threshold - value) / span);
}

export interface InteractionContribution {
	ruleId: string;
	target: keyof StasisState;
	/** Per-step contribution, already converted from displacement. */
	amount: number;
	/** Requested shift of the target's resting point, before the per-target cap. */
	displacement: number;
	activation: number;
}

export interface InteractionResult {
	delta: StasisStateDelta;
	contributions: InteractionContribution[];
	/** Variables whose summed contribution hit `maxTotalPerStep`. */
	capped: Array<keyof StasisState>;
}

export function interactionDelta(state: StasisState, config: StasisConfig): InteractionResult {
	const contributions: InteractionContribution[] = [];
	// Accumulate in displacement units so the per-target cap is expressed in the same
	// terms the rules are written in.
	const totals: StasisStateDelta = {};

	for (const rule of config.interactions.rules) {
		const strength = activation(rule, state);
		if (strength === 0) continue;
		const displacement = quantize(rule.displacement * strength);
		if (displacement === 0) continue;
		const amount = quantize(displacement * config.variables[rule.target].decayRate);
		contributions.push({ ruleId: rule.id, target: rule.target, amount, displacement, activation: strength });
		totals[rule.target] = quantize((totals[rule.target] ?? 0) + displacement);
	}

	const cap = config.interactions.maxDisplacementPerTarget;
	const delta: StasisStateDelta = {};
	const capped: Array<keyof StasisState> = [];
	for (const variable of STASIS_VARIABLES) {
		const total = totals[variable];
		if (total === undefined || total === 0) continue;
		const limited = clampMagnitude(total, cap);
		if (limited !== total) capped.push(variable);
		const amount = quantize(limited * config.variables[variable].decayRate);
		if (amount !== 0) delta[variable] = amount;
	}

	return { delta, contributions, capped };
}
