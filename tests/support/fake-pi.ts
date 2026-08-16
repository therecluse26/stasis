/**
 * A test double for Pi's extension host.
 *
 * Faithful to the parts of the contract this extension depends on, verified against the
 * installed `@earendil-works/pi-coding-agent` types:
 *
 *  - handlers registered via `pi.on` are invoked with `(event, ctx)`
 *  - a `tool_call` handler returning `{ block: true }` prevents execution
 *  - a `context` handler returning `{ messages }` replaces the outgoing message array
 *  - a `before_agent_start` handler returning `{ systemPrompt }` replaces the prompt
 *  - `pi.appendEntry` writes a `custom` entry onto the current branch
 *  - `ctx.ui.*` is safe to call and does nothing outside a real terminal
 *
 * Using a double rather than a live Pi session keeps the whole suite runnable with no
 * model, no credentials and no network, which is what makes it useful as a regression
 * gate rather than an occasional manual check.
 */

import type { BranchEntry } from "../../src/persistence/neuro-state-store.ts";

export interface FakeToolResult {
	toolName: string;
	toolCallId?: string;
	input: Record<string, unknown>;
	text: string;
	isError?: boolean;
	details?: unknown;
}

export interface FakeToolCall {
	toolName: string;
	toolCallId?: string;
	input: Record<string, unknown>;
}

export interface RecordedNotification {
	message: string;
	level: string;
}

type Handler = (event: unknown, ctx: unknown) => unknown;

export class FakePi {
	readonly handlers = new Map<string, Handler[]>();
	readonly commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	readonly entries: BranchEntry[] = [];
	readonly notifications: RecordedNotification[] = [];
	readonly widgets = new Map<string, string[] | undefined>();
	readonly statuses = new Map<string, string | undefined>();

	private callCounter = 0;

	constructor(
		readonly cwd: string,
		readonly options: { mode?: "tui" | "print" | "json" | "rpc"; hasUI?: boolean; sessionId?: string } = {},
	) {}

	// --- the ExtensionAPI surface the extension uses -------------------------

	readonly api = {
		on: (event: string, handler: Handler) => {
			const list = this.handlers.get(event) ?? [];
			list.push(handler);
			this.handlers.set(event, list);
		},
		registerCommand: (
			name: string,
			options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> },
		) => {
			this.commands.set(name, options);
		},
		registerTool: () => {
			throw new Error("the neuro extension must not register tools: the model could then reach its own physiology");
		},
		appendEntry: (customType: string, data?: unknown) => {
			this.entries.push({ type: "custom", customType, data });
		},
		registerShortcut: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
	};

	// --- the ExtensionContext surface ---------------------------------------

	get ctx(): Record<string, unknown> {
		return {
			cwd: this.cwd,
			mode: this.options.mode ?? "tui",
			hasUI: this.options.hasUI ?? true,
			model: { provider: "openrouter", id: "test/model" },
			isIdle: () => true,
			sessionManager: {
				getSessionId: () => this.options.sessionId ?? "test-session",
				getSessionFile: () => undefined,
				getBranch: () => this.entries,
				getEntries: () => this.entries,
			},
			ui: {
				notify: (message: string, level = "info") => this.notifications.push({ message, level }),
				setWidget: (key: string, content: string[] | undefined) => this.widgets.set(key, content),
				setStatus: (key: string, text: string | undefined) => this.statuses.set(key, text),
				theme: { fg: (_color: string, text: string) => text },
				confirm: async () => false,
				select: async () => undefined,
				input: async () => undefined,
			},
		};
	}

	// --- firing events -------------------------------------------------------

	private async dispatch(event: string, payload: unknown): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const handler of this.handlers.get(event) ?? []) {
			results.push(await handler(payload, this.ctx));
		}
		return results;
	}

	async sessionStart(reason = "startup"): Promise<void> {
		await this.dispatch("session_start", { type: "session_start", reason });
	}

	async sessionTree(): Promise<void> {
		await this.dispatch("session_tree", { type: "session_tree", newLeafId: "x", oldLeafId: "y" });
	}

	async sessionShutdown(reason = "quit"): Promise<void> {
		await this.dispatch("session_shutdown", { type: "session_shutdown", reason });
	}

	/** Fire `tool_call`; returns the block decision, mirroring Pi's short-circuit. */
	async toolCall(call: FakeToolCall): Promise<{ block?: boolean; reason?: string } | undefined> {
		const payload = {
			type: "tool_call",
			toolName: call.toolName,
			toolCallId: call.toolCallId ?? `call-${++this.callCounter}`,
			input: call.input,
		};
		for (const handler of this.handlers.get("tool_call") ?? []) {
			const result = (await handler(payload, this.ctx)) as { block?: boolean; reason?: string } | undefined;
			if (result?.block) return result;
		}
		return undefined;
	}

	async toolResult(result: FakeToolResult): Promise<void> {
		await this.dispatch("tool_result", {
			type: "tool_result",
			toolName: result.toolName,
			toolCallId: result.toolCallId ?? `call-${++this.callCounter}`,
			input: result.input,
			content: [{ type: "text", text: result.text }],
			isError: result.isError ?? false,
			details: result.details,
		});
	}

	/** Fire `context` and return the messages that would actually be sent. */
	async buildContext(messages: Array<Record<string, unknown>> = []): Promise<Array<Record<string, unknown>>> {
		let current = messages;
		for (const handler of this.handlers.get("context") ?? []) {
			const result = (await handler({ type: "context", messages: current }, this.ctx)) as
				| { messages?: Array<Record<string, unknown>> }
				| undefined;
			if (result?.messages) current = result.messages;
		}
		return current;
	}

	/** Fire `before_agent_start` and return the resulting system prompt. */
	async buildSystemPrompt(base = "BASE PROMPT", prompt = "do the thing"): Promise<string> {
		let current = base;
		for (const handler of this.handlers.get("before_agent_start") ?? []) {
			const result = (await handler(
				{ type: "before_agent_start", prompt, systemPrompt: current, systemPromptOptions: { cwd: this.cwd } },
				this.ctx,
			)) as { systemPrompt?: string } | undefined;
			if (result?.systemPrompt !== undefined) current = result.systemPrompt;
		}
		return current;
	}

	async turnEnd(turnIndex: number): Promise<void> {
		await this.dispatch("turn_end", { type: "turn_end", turnIndex, message: {}, toolResults: [] });
	}

	async runCommand(name: string, args = ""): Promise<void> {
		const command = this.commands.get(name);
		if (!command) throw new Error(`no such command: ${name}`);
		await command.handler(args, this.ctx);
	}

	/** Text of the injected block, if the extension injected one. */
	async injectedBlock(): Promise<string | undefined> {
		const before: Array<Record<string, unknown>> = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
		const after = await this.buildContext(before);
		if (after.length === before.length) return undefined;
		const injected = after.at(-1) as { content?: Array<{ text?: string }> };
		return injected?.content?.[0]?.text;
	}

	lastNotification(): RecordedNotification | undefined {
		return this.notifications.at(-1);
	}
}

/** A bash result shaped exactly as Pi produces it for a non-zero exit. */
export function failingBash(command: string, output: string, exitCode = 1): FakeToolResult {
	return {
		toolName: "bash",
		input: { command },
		text: `${output}\n\nCommand exited with code ${exitCode}`,
		isError: true,
		// Pi resets details to {} on the error path.
		details: {},
	};
}

export function passingBash(command: string, output = "ok"): FakeToolResult {
	return { toolName: "bash", input: { command }, text: output, isError: false, details: {} };
}
