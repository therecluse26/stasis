/**
 * Configuration schema, defaults, loading, validation and hashing.
 *
 * Design rule from the spec: no magic constants scattered through the codebase. Every
 * number that shapes physiological or policy behavior is declared here and supplied by
 * YAML, so experiments are run by editing configuration rather than source.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { AGENT_EVENT_TYPES, type AgentEventType } from "../appraisal/events.ts";
import { STASIS_VARIABLES, type StasisState, type StasisStateDelta, type StasisVariable } from "./state.ts";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface StasisVariableConfig {
	baseline: number;
	decayRate: number;
	min: number;
	max: number;
	maxDeltaPerEvent: number;
}

/** Scales a configured event delta by the event's appraised severity. */
export interface SeverityConfig {
	enabled: boolean;
	/** Scale applied at severity 0. */
	minScale: number;
	/** Scale applied at severity 1. Severity 0.5 always yields exactly 1.0. */
	maxScale: number;
}

/**
 * Continuous modulators applied on top of the discrete event delta, scaled by the
 * event's `uncertainty` and `novelty` fields.
 */
export interface ModulatorConfig {
	uncertainty: StasisStateDelta;
	novelty: StasisStateDelta;
}

export type InteractionDirection = "above" | "below";

/**
 * A cross-variable coupling term. Activation is computed from the *pre-transition*
 * state only, which makes the set of interactions order-independent and therefore
 * deterministic regardless of declaration order.
 */
export interface InteractionRule {
	id: string;
	source: StasisVariable;
	target: StasisVariable;
	/**
	 * How far this rule may shift its target's resting point, signed, at full activation.
	 *
	 * Strength is stated *relative to the target's own restoring force* rather than as a
	 * raw per-step amount. A variable pushed continuously by `a` per transition against
	 * decay `d` settles at `baseline + a/d`, so the engine computes the per-step
	 * contribution as `displacement * decayRate(target)`. Two consequences make this the
	 * right representation: the number is self-describing (0.25 means "shifts where this
	 * variable rests by a quarter of its range"), and a profile that changes a decay rate
	 * cannot silently turn a gentle coupling into one that pins its target at a bound.
	 */
	displacement: number;
	threshold: number;
	direction: InteractionDirection;
	description?: string;
}

export interface InteractionsConfig {
	/** Ceiling on any single rule's displacement. */
	maxDisplacementPerRule: number;
	/** Ceiling on the summed displacement acting on one variable; enforced at runtime. */
	maxDisplacementPerTarget: number;
	rules: InteractionRule[];
}

/**
 * A policy field derived from state by a bounded linear form.
 *
 * `unit = clamp01(intercept + sum(terms[v] * state[v]))`, then mapped onto [min,max]
 * and optionally rounded. Keeping every field in this one shape makes the whole policy
 * layer trivially testable and lets sign constraints be validated automatically.
 */
export interface PolicyFieldConfig {
	min: number;
	max: number;
	round: boolean;
	intercept: number;
	terms: Partial<Record<StasisVariable, number>>;
}

export type PolicyFieldName =
	| "maxPatchLines"
	| "verificationLevel"
	| "explorationLevel"
	| "inspectionDepth"
	| "retryTolerance"
	| "strategyBranchCount"
	| "assumptionVerificationLevel"
	| "testFrequency"
	| "contextExpansionLevel"
	| "changeRiskTolerance";

