/**
 * Level-3 enforcement: policy applied in code, not merely suggested in prose.
 *
 * Three rules, all deterministic and all logged:
 *
 *  - **patch limit**   an edit or write larger than `maxPatchLines` is refused
 *  - **retry limit**   a command that has already failed identically more than
 *                      `retryTolerance` times is refused
 *  - **verification**  a mutation to a file not read since the last failure is refused
 *                      once, when verification is running high
 *
 * Safety valves are not optional decoration; they are what makes hard enforcement safe
 * to run unattended:
 *
 *  - at most `maxConsecutiveBlocks` refusals in a row, then the next call passes and the
 *    relaxation is recorded
 *  - never two refusals for the same reason on the same tool call
 *  - the caller wraps every entry point so an internal error fails *open*
 *
 * An agent that cannot act is worse than an agent acting imperfectly, and a bug in this
 * file must never be able to wedge the host.
 */

import type { NeuroConfig } from "../neuro/config.ts";
import { countLines, editChangedLines } from "../appraisal/appraiser.ts";
import { detectMutationBypass } from "../appraisal/command-classifier.ts";
import type { FailureDetector } from "../appraisal/failure-detector.ts";
import { fingerprintAttempt } from "../appraisal/fingerprints.ts";
import type { PolicySnapshot } from "./policy.ts";

export type EnforcementRule = "patchLimit" | "retryLimit" | "verificationGate" | "bashGuard";

export interface ToolAttempt {
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
}

export interface EnforcementDecision {
	block: boolean;
	rule?: EnforcementRule;
	reason?: string;
	/** Set when a block was suppressed by a safety valve; recorded in telemetry. */
	relaxed?: boolean;
	/** Structured detail for telemetry. */
	detail?: Record<string, unknown>;
}

const ALLOW: EnforcementDecision = { block: false };

export interface EnforcementContext {
	policy: PolicySnapshot;
	detector: FailureDetector;
	/** Files read since the last failure, for the verification gate. */
	readSinceFailure: ReadonlySet<string>;
	/** True once at least one failure has been seen; the gate is meaningless before that. */
	hasFailed: boolean;
	/** Size on disk, when the caller could determine it (used for `write`). */
	existingLineCount?: (path: string) => number | undefined;
}

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * Refusal text.
 *
 * Written to be actionable rather than negotiable: it states the limit, what was
 * attempted, and the specific next step that would work. It does not invite the model to
 * argue about the policy, and it never implies the limit can be changed by asking.
 */
function explain(rule: EnforcementRule, body: string): string {
	return `BLOCKED_BY_NEURO_POLICY (${rule})\n\n${body}`;
}

export class Enforcement {
	private consecutiveBlocks = 0;
	/** Reasons already used for a given tool call, so one call is never blocked twice alike. */
	private blockedReasons = new Map<string, Set<EnforcementRule>>();

	constructor(private readonly config: NeuroConfig) {}

	get consecutive(): number {
		return this.consecutiveBlocks;
	}

	/** Called when a tool call is allowed through, ending any run of refusals. */
	noteAllowed(): void {
		this.consecutiveBlocks = 0;
	}

	reset(): void {
		this.consecutiveBlocks = 0;
		this.blockedReasons.clear();
	}

	/**
	 * Evaluate a tool call against the current policy.
	 *
	 * Returns a decision; it never throws. The caller still wraps it, because a throw
	 * inside Pi's `tool_call` handler blocks the tool — the opposite of failing open.
	 */
	review(attempt: ToolAttempt, context: EnforcementContext): EnforcementDecision {
		const enforcement = this.config.enforcement;
		if (!enforcement.enabled) return ALLOW;

		const decision = this.evaluate(attempt, context);
		if (!decision.block) {
			this.noteAllowed();
			return decision;
		}

		// Safety valve 1: never refuse the same call twice for the same reason.
		const already = this.blockedReasons.get(attempt.toolCallId);
		if (decision.rule && already?.has(decision.rule)) {
			this.consecutiveBlocks = 0;
			return { ...decision, block: false, relaxed: true, reason: "already blocked for this reason" };
		}

		// Safety valve 2: never refuse more than N calls in a row.
		if (this.consecutiveBlocks >= enforcement.maxConsecutiveBlocks) {
			this.consecutiveBlocks = 0;
			return {
				...decision,
				block: false,
				relaxed: true,
				reason: `relaxed after ${enforcement.maxConsecutiveBlocks} consecutive blocks`,
			};
		}

		this.consecutiveBlocks += 1;
		if (decision.rule) {
			const reasons = already ?? new Set<EnforcementRule>();
			reasons.add(decision.rule);
			this.blockedReasons.set(attempt.toolCallId, reasons);
		}
		return decision;
	}

