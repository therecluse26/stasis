/**
 * Shared shapes for the experiment harness.
 *
 * A study compares conditions that differ in exactly one respect — whether, and how,
 * physiology influences the agent. Everything else is pinned by these types so a
 * divergence has to be declared rather than accumulated by accident.
 */

import type { StasisMode } from "../src/stasis/config.ts";
import type { StasisState } from "../src/stasis/state.ts";

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
export const CONDITIONS = ["bare", "control", "static", "stasis"] as const;
export type Condition = (typeof CONDITIONS)[number];

export const CONDITION_MODES: Record<Condition, StasisMode | "none"> = {
	bare: "none",
	control: "observer",
	static: "static",
	stasis: "active",
};

export interface BenchmarkModel {
	provider: string;
	model: string;
	thinkingLevel?: string;
	/**
	 * OpenRouter routes to different upstream providers between requests, which adds
	 * variance unrelated to the hypothesis. Pinning it is recommended for any study whose
	 * conclusions depend on comparing arms.
	 *
	 * It matters more for an open-weight model than for a first-party one: the same model
	 * id is served by many providers, at differing quantizations and occasionally with
	 * differing tokenizers, so the spread between them can exceed the effect being measured.
	 *
	 * Passed through verbatim as OpenRouter's `provider` request field.
	 */
	routing?: OpenRouterRouting;
}

/** The subset of OpenRouter's provider-routing controls a study has reason to pin. */
export interface OpenRouterRouting {
	/** Exclusively allow these provider slugs. */
	only?: string[];
	/** Try these provider slugs in order, falling back along the list. */
	order?: string[];
	/** Skip these provider slugs. */
	ignore?: string[];
	/** Restrict to these quantization levels, e.g. `["bf16"]`. */
	quantizations?: string[];
	/** Whether a backup provider may serve the request. Set `false` to hold the pin. */
	allow_fallbacks?: boolean;
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
	/** Physiological profile for the stasis arm. */
	profile?: string;
	/**
	 * Physiology overrides for this study, applied as the highest-precedence overlay in
	 * every instrumented arm.
	 *
	 * A study is a claim about a specific configuration, so it should be able to state that
	 * configuration in its own file rather than depending on whatever the shipped defaults
	 * happen to be. It arrives at the extension as `inline`, so `/stasis config` and the
	 * telemetry run header both name it as a contributing source and a run stays
	 * reproducible from its own output.
	 */
	config?: unknown;
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
	/**
	 * The agent answered without calling a single tool.
	 *
	 * Not a failed attempt — no attempt. The workspace is untouched, so grading scores the
	 * shipped bug, and every behavioural metric contributes a zero drawn from a trial that
	 * never happened. Seen twice in roughly thirty-five live trials against the same
	 * open-weight endpoint, in two different conditions, which is frequent enough to decide
	 * an arm at these trial counts. Discarded from summaries and reported separately rather
	 * than averaged in; `transcript.json` in the trial directory holds what the model
	 * actually said.
	 */
	agentInert?: boolean;
	/** Set when the transcript could not be written. Diagnostic; never fails the trial. */
	transcriptError?: string;
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

/**
 * The agent answered without attempting the task.
 *
 * Derived rather than read from `agentInert`, so that a results file collected before that
 * flag existed is judged by the same rule as a fresh one — the stored flag is the record,
 * this is the definition. A timed-out or turn-capped trial is excluded because those made
 * an attempt and ran out of room, which is an outcome worth scoring.
 */
export function isNoAttempt(result: TrialResult): boolean {
	return !result.error && result.toolCalls === 0 && !result.timedOut && !result.turnCapped;
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
	finalState?: StasisState;
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
	mode: StasisMode | "none";
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
	/** Physiology overrides from the benchmark; see `Benchmark.config`. */
	config?: unknown;
	systemPrompt?: string;
	maxTurns: number;
	timeoutSeconds: number;
	/** Directory for this trial's workdir, telemetry and result. */
	outputDir: string;
	packageRoot: string;
}
