/**
 * The physiological state vector and the arithmetic used to move it.
 *
 * Two invariants matter more than anything else in this file:
 *
 *  1. Every variable stays inside its configured bounds, always.
 *  2. The same inputs produce byte-identical outputs, forever. Values are quantized
 *     after every operation so that accumulated floating-point drift can never make
 *     two replays of the same event sequence diverge.
 */

export const STASIS_VARIABLES = ["stress", "confidence", "noveltyDrive", "fatigue", "persistence"] as const;

export type StasisVariable = (typeof STASIS_VARIABLES)[number];

export interface StasisState {
	stress: number;
	confidence: number;
	noveltyDrive: number;
	fatigue: number;
	persistence: number;
}

export type StasisStateDelta = Partial<Record<StasisVariable, number>>;

/** Six decimal places. Chosen to be far finer than any behaviorally meaningful change. */
export const QUANTUM_DIGITS = 6;

/**
 * Round to a fixed number of decimals. `toFixed` is specified exactly by ECMA-262,
 * so this is stable across platforms and Node versions — which is what makes replay
 * reproducibility a guarantee rather than a hope.
 */
export function quantize(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Number(value.toFixed(QUANTUM_DIGITS));
}

export function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

export function clamp01(value: number): number {
	return clamp(value, 0, 1);
}

/** Clamp a signed magnitude to `limit`, preserving sign. */
export function clampMagnitude(value: number, limit: number): number {
	if (!Number.isFinite(value)) return 0;
	const bound = Math.abs(limit);
	if (value > bound) return bound;
	if (value < -bound) return -bound;
	return value;
}

export function emptyDelta(): StasisStateDelta {
	return {};
}

export function deltaValue(delta: StasisStateDelta, variable: StasisVariable): number {
	return delta[variable] ?? 0;
}

/** Add `amount` into `delta[variable]`, creating the key if needed. Mutates `delta`. */
export function addToDelta(delta: StasisStateDelta, variable: StasisVariable, amount: number): void {
	if (amount === 0) return;
	delta[variable] = quantize((delta[variable] ?? 0) + amount);
}

export function scaleDelta(delta: StasisStateDelta, factor: number): StasisStateDelta {
	const out: StasisStateDelta = {};
	for (const variable of STASIS_VARIABLES) {
		const value = delta[variable];
		if (value === undefined || value === 0) continue;
		out[variable] = quantize(value * factor);
	}
	return out;
}

export function sumDeltas(...deltas: StasisStateDelta[]): StasisStateDelta {
	const out: StasisStateDelta = {};
	for (const delta of deltas) {
		for (const variable of STASIS_VARIABLES) {
			const value = delta[variable];
			if (value === undefined || value === 0) continue;
			out[variable] = quantize((out[variable] ?? 0) + value);
		}
	}
	return out;
}

/** Drop zero-valued keys so telemetry records only what actually moved. */
export function pruneDelta(delta: StasisStateDelta): StasisStateDelta {
	const out: StasisStateDelta = {};
	for (const variable of STASIS_VARIABLES) {
		const value = delta[variable];
		if (value === undefined || value === 0) continue;
		out[variable] = value;
	}
	return out;
}

export function cloneState(state: StasisState): StasisState {
	return {
		stress: state.stress,
		confidence: state.confidence,
		noveltyDrive: state.noveltyDrive,
		fatigue: state.fatigue,
		persistence: state.persistence,
	};
}

export function statesEqual(a: StasisState, b: StasisState): boolean {
	return STASIS_VARIABLES.every((variable) => a[variable] === b[variable]);
}

/** True when every variable is finite and within [0,1]. Used as a test invariant. */
export function isValidState(state: StasisState): boolean {
	return STASIS_VARIABLES.every((variable) => {
		const value = state[variable];
		return Number.isFinite(value) && value >= 0 && value <= 1;
	});
}

export function formatState(state: StasisState): string {
	return STASIS_VARIABLES.map((variable) => `${variable}=${state[variable].toFixed(3)}`).join(" ");
}
