/**
 * Telemetry record types.
 *
 * The requirement is that the entire behavioral chain be reconstructible offline:
 *
 *     environment event -> appraisal -> physiological change -> policy change -> action
 *
 * Every record therefore carries the identifiers needed to stitch it to its neighbours
 * (`step`, `turnIndex`, `toolCallId`), and the authoritative account of why the agent
 * behaved as it did lives here rather than in the model's self-report.
 *
 * JSONL, one record per line, append-only.
 */

import type { AppraisedEvent } from "../appraisal/events.ts";
import type { StasisConfig, StasisMode } from "../stasis/config.ts";
import type { TransitionReason } from "../stasis/engine.ts";
import type { StasisState, StasisStateDelta } from "../stasis/state.ts";
import type { EnforcementRule } from "../policy/enforcement.ts";
import type { AgentPolicy, PolicySnapshot } from "../policy/policy.ts";

export const TELEMETRY_SCHEMA_VERSION = 1;

interface RecordBase {
	schema: number;
	type: string;
	timestamp: string;
	step: number;
	turnIndex?: number;
	sessionId?: string;
}

/**
 * Written once per run. Everything needed to reproduce the physiology exactly and to
 * identify what the agent side of the run was.
 */
export interface RunHeaderRecord extends RecordBase {
	type: "run_header";
	extensionVersion: string;
	piVersion?: string;
	gitCommit?: string;
	mode: StasisMode;
	profile: string;
	configHash: string;
	configSources: string[];
	config: StasisConfig;
	initialState: StasisState;
	initialPolicy: PolicySnapshot;
	model?: { provider?: string; id?: string; thinkingLevel?: string };
	cwd?: string;
	condition?: string;
	trial?: number;
	task?: string;
	environment: { platform: string; nodeVersion: string };
}

/** One physiological transition, with every contribution attributed. */
export interface TransitionRecord extends RecordBase {
	type: "transition";
	event: {
		type: AppraisedEvent["type"];
		severity: number;
		uncertainty: number;
		novelty: number;
		repeated: boolean;
		evidence: AppraisedEvent["evidence"];
	};
	stateBefore: StasisState;
	eventDelta: StasisStateDelta;
	interactionDelta: StasisStateDelta;
	homeostasisDelta: StasisStateDelta;
	stateAfter: StasisState;
	policy: PolicySnapshot;
	reasons: TransitionReason[];
	/** True in observer mode: the transition was computed but not applied. */
	suppressed: boolean;
}

export interface PolicyChangeRecord extends RecordBase {
	type: "policy_change";
	from: PolicySnapshot;
	to: PolicySnapshot;
	changed: Partial<Record<keyof AgentPolicy, [number, number]>>;
	trigger: AppraisedEvent["type"];
}

export interface EnforcementRecord extends RecordBase {
	type: "enforcement";
	toolCallId: string;
	toolName: string;
	rule: EnforcementRule;
	blocked: boolean;
	/** True when a safety valve suppressed a block that would otherwise have applied. */
	relaxed: boolean;
	reason: string;
	detail?: Record<string, unknown>;
	policy: PolicySnapshot;
}

/**
 * A shell command shaped like file mutation.
 *
 * Pi has no sandbox, so an edit limit can be sidestepped through bash. Recording this
 * keeps the experiment honest: a run where the agent routed around enforcement is not
 * the same as one where it complied, and the analysis must be able to tell them apart.
 */
export interface BypassRecord extends RecordBase {
	type: "bypass_suspected";
	toolCallId: string;
	command: string;
	constructs: string[];
	blocked: boolean;
}

export interface AppraisalRecord extends RecordBase {
	type: "appraisal";
	toolCallId: string;
	toolName: string;
	isError: boolean;
	events: Array<{ type: AppraisedEvent["type"]; severity: number }>;
	fingerprint?: string;
	repeatCount?: number;
}

/** Session lifecycle, including whether state was restored and from where. */
export interface LifecycleRecord extends RecordBase {
	type: "lifecycle";
	phase: "session_start" | "session_resume" | "session_shutdown" | "reset" | "enabled" | "disabled" | "error";
	reason?: string;
	restored?: boolean;
	state?: StasisState;
}

/**
 * Configuration changed on disk mid-session, or an internal error forced a shutdown.
 *
 * Both are recorded rather than acted on: a study must be able to see that it ran on a
 * config different from the file now sitting in the repository.
 */
export interface IntegrityRecord extends RecordBase {
	type: "integrity";
	issue: "config_changed" | "internal_error" | "state_restore_failed";
	detail: string;
}

export type StasisTelemetryRecord =
	| RunHeaderRecord
	| TransitionRecord
	| PolicyChangeRecord
	| EnforcementRecord
	| BypassRecord
	| AppraisalRecord
	| LifecycleRecord
	| IntegrityRecord;

export function isTransitionRecord(record: StasisTelemetryRecord): record is TransitionRecord {
	return record.type === "transition";
}

export function isEnforcementRecord(record: StasisTelemetryRecord): record is EnforcementRecord {
	return record.type === "enforcement";
}

/** Parse a telemetry file, skipping malformed lines rather than failing the analysis. */
export function parseTelemetry(contents: string): StasisTelemetryRecord[] {
	const records: StasisTelemetryRecord[] = [];
	for (const line of contents.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			records.push(JSON.parse(trimmed) as StasisTelemetryRecord);
		} catch {
			// A truncated final line is expected if a run was killed mid-write.
		}
	}
	return records;
}
