/**
 * The Pi extension: a thin adapter over `StasisRuntime`.
 *
 * Everything interesting lives behind `src/runtime/stasis-runtime.ts`, which knows
 * nothing about Pi. This file only translates — Pi events in, runtime calls out, runtime
 * decisions back into Pi's return shapes. Keeping it thin is what lets the causal chain
 * be tested without a harness, a model or a network.
 *
 * Two rules govern everything here:
 *
 *  1. **Every handler is wrapped.** An error inside a Pi event handler must degrade to a
 *     plain Pi session, never a broken one. This matters most for `tool_call`, which Pi
 *     does not wrap in a try/catch: a throw there *blocks the tool*, so an unguarded bug
 *     in this extension would silently paralyse the agent.
 *  2. **The model cannot reach physiology.** No tool is registered that writes state,
 *     commands are dispatched only from user input, and the stored history lives in a
 *     Pi entry type that is structurally excluded from LLM context.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { editChangedLines } from "./appraisal/appraiser.ts";
import type { StasisConfig } from "./stasis/config.ts";
import { STASIS_VARIABLES, type StasisState } from "./stasis/state.ts";
import { STASIS_STATE_ENTRY, findLatestSnapshot } from "./persistence/stasis-state-store.ts";
import { POLICY_FIELDS } from "./policy/policy.ts";
import { StasisRuntime } from "./runtime/stasis-runtime.ts";
import { type ResolveOptions, resolveConfig } from "./runtime/config-loader.ts";
import { createRecorder } from "./telemetry/recorder.ts";
import { renderPanel, renderPolicyChange, renderStatus } from "./ui/stasis-status.ts";
import { EXTENSION_VERSION } from "./version.ts";

const PACKAGE_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
const WIDGET_KEY = "stasis";

export interface StasisExtensionOptions extends Partial<Omit<ResolveOptions, "cwd" | "packageRoot">> {
	/** Identifies the arm of an experiment; recorded in the telemetry run header. */
	condition?: string;
	trial?: number;
	task?: string;
	/** Overrides telemetry destination; the experiment runner points this at its trial dir. */
	telemetryDir?: string;
}

function textOf(content: ToolResultEvent["content"]): string {
	return content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n")
		.trim();
}

