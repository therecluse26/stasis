/**
 * Benchmark and fixture loading.
 *
 * Nothing about the provider or model is hard-coded — a study says what it wants and the
 * runner resolves it against whatever Pi has configured.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { CONDITIONS, type Benchmark, type Condition, type FixtureDefinition } from "./types.ts";

export class BenchmarkError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BenchmarkError";
	}
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new BenchmarkError(`${what} must be a mapping`);
	}
	return value as Record<string, unknown>;
}

export function loadFixture(root: string): FixtureDefinition {
	const file = join(root, "fixture.yaml");
	if (!existsSync(file)) throw new BenchmarkError(`fixture is missing ${file}`);
	const raw = asRecord(parseYaml(readFileSync(file, "utf8")), file);

	const id = typeof raw.id === "string" ? raw.id : undefined;
	const prompt = typeof raw.prompt === "string" ? raw.prompt : undefined;
	const verify = typeof raw.verify === "string" ? raw.verify : undefined;
	if (!id || !prompt || !verify) {
		throw new BenchmarkError(`${file} requires id, prompt and verify`);
	}
	if (!existsSync(join(root, "workspace"))) {
		throw new BenchmarkError(`${root} requires a workspace/ directory`);
	}

	return {
		id,
		title: typeof raw.title === "string" ? raw.title : id,
		prompt,
		verify,
		timeoutSeconds: typeof raw.timeoutSeconds === "number" ? raw.timeoutSeconds : 900,
		maxTurns: typeof raw.maxTurns === "number" ? raw.maxTurns : 60,
		targets: Array.isArray(raw.targets) ? (raw.targets as string[]) : undefined,
		root,
	};
}

export function loadBenchmark(path: string): { benchmark: Benchmark; fixtures: Map<string, FixtureDefinition> } {
	if (!existsSync(path)) throw new BenchmarkError(`no such benchmark file: ${path}`);
	const raw = asRecord(parseYaml(readFileSync(path, "utf8")), path);
	const base = dirname(resolve(path));

	const name = typeof raw.name === "string" ? raw.name : undefined;
	if (!name) throw new BenchmarkError(`${path} requires a name`);

	const modelRaw = asRecord(raw.model ?? {}, `${path}: model`);
	if (typeof modelRaw.provider !== "string" || typeof modelRaw.model !== "string") {
		throw new BenchmarkError(`${path}: model requires provider and model`);
	}

	const conditions = (Array.isArray(raw.conditions) ? raw.conditions : ["control", "stasis"]) as Condition[];
	for (const condition of conditions) {
		if (!CONDITIONS.includes(condition)) {
			throw new BenchmarkError(`${path}: unknown condition "${condition}" (expected ${CONDITIONS.join(", ")})`);
		}
	}
	// A study needs something to compare against.
	if (conditions.length < 2) {
		throw new BenchmarkError(`${path}: a study needs at least two conditions to compare`);
	}

	const tasksRaw = Array.isArray(raw.tasks) ? raw.tasks : [];
	if (tasksRaw.length === 0) throw new BenchmarkError(`${path} requires at least one task`);

	const fixtures = new Map<string, FixtureDefinition>();
	const tasks = tasksRaw.map((entry, index) => {
		const task = asRecord(entry, `${path}: tasks[${index}]`);
		const fixturePath = typeof task.fixture === "string" ? task.fixture : undefined;
		if (!fixturePath) throw new BenchmarkError(`${path}: tasks[${index}] requires a fixture path`);
		const root = isAbsolute(fixturePath) ? fixturePath : resolve(base, fixturePath);
		const fixture = loadFixture(root);
		const id = typeof task.id === "string" ? task.id : fixture.id;
		fixtures.set(id, fixture);
		return {
			id,
			fixture: root,
			prompt: typeof task.prompt === "string" ? task.prompt : undefined,
			timeoutSeconds: typeof task.timeoutSeconds === "number" ? task.timeoutSeconds : undefined,
			maxTurns: typeof task.maxTurns === "number" ? task.maxTurns : undefined,
		};
	});

	const benchmark: Benchmark = {
		name,
		description: typeof raw.description === "string" ? raw.description : undefined,
		trials: typeof raw.trials === "number" ? raw.trials : 3,
		model: {
			provider: modelRaw.provider,
			model: modelRaw.model,
			thinkingLevel: typeof modelRaw.thinkingLevel === "string" ? modelRaw.thinkingLevel : undefined,
			routing: modelRaw.routing as { only?: string[]; order?: string[] } | undefined,
		},
		conditions,
		tasks,
		profile: typeof raw.profile === "string" ? raw.profile : undefined,
		systemPrompt: typeof raw.systemPrompt === "string" ? raw.systemPrompt : undefined,
		maxTurns: typeof raw.maxTurns === "number" ? raw.maxTurns : 60,
		timeoutSeconds: typeof raw.timeoutSeconds === "number" ? raw.timeoutSeconds : 900,
		concurrency: typeof raw.concurrency === "number" ? raw.concurrency : 1,
	};

	return { benchmark, fixtures };
}
