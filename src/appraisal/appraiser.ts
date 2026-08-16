/**
 * The appraisal engine: *what happened*, deliberately separate from *how physiology
 * responds*.
 *
 * This module decides only which events occurred and how severe, uncertain and novel
 * they were. It has no access to state and cannot change it. The event map in
 * configuration owns the physiological consequences, so the two can be reasoned about —
 * and re-tuned — independently.
 *
 * Appraisal is deterministic. No model call happens here. The interface leaves room for
 * a structured-output classifier for genuinely semantic judgments, but non-determinism
 * in appraisal would leak directly into the physiology, so the deterministic path is the
 * baseline rather than a fallback.
 */

import type { NeuroConfig } from "../neuro/config.ts";
import { clamp01 } from "../neuro/state.ts";
import {
	classifyBashOutcome,
	classifyCommand,
	detectMutationBypass,
	isTruncated,
	outcomeEventType,
} from "./command-classifier.ts";
import { type AppraisedEvent, appraisedEvent } from "./events.ts";
import { FailureDetector } from "./failure-detector.ts";
import { extractMentionedFiles, fingerprintAttempt, fingerprintFailure } from "./fingerprints.ts";

/**
 * A Pi-independent view of a completed tool call.
 *
 * The extension translates Pi's `ToolResultEvent` into this so appraisal — and its
 * tests — never depend on the harness.
 */
export interface ToolOutcome {
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
	/** Flattened text content of the result. */
	text: string;
	isError: boolean;
	details?: unknown;
	/** Lines changed, when the caller could compute it (edit and write calls). */
	changedLines?: number;
}

export interface AppraisalResult {
	events: AppraisedEvent[];
	/** Bypass suspicion for the enforcement layer to log. Never itself an event delta. */
	bypass?: { constructs: string[]; command: string };
}

export interface Appraiser {
	appraise(outcome: ToolOutcome): AppraisalResult;
	readonly detector: FailureDetector;
}

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Lines a set of edits would change, computed without touching the filesystem. */
export function editChangedLines(input: Record<string, unknown>): number {
	const edits = Array.isArray(input.edits) ? input.edits : [];
	let total = 0;
	for (const edit of edits) {
		if (!edit || typeof edit !== "object") continue;
		const oldText = asString((edit as Record<string, unknown>).oldText) ?? "";
		const newText = asString((edit as Record<string, unknown>).newText) ?? "";
		// Every line of the replaced block plus every line of its replacement. Counting
		// both sides matches how a reviewer reads a diff, and matches `+`/`-` counting on
		// the unified patch Pi produces after the fact.
		total += countLines(oldText) + countLines(newText);
	}
	// The legacy single-edit form Pi still accepts.
	if (edits.length === 0 && (input.oldText !== undefined || input.newText !== undefined)) {
		total += countLines(asString(input.oldText) ?? "") + countLines(asString(input.newText) ?? "");
	}
	return total;
}

export function countLines(text: string): number {
	if (text.length === 0) return 0;
	return text.split("\n").length;
}

/**
 * How severe a failure is, before the physiology sees it.
 *
 * Nominal is 0.5 by convention, so a first ordinary failure produces exactly the
 * configured delta. Repetition and breadth push it up.
 */
function failureSeverity(repeatCount: number, truncated: boolean): number {
	const base = 0.5;
	const repetition = Math.min(0.35, Math.max(0, repeatCount - 1) * 0.12);
	// A truncated failure is harder to reason about, not necessarily worse.
	return clamp01(base + repetition + (truncated ? 0.05 : 0));
}

