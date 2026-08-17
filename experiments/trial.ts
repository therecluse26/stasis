/**
 * One trial, in its own process.
 *
 * Invoked by the runner as `tsx experiments/trial.ts <base64 TrialRequest>`. A separate
 * process per trial buys three things worth the overhead: no module-level state can leak
 * between trials, a hung agent can be killed outright, and a crash takes down one trial
 * rather than the study.
 *
 * Everything that could differ between conditions is pinned here. The *only* intended
 * difference is the mode the extension runs in.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DefaultResourceLoader,
	type ExtensionAPI,
	SessionManager,
	SettingsManager,
	ModelRuntime,
	createAgentSession,
	resolveCliModel,
} from "@earendil-works/pi-coding-agent";
import { createStasisExtension } from "../src/extension.ts";
import { applyEnvFiles } from "../src/runtime/env-file.ts";
import { EXTENSION_VERSION } from "../src/version.ts";
import { createFauxAgent, fauxEnabled } from "./faux-agent.ts";
import { grade, prepareWorkspace } from "./grade.ts";
import { applyRouting } from "./model.ts";
import { computeMetrics, emptyMetrics, readTelemetry, runHeader } from "./metrics.ts";
import { CONDITION_MODES, isNoAttempt, type TrialRequest, type TrialResult } from "./types.ts";

/**
 * Instructions shared by every condition.
 *
 * This is the control-legitimacy requirement in code: whatever guidance the agent gets
 * about how to work, every arm gets the same. The only thing that varies between arms is
 * whether physiology influences the run.
 */
const SHARED_SYSTEM_PROMPT = `You are a coding agent working in a small repository.

Fix the problem the user describes. Run the tests to check your work. When the tests
pass and you believe the underlying cause is fixed, stop and briefly say what you changed.

Work only inside the current directory.`;

function readRequest(): TrialRequest {
	const encoded = process.argv[2];
	if (!encoded) throw new Error("usage: trial.ts <base64-encoded TrialRequest>");
	return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as TrialRequest;
}

