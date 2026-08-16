/**
 * Metrics derived from a trial's telemetry.
 *
 * Everything here comes from the extension's own records, which is why the control arm
 * runs the extension in observer mode: both arms are then measured by identical code,
 * and a difference between them cannot be an artefact of measuring them differently.
 *
 * The behavioral measures are the point of the exercise. "Did neuromodulation change
 * behavior?" and "did the change improve outcomes?" are separate questions, and a study
 * that only reports success rates cannot answer the first.
 */

import { readFileSync } from "node:fs";
import type { StasisState } from "../src/stasis/state.ts";
import {
	type AppraisalRecord,
	type BypassRecord,
	type EnforcementRecord,
	type StasisTelemetryRecord,
	type PolicyChangeRecord,
	type RunHeaderRecord,
	type TransitionRecord,
	parseTelemetry,
} from "../src/telemetry/schema.ts";
import type { TrialMetrics } from "./types.ts";

const mean = (values: number[]): number =>
	values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const round = (value: number, digits = 3): number => Number(value.toFixed(digits));

export function emptyMetrics(): TrialMetrics {
	return {
		filesRead: 0,
		commandsExecuted: 0,
		testsExecuted: 0,
		testFailures: 0,
		buildFailures: 0,
		repeatedFailures: 0,
		strategyChanges: 0,
		assumptionsInvalidated: 0,
		patchesApplied: 0,
		patchesRejected: 0,
		largeChanges: 0,
		policyBlocks: 0,
		policyRelaxations: 0,
		suspectedBypasses: 0,
		transitions: 0,
		policyChanges: 0,
		meanStress: 0,
		peakStress: 0,
		meanConfidence: 0,
		minPersistence: 0,
		meanFatigue: 0,
		peakFatigue: 0,
		regimeShare: {},
		meanPatchSizeOverall: 0,
		meanPatchSizeAfterFailure: 0,
		filesInspectedBeforeSecondModification: 0,
		repeatedFailureRate: 0,
		turnsToStrategyChange: null,
		verificationRatioAfterFailure: 0,
		patchSizeAtHighStress: null,
		patchSizeAtLowStress: null,
	};
}

export function readTelemetry(path: string): StasisTelemetryRecord[] {
	try {
		return parseTelemetry(readFileSync(path, "utf8"));
	} catch {
		return [];
	}
}

export function runHeader(records: StasisTelemetryRecord[]): RunHeaderRecord | undefined {
	return records.find((record): record is RunHeaderRecord => record.type === "run_header");
}

