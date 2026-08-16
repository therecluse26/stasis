/**
 * Analysis and reporting.
 *
 *     npm run analyze -- runs/<study>/results.jsonl
 *
 * Two principles shape the output.
 *
 * First, outcome and behavior are reported separately. "Did behavior change?" and "did
 * the change help?" are different questions, and a table of success rates alone cannot
 * answer the first — an intervention that changes nothing and one that changes a great
 * deal in a way that happens to cancel out look identical there.
 *
 * Second, nothing is dressed up. With the trial counts these studies realistically run,
 * differences are descriptive. The report prints spread alongside every mean and refuses
 * to imply significance it cannot support.
 */

import { readFileSync } from "node:fs";
import type { Condition, TrialMetrics, TrialResult } from "./types.ts";

export interface ConditionSummary {
	condition: Condition;
	trials: number;
	successes: number;
	successRate: number;
	/** Passed the visible tests but failed grading: patched around the cause. */
	visibleOnly: number;
	errors: number;
	timeouts: number;
	turnCaps: number;
	mean: Record<string, number>;
	stdev: Record<string, number>;
}

export interface Summary {
	byCondition: ConditionSummary[];
	byTask: Array<{ taskId: string; byCondition: ConditionSummary[] }>;
	totalTrials: number;
	totalCost: number;
}

const mean = (values: number[]): number =>
	values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

