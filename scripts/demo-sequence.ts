/**
 * Milestone 1 demonstration: deterministic physiology, no Pi, no model, no network.
 *
 * Replays a synthetic event sequence twice and asserts the two state histories are
 * byte-identical, then prints the trajectory and the policy it produces.
 *
 *     npm run demo:sequence            # default profile
 *     npm run demo:sequence -- exploratory
 */

import { join } from "node:path";
import { type AppraisedEvent, appraisedEvent } from "../src/appraisal/events.ts";
import { type NeuroConfig, baselineState, buildConfig, loadConfigFromFiles } from "../src/neuro/config.ts";
import { createEngine, replay } from "../src/neuro/engine.ts";
import { NEURO_VARIABLES, type NeuroState } from "../src/neuro/state.ts";
import { createPolicyAdapter } from "../src/policy/adapter.ts";
import { type PolicySnapshot, policyDiff } from "../src/policy/policy.ts";

const CONFIG_DIR = join(import.meta.dirname, "..", "config");

/**
 * A plausible debugging session: a hypothesis that fails, is retried, is detected as
 * repetition, forces a change of approach, and finally succeeds.
 */
const SEQUENCE: AppraisedEvent[] = [
	appraisedEvent({ type: "INSPECTION", evidence: { detail: "read the failing module" } }),
	appraisedEvent({ type: "PATCH_APPLIED", evidence: { changedLines: 18 } }),
	appraisedEvent({ type: "TEST_FAILURE", severity: 0.6, evidence: { detail: "first attempt" } }),
	appraisedEvent({ type: "TICK" }),
	appraisedEvent({ type: "PATCH_APPLIED", evidence: { changedLines: 24 } }),
	appraisedEvent({ type: "TEST_FAILURE", severity: 0.7, repeated: true, evidence: { repeatCount: 2 } }),
	appraisedEvent({ type: "REPEATED_FAILURE", severity: 0.6, repeated: true, evidence: { repeatCount: 2 } }),
	appraisedEvent({ type: "TICK" }),
	appraisedEvent({ type: "TEST_FAILURE", severity: 0.8, repeated: true, evidence: { repeatCount: 3 } }),
	appraisedEvent({ type: "REPEATED_FAILURE", severity: 0.85, repeated: true, evidence: { repeatCount: 3 } }),
	appraisedEvent({ type: "ASSUMPTION_INVALIDATED", severity: 0.7, uncertainty: 0.8 }),
	appraisedEvent({ type: "TICK" }),
	appraisedEvent({ type: "STRATEGY_CHANGE", novelty: 0.9 }),
	appraisedEvent({ type: "INSPECTION" }),
	appraisedEvent({ type: "INSPECTION" }),
	appraisedEvent({ type: "PATCH_APPLIED", evidence: { changedLines: 9 } }),
	appraisedEvent({ type: "TEST_SUCCESS", severity: 0.6 }),
	appraisedEvent({ type: "TICK" }),
	appraisedEvent({ type: "TASK_SUCCESS", severity: 0.7 }),
];

const BAR_WIDTH = 10;

function bar(value: number): string {
	const filled = Math.round(value * BAR_WIDTH);
	return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

function arrow(before: number, after: number): string {
	if (after > before) return "↑";
	if (after < before) return "↓";
	return " ";
}

function loadProfile(name: string | undefined): NeuroConfig {
	const files = [join(CONFIG_DIR, "default.yaml")];
	if (name) files.push(join(CONFIG_DIR, "profiles", `${name}.yaml`));
	try {
		return loadConfigFromFiles(files).config;
	} catch (error) {
		if (!name) throw error;
		console.error(`Could not load profile "${name}": ${(error as Error).message}`);
		process.exit(1);
	}
}

function printState(step: number, label: string, before: NeuroState, after: NeuroState): void {
	const cells = NEURO_VARIABLES.map(
		(variable) =>
			`${variable.slice(0, 4)} ${bar(after[variable])} ${after[variable].toFixed(2)}${arrow(before[variable], after[variable])}`,
	);
	console.log(`  ${String(step).padStart(2)} ${label.padEnd(24)} ${cells.join("  ")}`);
}

function summarizePolicy(policy: PolicySnapshot): string {
	return [
		`regime ${policy.regime}`,
		`patch<=${policy.maxPatchLines}`,
		`verify ${policy.verificationLevel.toFixed(2)}`,
		`explore ${policy.explorationLevel.toFixed(2)}`,
		`retry ${policy.retryTolerance}`,
		`depth ${policy.inspectionDepth}`,
		`branches ${policy.strategyBranchCount}`,
	].join("  ");
}

function main(): void {
	const profile = process.argv[2];
	const config = loadProfile(profile);
	const engine = createEngine(config);
	const adapter = createPolicyAdapter(config);
	const start = baselineState(config);

	console.log(`\npi-neuro — deterministic physiology replay (profile: ${config.profile})\n`);

	const first = replay(engine, start, SEQUENCE);
	const second = replay(engine, start, SEQUENCE);

	const identical = JSON.stringify(first.states) === JSON.stringify(second.states);
	if (!identical) {
		console.error("DETERMINISM VIOLATED: two replays of the same sequence diverged.");
		process.exit(1);
	}

	console.log("Trajectory\n");
	printState(0, "(baseline)", start, start);
	for (const transition of first.transitions) {
		printState(transition.step, transition.event.type, transition.before, transition.after);
	}

	console.log("\nPolicy at each change\n");
	let previous = adapter.derive(start);
	console.log(`   0 (baseline)               ${summarizePolicy(previous)}`);
	for (const transition of first.transitions) {
		const policy = adapter.derive(transition.after);
		const diff = policyDiff(previous, policy);
		if (Object.keys(diff).length === 0) continue;
		console.log(`  ${String(transition.step).padStart(2)} ${transition.event.type.padEnd(24)} ${summarizePolicy(policy)}`);
		previous = policy;
	}

	const startPolicy = adapter.derive(start);
	const endPolicy = adapter.derive(first.states.at(-1)!);
	console.log("\nNet policy change over the session\n");
	for (const [field, [from, to]] of Object.entries(policyDiff(startPolicy, endPolicy))) {
		const format = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(3));
		console.log(`  ${field.padEnd(28)} ${format(from).padStart(7)} -> ${format(to)}`);
	}

	console.log(`\nReplayed ${SEQUENCE.length} events twice; state histories are identical.`);
	console.log(`Config hash: ${buildConfig([{ label: "profile", data: config }]).hash}\n`);
}

main();