	private evaluate(attempt: ToolAttempt, context: EnforcementContext): EnforcementDecision {
		const enforcement = this.config.enforcement;
		const { policy } = context;

		if (attempt.toolName === "edit" || attempt.toolName === "write") {
			if (enforcement.patchLimit) {
				const patch = this.reviewPatchSize(attempt, context);
				if (patch.block) return patch;
			}
			if (enforcement.verificationGate) {
				const gate = this.reviewVerification(attempt, context);
				if (gate.block) return gate;
			}
			return ALLOW;
		}

		if (attempt.toolName === "bash") {
			const command = asString(attempt.input.command) ?? "";
			if (enforcement.retryLimit) {
				const retry = this.reviewRetry(command, policy, context);
				if (retry.block) return retry;
			}
			if (enforcement.guardBash) {
				const bypass = detectMutationBypass(command);
				if (bypass.suspected) {
					return {
						block: true,
						rule: "bashGuard",
						reason: explain(
							"bashGuard",
							`This command writes files through the shell (${bypass.constructs.join(", ")}), which would sidestep the edit limits in force.\n\nUse the edit or write tool for file changes. Shell commands are for running builds, tests and inspection.`,
						),
						detail: { constructs: bypass.constructs, command },
					};
				}
			}
			return ALLOW;
		}

		return ALLOW;
	}

	private reviewPatchSize(attempt: ToolAttempt, context: EnforcementContext): EnforcementDecision {
		const limit = context.policy.maxPatchLines;
		const path = asString(attempt.input.path) ?? "(unknown)";

		let changed: number;
		if (attempt.toolName === "edit") {
			changed = editChangedLines(attempt.input);
		} else {
			const content = asString(attempt.input.content) ?? "";
			const incoming = countLines(content);
			const existing = context.existingLineCount?.(path);
			// A write replaces the whole file, so the change is what goes in plus whatever it
			// displaces. For a new file there is nothing displaced.
			changed = incoming + (existing ?? 0);
		}

		if (changed <= limit) return ALLOW;

		return {
			block: true,
			rule: "patchLimit",
			reason: explain(
				"patchLimit",
				`This change touches about ${changed} lines of ${path}. The limit in force is ${limit}.\n\nMake the smallest change that tests the current hypothesis, verify it, then continue. If the work genuinely needs to be larger, split it into separate edits that can each be checked.`,
			),
			detail: { path, changedLines: changed, limit, tool: attempt.toolName },
		};
	}

	private reviewRetry(command: string, policy: PolicySnapshot, context: EnforcementContext): EnforcementDecision {
		if (!command) return ALLOW;
		const attempt = fingerprintAttempt("bash", command);
		const failures = context.detector.failuresForAttempt(attempt.hash);
		if (failures.length <= policy.retryTolerance) return ALLOW;

		const last = failures.at(-1);
		return {
			block: true,
			rule: "retryLimit",
			reason: explain(
				"retryLimit",
				`This command has already failed ${failures.length} time(s) in this session with the same result, and the retry limit in force is ${policy.retryTolerance}.\n\nLast failure: ${last?.summary ?? "unknown"}\n\nRunning it again unchanged will produce the same output. Change something first: inspect a different part of the system, test a different explanation, or widen the diagnosis. If you need this command's output for a genuinely new reason, say what changed.`,
			),
			detail: { command, failures: failures.length, tolerance: policy.retryTolerance, fingerprint: attempt.hash },
		};
	}

	/**
	 * Require inspection before mutating, when verification is running high.
	 *
	 * Only applies after something has actually failed — before the first failure there
	 * is no reason to demand evidence-gathering, and doing so would just tax normal work.
	 */
	private reviewVerification(attempt: ToolAttempt, context: EnforcementContext): EnforcementDecision {
		if (!context.hasFailed) return ALLOW;
		const threshold = this.config.policy.regime.cautiousVerification;
		if (context.policy.verificationLevel < threshold) return ALLOW;

		const path = asString(attempt.input.path);
		if (!path) return ALLOW;
		if (context.readSinceFailure.has(path)) return ALLOW;
		// Creating a new file cannot have been read first.
		if (attempt.toolName === "write" && context.existingLineCount?.(path) === undefined) return ALLOW;

		return {
			block: true,
			rule: "verificationGate",
			reason: explain(
				"verificationGate",
				`Verification is at ${context.policy.verificationLevel.toFixed(2)} following a failure, and ${path} has not been read since.\n\nRead it first, then make the change. Editing a file whose current contents you have not seen since the last failure is how a fix gets applied to the wrong version of the problem.`,
			),
			detail: { path, verificationLevel: context.policy.verificationLevel },
		};
	}
}
