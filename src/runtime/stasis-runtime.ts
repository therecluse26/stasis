/**
 * The orchestrator: appraisal, physiology, policy, enforcement and telemetry wired
 * together — with no dependency on Pi.
 *
 * Keeping this seam sharp is what makes the causal chain testable. Every claim the
 * project makes ("a failing test tightens the patch limit the model sees on the next
 * call") can be asserted against this class directly, with no harness, no model and no
 * network. `src/extension.ts` is then a thin adapter that translates Pi's events into
 * these calls and its return values back.
 *
 * Modes:
 *
 * | mode     | transitions | context injection | enforcement |
 * |----------|-------------|-------------------|-------------|
 * | active   | applied     | yes               | yes         |
 * | static   | suppressed  | yes, at baseline  | yes, constant |
 * | observer | applied     | no                | no          |
 * | off      | suppressed  | no                | no          |
 *
 * `observer` is the control condition: physiology runs and is recorded in full, so the
 * counterfactual trajectory is available for analysis, but nothing reaches the agent.
 * `static` isolates the effect of the dynamics from the effect of the injected text.
 */

import { type AppraisedEvent, appraisedEvent } from "../appraisal/events.ts";
import { type Appraiser, type ToolOutcome, createAppraiser } from "../appraisal/appraiser.ts";
import type { FailureDetectorSnapshot } from "../appraisal/failure-detector.ts";
import { type LoadedConfig, type StasisMode, baselineState } from "../stasis/config.ts";
import { type NeuromodulatorEngine, createEngine } from "../stasis/engine.ts";
import { type StasisState, cloneState } from "../stasis/state.ts";
import { Enforcement, type EnforcementDecision, type ToolAttempt } from "../policy/enforcement.ts";
import { type PolicyAdapter, createPolicyAdapter } from "../policy/adapter.ts";
import { type PolicySnapshot, policyDiff, policiesEqual } from "../policy/policy.ts";
import { PROTOCOL_PREAMBLE, renderStateBlock, summarizeForStatus } from "../policy/prompt-block.ts";
import { type Recorder, createMemoryRecorder, stamp } from "../telemetry/recorder.ts";
import type {
	AppraisalRecord,
	BypassRecord,
	EnforcementRecord,
	IntegrityRecord,
	LifecycleRecord,
	StasisTelemetryRecord,
	PolicyChangeRecord,
	RunHeaderRecord,
	TransitionRecord,
} from "../telemetry/schema.ts";
import { EXTENSION_VERSION } from "../version.ts";

/** Everything needed to resume a session exactly where it left off. */
export interface StasisSnapshot {
	version: 1;
	state: StasisState;
	step: number;
	turnIndex: number;
	configHash: string;
	configVersion: string;
	profile: string;
	mode: StasisMode;
	enabled: boolean;
	detector: FailureDetectorSnapshot;
	readSinceFailure: string[];
	hasFailed: boolean;
}

export interface StasisRuntimeOptions {
	loaded: LoadedConfig;
	recorder?: Recorder;
	sessionId?: string;
	cwd?: string;
	/** Injected in tests so telemetry timestamps are deterministic. */
	now?: () => Date;
	/** Size of an existing file, for sizing a whole-file write. */
	existingLineCount?: (path: string) => number | undefined;
}

