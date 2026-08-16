/**
 * The neuromodulator engine: the single place where physiological state changes.
 *
 * The LLM cannot reach this code. Nothing it emits — text, tool arguments, tool
 * results it fabricates — is an input here except by way of an appraised event, and
 * appraisal is deterministic. That separation is the whole point: the model
 * experiences the consequences of its internal state without being able to set it.
 *
 * Transition order is fixed and load-bearing for reproducibility:
 *
 *   1. event delta      configured magnitude, scaled by appraised severity
 *   2. modulators       continuous contributions from uncertainty and novelty
 *   3. clamp            per-variable cap on how far one event may move anything
 *   4. interactions     cross-variable coupling, computed from the *before* state
 *   5. homeostasis      restoring pull toward baseline, from the *before* state
 *   6. bound + quantize clamp into range, then round to a fixed precision
 *
 * Steps 4 and 5 read only `before`, so they commute with step 1-3 and with each other.
 * Step 6 makes the result exactly representable, so replays cannot drift.
 */

import type { AgentEventType, AppraisedEvent } from "../appraisal/events.ts";
import type { StasisConfig } from "./config.ts";
import { baselineState } from "./config.ts";
import { homeostasisDelta } from "./homeostasis.ts";
import { type InteractionContribution, interactionDelta } from "./interactions.ts";
import {
	STASIS_VARIABLES,
	type StasisState,
	type StasisStateDelta,
	type StasisVariable,
	clamp,
	clampMagnitude,
	cloneState,
	pruneDelta,
	quantize,
} from "./state.ts";

export type TransitionReasonKind = "event" | "modulator" | "interaction" | "homeostasis" | "clamp" | "bound";

export interface TransitionReason {
	kind: TransitionReasonKind;
	variable: StasisVariable;
	amount: number;
	detail: string;
}

export interface StasisTransition {
	step: number;
	event: AppraisedEvent;
	before: StasisState;
	/** Event and modulator contribution, after per-variable clamping. */
	delta: StasisStateDelta;
	interactions: StasisStateDelta;
	homeostasis: StasisStateDelta;
	after: StasisState;
	reasons: TransitionReason[];
	/** True when the engine was in a mode that suppresses state change. */
	suppressed: boolean;
}

export interface TransitionContext {
	/** Monotonic transition counter; recorded in telemetry, never used in the maths. */
	step: number;
	turnIndex?: number;
	toolCallId?: string;
	/** When false the transition is computed and returned but `after` equals `before`. */
	mutate?: boolean;
}

export interface NeuromodulatorEngine {
	transition(current: StasisState, event: AppraisedEvent, context: TransitionContext): StasisTransition;
	baseline(): StasisState;
	readonly config: StasisConfig;
}

/**
 * Map appraised severity onto a multiplier for the configured event delta.
 *
 * Severity 0.5 is nominal and always yields exactly 1.0, so the numbers written in
 * YAML are the magnitudes actually observed for a typical event of that type.
 */
export function severityScale(severity: number, config: StasisConfig): number {
	if (!config.severity.enabled) return 1;
	const { minScale, maxScale } = config.severity;
	const s = clamp(severity, 0, 1);
	const scale = s <= 0.5 ? minScale + (1 - minScale) * (s / 0.5) : 1 + (maxScale - 1) * ((s - 0.5) / 0.5);
	return quantize(scale);
}

function applyModulator(
	target: StasisStateDelta,
	source: StasisStateDelta,
	weight: number,
	label: string,
	reasons: TransitionReason[],
): void {
	if (weight <= 0) return;
	for (const variable of STASIS_VARIABLES) {
		const configured = source[variable];
		if (configured === undefined || configured === 0) continue;
		const amount = quantize(configured * weight);
		if (amount === 0) continue;
		target[variable] = quantize((target[variable] ?? 0) + amount);
		reasons.push({ kind: "modulator", variable, amount, detail: label });
	}
}