function stdev(values: number[]): number {
	if (values.length < 2) return 0;
	const m = mean(values);
	return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

/** Numeric fields reported for every condition. */
const OUTCOME_FIELDS = ["turns", "toolCalls", "diffLines", "filesModified", "durationSeconds", "totalTokens", "cost"] as const;

const METRIC_FIELDS: Array<keyof TrialMetrics> = [
	"testsExecuted",
	"testFailures",
	"repeatedFailures",
	"strategyChanges",
	"assumptionsInvalidated",
	"filesRead",
	"commandsExecuted",
	"patchesApplied",
	"largeChanges",
	"policyBlocks",
	"policyRelaxations",
	"suspectedBypasses",
	"meanStress",
	"peakStress",
	"meanConfidence",
	"minPersistence",
	"meanFatigue",
	"policyChanges",
	"meanPatchSizeOverall",
	"meanPatchSizeAfterFailure",
	"filesInspectedBeforeSecondModification",
	"repeatedFailureRate",
	"verificationRatioAfterFailure",
	"patchSizeAtHighStress",
	"patchSizeAtLowStress",
	"turnsToStrategyChange",
];

function numericFields(result: TrialResult): Record<string, number> {
	const fields: Record<string, number> = {
		turns: result.turns,
		toolCalls: result.toolCalls,
		diffLines: result.diffLines,
		filesModified: result.filesModified,
		durationSeconds: result.durationMs / 1000,
		totalTokens: result.tokens?.total ?? 0,
		cost: result.cost ?? 0,
	};
	for (const field of METRIC_FIELDS) {
		const value = result.metrics?.[field];
		// null means "not applicable in this trial" — excluded rather than counted as zero,
		// which would silently drag an average toward a value nothing observed.
		if (typeof value === "number") fields[field] = value;
	}
	return fields;
}

function summarizeCondition(condition: Condition, results: TrialResult[]): ConditionSummary {
	const fields = new Map<string, number[]>();
	for (const result of results) {
		for (const [key, value] of Object.entries(numericFields(result))) {
			const list = fields.get(key) ?? [];
			list.push(value);
			fields.set(key, list);
		}
	}

	const meanOf: Record<string, number> = {};
	const stdevOf: Record<string, number> = {};
	for (const [key, values] of fields) {
		meanOf[key] = Number(mean(values).toFixed(3));
		stdevOf[key] = Number(stdev(values).toFixed(3));
	}

	const successes = results.filter((result) => result.success).length;
	return {
		condition,
		trials: results.length,
		successes,
		successRate: results.length === 0 ? 0 : successes / results.length,
		visibleOnly: results.filter((result) => !result.success && result.visiblePassed).length,
		errors: results.filter((result) => result.error && !result.success).length,
		timeouts: results.filter((result) => result.timedOut).length,
		turnCaps: results.filter((result) => result.turnCapped).length,
		mean: meanOf,
		stdev: stdevOf,
	};
}

export function summarize(results: TrialResult[]): Summary {
	const conditions = [...new Set(results.map((result) => result.condition))];
	const taskIds = [...new Set(results.map((result) => result.taskId))];

	return {
		byCondition: conditions.map((condition) =>
			summarizeCondition(
				condition,
				results.filter((result) => result.condition === condition),
			),
		),
		byTask: taskIds.map((taskId) => ({
			taskId,
			byCondition: conditions.map((condition) =>
				summarizeCondition(
					condition,
					results.filter((result) => result.taskId === taskId && result.condition === condition),
				),
			),
		})),
		totalTrials: results.length,
		totalCost: Number(results.reduce((sum, result) => sum + (result.cost ?? 0), 0).toFixed(4)),
	};
}

const LABELS: Record<string, string> = {
	successRate: "success rate",
	visibleOnly: "visible tests only",
	turns: "mean turns",
	toolCalls: "mean tool calls",
	diffLines: "mean final diff (lines)",
	filesModified: "mean files modified",
	durationSeconds: "mean duration (s)",
	totalTokens: "mean tokens",
	cost: "mean cost",
	testsExecuted: "tests executed",
	testFailures: "test failures",
	repeatedFailures: "repeated failures",
	strategyChanges: "strategy changes",
	assumptionsInvalidated: "assumptions invalidated",
	filesRead: "files read",
	commandsExecuted: "commands run",
	patchesApplied: "patches applied",
	largeChanges: "large changes",
	policyBlocks: "policy blocks",
	policyRelaxations: "policy relaxations",
	suspectedBypasses: "suspected bypasses",
	meanStress: "mean stress",
	peakStress: "peak stress",
	meanConfidence: "mean confidence",
	minPersistence: "min persistence",
	meanFatigue: "mean fatigue",
	policyChanges: "policy changes",
	meanPatchSizeOverall: "mean patch size",
	meanPatchSizeAfterFailure: "patch size after failure",
	filesInspectedBeforeSecondModification: "inspections before 2nd edit",
	repeatedFailureRate: "repeated-failure rate",
	verificationRatioAfterFailure: "inspections per edit (post-failure)",
	patchSizeAtHighStress: "patch size, high stress",
	patchSizeAtLowStress: "patch size, low stress",
	turnsToStrategyChange: "turns to strategy change",
};

const OUTCOME_ROWS = ["successRate", "visibleOnly", ...OUTCOME_FIELDS] as string[];
const BEHAVIOR_ROWS = [
	"testsExecuted",
	"testFailures",
	"repeatedFailures",
	"repeatedFailureRate",
	"strategyChanges",
	"turnsToStrategyChange",
	"assumptionsInvalidated",
	"filesRead",
	"patchesApplied",
	"meanPatchSizeOverall",
	"meanPatchSizeAfterFailure",
	"filesInspectedBeforeSecondModification",
	"verificationRatioAfterFailure",
	"patchSizeAtLowStress",
	"patchSizeAtHighStress",
	"largeChanges",
];
const PHYSIOLOGY_ROWS = [
	"meanStress",
	"peakStress",
	"meanConfidence",
	"minPersistence",
	"meanFatigue",
	"policyChanges",
	"policyBlocks",
	"policyRelaxations",
	"suspectedBypasses",
];

function formatCell(summary: ConditionSummary, row: string): string {
	if (row === "successRate") {
		return `${(summary.successRate * 100).toFixed(0)}% (${summary.successes}/${summary.trials})`;
	}
	if (row === "visibleOnly") return String(summary.visibleOnly);
	const value = summary.mean[row];
	if (value === undefined) return "—";
	const spread = summary.stdev[row];
	const formatted = Number.isInteger(value) ? String(value) : value.toFixed(2);
	return spread && spread > 0 ? `${formatted} ±${spread.toFixed(1)}` : formatted;
}

function table(title: string, rows: string[], summaries: ConditionSummary[]): string {
	const present = rows.filter((row) =>
		summaries.some((summary) => row === "successRate" || row === "visibleOnly" || summary.mean[row] !== undefined),
	);
	if (present.length === 0) return "";

	const labelWidth = Math.max(...present.map((row) => (LABELS[row] ?? row).length)) + 2;
	const columnWidth = Math.max(14, ...summaries.map((summary) => summary.condition.length + 2));

	const lines: string[] = ["", title, "─".repeat(labelWidth + columnWidth * summaries.length)];
	lines.push(
		"".padEnd(labelWidth) + summaries.map((summary) => summary.condition.padStart(columnWidth)).join(""),
	);
	for (const row of present) {
		lines.push(
			(LABELS[row] ?? row).padEnd(labelWidth) +
				summaries.map((summary) => formatCell(summary, row).padStart(columnWidth)).join(""),
		);
	}
	return lines.join("\n");
}

export function renderReport(summary: Summary, results: TrialResult[]): string {
	const sections: string[] = [""];
	sections.push("═".repeat(72));
	sections.push(`RESULTS — ${summary.totalTrials} trials, $${summary.totalCost.toFixed(4)} total`);
	sections.push("═".repeat(72));

	sections.push(table("OUTCOMES", OUTCOME_ROWS, summary.byCondition));
	sections.push(table("BEHAVIOR — did the agent work differently?", BEHAVIOR_ROWS, summary.byCondition));
	sections.push(table("PHYSIOLOGY — recorded in every arm, influential only where enabled", PHYSIOLOGY_ROWS, summary.byCondition));

	for (const task of summary.byTask) {
		sections.push(table(`TASK: ${task.taskId}`, ["successRate", "visibleOnly", "turns", "diffLines"], task.byCondition));
	}

	// Caveats belong in the output, not in a footnote nobody reads.
	const notes: string[] = ["", "NOTES", "─".repeat(72)];
	const perCondition = summary.byCondition[0]?.trials ?? 0;
	if (perCondition < 10) {
		notes.push(
			`  Trial counts are small (${perCondition} per condition). Differences here are`,
			"  descriptive. Treat them as a reason to run more trials, not as a result.",
		);
	}
	const bypasses = summary.byCondition.filter((summary) => (summary.mean.suspectedBypasses ?? 0) > 0);
	if (bypasses.length > 0) {
		notes.push(
			"  Shell commands shaped like file mutation were seen. Pi has no sandbox, so",
			"  edit limits can be sidestepped through bash; those runs are not clean tests",
			`  of enforcement (${bypasses.map((s) => `${s.condition}: ${s.mean.suspectedBypasses}`).join(", ")}).`,
		);
	}
	const capped = summary.byCondition.filter((summary) => summary.turnCaps > 0 || summary.timeouts > 0);
	if (capped.length > 0) {
		notes.push(
			`  Some trials hit the turn cap or timed out (${capped
				.map((s) => `${s.condition}: ${s.turnCaps + s.timeouts}`)
				.join(", ")}). Those are recorded as failures.`,
		);
	}
	const inert = results.filter((result) => result.extensionInert);
	if (inert.length > 0) {
		notes.push(
			"",
			`  INVALID: ${inert.length} trial(s) ran a condition that should have been`,
			"  instrumented but produced no telemetry — the extension never activated. Those",
			"  arms are indistinguishable from the control by construction, so this run does",
			"  not measure anything. Do not report it.",
		);
	}
	const errored = results.filter((result) => result.error && !result.success && !result.timedOut);
	if (errored.length > 0) {
		notes.push(`  ${errored.length} trial(s) recorded an error. First: ${errored[0]!.error?.slice(0, 120)}`);
	}
	const control = summary.byCondition.find((summary) => summary.condition === "control");
	const bare = summary.byCondition.find((summary) => summary.condition === "bare");
	if (control && bare) {
		notes.push(
			"  control vs bare is the inertness check: the observer-mode extension should",
			"  behave indistinguishably from no extension at all.",
		);
	}
	sections.push(notes.join("\n"));

	return sections.filter(Boolean).join("\n");
}

function loadResults(path: string): TrialResult[] {
	const contents = readFileSync(path, "utf8");
	if (path.endsWith(".jsonl")) {
		return contents
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as TrialResult);
	}
	const parsed = JSON.parse(contents) as { results?: TrialResult[] } | TrialResult[];
	return Array.isArray(parsed) ? parsed : (parsed.results ?? []);
}

