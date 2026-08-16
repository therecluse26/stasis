/**
 * The operating policy: physiological state translated into concrete constraints.
 *
 * Raw state is never exposed to any decision path on its own. Everything the extension
 * does — what it injects, what it blocks, what it displays — reads the policy, not the
 * state. That keeps behavior traceable to a small set of named, bounded quantities.
 */

export interface AgentPolicy {
	/** Hard ceiling on lines changed by a single edit or write. */
	maxPatchLines: number;
	/** 0..1 — how much checking is expected before accepting a result. */
	verificationLevel: number;
	/** 0..1 — willingness to try unfamiliar approaches. */
	explorationLevel: number;
	/** Number of files to read before committing to a change. */
	inspectionDepth: number;
	/** How many times an equivalent failing action may be repeated. */
	retryTolerance: number;
	/** How many alternative strategies to hold open at once. */
	strategyBranchCount: number;
	/** 0..1 — how hard to test assumptions rather than acting on them. */
	assumptionVerificationLevel: number;
	/** 0..1 — how often to run tests relative to making changes. */
	testFrequency: number;
	/** 0..1 — appetite for pulling more context in versus summarizing. */
	contextExpansionLevel: number;
	/** 0..1 — tolerance for changes whose blast radius is uncertain. */
	changeRiskTolerance: number;
}

/** Coarse label for display and for bucketing telemetry. Never feeds back into state. */
export type PolicyRegime = "CAUTIOUS" | "EXPLORATORY" | "CONVERGENT" | "DECISIVE";

export interface PolicySnapshot extends AgentPolicy {
	regime: PolicyRegime;
}

export const POLICY_FIELDS: ReadonlyArray<keyof AgentPolicy> = [
	"maxPatchLines",
	"verificationLevel",
	"explorationLevel",
	"inspectionDepth",
	"retryTolerance",
	"strategyBranchCount",
	"assumptionVerificationLevel",
	"testFrequency",
	"contextExpansionLevel",
	"changeRiskTolerance",
];

/** Fields expressed as a 0..1 level rather than a count. */
export const POLICY_LEVEL_FIELDS: ReadonlyArray<keyof AgentPolicy> = [
	"verificationLevel",
	"explorationLevel",
	"assumptionVerificationLevel",
	"testFrequency",
	"contextExpansionLevel",
	"changeRiskTolerance",
];

export function policiesEqual(a: AgentPolicy, b: AgentPolicy): boolean {
	return POLICY_FIELDS.every((field) => a[field] === b[field]);
}

export function policyDiff(a: AgentPolicy, b: AgentPolicy): Partial<Record<keyof AgentPolicy, [number, number]>> {
	const diff: Partial<Record<keyof AgentPolicy, [number, number]>> = {};
	for (const field of POLICY_FIELDS) {
		if (a[field] !== b[field]) diff[field] = [a[field], b[field]];
	}
	return diff;
}

/** Render a 0..1 level as a word, for prompt text that should read operationally. */
export function levelWord(value: number): "MINIMAL" | "LOW" | "MODERATE" | "HIGH" | "MAXIMAL" {
	if (value < 0.2) return "MINIMAL";
	if (value < 0.4) return "LOW";
	if (value < 0.6) return "MODERATE";
	if (value < 0.8) return "HIGH";
	return "MAXIMAL";
}
