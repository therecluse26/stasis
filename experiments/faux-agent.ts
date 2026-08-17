/**
 * A scripted agent, for validating the harness without spending money.
 *
 * Enabled with `PI_STASIS_FAUX=1`. Pi's faux provider replaces the model with a fixed
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

	if (taskId === "bug-005-invisible-edit") {
		// Walks the trap the fixture is built around, through the whole harness rather than
		// in a unit test: two genuinely different repairs written to `src/tokens.js`, which
		// `package.json` does not wire to anything, so both test runs fail byte-identically.
		//
		// The second repair is *correct*. If REPEATED_FAILURE does not fire here, either the
		// fixture's decoy has been wired back into the code path or the fingerprint has been
		// sharpened to the point of noticing edits that changed nothing — and a faux run
		// says so for free, before a study spends money discovering it.
		const shipped = '\treturn s.split(" ").length;';
		const attempt = (newText: string): FauxResponseStep =>
			fauxAssistantMessage([fauxToolCall("edit", { path: "src/tokens.js", edits: [{ oldText: shipped, newText }] })], {
				stopReason: "toolUse",
			});
		const test = fauxAssistantMessage([fauxToolCall("bash", { command: "node --test" })], { stopReason: "toolUse" });
		return [
			fauxAssistantMessage([fauxToolCall("read", { path: "src/tokens.js" })], { stopReason: "toolUse" }),
			attempt("\treturn s.split(/\\s+/).length;"),
			test,
			fauxAssistantMessage([fauxToolCall("read", { path: "src/tokens.js" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[
					fauxToolCall("edit", {
						path: "src/tokens.js",
						edits: [
							{
								oldText: "\treturn s.split(/\\s+/).length;",
								newText: '\treturn s.trim() === "" ? 0 : s.trim().split(/\\s+/).length;',
							},
						],
					}),
				],
				{ stopReason: "toolUse" },
			),
			test,
			fauxAssistantMessage([fauxText("The tests fail the same way whatever I write.")], { stopReason: "stop" }),
		];
	}

	// For every other fixture the scripted agent flails: it runs the tests, runs the exact
	// same thing again, then tries a materially different invocation before giving up.
	//
	// The third command is not decoration. Repeating one command exercises TEST_FAILURE and
	// REPEATED_FAILURE but can never produce a STRATEGY_CHANGE, so with an all-identical
	// script `strategyChanges` reads 0 whether the event is wired up or not — which is
	// exactly how it went unnoticed that nothing in the extension called the detector at
	// all. A scripted agent that never changes approach cannot detect a broken change-of-
	// approach signal, and detecting silent breakage is what this agent is for.
	return [
		fauxAssistantMessage([fauxToolCall("bash", { command: "node --test" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("bash", { command: "node --test" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("bash", { command: "node --test --test-concurrency=1" })], {
			stopReason: "toolUse",
		}),
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
	return env.PI_STASIS_FAUX === "1";
}