export const POLICY_FIELD_NAMES: readonly PolicyFieldName[] = [
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

export interface PolicyRegimeConfig {
	/** verificationLevel at or above this reads as cautious. */
	cautiousVerification: number;
	/** explorationLevel at or above this reads as exploratory. */
	exploratoryExploration: number;
}

export interface PolicyConfig {
	fields: Record<PolicyFieldName, PolicyFieldConfig>;
	regime: PolicyRegimeConfig;
}

export interface EnforcementConfig {
	/** Master switch for level-3 hard enforcement. */
	enabled: boolean;
	patchLimit: boolean;
	retryLimit: boolean;
	verificationGate: boolean;
	/** After this many consecutive blocks the next call is allowed through, and logged. */
	maxConsecutiveBlocks: number;
	/** Upgrade suspected bash bypasses from "log" to "block". */
	guardBash: boolean;
	/** Treat an edit/write touching at least this many lines as LARGE_CHANGE. */
	largeChangeLines: number;
}

export interface AppraisalConfig {
	/** Number of recent outcomes retained for repetition detection. */
	failureWindow: number;
	/** Repeat count at which REPEATED_FAILURE begins to be emitted. */
	repeatThreshold: number;
	/** Repeat count at which REPEATED_FAILURE severity saturates at 1.0. */
	repeatSaturation: number;
	/** Distinctive error lines retained when building a failure fingerprint. */
	fingerprintErrorLines: number;
}

export type StasisMode = "active" | "static" | "observer" | "off";
export type DisplayMode = "panel" | "status" | "off";

export interface RuntimeConfig {
	/**
	 * active   - full dynamics: state transitions, injection and enforcement
	 * static   - injection and enforcement at frozen baseline state (isolates dynamics)
	 * observer - appraise and record only; zero behavioral influence
	 * off      - extension inert
	 */
	mode: StasisMode;
	display: DisplayMode;
	/** Directory for telemetry JSONL, relative to cwd unless absolute. */
	telemetryDir: string;
	telemetryEnabled: boolean;
	/** Emit a TICK event at the end of every turn, giving time-like decay. */
	tickOnTurnEnd: boolean;
	/** Number of transitions retained in memory for `/stasis history`. */
	historyLimit: number;
}

export interface StasisConfig {
	version: string;
	profile: string;
	variables: Record<StasisVariable, StasisVariableConfig>;
	events: Partial<Record<AgentEventType, StasisStateDelta>>;
	severity: SeverityConfig;
	modulators: ModulatorConfig;
	interactions: InteractionsConfig;
	policy: PolicyConfig;
	enforcement: EnforcementConfig;
	appraisal: AppraisalConfig;
	runtime: RuntimeConfig;
}

/** A config plus the hash of its normalized form, recorded in every telemetry header. */
export interface LoadedConfig {
	config: StasisConfig;
	hash: string;
	sources: string[];
}

// ---------------------------------------------------------------------------
// Baseline state
// ---------------------------------------------------------------------------

export function baselineState(config: StasisConfig): StasisState {
	return {
		stress: config.variables.stress.baseline,
		confidence: config.variables.confidence.baseline,
		noveltyDrive: config.variables.noveltyDrive.baseline,
		fatigue: config.variables.fatigue.baseline,
		persistence: config.variables.persistence.baseline,
	};
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export class StasisConfigError extends Error {
	readonly issues: string[];

	constructor(message: string, issues: string[]) {
		super(issues.length > 0 ? `${message}\n  - ${issues.join("\n  - ")}` : message);
		this.name = "StasisConfigError";
		this.issues = issues;
	}
}

type PlainObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Deep merge for configuration overlays. Arrays replace wholesale rather than
 * concatenating — a profile that declares `interactions.rules` means exactly those
 * rules, not the defaults plus more.
 */
function mergeDeep<T>(base: T, overlay: unknown): T {
	if (!isPlainObject(overlay)) return (overlay === undefined ? base : (overlay as T));
	if (!isPlainObject(base)) return overlay as unknown as T;
	const out: PlainObject = { ...base };
	for (const [key, value] of Object.entries(overlay)) {
		if (value === undefined) continue;
		out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeDeep(out[key], value) : value;
	}
	return out as T;
}

export function parseConfigSource(text: string, label: string): PlainObject {
	let parsed: unknown;
	try {
		parsed = parseYaml(text);
	} catch (error) {
		throw new StasisConfigError(`Could not parse ${label}`, [String(error)]);
	}
	if (parsed === null || parsed === undefined) return {};
	if (!isPlainObject(parsed)) {
		throw new StasisConfigError(`Could not parse ${label}`, ["top level must be a mapping"]);
	}
	return parsed;
}

/**
 * Stable stringify so the config hash depends on content, not key order or formatting.
 */
function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (isPlainObject(value)) {
		const out: PlainObject = {};
		for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
		return out;
	}
	return value;
}

export function hashConfig(config: StasisConfig): string {
	return createHash("sha256").update(JSON.stringify(canonicalize(config))).digest("hex").slice(0, 16);
}

/** Merge overlays onto the built-in defaults, validate, and hash. */
export function buildConfig(overlays: Array<{ label: string; data: unknown }> = []): LoadedConfig {
	// Clone so callers can never mutate the shared defaults through a returned config.
	let config = structuredClone(DEFAULT_CONFIG) as StasisConfig;
	const sources = ["builtin:default"];
	for (const overlay of overlays) {
		config = mergeDeep(config, overlay.data);
		sources.push(overlay.label);
	}
	const issues = validateConfig(config);
	if (issues.length > 0) throw new StasisConfigError("Invalid stasis configuration", issues);
	return { config, hash: hashConfig(config), sources };
}

export function loadConfigFromFiles(paths: string[]): LoadedConfig {
	const overlays = paths.map((path) => ({
		label: path,
		data: parseConfigSource(readFileSync(path, "utf8"), path),
	}));
	return buildConfig(overlays);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Structural and semantic validation. The sign constraints are the interesting part:
 * they encode the spec's behavioral requirements (high stress must not permit larger
 * patches; low persistence must not raise retry tolerance) directly into config
 * validation, so a flipped sign in YAML fails loudly instead of silently inverting
 * the experiment.
 */
export const POLICY_SIGN_CONSTRAINTS: ReadonlyArray<{
	field: PolicyFieldName;
	variable: StasisVariable;
	sign: "negative" | "positive";
	rationale: string;
}> = [
	{
		field: "maxPatchLines",
		variable: "stress",
		sign: "negative",
		rationale: "high stress must reduce allowed patch size",
	},
	{
		field: "verificationLevel",
		variable: "stress",
		sign: "positive",
		rationale: "high stress must increase verification",
	},
	{
		field: "verificationLevel",
		variable: "confidence",
		sign: "negative",
		rationale: "confidence reduces redundant checking",
	},
	{
		field: "retryTolerance",
		variable: "persistence",
		sign: "positive",
		rationale: "low persistence must lower retry tolerance",
	},
	{
		field: "strategyBranchCount",
		variable: "fatigue",
		sign: "negative",
		rationale: "fatigue must reduce branching",
	},
	{
		field: "contextExpansionLevel",
		variable: "fatigue",
		sign: "negative",
		rationale: "fatigue must encourage context compression",
	},
	{
		field: "explorationLevel",
		variable: "noveltyDrive",
		sign: "positive",
		rationale: "novelty drive must increase exploration",
	},
	{
		field: "changeRiskTolerance",
		variable: "stress",
		sign: "negative",
		rationale: "stress must reduce risk tolerance",
	},
];

export function validateConfig(config: StasisConfig): string[] {
	const issues: string[] = [];
	const finite = (value: unknown, path: string): value is number => {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			issues.push(`${path} must be a finite number`);
			return false;
		}
		return true;
	};

	if (typeof config.version !== "string" || config.version.length === 0) {
		issues.push("version must be a non-empty string");
	}

	for (const variable of STASIS_VARIABLES) {
		const spec = config.variables?.[variable];
		const path = `variables.${variable}`;
		if (!spec) {
			issues.push(`${path} is missing`);
			continue;
		}
		if (finite(spec.min, `${path}.min`) && finite(spec.max, `${path}.max`) && spec.min >= spec.max) {
			issues.push(`${path}.min must be less than ${path}.max`);
		}
		if (finite(spec.baseline, `${path}.baseline`) && (spec.baseline < spec.min || spec.baseline > spec.max)) {
			issues.push(`${path}.baseline must lie within [${spec.min}, ${spec.max}]`);
		}
		if (finite(spec.decayRate, `${path}.decayRate`) && (spec.decayRate < 0 || spec.decayRate > 1)) {
			issues.push(`${path}.decayRate must lie within [0, 1]`);
		}
		if (finite(spec.maxDeltaPerEvent, `${path}.maxDeltaPerEvent`) && spec.maxDeltaPerEvent <= 0) {
			issues.push(`${path}.maxDeltaPerEvent must be greater than 0`);
		}
		if (spec.min < 0 || spec.max > 1) {
			issues.push(`${path} bounds must stay within [0, 1]`);
		}
	}

	for (const [type, delta] of Object.entries(config.events ?? {})) {
		if (!(AGENT_EVENT_TYPES as readonly string[]).includes(type)) {
			issues.push(`events.${type} is not a known event type`);
			continue;
		}
		for (const [variable, amount] of Object.entries(delta ?? {})) {
			if (!(STASIS_VARIABLES as readonly string[]).includes(variable)) {
				issues.push(`events.${type}.${variable} is not a known variable`);
				continue;
			}
			finite(amount, `events.${type}.${variable}`);
		}
	}

	if (config.severity) {
		finite(config.severity.minScale, "severity.minScale");
		finite(config.severity.maxScale, "severity.maxScale");
		if (config.severity.minScale < 0) issues.push("severity.minScale must not be negative");
		if (config.severity.maxScale < config.severity.minScale) {
			issues.push("severity.maxScale must be at least severity.minScale");
		}
	} else {
		issues.push("severity is missing");
	}

	const seenRuleIds = new Set<string>();
	for (const rule of config.interactions?.rules ?? []) {
		const path = `interactions.rules.${rule.id ?? "<unnamed>"}`;
		if (!rule.id) issues.push(`${path} requires an id`);
		else if (seenRuleIds.has(rule.id)) issues.push(`${path} has a duplicate id`);
		else seenRuleIds.add(rule.id);
		if (!(STASIS_VARIABLES as readonly string[]).includes(rule.source)) issues.push(`${path}.source is unknown`);
		if (!(STASIS_VARIABLES as readonly string[]).includes(rule.target)) issues.push(`${path}.target is unknown`);
		if (rule.direction !== "above" && rule.direction !== "below") {
			issues.push(`${path}.direction must be "above" or "below"`);
		}
		if (finite(rule.threshold, `${path}.threshold`) && (rule.threshold <= 0 || rule.threshold >= 1)) {
			issues.push(`${path}.threshold must lie strictly within (0, 1)`);
		}
		if ("gain" in (rule as object)) {
			issues.push(
				`${path}.gain is no longer supported; use displacement, which states strength relative to the target's restoring force`,
			);
		}
		finite(rule.displacement, `${path}.displacement`);
	}
	for (const key of ["maxDisplacementPerRule", "maxDisplacementPerTarget"] as const) {
		const value = config.interactions?.[key];
		if (finite(value, `interactions.${key}`) && (value <= 0 || value > 1)) {
			issues.push(`interactions.${key} must lie within (0, 1]`);
		}
	}

	issues.push(...validateDynamics(config));

	for (const field of POLICY_FIELD_NAMES) {
		const spec = config.policy?.fields?.[field];
		const path = `policy.fields.${field}`;
		if (!spec) {
			issues.push(`${path} is missing`);
			continue;
		}
		if (finite(spec.min, `${path}.min`) && finite(spec.max, `${path}.max`) && spec.min > spec.max) {
			issues.push(`${path}.min must not exceed ${path}.max`);
		}
		finite(spec.intercept, `${path}.intercept`);
		for (const [variable, coefficient] of Object.entries(spec.terms ?? {})) {
			if (!(STASIS_VARIABLES as readonly string[]).includes(variable)) {
				issues.push(`${path}.terms.${variable} is not a known variable`);
				continue;
			}
			finite(coefficient, `${path}.terms.${variable}`);
		}
	}

	for (const constraint of POLICY_SIGN_CONSTRAINTS) {
		const coefficient = config.policy?.fields?.[constraint.field]?.terms?.[constraint.variable];
		if (coefficient === undefined) {
			issues.push(
				`policy.fields.${constraint.field}.terms.${constraint.variable} is required (${constraint.rationale})`,
			);
			continue;
		}
		const ok = constraint.sign === "negative" ? coefficient < 0 : coefficient > 0;
		if (!ok) {
			issues.push(
				`policy.fields.${constraint.field}.terms.${constraint.variable} must be ${constraint.sign} (${constraint.rationale})`,
			);
		}
	}

	const mode = config.runtime?.mode;
	if (mode !== "active" && mode !== "static" && mode !== "observer" && mode !== "off") {
		issues.push('runtime.mode must be one of "active", "static", "observer", "off"');
	}
	const display = config.runtime?.display;
	if (display !== "panel" && display !== "status" && display !== "off") {
		issues.push('runtime.display must be one of "panel", "status", "off"');
	}
	if (config.enforcement && config.enforcement.maxConsecutiveBlocks < 1) {
		issues.push("enforcement.maxConsecutiveBlocks must be at least 1");
	}
	if (config.appraisal) {
		if (config.appraisal.repeatThreshold < 2) issues.push("appraisal.repeatThreshold must be at least 2");
		if (config.appraisal.repeatSaturation < config.appraisal.repeatThreshold) {
			issues.push("appraisal.repeatSaturation must be at least appraisal.repeatThreshold");
		}
		if (config.appraisal.failureWindow < 1) issues.push("appraisal.failureWindow must be at least 1");
	}

	return issues;
}

