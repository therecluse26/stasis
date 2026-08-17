/**
 * Repeated-failure detection.
 *
 * The central experimental feature. An agent stuck in a loop produces the same
 * unsuccessful outcome again and again while believing each attempt is new. Detecting
 * that deterministically is what lets persistence fall, novelty rise, and — eventually —
 * the policy refuse another identical attempt rather than permit an unbounded retry
 * loop.
 *
 * State is a bounded rolling window, serializable so it survives session resume.
 */

import type { AppraisalConfig } from "../stasis/config.ts";
import { clamp01 } from "../stasis/state.ts";
import type { CommandKind } from "./events.ts";

export interface FailureRecord {
	/** Identity of the failure: what was attempted *and* how it failed. */
	fingerprint: string;
	/** Identity of the attempt alone, ignoring the failure mode. */
	attempt: string;
	summary: string;
	kind: CommandKind;
	files: string[];
	step: number;
}

export interface RepetitionVerdict {
	/** How many times this exact failure has now been seen, including this one. */
	count: number;
	repeated: boolean;
	/** 0..1, saturating at `appraisal.repeatSaturation`. */
	severity: number;
	/** The same failure recurred after files it implicates were edited. */
	assumptionInvalidated: boolean;
	/** Files edited since the previous occurrence of this fingerprint. */
	changedSince: string[];
}

export interface FailureDetectorSnapshot {
	records: FailureRecord[];
	editedFiles: string[];
	lastFailureFingerprint?: string;
	lastAttemptFingerprint?: string;
	lastCommandKind?: CommandKind;
	strategyEpoch: number;
	repeatUnanswered?: boolean;
}

/**
 * Command families that carry a verdict about the code, and so can constitute a change of
 * approach.
 *
 * Inspection is pointedly not among them. Listing a directory between two identical test
 * runs satisfies the structural test — it is a different command family — but it is not a
 * change of approach, it is looking. Crediting it is worse than crediting nothing: it
 * spends the episode on the wrong action, leaving the real change of approach that follows
 * with no reward at all. Information-gathering already has its own event, INSPECTION.
 */
const VERDICT_KINDS = new Set<CommandKind>(["test", "build", "typecheck", "lint"]);

/**
 * Tracks recent failures and the edits between them.
 *
 * Deliberately not a general cache: the window is small and bounded, because the
 * question is always "is this happening *now*", not "has this ever happened".
 */
export class FailureDetector {
	private records: FailureRecord[] = [];
	/** Files edited since the last failure, used to judge whether anything actually changed. */
	private editedFiles = new Set<string>();
	private lastFailureFingerprint: string | undefined;
	private lastAttemptFingerprint: string | undefined;
	private lastCommandKind: CommandKind | undefined;
	/** Increments whenever a materially different approach is detected. */
	private strategyEpoch = 0;
	/**
	 * A repeated failure the agent has not yet answered by changing approach.
	 *
	 * Opens on a repeated failure, closes when the failing command family finally passes
	 * or when a change of approach is credited against it. Gating on this is what stops
	 * STRATEGY_CHANGE from firing continuously; see `creditStrategyChange`.
	 */
	private repeatUnanswered = false;

	constructor(private readonly config: AppraisalConfig) {}

	/** Note a file mutation, so the next failure can tell whether anything changed. */
	recordEdit(path: string): void {
		this.editedFiles.add(path);
	}

	get currentEpoch(): number {
		return this.strategyEpoch;
	}

	/**
	 * Record a failure and report whether it repeats a recent one.
	 *
	 * `assumptionInvalidated` is the sharper signal: the same failure recurring *after*
	 * the implicated files were edited means the agent's model of the problem is wrong,
	 * not merely that it has not finished yet.
	 */
	observeFailure(record: FailureRecord): RepetitionVerdict {
		const priorSameFailure = this.records.filter((r) => r.fingerprint === record.fingerprint);
		const count = priorSameFailure.length + 1;

		const changedSince = [...this.editedFiles];
		const touchedImplicated =
			record.files.length > 0 && changedSince.some((file) => record.files.some((f) => file.endsWith(f) || f.endsWith(file)));
		const assumptionInvalidated = count >= 2 && (touchedImplicated || (changedSince.length > 0 && record.files.length === 0));

		this.records.push(record);
		if (this.records.length > this.config.failureWindow) {
			this.records.splice(0, this.records.length - this.config.failureWindow);
		}
		this.lastFailureFingerprint = record.fingerprint;
		this.lastAttemptFingerprint = record.attempt;
		this.lastCommandKind = record.kind;
		// Edits are "spent" by the failure that judges them.
		this.editedFiles.clear();

		const threshold = this.config.repeatThreshold;
		const saturation = Math.max(this.config.repeatSaturation, threshold + 1);
		const severity = count < threshold ? 0 : clamp01((count - threshold) / (saturation - threshold));

		const repeated = count >= threshold;
		if (repeated) this.repeatUnanswered = true;

		return { count, repeated, severity, assumptionInvalidated, changedSince };
	}