export function createEngine(config: StasisConfig): NeuromodulatorEngine {
	return {
		config,
		baseline: () => baselineState(config),
		transition(current, event, context) {
			const before = cloneState(current);
			const reasons: TransitionReason[] = [];

			// 1. Configured event delta, scaled by severity.
			const raw: StasisStateDelta = {};
			const configured = config.events[event.type] ?? {};
			const scale = severityScale(event.severity, config);
			for (const variable of STASIS_VARIABLES) {
				const base = configured[variable];
				if (base === undefined || base === 0) continue;
				const amount = quantize(base * scale);
				if (amount === 0) continue;
				raw[variable] = quantize((raw[variable] ?? 0) + amount);
				reasons.push({
					kind: "event",
					variable,
					amount,
					detail: `${event.type} x${scale.toFixed(3)}`,
				});
			}

			// 2. Continuous modulators.
			applyModulator(raw, config.modulators.uncertainty, event.uncertainty, "uncertainty", reasons);
			applyModulator(raw, config.modulators.novelty, event.novelty, "novelty", reasons);

			// 3. Per-variable cap on a single event's influence.
			const delta: StasisStateDelta = {};
			for (const variable of STASIS_VARIABLES) {
				const value = raw[variable];
				if (value === undefined || value === 0) continue;
				const limit = config.variables[variable].maxDeltaPerEvent;
				const limited = quantize(clampMagnitude(value, limit));
				if (limited !== value) {
					reasons.push({
						kind: "clamp",
						variable,
						amount: quantize(limited - value),
						detail: `maxDeltaPerEvent ${limit}`,
					});
				}
				delta[variable] = limited;
			}

			// 4 & 5. Coupling and restoring force, both from `before`.
			const interaction = interactionDelta(before, config);
			for (const contribution of interaction.contributions) {
				reasons.push({
					kind: "interaction",
					variable: contribution.target,
					amount: contribution.amount,
					detail: `${contribution.ruleId} @${contribution.activation.toFixed(3)}`,
				});
			}
			for (const variable of interaction.capped) {
				reasons.push({
					kind: "clamp",
					variable,
					amount: 0,
					detail: `interactions.maxDisplacementPerTarget ${config.interactions.maxDisplacementPerTarget}`,
				});
			}

			const homeostasis = homeostasisDelta(before, config);
			for (const variable of STASIS_VARIABLES) {
				const amount = homeostasis[variable];
				if (amount === undefined || amount === 0) continue;
				reasons.push({
					kind: "homeostasis",
					variable,
					amount,
					detail: `toward ${config.variables[variable].baseline}`,
				});
			}

			// 6. Combine, bound, quantize.
			const after = cloneState(before);
			for (const variable of STASIS_VARIABLES) {
				const spec = config.variables[variable];
				const sum =
					before[variable] +
					(delta[variable] ?? 0) +
					(interaction.delta[variable] ?? 0) +
					(homeostasis[variable] ?? 0);
				const bounded = clamp(sum, spec.min, spec.max);
				if (bounded !== sum) {
					reasons.push({
						kind: "bound",
						variable,
						amount: quantize(bounded - sum),
						detail: `bounds [${spec.min}, ${spec.max}]`,
					});
				}
				after[variable] = quantize(bounded);
			}

			const suppressed = context.mutate === false;
			return {
				step: context.step,
				event,
				before,
				delta: pruneDelta(delta),
				interactions: pruneDelta(interaction.delta),
				homeostasis: pruneDelta(homeostasis),
				after: suppressed ? before : after,
				reasons,
				suppressed,
			};
		},
	};
}

/**
 * Replay a whole event sequence from a starting state.
 *
 * Used by tests and by `npm run demo:sequence` to demonstrate that identical inputs
 * produce an identical state history.
 */
export function replay(
	engine: NeuromodulatorEngine,
	initial: StasisState,
	events: AppraisedEvent[],
): { states: StasisState[]; transitions: StasisTransition[] } {
	let state = cloneState(initial);
	const states: StasisState[] = [cloneState(state)];
	const transitions: StasisTransition[] = [];
	events.forEach((event, index) => {
		const transition = engine.transition(state, event, { step: index + 1 });
		state = transition.after;
		states.push(cloneState(state));
		transitions.push(transition);
	});
	return { states, transitions };
}

/** Net configured effect of an event type on a variable, ignoring severity scaling. */
export function configuredEffect(
	config: StasisConfig,
	type: AgentEventType,
	variable: StasisVariable,
): number | undefined {
	return config.events[type]?.[variable];
}