/**
 * Guard against pathological dynamics that structural validation would otherwise miss.
 *
 * Both checks compare a *sustained* forcing term against the restoring force that
 * opposes it. A variable pushed continuously by `amount` per transition against decay
 * `d` settles at `baseline + amount/d`. When that displacement approaches 1 the
 * variable pins at a bound and stops carrying information — fatigue crushing
 * persistence to zero purely because turns elapsed, for instance, which is precisely
 * the "fatigue simply makes the model worse" failure the design forbids.
 *
 * These are load-time errors rather than runtime clamps: a study should fail to start
 * rather than quietly run on a physiology that saturates.
 */
export function validateDynamics(config: StasisConfig): string[] {
	const issues: string[] = [];
	const interactions = config.interactions;
	if (!interactions?.rules) return issues;

	const limit = interactions.maxDisplacementPerRule;
	if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
		issues.push("interactions.maxDisplacementPerRule must be a positive number");
		return issues;
	}

	for (const rule of interactions.rules) {
		const target = config.variables?.[rule.target];
		if (!target || typeof rule.displacement !== "number") continue;
		if (target.decayRate <= 0) {
			issues.push(
				`interactions.rules.${rule.id} targets ${rule.target}, which has no restoring force (decayRate 0); the coupling would accumulate without bound`,
			);
			continue;
		}
		if (Math.abs(rule.displacement) > limit) {
			issues.push(
				`interactions.rules.${rule.id} would shift ${rule.target}'s resting point by ${Math.abs(rule.displacement).toFixed(2)}, exceeding interactions.maxDisplacementPerRule (${limit})`,
			);
		}
	}

	// TICK fires every turn unconditionally, so it is the one event whose steady state
	// is reached in any long session regardless of what the agent does.
	for (const [variable, amount] of Object.entries(config.events?.TICK ?? {})) {
		const spec = config.variables?.[variable as StasisVariable];
		if (!spec || typeof amount !== "number" || amount === 0) continue;
		if (spec.decayRate <= 0) {
			issues.push(`events.TICK.${variable} accumulates without bound: ${variable} has decayRate 0`);
			continue;
		}
		const settled = spec.baseline + amount / spec.decayRate;
		if (settled > spec.max || settled < spec.min) {
			issues.push(
				`events.TICK.${variable} settles at ${settled.toFixed(2)}, outside [${spec.min}, ${spec.max}]; the passage of turns alone would peg ${variable} at a bound`,
			);
		}
	}

	return issues;
}