	/** Clear the window after a success, so an old failure cannot haunt a fixed problem. */
	observeSuccess(kind: CommandKind): void {
		this.records = this.records.filter((record) => record.kind !== kind);
		this.editedFiles.clear();
		if (this.lastCommandKind === kind) this.lastFailureFingerprint = undefined;
		// The episode is only over once nothing is still failing. Judged on the window
		// rather than on this one success, because a passing `ls` says nothing about a
		// failing test suite.
		if (this.records.length === 0) this.repeatUnanswered = false;
	}

	/** How many times this exact failure appears in the window. */
	countOf(fingerprint: string): number {
		return this.records.filter((record) => record.fingerprint === fingerprint).length;
	}

	/** How many times this attempt was made, regardless of how it failed. */
	countOfAttempt(attempt: string): number {
		return this.records.filter((record) => record.attempt === attempt).length;
	}

	/**
	 * Would repeating this attempt exceed the policy's tolerance?
	 *
	 * Reports the *failure* count for the attempt, so a command that has since started
	 * succeeding does not count against the agent.
	 */
	failuresForAttempt(attempt: string): FailureRecord[] {
		return this.records.filter((record) => record.attempt === attempt);
	}

	/**
	 * Detect a materially different approach.
	 *
	 * Deliberately structural rather than semantic: a different command family, or a
	 * different failure signature, or edits to files not previously implicated. An LLM
	 * could judge this better, but non-determinism in appraisal would leak straight into
	 * the physiology, and the spec asks for deterministic logic wherever it will do.
	 */
	detectStrategyChange(attempt: string, kind: CommandKind, files: string[]): boolean {
		if (this.lastAttemptFingerprint === undefined) return false;
		const differentAttempt = attempt !== this.lastAttemptFingerprint;
		const differentKind = this.lastCommandKind !== undefined && kind !== this.lastCommandKind;
		const knownFiles = new Set(this.records.flatMap((record) => record.files));
		const newTerritory = files.length > 0 && files.every((file) => !knownFiles.has(file));
		const changed = (differentAttempt && this.records.length > 0) || differentKind || newTerritory;
		if (changed) this.strategyEpoch += 1;
		return changed;
	}

	/**
	 * Should a change of approach be credited to the physiology right now?
	 *
	 * The structural test above is far too eager to drive an event on its own: any command
	 * from another family satisfies `differentKind`, so after one failing `npm test` an
	 * intervening `ls` scores as a change of approach, and so does the next `npm test`.
	 * That matters because STRATEGY_CHANGE adds persistence (+0.10) while REPEATED_FAILURE
	 * removes it (−0.15) — ungated, the reward cancels the drain within two tool calls, the
	 * policy never tightens, and the loop this whole system exists to observe is neutralized
	 * by its own reward signal.
	 *
	 * So a change is credited only when it answers an outstanding repeated failure, and only
	 * once per episode. That is also the design's own claim: repeated failure drains
	 * persistence until the agent changes approach, and changing approach restores it.
	 */
	creditStrategyChange(attempt: string, kind: CommandKind, files: string[]): boolean {
		if (!this.repeatUnanswered) return false;
		if (!VERDICT_KINDS.has(kind)) return false;
		if (!this.detectStrategyChange(attempt, kind, files)) return false;
		this.repeatUnanswered = false;
		return true;
	}

	snapshot(): FailureDetectorSnapshot {
		return {
			records: this.records.map((record) => ({ ...record, files: [...record.files] })),
			editedFiles: [...this.editedFiles],
			lastFailureFingerprint: this.lastFailureFingerprint,
			lastAttemptFingerprint: this.lastAttemptFingerprint,
			lastCommandKind: this.lastCommandKind,
			strategyEpoch: this.strategyEpoch,
			repeatUnanswered: this.repeatUnanswered,
		};
	}

	restore(snapshot: FailureDetectorSnapshot | undefined): void {
		if (!snapshot) return;
		this.records = (snapshot.records ?? []).map((record) => ({ ...record, files: [...(record.files ?? [])] }));
		this.editedFiles = new Set(snapshot.editedFiles ?? []);
		this.lastFailureFingerprint = snapshot.lastFailureFingerprint;
		this.lastAttemptFingerprint = snapshot.lastAttemptFingerprint;
		this.lastCommandKind = snapshot.lastCommandKind;
		this.strategyEpoch = snapshot.strategyEpoch ?? 0;
		this.repeatUnanswered = snapshot.repeatUnanswered ?? false;
	}

	reset(): void {
		this.records = [];
		this.editedFiles.clear();
		this.lastFailureFingerprint = undefined;
		this.lastAttemptFingerprint = undefined;
		this.lastCommandKind = undefined;
		this.strategyEpoch = 0;
		this.repeatUnanswered = false;
	}
}