export function createAppraiser(config: NeuroConfig, detector = new FailureDetector(config.appraisal)): Appraiser {
	let step = 0;

	function appraiseBash(outcome: ToolOutcome): AppraisalResult {
		const command = asString(outcome.input.command) ?? "";
		const kind = classifyCommand(command);
		const verdict = classifyBashOutcome(outcome.text, outcome.isError);
		const truncated = isTruncated(outcome.text);
		const events: AppraisedEvent[] = [];
		const bypassCheck = detectMutationBypass(command);

		const attempt = fingerprintAttempt("bash", command);

		if (!verdict.failed) {
			detector.observeSuccess(kind);
			events.push(
				appraisedEvent({
					type: outcomeEventType(kind, false),
					severity: 0.5,
					evidence: {
						source: "tool_result",
						toolName: "bash",
						toolCallId: outcome.toolCallId,
						command,
						commandKind: kind,
						exitCode: 0,
						fingerprint: attempt.hash,
						truncated,
					},
				}),
			);
			return { events, ...(bypassCheck.suspected ? { bypass: { constructs: bypassCheck.constructs, command } } : {}) };
		}

		// A command the harness refused never ran. It is not evidence about the code, so it
		// must not enter the failure window: counting it would let enforcement manufacture
		// the repeated failures that justify more enforcement.
		if (verdict.kind === "blocked") {
			return { events, ...(bypassCheck.suspected ? { bypass: { constructs: bypassCheck.constructs, command } } : {}) };
		}

		const files = extractMentionedFiles(outcome.text);
		const fingerprint = fingerprintFailure({
			toolName: "bash",
			command,
			errorText: outcome.text,
			exitCode: verdict.exitCode,
			maxErrorLines: config.appraisal.fingerprintErrorLines,
		});

		const repetition = detector.observeFailure({
			fingerprint: fingerprint.hash,
			attempt: attempt.hash,
			summary: fingerprint.summary,
			kind,
			files,
			step: ++step,
		});

		const evidence = {
			source: "tool_result" as const,
			toolName: "bash",
			toolCallId: outcome.toolCallId,
			command,
			commandKind: kind,
			exitCode: verdict.exitCode,
			files,
			fingerprint: fingerprint.hash,
			repeatCount: repetition.count,
			truncated,
			detail: fingerprint.summary,
		};

		events.push(
			appraisedEvent({
				type: outcomeEventType(kind, true),
				severity: failureSeverity(repetition.count, truncated),
				// A timed-out or unrecognized failure tells us less than a clean non-zero exit.
				uncertainty: verdict.kind === "exit" ? 0.2 : 0.6,
				repeated: repetition.repeated,
				evidence,
			}),
		);

		if (repetition.repeated) {
			events.push(
				appraisedEvent({
					type: "REPEATED_FAILURE",
					severity: clamp01(0.4 + repetition.severity * 0.6),
					uncertainty: 0.4,
					novelty: 0,
					repeated: true,
					evidence,
				}),
			);
		}

		if (repetition.assumptionInvalidated) {
			events.push(
				appraisedEvent({
					type: "ASSUMPTION_INVALIDATED",
					severity: clamp01(0.45 + repetition.severity * 0.4),
					uncertainty: 0.6,
					repeated: true,
					evidence: { ...evidence, detail: `unchanged failure after editing ${repetition.changedSince.length} file(s)` },
				}),
			);
		}

		return { events, ...(bypassCheck.suspected ? { bypass: { constructs: bypassCheck.constructs, command } } : {}) };
	}

	function appraiseMutation(outcome: ToolOutcome): AppraisalResult {
		const path = asString(outcome.input.path) ?? "";
		const events: AppraisedEvent[] = [];

		if (outcome.isError) {
			const fingerprint = fingerprintFailure({
				toolName: outcome.toolName,
				command: path,
				errorText: outcome.text,
				maxErrorLines: config.appraisal.fingerprintErrorLines,
			});
			const repetition = detector.observeFailure({
				fingerprint: fingerprint.hash,
				attempt: fingerprintAttempt(outcome.toolName, path).hash,
				summary: fingerprint.summary,
				kind: "other",
				files: path ? [path] : [],
				step: ++step,
			});
			events.push(
				appraisedEvent({
					type: "PATCH_REJECTED",
					severity: failureSeverity(repetition.count, false),
					uncertainty: 0.3,
					repeated: repetition.repeated,
					evidence: {
						source: "tool_result",
						toolName: outcome.toolName,
						toolCallId: outcome.toolCallId,
						files: path ? [path] : [],
						fingerprint: fingerprint.hash,
						repeatCount: repetition.count,
						detail: fingerprint.summary,
					},
				}),
			);
			return { events };
		}

		if (path) detector.recordEdit(path);
		const changedLines = outcome.changedLines ?? 0;
		events.push(
			appraisedEvent({
				type: "PATCH_APPLIED",
				severity: 0.5,
				evidence: {
					source: "tool_result",
					toolName: outcome.toolName,
					toolCallId: outcome.toolCallId,
					files: path ? [path] : [],
					changedLines,
				},
			}),
		);

		if (changedLines >= config.enforcement.largeChangeLines) {
			events.push(
				appraisedEvent({
					type: "LARGE_CHANGE",
					// Severity grows with how far past the threshold the change went.
					severity: clamp01(0.4 + (changedLines / config.enforcement.largeChangeLines - 1) * 0.3),
					evidence: {
						source: "tool_result",
						toolName: outcome.toolName,
						toolCallId: outcome.toolCallId,
						files: path ? [path] : [],
						changedLines,
					},
				}),
			);
		}

		return { events };
	}

	function appraiseRead(outcome: ToolOutcome): AppraisalResult {
		if (outcome.isError) {
			return {
				events: [
					appraisedEvent({
						type: "TOOL_ERROR",
						severity: 0.35,
						uncertainty: 0.3,
						evidence: {
							source: "tool_result",
							toolName: outcome.toolName,
							toolCallId: outcome.toolCallId,
							detail: outcome.text.slice(0, 200),
						},
					}),
				],
			};
		}
		// Inspection is what a cautious policy asks for; appraising it must never create
		// the pressure that demanded it.
		return {
			events: [
				appraisedEvent({
					type: "INSPECTION",
					severity: 0.5,
					evidence: {
						source: "tool_result",
						toolName: outcome.toolName,
						toolCallId: outcome.toolCallId,
						files: [asString(outcome.input.path) ?? ""].filter(Boolean),
					},
				}),
			],
		};
	}

	return {
		detector,
		appraise(outcome) {
			switch (outcome.toolName) {
				case "bash":
					return appraiseBash(outcome);
				case "edit":
				case "write":
					return appraiseMutation(outcome);
				case "read":
				case "grep":
				case "find":
				case "ls":
					return appraiseRead(outcome);
				default:
					// Unknown tools (including other extensions') still register as work done,
					// and as a tool error when they fail.
					return {
						events: [
							appraisedEvent({
								type: outcome.isError ? "TOOL_ERROR" : "INSPECTION",
								severity: 0.4,
								uncertainty: outcome.isError ? 0.4 : 0,
								evidence: {
									source: "tool_result",
									toolName: outcome.toolName,
									toolCallId: outcome.toolCallId,
								},
							}),
						],
					};
			}
		},
	};
}