/** State trajectories, one row per transition, for plotting. */
export function renderTrajectoryCsv(results: TrialResult[]): string {
	const rows = ["condition,task,trial,step,turn,event,stress,confidence,noveltyDrive,fatigue,persistence,regime,maxPatchLines"];
	for (const result of results) {
		if (!result.telemetryPath) continue;
		let records: ReturnType<typeof JSON.parse>[] = [];
		try {
			records = readFileSync(result.telemetryPath, "utf8")
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.map((line) => JSON.parse(line));
		} catch {
			continue;
		}
		for (const record of records) {
			if (record.type !== "transition") continue;
			const s = record.stateAfter;
			rows.push(
				[
					result.condition,
					result.taskId,
					result.trial,
					record.step,
					record.turnIndex ?? 0,
					record.event.type,
					s.stress,
					s.confidence,
					s.noveltyDrive,
					s.fatigue,
					s.persistence,
					record.policy.regime,
					record.policy.maxPatchLines,
				].join(","),
			);
		}
	}
	return rows.join("\n");
}

async function main(): Promise<void> {
	const path = process.argv[2];
	if (!path) {
		console.error("usage: npm run analyze -- runs/<study>/results.jsonl");
		process.exit(1);
	}
	const results = loadResults(path);
	console.log(renderReport(summarize(results), results));
	console.log("");
}

// Only run as a CLI, not when imported by the runner.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? " ")) {
	void main();
}