function gitCommit(cwd: string): string | undefined {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

function piVersion(): string | undefined {
	try {
		const path = join(PACKAGE_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
		if (!existsSync(path)) return undefined;
		return (JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version;
	} catch {
		return undefined;
	}
}

/** Line count of an existing file, for sizing a whole-file write. */
function existingLineCount(cwd: string): (path: string) => number | undefined {
	return (path) => {
		try {
			const full = resolve(cwd, path);
			if (!existsSync(full)) return undefined;
			return readFileSync(full, "utf8").split("\n").length;
		} catch {
			return undefined;
		}
	};
}

function formatValue(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

/**
 * Build the extension factory.
 *
 * Exported separately from the default export so the experiment runner can construct an
 * in-memory extension with an explicit configuration, which is how a trial's condition is
 * selected without touching the filesystem.
 */
export function createStasisExtension(options: StasisExtensionOptions = {}) {
	return function stasisExtension(pi: ExtensionAPI): void {
		let runtime: StasisRuntime | undefined;
		let previousState: StasisState | undefined;
		let startupWarnings: string[] = [];
		let lastPolicyNotice: string | undefined;

		/**
		 * Guard for every handler.
		 *
		 * On error the extension disables itself for the session and returns `fallback`.
		 * The agent keeps working; the failure is recorded and surfaced once.
		 */
		function safe<T>(label: string, fallback: T, fn: () => T): T {
			try {
				return fn();
			} catch (error) {
				try {
					runtime?.fault(error as Error);
					// eslint-disable-next-line no-console
					console.error(`[stasis] disabled after error in ${label}:`, error);
				} catch {
					// Nothing further to do; never rethrow out of a Pi handler.
				}
				return fallback;
			}
		}

		async function safeAsync<T>(label: string, fallback: T, fn: () => Promise<T>): Promise<T> {
			try {
				return await fn();
			} catch (error) {
				try {
					runtime?.fault(error as Error);
					// eslint-disable-next-line no-console
					console.error(`[stasis] disabled after error in ${label}:`, error);
				} catch {
					// swallow
				}
				return fallback;
			}
		}

		function config(): StasisConfig | undefined {
			return runtime?.loaded.config;
		}

		function refreshDisplay(ctx: ExtensionContext): void {
			const active = runtime;
			if (!active || ctx.mode !== "tui") return;
			const display = active.loaded.config.runtime.display;
			if (display === "off") {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				ctx.ui.setStatus(WIDGET_KEY, undefined);
				return;
			}
			const view = {
				state: active.state,
				policy: active.policy,
				previous: previousState,
				mode: active.mode,
				enabled: active.enabled,
				theme: (color: string, text: string) => ctx.ui.theme.fg(color as never, text),
			};
			ctx.ui.setStatus(WIDGET_KEY, renderStatus(view));
			ctx.ui.setWidget(WIDGET_KEY, display === "panel" ? renderPanel(view) : undefined, {
				placement: "aboveEditor",
			});
		}

		function persist(): void {
			if (!runtime) return;
			pi.appendEntry(STASIS_STATE_ENTRY, runtime.snapshot());
		}

		// -------------------------------------------------------------------
		// Session lifecycle
		// -------------------------------------------------------------------

		pi.on("session_start", async (event, ctx) => {
			safe("session_start", undefined, () => {
				const resolution = resolveConfig({
					cwd: ctx.cwd,
					packageRoot: PACKAGE_ROOT,
					profile: options.profile,
					mode: options.mode,
					env: options.env,
					envFiles: options.envFiles,
					extraFiles: options.extraFiles,
					inline: options.inline,
				});
				startupWarnings = resolution.warnings;

				const runtimeConfig = resolution.loaded.config.runtime;
				const sessionId = ctx.sessionManager.getSessionId() ?? "ephemeral";
				runtime = new StasisRuntime({
					loaded: resolution.loaded,
					sessionId,
					cwd: ctx.cwd,
					existingLineCount: existingLineCount(ctx.cwd),
					recorder: createRecorder({
						enabled: runtimeConfig.telemetryEnabled,
						target: options.telemetryDir ?? runtimeConfig.telemetryDir,
						cwd: ctx.cwd,
						sessionId,
						historyLimit: runtimeConfig.historyLimit,
						onError: () => {
							/* telemetry is best-effort; a failed sink must not disturb the agent */
						},
					}),
				});

				// Resuming or forking: pick up where the branch left off.
				const restored = runtime.restore(findLatestSnapshot(ctx.sessionManager));
				runtime.recordRunHeader({
					piVersion: piVersion(),
					gitCommit: gitCommit(ctx.cwd),
					model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
					condition: options.condition,
					trial: options.trial,
					task: options.task,
				});
				runtime.recordLifecycle(event.reason === "startup" ? "session_start" : "session_resume", event.reason, restored);

				previousState = runtime.state;
				refreshDisplay(ctx);

				if (ctx.hasUI && startupWarnings.length > 0) {
					ctx.ui.notify(`stasis: ${startupWarnings.join("; ")}`, "warning");
				}
			});
		});

		// A fork or tree navigation changes the active branch, so state must be rebuilt
		// from that branch rather than carried over from the abandoned one.
		pi.on("session_tree", async (_event, ctx) => {
			safe("session_tree", undefined, () => {
				if (!runtime) return;
				const restored = runtime.restore(findLatestSnapshot(ctx.sessionManager));
				if (!restored) runtime.reset();
				previousState = runtime.state;
				refreshDisplay(ctx);
			});
		});

		pi.on("session_shutdown", async (_event, _ctx) => {
			safe("session_shutdown", undefined, () => {
				if (!runtime) return;
				runtime.recordLifecycle("session_shutdown");
				persist();
				runtime.recorder.close();
			});
		});

		// -------------------------------------------------------------------
		// Observation: tool results drive physiology
		// -------------------------------------------------------------------

		pi.on("tool_result", async (event, ctx) => {
			safe("tool_result", undefined, () => {
				if (!runtime || !runtime.enabled) return;

				const changedLines =
					event.toolName === "edit"
						? editChangedLines(event.input)
						: event.toolName === "write"
							? String((event.input as { content?: unknown }).content ?? "").split("\n").length
							: undefined;

				const result = runtime.observeToolResult({
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					input: event.input,
					text: textOf(event.content),
					isError: event.isError,
					details: (event as { details?: unknown }).details,
					changedLines,
				});

				if (result.policyChanged) {
					const last = result.transitions.at(-1);
					const first = result.transitions[0];
					if (last && first) {
						lastPolicyNotice = renderPolicyChange(
							Object.fromEntries(
								POLICY_FIELDS.filter((field) => first.policy[field] !== last.policy[field]).map((field) => [
									field,
									[first.policy[field], last.policy[field]] as [number, number],
								]),
							),
							last.event.type,
						);
					}
				}

				refreshDisplay(ctx);
			});
		});

		// -------------------------------------------------------------------
		// Enforcement: policy applied before a tool runs
		// -------------------------------------------------------------------

		pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
			// Pi does not wrap this handler: an uncaught throw here blocks the tool. The
			// guard's fallback is therefore "allow", so a bug in this extension can never
			// paralyse the agent.
			return safe<{ block: true; reason: string } | undefined>("tool_call", undefined, () => {
				if (!runtime || !runtime.enabled) return undefined;

				const decision = runtime.reviewToolCall({
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					input: event.input as Record<string, unknown>,
				});

				if (!decision.block) return undefined;

				if (ctx.hasUI && ctx.mode === "tui") {
					ctx.ui.notify(`stasis: blocked ${event.toolName} (${decision.rule})`, "warning");
				}
				refreshDisplay(ctx);
				return { block: true, reason: decision.reason ?? "Blocked by stasis policy" };
			});
		});

		// -------------------------------------------------------------------
		// Influence: state reaches the model
		// -------------------------------------------------------------------

		// Static protocol text, once per user turn. Constant within a session, so prompt
		// caching is unaffected.
		pi.on("before_agent_start", async (event, _ctx) => {
			return safe<{ systemPrompt: string } | undefined>("before_agent_start", undefined, () => {
				const addendum = runtime?.systemPromptAddendum();
				if (!addendum) return undefined;
				return { systemPrompt: `${event.systemPrompt}\n\n${addendum}` };
			});
		});

		// The dynamic block, recomputed before every LLM call so a failing test reaches
		// the model on the very next call inside the same turn. Appended at the tail,
		// which keeps the cached prefix intact.
		pi.on("context", async (event, _ctx) => {
			return safe<{ messages: typeof event.messages } | undefined>("context", undefined, () => {
				const block = runtime?.contextBlock();
				if (!block) return undefined;
				return {
					messages: [...event.messages, { role: "user", content: [{ type: "text", text: block }], timestamp: Date.now() }],
				};
			});
		});

		// -------------------------------------------------------------------
		// Turn boundary
		// -------------------------------------------------------------------

		pi.on("turn_end", async (event, ctx) => {
			safe("turn_end", undefined, () => {
				if (!runtime || !runtime.enabled) return;
				runtime.endTurn(event.turnIndex);
				persist();
				refreshDisplay(ctx);
				if (lastPolicyNotice && ctx.hasUI && ctx.mode === "tui") {
					ctx.ui.notify(`stasis: ${lastPolicyNotice}`, "info");
					lastPolicyNotice = undefined;
				}
				previousState = runtime.state;
			});
		});

		// -------------------------------------------------------------------
		// Commands
		// -------------------------------------------------------------------

		const SUBCOMMANDS = ["status", "history", "reset", "enable", "disable", "config", "debug", "export"];

		pi.registerCommand("stasis", {
			description: "Inspect and control the synthetic physiology",
			getArgumentCompletions: (prefix) => {
				const matches = SUBCOMMANDS.filter((name) => name.startsWith(prefix.trim()));
				return matches.length > 0 ? matches.map((name) => ({ value: name, label: name })) : null;
			},
			handler: async (args, ctx) => {
				await safeAsync("command", undefined, async () => {
					const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
					await handleCommand(sub, rest, ctx);
				});
			},
		});

		async function handleCommand(sub: string, rest: string[], ctx: ExtensionCommandContext): Promise<void> {
			const active = runtime;
			if (!active) {
				ctx.ui.notify("stasis: not initialized yet", "warning");
				return;
			}

			switch (sub) {
				case "status": {
					const state = active.state;
					const policy = active.policy;
					const lines = [
						`stasis ${active.enabled ? active.mode : "disabled"}  profile ${active.loaded.config.profile}  config ${active.loaded.hash}`,
						"",
						...STASIS_VARIABLES.map((variable) => `  ${variable.padEnd(13)}${state[variable].toFixed(3)}`),
						"",
						`  policy       ${policy.regime}`,
						...POLICY_FIELDS.map((field) => `  ${field.padEnd(28)}${formatValue(policy[field])}`),
						"",
						`  transitions  ${active.transitionCount}`,
						`  telemetry    ${active.recorder.path ?? "(memory only)"}`,
					];
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				case "history": {
					const limit = Number(rest[0]) || 15;
					const history = active.history(limit);
					if (history.length === 0) {
						ctx.ui.notify("stasis: no transitions yet", "info");
						return;
					}
					const lines = history.map((record) => {
						const moved = STASIS_VARIABLES.filter(
							(variable) => record.stateBefore[variable] !== record.stateAfter[variable],
						)
							.map((variable) => `${variable.slice(0, 4)} ${record.stateAfter[variable].toFixed(2)}`)
							.join(" ");
						return `  ${String(record.step).padStart(4)} ${record.event.type.padEnd(24)} ${moved}`;
					});
					ctx.ui.notify([`last ${history.length} transitions`, ...lines].join("\n"), "info");
					return;
				}

				case "reset": {
					active.reset();
					persist();
					previousState = active.state;
					refreshDisplay(ctx);
					ctx.ui.notify("stasis: state reset to configured baselines", "info");
					return;
				}

				case "enable":
				case "disable": {
					active.setEnabled(sub === "enable");
					persist();
					refreshDisplay(ctx);
					ctx.ui.notify(`stasis: ${sub}d`, "info");
					return;
				}

				case "config": {
					const cfg = active.loaded.config;
					const lines = [
						`profile ${cfg.profile}  version ${cfg.version}  hash ${active.loaded.hash}`,
						`sources: ${active.loaded.sources.join(" -> ")}`,
						"",
						"variables (baseline / decay / maxDelta)",
						...STASIS_VARIABLES.map((variable) => {
							const spec = cfg.variables[variable];
							return `  ${variable.padEnd(13)}${spec.baseline.toFixed(2)}  ${spec.decayRate.toFixed(3)}  ${spec.maxDeltaPerEvent.toFixed(2)}`;
						}),
						"",
						`enforcement: ${cfg.enforcement.enabled ? "on" : "off"}  patch ${cfg.enforcement.patchLimit} retry ${cfg.enforcement.retryLimit} gate ${cfg.enforcement.verificationGate} guardBash ${cfg.enforcement.guardBash}`,
						`display: ${cfg.runtime.display}  telemetry: ${cfg.runtime.telemetryEnabled ? "on" : "off"}`,
						...(startupWarnings.length > 0 ? ["", "warnings:", ...startupWarnings.map((w) => `  ${w}`)] : []),
					];
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				case "debug": {
					const records = active.recentRecords(Number(rest[0]) || 12);
					const lines = records.map((record) => {
						if (record.type === "transition") {
							const reasons = record.reasons
								.map((reason) => `${reason.kind}:${reason.variable}${reason.amount >= 0 ? "+" : ""}${reason.amount.toFixed(3)}`)
								.join(" ");
							return `  ${String(record.step).padStart(4)} ${record.event.type} sev ${record.event.severity.toFixed(2)}${record.suppressed ? " [suppressed]" : ""}\n       ${reasons}`;
						}
						if (record.type === "enforcement") {
							return `  ${String(record.step).padStart(4)} ${record.blocked ? "BLOCK" : "relaxed"} ${record.rule} ${record.toolName} ${JSON.stringify(record.detail ?? {})}`;
						}
						if (record.type === "bypass_suspected") {
							return `  ${String(record.step).padStart(4)} BYPASS? ${record.constructs.join(",")} :: ${record.command.slice(0, 80)}`;
						}
						if (record.type === "appraisal") {
							return `  ${String(record.step).padStart(4)} appraise ${record.toolName}${record.isError ? " (error)" : ""} -> ${record.events.map((e) => e.type).join(", ")}${record.repeatCount ? ` x${record.repeatCount}` : ""}`;
						}
						return `  ${String(record.step).padStart(4)} ${record.type}`;
					});
					ctx.ui.notify([`last ${records.length} records`, ...lines].join("\n"), "info");
					return;
				}

				case "export": {
					const path = active.recorder.path;
					ctx.ui.notify(
						path ? `stasis: telemetry at ${path}` : "stasis: telemetry disabled; nothing written to disk",
						"info",
					);
					return;
				}

				default:
					ctx.ui.notify(`stasis: unknown subcommand "${sub}". Try: ${SUBCOMMANDS.join(", ")}`, "warning");
			}
		}
	};
}

/** Default export: what Pi loads from `.pi/extensions` or `-e`. */
export default function stasis(pi: ExtensionAPI): void {
	createStasisExtension()(pi);
}

export { EXTENSION_VERSION };
