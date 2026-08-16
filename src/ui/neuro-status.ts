/**
 * The TUI display.
 *
 * Rendering is a pure function from state to strings so it can be tested without a
 * terminal; the extension passes the result to `ctx.ui.setWidget`. Colour is applied
 * through an injected theme function, because `ctx.ui.theme` exists only in a real
 * session and is a no-op elsewhere.
 *
 * The panel is meant to be glanceable and quiet. Pi remains the interface; this is a
 * gauge on it, not a second application.
 */

import type { NeuroState } from "../neuro/state.ts";
import { NEURO_VARIABLES } from "../neuro/state.ts";
import type { PolicySnapshot } from "../policy/policy.ts";

export type ThemeFn = (color: string, text: string) => string;

const IDENTITY_THEME: ThemeFn = (_color, text) => text;

const BAR_WIDTH = 10;

const LABELS: Record<keyof NeuroState, string> = {
	stress: "stress",
	confidence: "confidence",
	noveltyDrive: "novelty",
	fatigue: "fatigue",
	persistence: "persistence",
};

/** Which direction is "worse", so the display can colour movement meaningfully. */
const RISING_IS_STRAIN: Record<keyof NeuroState, boolean> = {
	stress: true,
	confidence: false,
	noveltyDrive: false,
	fatigue: true,
	persistence: false,
};

function bar(value: number): string {
	const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(value * BAR_WIDTH)));
	return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

function trend(before: number | undefined, after: number): string {
	if (before === undefined || Math.abs(after - before) < 0.005) return " ";
	return after > before ? "↑" : "↓";
}

export interface PanelOptions {
	state: NeuroState;
	policy: PolicySnapshot;
	previous?: NeuroState;
	mode: string;
	enabled: boolean;
	theme?: ThemeFn;
}

/**
 * The status panel.
 *
 * Returns plain lines; Pi's widget API accepts a string array directly.
 */
export function renderPanel(options: PanelOptions): string[] {
	const theme = options.theme ?? IDENTITY_THEME;
	const { state, policy } = options;

	if (!options.enabled) {
		return [theme("dim", "Neuro  disabled — /neuro enable to resume")];
	}

	const lines: string[] = [];
	const heading = options.mode === "active" ? "Neuro" : `Neuro (${options.mode})`;
	lines.push(theme("accent", heading));

	for (const variable of NEURO_VARIABLES) {
		const value = state[variable];
		const direction = trend(options.previous?.[variable], value);
		const strained = RISING_IS_STRAIN[variable] ? value > 0.6 : value < 0.4;
		const colour = strained ? "warning" : "dim";
		lines.push(
			`  ${theme("dim", LABELS[variable].padEnd(11))}${theme(colour, bar(value))} ${value.toFixed(2)}${direction}`,
		);
	}

	lines.push(
		"",
		`  ${theme("dim", "policy".padEnd(11))}${theme("accent", policy.regime)}`,
		`  ${theme("dim", "".padEnd(11))}patch ≤ ${policy.maxPatchLines}  verify ${policy.verificationLevel.toFixed(2)}  retry ${policy.retryTolerance}  depth ${policy.inspectionDepth}  branches ${policy.strategyBranchCount}`,
	);

	return lines;
}

/** Compact single line for the footer status area. */
export function renderStatus(options: PanelOptions): string {
	const theme = options.theme ?? IDENTITY_THEME;
	if (!options.enabled) return theme("dim", "neuro off");
	const { state, policy } = options;
	const strain = state.stress > 0.6 || state.persistence < 0.3 ? "warning" : "dim";
	return theme(
		strain,
		`neuro ${policy.regime.toLowerCase()} s${state.stress.toFixed(2)} c${state.confidence.toFixed(2)} p${state.persistence.toFixed(2)} patch≤${policy.maxPatchLines}`,
	);
}

/**
 * Lines summarising a policy change, for the transcript notification after a turn.
 *
 * Only the fields that actually moved, so the notice stays short enough to be read.
 */
export function renderPolicyChange(
	changed: Partial<Record<string, [number, number]>>,
	trigger: string,
): string | undefined {
	const entries = Object.entries(changed);
	if (entries.length === 0) return undefined;
	const format = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2));
	const parts = entries.slice(0, 4).map(([field, pair]) => `${field} ${format(pair![0])}→${format(pair![1])}`);
	const more = entries.length > 4 ? ` (+${entries.length - 4} more)` : "";
	return `${trigger}: ${parts.join(", ")}${more}`;
}
