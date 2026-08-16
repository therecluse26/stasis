/**
 * A scripted agent, for validating the harness without spending money.
 *
 * Enabled with `PI_NEURO_FAUX=1`. Pi's faux provider replaces the model with a fixed
 * sequence of turns, so a study can be run end to end — workspace preparation, extension
 * activation, tool execution, telemetry, grading, aggregation, report — with no
 * credentials and no network.
 *
 * This exists because the failure modes that matter most in an experiment harness are
 * silent ones. A study that compares two arms which are secretly identical produces a
 * clean, plausible, meaningless table. Being able to run the whole pipeline cheaply and
 * assert that it reports a *known* outcome is what makes that detectable.
 *
 * The script deliberately fixes `bug-003-easy-control` correctly, so a healthy pipeline
 * reports success on that fixture and failure elsewhere.
 */

import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseStep } from "@earendil-works/pi-ai";

export interface FauxAgentPlan {
	handle: ReturnType<typeof fauxProvider>;
}

/** Turns that correctly fix each shipped fixture, or trail off if the task is unknown. */
function scriptFor(taskId: string): FauxResponseStep[] {
	if (taskId === "bug-003-easy-control") {
		return [
			fauxAssistantMessage([fauxToolCall("read", { path: "src/clamp.js" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: "src/clamp.js",
						edits: [{ oldText: "\tif (value >= max) return max - 1;", newText: "\tif (value > max) return max;" }],
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("bash", { command: "node --test" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Fixed the comparison so the upper bound is inclusive.")], {
				stopReason: "stop",
			}),
		];
	}

	// For every other fixture the scripted agent flails: it runs the tests, makes a wrong
	// change, runs them again, and gives up. That exercises the failure and repeated-failure
	// paths, which is what the harness most needs to be able to observe.
	return [
		fauxAssistantMessage([fauxToolCall("bash", { command: "node --test" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("bash", { command: "node --test" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("bash", { command: "node --test" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("I could not work out the cause.")], { stopReason: "stop" }),
	];
}

export function createFauxAgent(taskId: string): FauxAgentPlan {
	const handle = fauxProvider({
		provider: "faux",
		models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4096 }],
	});
	handle.setResponses(scriptFor(taskId));
	return { handle };
}

export function fauxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PI_NEURO_FAUX === "1";
}