// ---------------------------------------------------------------------------
// Built-in defaults
//
// These mirror config/default.yaml. They exist so the engine is usable (and testable)
// with zero filesystem access; the YAML file is the editable surface for experiments.
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: StasisConfig = {
	version: "0.1.0",
	profile: "balanced",
	variables: {
		stress: { baseline: 0.2, decayRate: 0.05, min: 0, max: 1, maxDeltaPerEvent: 0.2 },
		confidence: { baseline: 0.5, decayRate: 0.02, min: 0, max: 1, maxDeltaPerEvent: 0.2 },
		noveltyDrive: { baseline: 0.4, decayRate: 0.03, min: 0, max: 1, maxDeltaPerEvent: 0.2 },
		fatigue: { baseline: 0.0, decayRate: 0.02, min: 0, max: 1, maxDeltaPerEvent: 0.1 },
		persistence: { baseline: 0.8, decayRate: 0.02, min: 0, max: 1, maxDeltaPerEvent: 0.2 },
	},
	events: {
		TEST_FAILURE: { stress: 0.12, confidence: -0.08, fatigue: 0.02 },
		TEST_SUCCESS: { stress: -0.08, confidence: 0.1, fatigue: 0.008 },
		REPEATED_FAILURE: { stress: 0.15, confidence: -0.1, persistence: -0.15, noveltyDrive: 0.12, fatigue: 0.025 },
		BUILD_FAILURE: { stress: 0.1, confidence: -0.07, fatigue: 0.02 },
		BUILD_SUCCESS: { stress: -0.05, confidence: 0.06, fatigue: 0.008 },
		TYPECHECK_FAILURE: { stress: 0.08, confidence: -0.06, fatigue: 0.015 },
		TYPECHECK_SUCCESS: { stress: -0.04, confidence: 0.05, fatigue: 0.008 },
		LINT_FAILURE: { stress: 0.04, confidence: -0.03, fatigue: 0.012 },
		LINT_SUCCESS: { stress: -0.02, confidence: 0.02, fatigue: 0.006 },
		PATCH_APPLIED: { confidence: 0.03, fatigue: 0.015 },
		PATCH_REJECTED: { stress: 0.07, confidence: -0.05, fatigue: 0.015 },
		REVERT: { stress: 0.05, confidence: -0.09, persistence: -0.05, noveltyDrive: 0.05 },
		STRATEGY_CHANGE: { stress: -0.03, confidence: -0.02, persistence: 0.1, noveltyDrive: -0.05, fatigue: 0.02 },
		ASSUMPTION_INVALIDATED: { stress: 0.1, confidence: -0.16, persistence: -0.08, noveltyDrive: 0.1 },
		TOOL_ERROR: { stress: 0.05, confidence: -0.02, fatigue: 0.012 },
		LARGE_CHANGE: { stress: 0.04, fatigue: 0.03 },
		HIGH_UNCERTAINTY: { stress: 0.06, confidence: -0.05, noveltyDrive: 0.04 },
		TASK_SUCCESS: { stress: -0.15, confidence: 0.15, persistence: 0.05 },
		TASK_FAILURE: { stress: 0.15, confidence: -0.15, persistence: -0.1 },
		// Inspection is what a cautious policy asks for. It must never itself raise
		// stress, or verification would feed the pressure that demanded it.
		INSPECTION: { stress: -0.01, fatigue: 0.01 },
		POLICY_BLOCK: { fatigue: 0.008, noveltyDrive: 0.03 },
		// Settles fatigue at 0.4 from the passage of turns alone, leaving the upper
		// half of the range to describe genuinely heavy work.
		TICK: { fatigue: 0.008 },
	},
	severity: { enabled: true, minScale: 0.5, maxScale: 1.5 },
	modulators: {
		uncertainty: { stress: 0.06, confidence: -0.04, noveltyDrive: 0.02 },
		novelty: { noveltyDrive: 0.04, fatigue: 0.01 },
	},
	interactions: {
		// An interaction should bias where a variable rests, never decide it. Stating
		// strength as a fraction of the target's own restoring force makes that structural:
		// the ceilings below are in the same units, and profiles that change decay rates
		// rescale their couplings automatically.
		maxDisplacementPerRule: 0.35,
		maxDisplacementPerTarget: 0.5,
		rules: [
			{
				id: "fatigue-suppresses-novelty",
				source: "fatigue",
				target: "noveltyDrive",
				displacement: -0.25,
				threshold: 0.6,
				direction: "above",
				description: "Heavy workload narrows exploration rather than degrading quality",
			},
			{
				id: "fatigue-erodes-persistence",
				source: "fatigue",
				target: "persistence",
				displacement: -0.2,
				threshold: 0.7,
				direction: "above",
				description: "Sustained load makes continuing the current line less attractive",
			},
			{
				id: "low-persistence-drives-novelty",
				source: "persistence",
				target: "noveltyDrive",
				displacement: 0.25,
				threshold: 0.35,
				direction: "below",
				description: "Abandoning a strategy should open the search, not close it",
			},
			{
				id: "confidence-damps-stress",
				source: "confidence",
				target: "stress",
				displacement: -0.15,
				threshold: 0.75,
				direction: "above",
				description: "Well-supported understanding lowers threat pressure",
			},
			{
				id: "stress-damps-novelty",
				source: "stress",
				target: "noveltyDrive",
				displacement: -0.2,
				threshold: 0.8,
				direction: "above",
				description: "Acute pressure favors consolidation over speculative branching",
			},
		],
	},
	policy: {
		fields: {
			maxPatchLines: {
				min: 20,
				max: 400,
				round: true,
				intercept: 0.55,
				terms: { stress: -0.55, confidence: 0.3, fatigue: -0.1 },
			},
			verificationLevel: {
				min: 0,
				max: 1,
				round: false,
				intercept: 0.3,
				terms: { stress: 0.5, confidence: -0.25, fatigue: -0.05 },
			},
			explorationLevel: {
				min: 0,
				max: 1,
				round: false,
				intercept: 0.1,
				terms: { noveltyDrive: 0.7, persistence: -0.25, fatigue: -0.2 },
			},
			inspectionDepth: {
				min: 2,
				max: 8,
				round: true,
				intercept: 0.25,
				terms: { stress: 0.5, confidence: -0.2, fatigue: -0.1 },
			},
			retryTolerance: {
				min: 0,
				max: 4,
				round: true,
				intercept: 0.05,
				terms: { persistence: 0.85, stress: -0.15 },
			},
			strategyBranchCount: {
				min: 1,
				max: 4,
				round: true,
				// Intercept places the baseline state at two open strategies. Lower values
				// leave the field pinned near its floor, so ordinary work would strip the
				// agent of alternatives before fatigue had said anything meaningful.
				intercept: 0.25,
				terms: { noveltyDrive: 0.6, fatigue: -0.45, persistence: -0.15 },
			},
			assumptionVerificationLevel: {
				min: 0,
				max: 1,
				round: false,
				// Large enough that the baseline state lands inside the range rather than
				// clamped against the floor, where the field would stop responding at all.
				intercept: 0.5,
				terms: { stress: 0.35, persistence: -0.3, confidence: -0.2 },
			},
			testFrequency: {
				min: 0,
				max: 1,
				round: false,
				intercept: 0.35,
				terms: { stress: 0.4, confidence: -0.2, fatigue: -0.1 },
			},
			contextExpansionLevel: {
				min: 0,
				max: 1,
				round: false,
				intercept: 0.4,
				terms: { noveltyDrive: 0.35, fatigue: -0.55, stress: 0.1 },
			},
			changeRiskTolerance: {
				min: 0,
				max: 1,
				round: false,
				intercept: 0.25,
				terms: { confidence: 0.55, stress: -0.5, persistence: 0.1 },
			},
		},
		regime: { cautiousVerification: 0.6, exploratoryExploration: 0.55 },
	},
	enforcement: {
		enabled: true,
		patchLimit: true,
		retryLimit: true,
		verificationGate: true,
		maxConsecutiveBlocks: 2,
		guardBash: false,
		largeChangeLines: 120,
	},
	appraisal: {
		failureWindow: 24,
		repeatThreshold: 2,
		repeatSaturation: 5,
		fingerprintErrorLines: 3,
	},
	runtime: {
		mode: "active",
		display: "panel",
		telemetryDir: ".pi/stasis/telemetry",
		telemetryEnabled: true,
		tickOnTurnEnd: true,
		historyLimit: 200,
	},
};