export interface ObservationResult {
	events: AppraisedEvent[];
	transitions: TransitionRecord[];
	policyChanged: boolean;
}

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export class StasisRuntime {
	readonly loaded: LoadedConfig;
	readonly engine: NeuromodulatorEngine;
	readonly adapter: PolicyAdapter;
	readonly appraiser: Appraiser;
	readonly enforcement: Enforcement;
	readonly recorder: Recorder;

	private _state: StasisState;
	private _policy: PolicySnapshot;
	private _mode: StasisMode;
	private _enabled = true;
	private step = 0;
	private turnIndex = 0;
	private readSinceFailure = new Set<string>();
	private hasFailed = false;
	private readonly sessionId: string | undefined;
	private readonly cwd: string;
	private readonly now: () => Date;
	private readonly existingLineCount: ((path: string) => number | undefined) | undefined;
	/** Set when an internal error has forced neuromodulation off for the session. */
	private faulted = false;

	constructor(options: StasisRuntimeOptions) {
		this.loaded = options.loaded;
		const config = options.loaded.config;
		this.engine = createEngine(config);
		this.adapter = createPolicyAdapter(config);
		this.appraiser = createAppraiser(config);
		this.enforcement = new Enforcement(config);
		this.recorder = options.recorder ?? createMemoryRecorder(config.runtime.historyLimit);
		this.sessionId = options.sessionId;
		this.cwd = options.cwd ?? process.cwd();
		this.now = options.now ?? (() => new Date());
		this.existingLineCount = options.existingLineCount;
		this._mode = config.runtime.mode;
		this._state = baselineState(config);
		this._policy = this.adapter.derive(this._state);
	}

	// -----------------------------------------------------------------------
	// Inspection
	// -----------------------------------------------------------------------

	get state(): StasisState {
		return cloneState(this._state);
	}

	get policy(): PolicySnapshot {
		return { ...this._policy };
	}

	get mode(): StasisMode {
		return this.effectiveMode;
	}

	get configuredMode(): StasisMode {
		return this._mode;
	}

	get enabled(): boolean {
		return this._enabled && !this.faulted;
	}

	get transitionCount(): number {
		return this.step;
	}

	/** The mode actually in force, accounting for the runtime toggle and any fault. */
	private get effectiveMode(): StasisMode {
		if (!this._enabled || this.faulted) return "off";
		return this._mode;
	}

	private get influencesAgent(): boolean {
		const mode = this.effectiveMode;
		return mode === "active" || mode === "static";
	}

	private get appliesTransitions(): boolean {
		const mode = this.effectiveMode;
		return mode === "active" || mode === "observer";
	}

	// -----------------------------------------------------------------------
	// Telemetry helpers
	// -----------------------------------------------------------------------

	private emit<T extends StasisTelemetryRecord>(partial: Omit<T, "schema" | "timestamp">): T {
		const record = stamp<T>(partial, this.now);
		this.recorder.record(record);
		return record;
	}

	recordRunHeader(context: {
		piVersion?: string;
		gitCommit?: string;
		model?: RunHeaderRecord["model"];
		condition?: string;
		trial?: number;
		task?: string;
	}): void {
		this.emit<RunHeaderRecord>({
			type: "run_header",
			step: this.step,
			sessionId: this.sessionId,
			extensionVersion: EXTENSION_VERSION,
			piVersion: context.piVersion,
			gitCommit: context.gitCommit,
			mode: this.effectiveMode,
			profile: this.loaded.config.profile,
			configHash: this.loaded.hash,
			configSources: this.loaded.sources,
			config: this.loaded.config,
			initialState: this.state,
			initialPolicy: this.policy,
			model: context.model,
			cwd: this.cwd,
			condition: context.condition,
			trial: context.trial,
			task: context.task,
			environment: { platform: process.platform, nodeVersion: process.version },
		});
	}

	recordLifecycle(phase: LifecycleRecord["phase"], reason?: string, restored?: boolean): void {
		this.emit<LifecycleRecord>({
			type: "lifecycle",
			step: this.step,
			turnIndex: this.turnIndex,
			sessionId: this.sessionId,
			phase,
			reason,
			restored,
			state: this.state,
		});
	}

	recordIntegrity(issue: IntegrityRecord["issue"], detail: string): void {
		this.emit<IntegrityRecord>({
			type: "integrity",
			step: this.step,
			turnIndex: this.turnIndex,
			sessionId: this.sessionId,
			issue,
			detail,
		});
	}

	/**
	 * Disable neuromodulation for the rest of the session after an internal error.
	 *
	 * A bug in the physiology must degrade to a plain Pi session, never to a broken one.
	 */
	fault(error: Error): void {
		if (this.faulted) return;
		this.faulted = true;
		this.recordIntegrity("internal_error", `${error.message}\n${error.stack ?? ""}`.slice(0, 2000));
		this.recordLifecycle("error", error.message);
	}

	// -----------------------------------------------------------------------
	// The causal chain
	// -----------------------------------------------------------------------

	/**
	 * Apply one appraised event.
	 *
	 * The single point at which physiological state changes. Nothing the model emits
	 * reaches this except as an event produced by deterministic appraisal.
	 */
	applyEvent(event: AppraisedEvent, toolCallId?: string): TransitionRecord {
		const mutate = this.appliesTransitions;
		this.step += 1;
		const transition = this.engine.transition(this._state, event, {
			step: this.step,
			turnIndex: this.turnIndex,
			toolCallId,
			mutate,
		});
		const previousPolicy = this._policy;
		if (mutate) this._state = transition.after;
		this._policy = this.adapter.derive(this._state);

		const record = this.emit<TransitionRecord>({
			type: "transition",
			step: this.step,
			turnIndex: this.turnIndex,
			sessionId: this.sessionId,
			event: {
				type: event.type,
				severity: event.severity,
				uncertainty: event.uncertainty,
				novelty: event.novelty,
				repeated: event.repeated,
				evidence: event.evidence,
			},
			stateBefore: transition.before,
			eventDelta: transition.delta,
			interactionDelta: transition.interactions,
			homeostasisDelta: transition.homeostasis,
			stateAfter: transition.after,
			policy: this.policy,
			reasons: transition.reasons,
			suppressed: transition.suppressed,
		});

		if (!policiesEqual(previousPolicy, this._policy)) {
			this.emit<PolicyChangeRecord>({
				type: "policy_change",
				step: this.step,
				turnIndex: this.turnIndex,
				sessionId: this.sessionId,
				from: previousPolicy,
				to: this.policy,
				changed: policyDiff(previousPolicy, this._policy),
				trigger: event.type,
			});
		}

		return record;
	}

	/**
	 * Observe a completed tool call: appraise it, then apply what it implies.
	 *
	 * Bookkeeping that enforcement depends on happens here — which files have been read
	 * since the last failure, and whether anything has failed at all.
	 */
	observeToolResult(outcome: ToolOutcome): ObservationResult {
		const beforePolicy = this._policy;
		const { events, bypass } = this.appraiser.appraise(outcome);

		this.emit<AppraisalRecord>({
			type: "appraisal",
			step: this.step,
			turnIndex: this.turnIndex,
			sessionId: this.sessionId,
			toolCallId: outcome.toolCallId,
			toolName: outcome.toolName,
			isError: outcome.isError,
			events: events.map((event) => ({ type: event.type, severity: event.severity })),
			fingerprint: events[0]?.evidence.fingerprint,
			repeatCount: events[0]?.evidence.repeatCount,
		});

		if (bypass) {
			this.emit<BypassRecord>({
				type: "bypass_suspected",
				step: this.step,
				turnIndex: this.turnIndex,
				sessionId: this.sessionId,
				toolCallId: outcome.toolCallId,
				command: bypass.command,
				constructs: bypass.constructs,
				// Blocking happens at tool_call time; by here the command has already run.
				blocked: false,
			});
		}

		this.updateInspectionBookkeeping(outcome, events);

		const transitions = events.map((event) => this.applyEvent(event, outcome.toolCallId));
		return { events, transitions, policyChanged: !policiesEqual(beforePolicy, this._policy) };
	}

	private updateInspectionBookkeeping(outcome: ToolOutcome, events: AppraisedEvent[]): void {
		const path = asString(outcome.input.path);
		if (!outcome.isError && (outcome.toolName === "read" || outcome.toolName === "grep") && path) {
			this.readSinceFailure.add(path);
		}
		const failed = events.some((event) => event.evidence.fingerprint !== undefined && event.type.endsWith("FAILURE"));
		if (failed) {
			this.hasFailed = true;
			// A failure invalidates prior reading: what was inspected before the failure is
			// not evidence about the state of the code after it.
			this.readSinceFailure.clear();
			for (const event of events) {
				for (const file of event.evidence.files ?? []) this.readSinceFailure.delete(file);
			}
		}
	}

	/**
	 * Decide whether a tool call may proceed.
	 *
	 * Returns a decision and never throws; the adapter still guards the call, because a
	 * throw inside Pi's `tool_call` handler blocks the tool — failing closed, which is
	 * exactly what must not happen.
	 */
	reviewToolCall(attempt: ToolAttempt): EnforcementDecision {
		if (!this.influencesAgent) return { block: false };

		const decision = this.enforcement.review(attempt, {
			policy: this._policy,
			detector: this.appraiser.detector,
			readSinceFailure: this.readSinceFailure,
			hasFailed: this.hasFailed,
			existingLineCount: this.existingLineCount,
		});

		if (decision.block || decision.relaxed) {
			this.emit<EnforcementRecord>({
				type: "enforcement",
				step: this.step,
				turnIndex: this.turnIndex,
				sessionId: this.sessionId,
				toolCallId: attempt.toolCallId,
				toolName: attempt.toolName,
				rule: decision.rule ?? "patchLimit",
				blocked: decision.block,
				relaxed: decision.relaxed ?? false,
				reason: decision.reason ?? "",
				detail: decision.detail,
				policy: this.policy,
			});
		}

		if (decision.block) {
			// A refusal is workload and a prompt to look elsewhere, not evidence that the
			// agent's hypothesis was wrong. It must never raise stress on its own.
			this.applyEvent(
				appraisedEvent({
					type: "POLICY_BLOCK",
					severity: 0.4,
					evidence: {
						source: "tool_call",
						toolName: attempt.toolName,
						toolCallId: attempt.toolCallId,
						detail: decision.rule,
					},
				}),
				attempt.toolCallId,
			);
		}

		return decision;
	}

	/**
	 * End a turn.
	 *
	 * Emits TICK, which is what supplies time-like decay without putting a clock into the
	 * maths — a session that idles still relaxes toward baseline, and replays stay exact.
	 */
	endTurn(turnIndex: number): TransitionRecord | undefined {
		this.turnIndex = turnIndex;
		if (!this.loaded.config.runtime.tickOnTurnEnd) return undefined;
		return this.applyEvent(appraisedEvent({ type: "TICK", evidence: { source: "turn" } }));
	}

	// -----------------------------------------------------------------------
	// Influence on the model
	// -----------------------------------------------------------------------

	/** Static preamble for the system prompt, or undefined when nothing should be said. */
	systemPromptAddendum(): string | undefined {
		return this.influencesAgent ? PROTOCOL_PREAMBLE : undefined;
	}

	/**
	 * The dynamic block appended to the message array before an LLM call.
	 *
	 * Returns undefined in observer and off modes — that is the whole of the control
	 * condition's non-influence, and it is asserted by test.
	 */
	contextBlock(): string | undefined {
		if (!this.influencesAgent) return undefined;
		return renderStateBlock({
			state: this._state,
			policy: this._policy,
			frozen: this.effectiveMode === "static",
			notes: this.activeNotes(),
		});
	}

	/** Short operational notes: conditions worth naming rather than leaving implicit. */
	private activeNotes(): string[] {
		const notes: string[] = [];
		if (this._policy.retryTolerance === 0) {
			notes.push("Retry limit is 0: any command that has already failed will be refused. Change approach.");
		}
		if (this._state.persistence < 0.3) {
			notes.push("The current strategy has not been working. Prefer a different explanation over another attempt.");
		}
		if (this._state.fatigue > 0.7) {
			notes.push("Session is long: summarize findings and converge rather than opening new lines of enquiry.");
		}
		return notes;
	}

	statusLine(): string {
		return summarizeForStatus(this._state, this._policy);
	}

	// -----------------------------------------------------------------------
	// Control
	// -----------------------------------------------------------------------

	/** Return to configured baselines. Always available to the user; never to the model. */
	reset(): void {
		this._state = this.engine.baseline();
		this._policy = this.adapter.derive(this._state);
		this.appraiser.detector.reset();
		this.enforcement.reset();
		this.readSinceFailure.clear();
		this.hasFailed = false;
		this.faulted = false;
		this.recordLifecycle("reset");
	}

	setEnabled(enabled: boolean): void {
		this._enabled = enabled;
		if (enabled) this.faulted = false;
		this.recordLifecycle(enabled ? "enabled" : "disabled");
	}

	setMode(mode: StasisMode): void {
		this._mode = mode;
	}

	history(limit = 20): TransitionRecord[] {
		return this.recorder
			.recent()
			.filter((record): record is TransitionRecord => record.type === "transition")
			.slice(-limit);
	}

	recentRecords(limit = 40): StasisTelemetryRecord[] {
		return this.recorder.recent(limit);
	}

	// -----------------------------------------------------------------------
	// Persistence
	// -----------------------------------------------------------------------

	snapshot(): StasisSnapshot {
		return {
			version: 1,
			state: this.state,
			step: this.step,
			turnIndex: this.turnIndex,
			configHash: this.loaded.hash,
			configVersion: this.loaded.config.version,
			profile: this.loaded.config.profile,
			mode: this._mode,
			enabled: this._enabled,
			detector: this.appraiser.detector.snapshot(),
			readSinceFailure: [...this.readSinceFailure],
			hasFailed: this.hasFailed,
		};
	}

	/**
	 * Restore a snapshot taken earlier in this session or a previous one.
	 *
	 * A config change between snapshot and restore is recorded rather than silently
	 * accepted: continuing a session under different physiology is legitimate, but a
	 * study must be able to see that it happened.
	 */
	restore(snapshot: StasisSnapshot | undefined): boolean {
		if (!snapshot || snapshot.version !== 1) return false;
		try {
			if (snapshot.configHash !== this.loaded.hash) {
				this.recordIntegrity(
					"config_changed",
					`snapshot was taken under config ${snapshot.configHash} (${snapshot.profile}); this session uses ${this.loaded.hash} (${this.loaded.config.profile})`,
				);
			}
			this._state = cloneState(snapshot.state);
			this._policy = this.adapter.derive(this._state);
			this.step = snapshot.step ?? 0;
			this.turnIndex = snapshot.turnIndex ?? 0;
			this.appraiser.detector.restore(snapshot.detector);
			this.readSinceFailure = new Set(snapshot.readSinceFailure ?? []);
			this.hasFailed = snapshot.hasFailed ?? false;
			this._enabled = snapshot.enabled ?? true;
			return true;
		} catch (error) {
			this.recordIntegrity("state_restore_failed", (error as Error).message);
			return false;
		}
	}
}
