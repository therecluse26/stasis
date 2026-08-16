/**
 * The event vocabulary shared by the appraisal engine and the neuromodulator engine.
 *
 * This module is deliberately dependency-free: it describes *what happened*, never
 * *how physiology responds*. The mapping from an event to a physiological delta lives
 * entirely in configuration (see `config/default.yaml`), and is applied by
 * `src/stasis/engine.ts`.
 */

export const AGENT_EVENT_TYPES = [
	"TEST_SUCCESS",
	"TEST_FAILURE",
	"REPEATED_FAILURE",
	"BUILD_SUCCESS",
	"BUILD_FAILURE",
	"LINT_SUCCESS",
	"LINT_FAILURE",
	"TYPECHECK_SUCCESS",
	"TYPECHECK_FAILURE",
	"PATCH_APPLIED",
	"PATCH_REJECTED",
	"REVERT",
	"STRATEGY_CHANGE",
	"ASSUMPTION_INVALIDATED",
	"TOOL_ERROR",
	"LARGE_CHANGE",
	"HIGH_UNCERTAINTY",
	"TASK_SUCCESS",
	"TASK_FAILURE",
	"INSPECTION",
	"POLICY_BLOCK",
	"TICK",
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(AGENT_EVENT_TYPES);

export function isAgentEventType(value: string): value is AgentEventType {
	return EVENT_TYPE_SET.has(value);
}

/** Deterministic classification of a shell command's purpose. */
export type CommandKind = "test" | "build" | "typecheck" | "lint" | "vcs" | "inspect" | "other";

/**
 * Provenance for an appraised event. Everything here is recorded in telemetry so the
 * chain `environment event -> appraisal -> physiological change -> policy change` can be
 * reconstructed offline without trusting the model's self-report.
 */
export interface EventEvidence {
	source: "tool_result" | "tool_call" | "turn" | "session" | "synthetic";
	toolName?: string;
	toolCallId?: string;
	command?: string;
	commandKind?: CommandKind;
	/** Recovered from bash output text; Pi does not expose exit codes structurally. */
	exitCode?: number | null;
	files?: string[];
	/** Normalized failure fingerprint, when the event describes a failure. */
	fingerprint?: string;
	/** How many times this fingerprint has been seen in the current window. */
	repeatCount?: number;
	changedLines?: number;
	truncated?: boolean;
	detail?: string;
}

/**
 * An event after appraisal: what happened, how bad, how uncertain, how novel.
 *
 * `severity` is normalized so that 0.5 is the nominal magnitude for the event type.
 * The configured event delta is the magnitude at severity 0.5; the engine scales it
 * between `severity.minScale` and `severity.maxScale`.
 */
export interface AppraisedEvent {
	type: AgentEventType;
	severity: number;
	uncertainty: number;
	novelty: number;
	repeated: boolean;
	evidence: EventEvidence;
}

export interface AppraisedEventInit {
	type: AgentEventType;
	severity?: number;
	uncertainty?: number;
	novelty?: number;
	repeated?: boolean;
	evidence?: Partial<EventEvidence>;
}

const unit = (value: number, fallback: number): number => {
	if (!Number.isFinite(value)) return fallback;
	return value < 0 ? 0 : value > 1 ? 1 : value;
};

/** Build a fully-populated event with normalized fields. Used by appraisers and tests. */
export function appraisedEvent(init: AppraisedEventInit): AppraisedEvent {
	return {
		type: init.type,
		severity: unit(init.severity ?? 0.5, 0.5),
		uncertainty: unit(init.uncertainty ?? 0, 0),
		novelty: unit(init.novelty ?? 0, 0),
		repeated: init.repeated ?? false,
		evidence: { source: "synthetic", ...init.evidence },
	};
}

/** Events that represent a confirmed negative outcome. Used for failure bookkeeping. */
export const FAILURE_EVENT_TYPES: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
	"TEST_FAILURE",
	"REPEATED_FAILURE",
	"BUILD_FAILURE",
	"LINT_FAILURE",
	"TYPECHECK_FAILURE",
	"PATCH_REJECTED",
	"TOOL_ERROR",
	"ASSUMPTION_INVALIDATED",
	"TASK_FAILURE",
]);

/** Events that represent a confirmed positive outcome. */
export const SUCCESS_EVENT_TYPES: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
	"TEST_SUCCESS",
	"BUILD_SUCCESS",
	"LINT_SUCCESS",
	"TYPECHECK_SUCCESS",
	"TASK_SUCCESS",
]);

export function isFailureEvent(type: AgentEventType): boolean {
	return FAILURE_EVENT_TYPES.has(type);
}

export function isSuccessEvent(type: AgentEventType): boolean {
	return SUCCESS_EVENT_TYPES.has(type);
}