async function main(): Promise<void> {
	const request = readRequest();

	// Under the runner this changes nothing: the parent already loaded these and a trial
	// inherits its environment, and an already-set variable is never overwritten. It is
	// here so that running one trial by hand authenticates the same way a study does.
	//
	// This cannot reach the physiology. The extension below is constructed with an
	// explicit `env`, which suppresses `.env` loading in the config layer entirely.
	applyEnvFiles({ dirs: [request.packageRoot] });
	const startedAt = new Date().toISOString();
	const started = Date.now();

	const workdir = join(request.outputDir, "workspace");
	const gradingDir = join(request.outputDir, "grading");
	const telemetryPath = join(request.outputDir, "stasis.jsonl");
	mkdirSync(request.outputDir, { recursive: true });

	const mode = CONDITION_MODES[request.condition];

	const result: TrialResult = {
		benchmark: request.benchmark,
		taskId: request.task.id,
		condition: request.condition,
		trial: request.trial,
		success: false,
		visiblePassed: false,
		timedOut: false,
		turnCapped: false,
		durationMs: 0,
		turns: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		cost: 0,
		diffLines: 0,
		filesModified: 0,
		telemetryPath,
		workdir,
		metrics: emptyMetrics(),
		repro: {
			extensionVersion: EXTENSION_VERSION,
			mode,
			model: request.model,
			startedAt,
			nodeVersion: process.version,
			platform: process.platform,
		},
	};

	try {
		prepareWorkspace(request.fixture, workdir);

		// Harness self-test: a scripted agent instead of a real model. See faux-agent.ts.
		const faux = fauxEnabled() ? createFauxAgent(request.task.id) : undefined;

		const modelRuntime = await ModelRuntime.create(
			faux ? { modelsPath: null, refreshOnCreate: false } : undefined,
		);
		const resolved = faux
			? { model: faux.handle.models[0], thinkingLevel: undefined }
			: resolveCliModel({
					cliProvider: request.model.provider,
					cliModel: request.model.model,
					cliThinking: request.model.thinkingLevel as never,
					modelRuntime,
				});
		const resolvedModel = resolved.model;
		if (!resolvedModel) {
			throw new Error(
				`could not resolve model ${request.model.provider}/${request.model.model}. ` +
					`Authenticate first (for OpenRouter: set OPENROUTER_API_KEY or run \`pi\` then \`/login openrouter\`).`,
			);
		}

		// Pin the upstream provider, where the study asked for one. See experiments/model.ts.
		const model = applyRouting(resolvedModel, request.model);

		// Everything below is identical across conditions except `extensionFactories`.
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: true, maxRetries: 2 },
		});

		const resourceLoader = new DefaultResourceLoader({
			cwd: workdir,
			agentDir: join(request.outputDir, "agent"),
			settingsManager,
			// Nothing from the host machine or from this repository may reach a trial: no
			// discovered extensions (which would otherwise include this project's own
			// .pi/extensions and contaminate the control arm), no skills, no themes, no
			// AGENTS.md walk-up.
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: request.systemPrompt ?? SHARED_SYSTEM_PROMPT,
			appendSystemPromptOverride: () => [],
			extensionFactories: [
				...(faux
					? [{ name: "faux-provider", factory: (pi: ExtensionAPI) => pi.registerProvider(faux.handle.provider) }]
					: []),
				...(mode === "none"
					? []
					: [
							{
								name: `stasis-${request.condition}`,
								factory: createStasisExtension({
									mode,
									profile: request.profile,
									inline: request.config,
									telemetryDir: telemetryPath,
									condition: request.condition,
									trial: request.trial,
									task: request.task.id,
									// The runner owns configuration; ignore ambient overrides so a stray
									// environment variable cannot silently change one arm of a study.
									env: {} as NodeJS.ProcessEnv,
								}),
							},
						]),
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: workdir,
			agentDir: join(request.outputDir, "agent"),
			model,
			thinkingLevel: (request.model.thinkingLevel ?? resolved.thinkingLevel) as never,
			modelRuntime,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			tools: ["read", "bash", "edit", "write"],
		});

		// createAgentSession() loads extensions but does not activate them; without this
		// no handler ever fires. Every condition would then behave identically and a study
		// would compare control against control while looking entirely healthy.
		// tests/live-session.test.ts pins this against the real harness.
		await session.bindExtensions({ mode: "print" });

		// The SDK exposes no turn budget, so the cap is enforced here by counting
		// turn_end events and aborting. Recorded, so a capped trial is never mistaken
		// for one that simply gave up.
		let turns = 0;
		let capped = false;
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "turn_end") {
				turns += 1;
				if (turns >= request.maxTurns && !capped) {
					capped = true;
					void session.abort();
				}
			}
		});

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			void session.abort();
		}, request.timeoutSeconds * 1000);

		try {
			await session.prompt(request.task.prompt ?? request.fixture.prompt);
		} finally {
			clearTimeout(timer);
			unsubscribe();
		}

		// The transcript, before anything derived from it.
		//
		// `SessionManager.inMemory()` keeps trials from leaking into each other, but it also
		// means nothing survives the process unless it is written here, and a trial that ends
		// after one turn with no tool calls is then unfalsifiable: a model that replied
		// conversationally, one whose response was truncated, and one that never saw the
		// prompt all look identical in the counters. That has now happened twice in ~35 live
		// trials, and both times the evidence needed to tell those apart no longer existed.
		try {
			writeFileSync(join(request.outputDir, "transcript.json"), `${JSON.stringify(session.messages, null, 2)}\n`, "utf8");
		} catch (error) {
			// Diagnostic only. Losing it must not cost the trial.
			result.transcriptError = (error as Error).message;
		}

		const stats = session.getSessionStats();
		result.turns = turns;
		result.turnCapped = capped;
		result.timedOut = timedOut;
		result.assistantMessages = stats.assistantMessages;
		result.toolCalls = stats.toolCalls;
		result.toolResults = stats.toolResults;
		result.tokens = stats.tokens;
		result.cost = stats.cost;
		if (session.agent.state.errorMessage) result.error = session.agent.state.errorMessage;

		session.dispose();
	} catch (error) {
		result.error = (error as Error).message;
	}

	// Grade whatever the agent left behind, even if the run errored: a partial fix that
	// happens to pass is a real outcome, and so is a run that broke the repository.
	try {
		const graded = grade(request.fixture, workdir, gradingDir);
		result.success = graded.success;
		result.visiblePassed = graded.visiblePassed;
		result.diffLines = graded.diffLines;
		result.filesModified = graded.filesModified;
		result.diff = graded.diff;
		// Why grading failed is not an *error*: an agent that simply did not fix the bug is
		// an ordinary outcome, and reporting it as an error would inflate the error count
		// with every unsuccessful trial and hide the ones that actually went wrong.
		result.gradeDetail = graded.detail?.slice(0, 1000);
	} catch (error) {
		result.error = `grading failed: ${(error as Error).message}`;
	}

	const records = readTelemetry(telemetryPath);
	result.metrics = computeMetrics(records);

	// A condition that should have been instrumented but wrote nothing means the
	// extension never ran. Silence here would look like a legitimate null result.
	if (mode !== "none" && records.length === 0) {
		result.extensionInert = true;
		result.error = result.error ?? "extension produced no telemetry: it was loaded but never activated";
	}

	// An agent that answered without touching the workspace did not attempt the task, and
	// scoring it as a failed attempt is worse than not scoring it: the trial contributes a
	// zero to every behavioural mean and a miss to the success rate of whichever arm it
	// happened to land in. Observed twice in ~35 live trials, in two different conditions,
	// which is enough to corrupt an arm at the trial counts these studies run.
	if (isNoAttempt(result)) result.agentInert = true;

	const header = runHeader(records);
	if (header) {
		result.repro.piVersion = header.piVersion;
		result.repro.gitCommit = header.gitCommit;
		result.repro.configHash = header.configHash;
		result.repro.profile = header.profile;
	}
	result.durationMs = Date.now() - started;

	writeFileSync(join(request.outputDir, "trial.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
	// The runner reads this line from stdout.
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
	process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
	process.exit(1);
});
