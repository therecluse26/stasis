/**
 * Telemetry sink.
 *
 * JSONL, append-only, one file per session. Writes are synchronous and best-effort: a
 * telemetry failure must never disturb the agent, so every write is guarded and a broken
 * sink degrades to silence rather than throwing into a Pi event handler.
 *
 * The storage abstraction is deliberately thin — a `Recorder` is anything with `record`
 * and `close` — so swapping JSONL for SQLite later touches this file only.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { type NeuroTelemetryRecord, TELEMETRY_SCHEMA_VERSION } from "./schema.ts";

export interface Recorder {
	record(record: NeuroTelemetryRecord): void;
	/** Records held in memory, for `/neuro history` and for tests. */
	recent(limit?: number): NeuroTelemetryRecord[];
	readonly path: string | undefined;
	close(): void;
}

export interface RecorderOptions {
	enabled: boolean;
	/** Directory, or a full file path when it ends in `.jsonl`. */
	target: string;
	cwd: string;
	sessionId: string;
	/** Records retained in memory. */
	historyLimit: number;
	/** Injected in tests; production passes nothing and gets a real clock. */
	now?: () => Date;
	onError?: (error: Error) => void;
}

/** Keeps recent records in memory and never touches the filesystem. */
export function createMemoryRecorder(historyLimit = 200): Recorder {
	const history: NeuroTelemetryRecord[] = [];
	return {
		path: undefined,
		record(record) {
			history.push(record);
			if (history.length > historyLimit) history.splice(0, history.length - historyLimit);
		},
		recent(limit) {
			return limit === undefined ? [...history] : history.slice(-limit);
		},
		close() {},
	};
}

export function resolveTelemetryPath(options: Pick<RecorderOptions, "target" | "cwd" | "sessionId">): string {
	const base = isAbsolute(options.target) ? options.target : join(options.cwd, options.target);
	return base.endsWith(".jsonl") ? base : join(base, `${options.sessionId}.jsonl`);
}

export function createRecorder(options: RecorderOptions): Recorder {
	const history: NeuroTelemetryRecord[] = [];
	if (!options.enabled) {
		const memory = createMemoryRecorder(options.historyLimit);
		return memory;
	}

	const path = resolveTelemetryPath(options);
	let writable = true;

	try {
		mkdirSync(dirname(path), { recursive: true });
	} catch (error) {
		writable = false;
		options.onError?.(error as Error);
	}

	return {
		path,
		record(record) {
			history.push(record);
			if (history.length > options.historyLimit) history.splice(0, history.length - options.historyLimit);
			if (!writable) return;
			try {
				appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
			} catch (error) {
				// Stop trying rather than raising on every subsequent event.
				writable = false;
				options.onError?.(error as Error);
			}
		},
		recent(limit) {
			return limit === undefined ? [...history] : history.slice(-limit);
		},
		close() {},
	};
}

/** Fills in the fields every record shares, so call sites state only what differs. */
export function stamp<T extends NeuroTelemetryRecord>(
	partial: Omit<T, "schema" | "timestamp">,
	now: () => Date = () => new Date(),
): T {
	return { ...partial, schema: TELEMETRY_SCHEMA_VERSION, timestamp: now().toISOString() } as T;
}
