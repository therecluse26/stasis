/**
 * Homeostatic restoring force.
 *
 * Every variable is continuously pulled back toward its configured baseline:
 *
 *     homeostasis(v) = decayRate(v) * (baseline(v) - current(v))
 *
 * This is applied on every transition, which is what keeps the system from latching:
 * a burst of failures raises stress, but with no further evidence stress returns to
 * baseline on its own. Decay is driven by *events*, not wall-clock time, so replaying
 * an event sequence reproduces the state history exactly. Time-like decay during long
 * quiet stretches is supplied by the TICK event emitted at the end of each turn.
 */

import type { StasisConfig } from "./config.ts";
import { STASIS_VARIABLES, type StasisState, type StasisStateDelta, quantize } from "./state.ts";

export function homeostasisDelta(state: StasisState, config: StasisConfig): StasisStateDelta {
	const delta: StasisStateDelta = {};
	for (const variable of STASIS_VARIABLES) {
		const spec = config.variables[variable];
		const pull = spec.decayRate * (spec.baseline - state[variable]);
		const quantized = quantize(pull);
		if (quantized !== 0) delta[variable] = quantized;
	}
	return delta;
}

/**
 * Fixed point of the homeostatic map for a variable, given a constant per-event delta.
 *
 * With a repeated event contributing `perEvent` to a variable, the state converges to
 * `baseline + perEvent / decayRate` (clamped to the variable's bounds). Exposed so
 * tests can assert convergence targets rather than hard-coding numbers, and so
 * configuration can be checked for events whose steady state would peg a variable.
 */
export function steadyState(variable: keyof StasisState, perEvent: number, config: StasisConfig): number {
	const spec = config.variables[variable];
	if (spec.decayRate === 0) return perEvent > 0 ? spec.max : perEvent < 0 ? spec.min : spec.baseline;
	const target = spec.baseline + perEvent / spec.decayRate;
	return Math.min(spec.max, Math.max(spec.min, target));
}