/** High and low stress, split at the median so the comparison adapts to the arm's range. */
function medianOf(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export function computeMetrics(records: StasisTelemetryRecord[]): TrialMetrics {
	const metrics = emptyMetrics();

	const transitions = records.filter((r): r is TransitionRecord => r.type === "transition");
	const appraisals = records.filter((r): r is AppraisalRecord => r.type === "appraisal");
	const enforcements = records.filter((r): r is EnforcementRecord => r.type === "enforcement");
	const policyChanges = records.filter((r): r is PolicyChangeRecord => r.type === "policy_change");
	const bypasses = records.filter((r): r is BypassRecord => r.type === "bypass_suspected");

	metrics.transitions = transitions.length;
	metrics.policyChanges = policyChanges.length;
	metrics.policyBlocks = enforcements.filter((record) => record.blocked).length;
	metrics.policyRelaxations = enforcements.filter((record) => record.relaxed).length;
	metrics.suspectedBypasses = bypasses.length;

	// --- activity counts, from what each appraisal saw ---------------------
	for (const record of appraisals) {
		if (record.toolName === "read" || record.toolName === "grep") metrics.filesRead += 1;
		if (record.toolName === "bash") metrics.commandsExecuted += 1;
	}

	for (const record of transitions) {
		const { type } = record.event;
		const kind = record.event.evidence.commandKind;
		if (kind === "test") metrics.testsExecuted += 1;
		if (type === "TEST_FAILURE") metrics.testFailures += 1;
		if (type === "BUILD_FAILURE" || type === "TYPECHECK_FAILURE") metrics.buildFailures += 1;
		if (type === "REPEATED_FAILURE") metrics.repeatedFailures += 1;
		if (type === "STRATEGY_CHANGE") metrics.strategyChanges += 1;
		if (type === "ASSUMPTION_INVALIDATED") metrics.assumptionsInvalidated += 1;
		if (type === "PATCH_APPLIED") metrics.patchesApplied += 1;
		if (type === "PATCH_REJECTED") metrics.patchesRejected += 1;
		if (type === "LARGE_CHANGE") metrics.largeChanges += 1;
	}

	// --- physiology, recorded in every arm ---------------------------------
	if (transitions.length > 0) {
		const states = transitions.map((record) => record.stateAfter);
		const pick = (key: keyof StasisState) => states.map((state) => state[key]);
		metrics.meanStress = round(mean(pick("stress")));
		metrics.peakStress = round(Math.max(...pick("stress")));
		metrics.meanConfidence = round(mean(pick("confidence")));
		metrics.minPersistence = round(Math.min(...pick("persistence")));
		metrics.meanFatigue = round(mean(pick("fatigue")));
		metrics.peakFatigue = round(Math.max(...pick("fatigue")));
		metrics.finalState = states.at(-1);

		const regimes = new Map<string, number>();
		for (const record of transitions) {
			regimes.set(record.policy.regime, (regimes.get(record.policy.regime) ?? 0) + 1);
		}
		for (const [regime, count] of regimes) {
			metrics.regimeShare[regime] = round(count / transitions.length);
		}
	}

	// --- behavioral measures ------------------------------------------------
	// An ordered view of the actions that matter, so "after a failure" is answerable.
	interface Action {
		step: number;
		turn: number;
		kind: "mutation" | "failure" | "inspection" | "strategyChange";
		lines?: number;
		stress: number;
		repeated?: boolean;
	}

	const actions: Action[] = [];
	for (const record of transitions) {
		const { type, evidence } = record.event;
		const common = { step: record.step, turn: record.turnIndex ?? 0, stress: record.stateBefore.stress };
		if (type === "PATCH_APPLIED") {
			actions.push({ ...common, kind: "mutation", lines: evidence.changedLines ?? 0 });
		} else if (type.endsWith("_FAILURE") && type !== "REPEATED_FAILURE") {
			actions.push({ ...common, kind: "failure", repeated: record.event.repeated });
		} else if (type === "INSPECTION") {
			actions.push({ ...common, kind: "inspection" });
		} else if (type === "STRATEGY_CHANGE" || type === "ASSUMPTION_INVALIDATED") {
			actions.push({ ...common, kind: "strategyChange" });
		}
	}

	const mutations = actions.filter((action) => action.kind === "mutation");
	metrics.meanPatchSizeOverall = round(mean(mutations.map((action) => action.lines ?? 0)), 1);

	const firstFailure = actions.find((action) => action.kind === "failure");
	if (firstFailure) {
		const after = mutations.filter((action) => action.step > firstFailure.step);
		metrics.meanPatchSizeAfterFailure = round(mean(after.map((action) => action.lines ?? 0)), 1);

		const inspectionsAfter = actions.filter(
			(action) => action.kind === "inspection" && action.step > firstFailure.step,
		).length;
		metrics.verificationRatioAfterFailure = after.length === 0 ? 0 : round(inspectionsAfter / after.length, 2);
	}

	// How much the agent looked at the code between its first and second change.
	if (mutations.length >= 2) {
		const first = mutations[0]!;
		const second = mutations[1]!;
		metrics.filesInspectedBeforeSecondModification = actions.filter(
			(action) => action.kind === "inspection" && action.step > first.step && action.step < second.step,
		).length;
	}

	const failures = actions.filter((action) => action.kind === "failure");
	if (failures.length > 0) {
		metrics.repeatedFailureRate = round(failures.filter((action) => action.repeated).length / failures.length, 3);
	}

	// How long the agent persisted with an approach that had already failed twice.
	const firstRepeat = transitions.find((record) => record.event.type === "REPEATED_FAILURE");
	if (firstRepeat) {
		const change = transitions.find(
			(record) =>
				record.step > firstRepeat.step &&
				(record.event.type === "STRATEGY_CHANGE" || record.event.type === "ASSUMPTION_INVALIDATED"),
		);
		metrics.turnsToStrategyChange = change ? (change.turnIndex ?? 0) - (firstRepeat.turnIndex ?? 0) : null;
	}

	// Riskiness of edits at different stress levels, split at this trial's own median so
	// the comparison is meaningful even in an arm where stress never moved much.
	if (mutations.length >= 2) {
		const threshold = medianOf(mutations.map((action) => action.stress));
		const high = mutations.filter((action) => action.stress > threshold).map((action) => action.lines ?? 0);
		const low = mutations.filter((action) => action.stress <= threshold).map((action) => action.lines ?? 0);
		metrics.patchSizeAtHighStress = high.length > 0 ? round(mean(high), 1) : null;
		metrics.patchSizeAtLowStress = low.length > 0 ? round(mean(low), 1) : null;
	}

	return metrics;
}
