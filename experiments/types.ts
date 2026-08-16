/**
 * Shared shapes for the experiment harness.
 *
 * A study compares conditions that differ in exactly one respect — whether, and how,
 * physiology influences the agent. Everything else is pinned by these types so a
 * divergence has to be declared rather than accumulated by accident.
 */

import type { NeuroMode } from "../src/neuro/config.ts";
import type { NeuroState } from "../src/neuro/state.ts";

/**
 * The arms of a study.
 *
 * `bare` runs no extension at all. It exists only to confirm that `control` is genuinely
 * inert; it cannot produce behavioral metrics, because those come from the extension's
 * own appraisal records.
 *
 * `control` is the real control: the extension observes and records everything and
 * influences nothing.
 *
 * `static` holds physiology at baseline while still injecting the block and enforcing a
 * constant policy, which separates the effect of the *dynamics* from the effect of the
 * extra text in the prompt.
 */
export const CONDITIONS = ["bare", "control", "static", "neuro"] as const;
export type Condition = (typeof CONDITIONS)[number];

export const CONDITION_MODES: Record<Condition, NeuroMode | "none"> = {
	bare: "none",
	control: "observer",
	static: "static",
	neuro: "active",
};

export interface BenchmarkModel {
	provider: string;
	model: string;
	thinkingLevel?: string;
	/**
	 * OpenRouter routes to different upstream providers between requests, which adds
	 * variance unrelated to the hypothesis. Pinning it is recommended for any study whose
	 * conclusions depend on comparing arms.
	 */
	routing?: { only?: string[]; order?: string[] };
}

export interface BenchmarkTask {
	id: string;
	/** Fixture directory, relative to the benchmark file. */
	fixture: string;
	/** Overrides the fixture's own prompt. */
	prompt?: string;
	timeoutSeconds?: number;
	maxTurns?: number;
}

export interface Benchmark {
	name: string;
	description?: string;
	trials: number;
	model: BenchmarkModel;
	conditions: Condition[];
	tasks: BenchmarkTask[];
	/** Physiological profile for the neuro arm. */
	profile?: string;
	/** Held identical across every condition, so no arm gets extra instruction. */
	systemPrompt?: string;
	maxTurns: number;
	timeoutSeconds: number;
	/** Trials run at once. Keep low: concurrent trials contend for rate limits. */
	concurrency: number;
}

export interface FixtureDefinition {
	id: string;
	title: string;
	prompt: string;
	verify: string;
	timeoutSeconds: number;
	maxTurns: number;
	targets?: string[];
	/** Absolute path to the fixture directory. */
	root: string;
}

/** What a trial produced, before analysis. */
export interface TrialResult {
	benchmark: string;
	taskId: string;
	condition: Condition;
	trial: number;
	/** Hidden grading tests passed. */
	success: boolean;
	/** Visible tests passed; differs from `success` when the agent patched around the bug. */
	visiblePassed: boolean;
	/** A harness or agent failure. Not set merely because the agent did not fix the bug. */
	error?: string;
	/** Why grading failed, when it did. An ordinary outcome, not an error. */
	gradeDetail?: string;
	timedOut: boolean;
	turnCapped: boolean;
	/**
	 * The extension was supposed to run but produced no telemetry at all.
	 *
	 * Guards a failure mode that is otherwise invisible: if extensions load but are never
	 * activated, every condition behaves identically and the study reports a clean null
	 * result rather than an obvious error. Any trial with this set should invalidate the
	 * run rather than be averaged into it.
	 */
	extensionInert?: boolean;
	durationMs: number;

	turns: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;

	/** Unified diff the agent produced, and its size. */
	diffLines: number;
	filesModified: number;
	diff?: string;

	/** Paths written by the harness, for later analysis. */
	telemetryPath?: string;
	workdir?: string;

	metrics: TrialMetrics;
	repro: TrialRepro;
}

/** Metrics derived from the extension's own records, available in every arm but `bare`. */
export interface TrialMetrics {
	filesRead: number;
	commandsExecuted: number;
	testsExecuted: number;
	testFailures: number;
	buildFailures: number;
	repeatedFailures: number;
	strategyChanges: number;
	assumptionsInvalidated: number;
	patchesApplied: number;
	patchesRejected: number;
	largeChanges: number;
	policyBlocks: number;
	policyRelaxations: number;
	suspectedBypasses: number;

	/** Physiology, recorded even in the control arm where it influenced nothing. */
	transitions: number;
	policyChanges: number;
	meanStress: number;
	peakStress: number;
	meanConfidence: number;
	minPersistence: number;
	meanFatigue: number;
	peakFatigue: number;
	finalState?: NeuroState;
	/** Fraction of transitions spent in each policy regime. */
	regimeShare: Record<string, number>;

	// Behavioral measures — did behavior change, separately from whether it improved?
	meanPatchSizeOverall: number;
	meanPatchSizeAfterFailure: number;
	filesInspectedBeforeSecondModification: number;
	/** Of all failures, the fraction that repeated a failure already seen. */
	repeatedFailureRate: number;
	/** Turns from the first repeated failure to the next change of approach. */
	turnsToStrategyChange: number | null;
	/** Inspections per mutation, after the first failure. */
	verificationRatioAfterFailure: number;
	/** Mean patch size while stress was high, versus while it was low. */
	patchSizeAtHighStress: number | null;
	patchSizeAtLowStress: number | null;
}

export interface TrialRepro {
	extensionVersion: string;
	piVersion?: string;
	gitCommit?: string;
	configHash?: string;
	profile?: string;
	mode: NeuroMode | "none";
	model: BenchmarkModel;
	startedAt: string;
	nodeVersion: string;
	platform: string;
}

/** Configuration handed to a trial subprocess. */
export interface TrialRequest {
	benchmark: string;
	task: BenchmarkTask;
	fixture: FixtureDefinition;
	condition: Condition;
	trial: number;
	model: BenchmarkModel;
	profile?: string;
	systemPrompt?: string;
	maxTurns: number;
	timeoutSeconds: number;
	/** Directory for this trial's workdir, telemetry and result. */
	outputDir: string;
	packageRoot: string;
}
