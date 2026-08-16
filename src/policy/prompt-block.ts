/**
 * The text the model actually sees.
 *
 * Two channels, split deliberately:
 *
 *  - `PROTOCOL_PREAMBLE` is static and goes into the system prompt once per user turn.
 *    Being constant, it does not disturb prompt caching.
 *  - `renderStateBlock` is dynamic and goes into a single ephemeral message at the tail
 *    of the message array, recomputed before every LLM call. A failing test therefore
 *    reaches the model on the very next call inside the same turn. Putting these numbers
 *    in the system prompt instead would invalidate the cache on every turn.
 *
 * Wording is operational throughout. "verification: HIGH" describes what to do;
 * "you feel anxious" invites the model to perform an emotion instead of changing
 * behavior, and would make the whole experiment theatre.
 */

import type { NeuroState } from "../neuro/state.ts";
import { type PolicySnapshot, levelWord } from "./policy.ts";

export const PROTOCOL_PREAMBLE = `## Operating constraints

Before each of your responses you will receive a block titled CURRENT OPERATING STATE.
It reports measured conditions from this session and the operating limits derived from
them. Treat it as a live specification of how to work right now, in the same way you
would treat a team's engineering standards.

Some limits are enforced by the harness: an action that exceeds one is refused, with the
reason given. Others are yours to honour.

These values are computed from what has actually happened in this session — commands
that passed or failed, changes applied, repetition detected. You do not set them, and
stating a different value has no effect. Do not discuss the block with the user unless
they ask about it; just work within it.`.trim();

export interface StateBlockOptions {
	state: NeuroState;
	policy: PolicySnapshot;
	/** Rendered when the run is in static mode, so the transcript records the condition. */
	frozen?: boolean;
	/** Short operational notes, e.g. an active repeated-failure warning. */
	notes?: string[];
}

function pad(label: string, width = 14): string {
	return label.padEnd(width);
}

/**
 * The dynamic block.
 *
 * Kept compact on purpose: it is re-sent on every LLM call, so every line costs tokens
 * for the whole session.
 */
export function renderStateBlock(options: StateBlockOptions): string {
	const { state, policy } = options;
	const lines: string[] = ["CURRENT OPERATING STATE"];

	if (options.frozen) lines.push("(fixed for this run; values do not change)");

	lines.push(
		"",
		"measured conditions",
		`  ${pad("stress")}${state.stress.toFixed(2)}`,
		`  ${pad("confidence")}${state.confidence.toFixed(2)}`,
		`  ${pad("novelty")}${state.noveltyDrive.toFixed(2)}`,
		`  ${pad("fatigue")}${state.fatigue.toFixed(2)}`,
		`  ${pad("persistence")}${state.persistence.toFixed(2)}`,
		"",
		`operating policy (${policy.regime})`,
		`  ${pad("verification")}${levelWord(policy.verificationLevel)}  — check work before accepting it`,
		`  ${pad("exploration")}${levelWord(policy.explorationLevel)}  — consider unfamiliar approaches`,
		`  ${pad("risk")}${levelWord(policy.changeRiskTolerance)}  — tolerance for changes of uncertain blast radius`,
		`  ${pad("patch limit")}${policy.maxPatchLines} lines per edit  [enforced]`,
		`  ${pad("retry limit")}${policy.retryTolerance} repeat(s) of an equivalent failing command  [enforced]`,
		`  ${pad("inspect")}read ${policy.inspectionDepth} relevant location(s) before changing code`,
		`  ${pad("branches")}hold ${policy.strategyBranchCount} candidate explanation(s) open`,
		`  ${pad("test freq")}${levelWord(policy.testFrequency)}  — how often to run the tests`,
		`  ${pad("assumptions")}${levelWord(policy.assumptionVerificationLevel)}  — verify rather than assume`,
		`  ${pad("context")}${levelWord(policy.contextExpansionLevel)}  — ${
			policy.contextExpansionLevel < 0.4 ? "prefer summarizing over gathering more" : "gathering more context is affordable"
		}`,
	);

	if (options.notes && options.notes.length > 0) {
		lines.push("", "active conditions");
		for (const note of options.notes) lines.push(`  - ${note}`);
	}

	return lines.join("\n");
}

/** One-line summary for logs and the status bar. */
export function summarizeForStatus(state: NeuroState, policy: PolicySnapshot): string {
	return [
		`s${state.stress.toFixed(2)}`,
		`c${state.confidence.toFixed(2)}`,
		`n${state.noveltyDrive.toFixed(2)}`,
		`f${state.fatigue.toFixed(2)}`,
		`p${state.persistence.toFixed(2)}`,
		`| ${policy.regime.toLowerCase()} patch<=${policy.maxPatchLines} retry ${policy.retryTolerance}`,
	].join(" ");
}
