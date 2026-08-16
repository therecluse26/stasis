/**
 * The extension inside a real Pi session.
 *
 * Everything else in this suite exercises the extension through a test double. That
 * proves the logic but not the wiring: whether Pi actually calls these handlers, whether
 * a `context` return value really reaches the provider, whether `{ block: true }` really
 * stops a tool in the agent loop.
 *
 * Pi ships a scriptable faux provider, so those questions can be answered against the
 * genuine harness with no credentials and no network — the model's turns are scripted,
 * everything else is the real Pi runtime.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNeuroExtension } from "../src/extension.ts";
import { parseTelemetry } from "../src/telemetry/schema.ts";

let workdir: string;

beforeEach(() => {
	workdir = mkdtempSync(join(tmpdir(), "neuro-live-"));
	writeFileSync(join(workdir, "app.js"), "export const value = 1;\n", "utf8");
	// A genuinely failing test, so the scripted `node --test` call produces a real
	// non-zero exit for the extension to appraise.
	writeFileSync(join(workdir, "package.json"), '{ "name": "live", "type": "module", "private": true }\n', "utf8");
	writeFileSync(
		join(workdir, "app.test.js"),
		"import assert from 'node:assert/strict';\nimport { test } from 'node:test';\ntest('value is two', () => {\n  assert.equal(1, 2);\n});\n",
		"utf8",
	);
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

interface Harness {
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	faux: ReturnType<typeof fauxProvider>;
	telemetryPath: string;
	/**
	 * The context handed to the model on each call, captured inside the provider itself.
	 *
	 * This is the authoritative view of what the model actually saw: it is taken after
	 * Pi has run every `context` handler and assembled the request, so anything visible
	 * here genuinely reached the model, and anything absent genuinely did not.
	 */
	contexts: string[];
}

async function startSession(options: { mode?: "active" | "observer" | "static" | "off" } = {}): Promise<Harness> {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4096 }] });
	const telemetryPath = join(workdir, "neuro.jsonl");
	const contexts: string[] = [];

	const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });

	const resourceLoader = new DefaultResourceLoader({
		cwd: workdir,
		agentDir: join(workdir, "agent"),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "You are a test agent.",
		extensionFactories: [
			// Registers the scripted provider so the real agent loop has something to talk to.
			{ name: "faux-registrar", factory: (pi) => pi.registerProvider(faux.provider) },
			{
				name: "neuro",
				factory: createNeuroExtension({
					mode: options.mode ?? "active",
					telemetryDir: telemetryPath,
					env: {} as NodeJS.ProcessEnv,
				}),
			},
		],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: workdir,
		agentDir: join(workdir, "agent"),
		model: faux.models[0] as never,
		modelRuntime,
		resourceLoader,
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		sessionManager: SessionManager.inMemory(),
		tools: ["read", "bash", "edit", "write"],
	});

	// createAgentSession() loads extensions but does not activate them. Without this the
	// handlers never fire and every condition behaves identically — a study would compare
	// control against control and report it as a result.
	await session.bindExtensions({ mode: "print" });

	return { session, faux, telemetryPath, contexts };
}

function telemetry(path: string) {
	try {
		return parseTelemetry(readFileSync(path, "utf8"));
	} catch {
		return [];
	}
}

/**
 * Wrap a scripted response so the context Pi assembled for it is captured first.
 *
 * The faux provider hands its factory the same `Context` a real provider would receive,
 * which is the closest thing to asking the model what it saw.
 */
function capturing(contexts: string[], message: ReturnType<typeof fauxAssistantMessage>) {
	return (context: unknown) => {
		contexts.push(JSON.stringify(context));
		return message;
	};
}

describe("inside a real Pi session", () => {
	it("observes a failing command and reaches the next model call with a tighter policy", async () => {
		const harness = await startSession();
		harness.faux.setResponses([
			capturing(
				harness.contexts,
				fauxAssistantMessage([fauxToolCall("bash", { command: "node --test" })], { stopReason: "toolUse" }),
			),
			capturing(harness.contexts, fauxAssistantMessage([fauxText("I see the failure.")], { stopReason: "stop" })),
		]);

		await harness.session.prompt("Fix the failing test.");

		const records = telemetry(harness.telemetryPath);
		const transitions = records.filter((record) => record.type === "transition");
		expect(transitions.length).toBeGreaterThan(0);

		// Pi really ran our appraisal on a real tool result.
		const appraisals = records.filter((record) => record.type === "appraisal");
		expect(appraisals.length).toBeGreaterThan(0);

		// And the block really reached the model on both calls.
		expect(harness.contexts.length).toBeGreaterThanOrEqual(2);
		for (const context of harness.contexts) {
			expect(context).toContain("CURRENT OPERATING STATE");
		}

		// The second call must carry a tighter limit than the first: the failing command
		// changed the policy the model sees, inside a single turn.
		const limitOf = (context: string) => Number(/patch limit[^\d]*(\d+) lines/.exec(context)?.[1]);
		expect(limitOf(harness.contexts.at(-1)!)).toBeLessThan(limitOf(harness.contexts[0]!));

		harness.session.dispose();
	});

	it("injects nothing in observer mode", async () => {
		const harness = await startSession({ mode: "observer" });
		harness.faux.setResponses([
			capturing(harness.contexts, fauxAssistantMessage([fauxText("nothing to do")], { stopReason: "stop" })),
		]);

		await harness.session.prompt("Have a look.");

		expect(harness.contexts.length).toBeGreaterThan(0);
		for (const context of harness.contexts) {
			expect(context).not.toContain("CURRENT OPERATING STATE");
			expect(context).not.toContain("Operating constraints");
		}
		harness.session.dispose();
	});

	it("really blocks an oversized edit in the agent loop", async () => {
		const harness = await startSession();
		const huge = Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n");
		harness.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: "app.js", content: huge })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("blocked, understood")], { stopReason: "stop" }),
		]);

		await harness.session.prompt("Rewrite app.js entirely.");

		// The tool result Pi produced must carry our refusal...
		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults.length).toBeGreaterThan(0);
		expect(JSON.stringify(toolResults)).toContain("BLOCKED_BY_NEURO_POLICY");

		// ...and the file must be untouched on disk.
		expect(readFileSync(join(workdir, "app.js"), "utf8")).toBe("export const value = 1;\n");

		const blocks = telemetry(harness.telemetryPath).filter(
			(record) => record.type === "enforcement" && record.blocked,
		);
		expect(blocks.length).toBeGreaterThan(0);

		harness.session.dispose();
	});

	it("persists state where the model cannot see it", async () => {
		const harness = await startSession();
		harness.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "node --test" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")], { stopReason: "stop" }),
		]);

		await harness.session.prompt("Run the tests.");

		// Pi's own context builder is the authority on what the model sees.
		const context = JSON.stringify(harness.session.messages);
		expect(context).not.toContain("neuro:state");
		expect(context).not.toContain("stateBefore");

		harness.session.dispose();
	});

	it("leaves the session working when neuromodulation is off", async () => {
		const harness = await startSession({ mode: "off" });
		harness.faux.setResponses([fauxAssistantMessage([fauxText("hello")], { stopReason: "stop" })]);

		await harness.session.prompt("Say hello.");
		expect(harness.session.messages.some((message) => message.role === "assistant")).toBe(true);
		harness.session.dispose();
	});
});
