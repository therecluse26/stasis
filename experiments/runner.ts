/**
 * Study runner.
 *
 *     npm run experiment -- experiments/benchmarks/repeated-failure-study.yaml
 *     npm run experiment -- <benchmark> --trials 3 --conditions control,stasis --task bug-001-repeat-trap
 *     npm run experiment -- <benchmark> --dry-run
 *
 * Trials are interleaved across conditions rather than run in blocks, so that drift in
 * the provider over the course of a study — latency, routing, model updates — lands on
 * every arm evenly instead of on whichever arm ran last.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEnvFiles, describeEnvValues } from "../src/runtime/env-file.ts";
import { loadBenchmark } from "./benchmark.ts";
import { renderReport, summarize } from "./analysis.ts";
import { CONDITION_MODES, type Benchmark, type Condition, type TrialRequest, type TrialResult } from "./types.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface CliOptions {
	benchmarkPath: string;
	trials?: number;
	conditions?: Condition[];
	tasks?: string[];
	outputRoot: string;
	dryRun: boolean;
	concurrency?: number;
	/**
	 * An explicit `.env`, instead of the conventional `.env` / `.env.local`.
	 *
	 * Spelled `--dotenv` rather than the obvious `--env-file` because Node claims that
	 * name for itself anywhere in argv, even after the script — `node script.js
	 * --env-file x` never reaches the script at all. Do not "fix" this back.
	 */
	envFile?: string;
	/** Ignore `.env` files entirely and use only what the shell provides. */
	noEnvFile: boolean;
}

function parseArgs(argv: string[]): CliOptions {
	const positional: string[] = [];
	const flags = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg.startsWith("--")) {
			const [name, inline] = arg.slice(2).split("=", 2);
			if (inline !== undefined) flags.set(name!, inline);
			else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) flags.set(name!, argv[++i]!);
			else flags.set(name!, "true");
		} else {
			positional.push(arg);
		}
	}

	const benchmarkPath = positional[0];
	if (!benchmarkPath) {
		throw new Error(
			"usage: npm run experiment -- <benchmark.yaml> [--trials N] [--conditions a,b] [--task id]\n" +
				"                            [--dotenv PATH] [--no-dotenv]",
		);
	}

	return {
		benchmarkPath: resolve(benchmarkPath),
		trials: flags.has("trials") ? Number(flags.get("trials")) : undefined,
		conditions: flags.has("conditions") ? (flags.get("conditions")!.split(",") as Condition[]) : undefined,
		tasks: flags.has("task") ? flags.get("task")!.split(",") : undefined,
		outputRoot: resolve(flags.get("out") ?? join(PACKAGE_ROOT, "runs")),
		dryRun: flags.get("dry-run") === "true",
		concurrency: flags.has("concurrency") ? Number(flags.get("concurrency")) : undefined,
		envFile: flags.get("dotenv"),
		noEnvFile: flags.get("no-dotenv") === "true",
	};
}

/** Shorten a path for display when it sits inside the repository. */
function displayPath(path: string): string {
	const inside = relative(PACKAGE_ROOT, path);
	return inside.startsWith("..") ? path : inside;
}

function runTrial(request: TrialRequest): Promise<TrialResult> {
	return new Promise((resolvePromise) => {
		const encoded = Buffer.from(JSON.stringify(request)).toString("base64");
		const child = spawn("npx", ["tsx", join(PACKAGE_ROOT, "experiments", "trial.ts"), encoded], {
			cwd: PACKAGE_ROOT,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});

		// A hard ceiling above the in-trial timeout, in case the child itself wedges.
		const kill = setTimeout(() => child.kill("SIGKILL"), (request.timeoutSeconds + 180) * 1000);

		child.on("close", () => {
			clearTimeout(kill);
			const line = stdout.trim().split("\n").filter(Boolean).at(-1);
			if (line) {
				try {
					resolvePromise(JSON.parse(line) as TrialResult);
					return;
				} catch {
					// fall through to the failure record below
				}
			}
			resolvePromise(failedTrial(request, stderr.slice(-1500) || "trial produced no result"));
		});
	});
}

function failedTrial(request: TrialRequest, error: string): TrialResult {
	return {
		benchmark: request.benchmark,
		taskId: request.task.id,
		condition: request.condition,
		trial: request.trial,
		success: false,
		visiblePassed: false,
		error,
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
		metrics: {} as TrialResult["metrics"],
		repro: {
			extensionVersion: "unknown",
			mode: CONDITION_MODES[request.condition],
			model: request.model,
			startedAt: new Date().toISOString(),
			nodeVersion: process.version,
			platform: process.platform,
		},
	};
}

/** Interleave trials so provider drift lands evenly across arms. */
function planTrials(benchmark: Benchmark, options: CliOptions, runDir: string, fixtures: Map<string, never>): TrialRequest[] {
	const conditions = options.conditions ?? benchmark.conditions;
	const trials = options.trials ?? benchmark.trials;
	const tasks = options.tasks ? benchmark.tasks.filter((task) => options.tasks!.includes(task.id)) : benchmark.tasks;

	const plan: TrialRequest[] = [];
	for (let trial = 1; trial <= trials; trial++) {
		for (const task of tasks) {
			for (const condition of conditions) {
				const fixture = fixtures.get(task.id) as never;
				plan.push({
					benchmark: benchmark.name,
					task,
					fixture,
					condition,
					trial,
					model: benchmark.model,
					profile: benchmark.profile,
					systemPrompt: benchmark.systemPrompt,
					maxTurns: task.maxTurns ?? benchmark.maxTurns,
					timeoutSeconds: task.timeoutSeconds ?? benchmark.timeoutSeconds,
					outputDir: join(runDir, task.id, condition, `trial-${trial}`),
					packageRoot: PACKAGE_ROOT,
				});
			}
		}
	}
	return plan;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));

	// Trials inherit this process's environment wholesale, so loading here is the only
	// place credentials need to arrive. Anything already set in the shell is left alone.
	const envLoad = applyEnvFiles({
		dirs: [PACKAGE_ROOT, process.cwd()],
		file: options.envFile,
		disabled: options.noEnvFile,
	});

	const { benchmark, fixtures } = loadBenchmark(options.benchmarkPath);

	// No Date.now in the physiology, but a study directory needs a name.
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const runDir = join(options.outputRoot, `${benchmark.name}-${stamp}`);
	const plan = planTrials(benchmark, options, runDir, fixtures as never);

	const conditions = options.conditions ?? benchmark.conditions;
	console.log(`\n${benchmark.name}`);
	if (benchmark.description) console.log(benchmark.description.trim());
	console.log(
		`\n  model        ${benchmark.model.provider}/${benchmark.model.model}${benchmark.model.thinkingLevel ? `:${benchmark.model.thinkingLevel}` : ""}`,
	);
	console.log(`  conditions   ${conditions.join(", ")}`);
	console.log(`  tasks        ${[...new Set(plan.map((request) => request.task.id))].join(", ")}`);
	console.log(`  trials       ${options.trials ?? benchmark.trials} per condition per task`);
	console.log(`  total runs   ${plan.length}`);
	console.log(`  output       ${runDir}`);
	if (envLoad.files.length > 0 && Object.keys(envLoad.values).length > 0) {
		console.log(`  env file     ${envLoad.files.map(displayPath).join(", ")} (${describeEnvValues(envLoad.values)})`);
	}
	for (const warning of envLoad.warnings) console.log(`  env warning  ${warning}`);
	if (benchmark.model.provider === "openrouter" && !benchmark.model.routing) {
		console.log(
			"\n  note: OpenRouter routing is not pinned. Upstream provider varies between\n" +
				"        requests, which adds variance unrelated to the hypothesis.",
		);
	}
	// A stale PI_STASIS_FAUX=1 in a dotfile would run the entire study against the scripted
	// agent while every trial looked healthy — the extensionInert guard cannot see it,
	// because the extension does run. Nobody typed this one, so say so.
	if (envLoad.values.PI_STASIS_FAUX === "1") {
		console.log(
			`\n  WARNING: PI_STASIS_FAUX=1 came from ${displayPath(envLoad.sources.PI_STASIS_FAUX!)}, not from your shell.\n` +
				"           Every trial will run against the scripted agent, not a real model.\n" +
				"           Remove it from the file, or pass --no-dotenv.",
		);
	}

	if (options.dryRun) {
		console.log("\ndry run: nothing executed.\n");
		for (const request of plan) {
			console.log(`  ${request.task.id.padEnd(24)} ${request.condition.padEnd(8)} trial ${request.trial}`);
		}
		return;
	}

	mkdirSync(runDir, { recursive: true });
	writeFileSync(
		join(runDir, "benchmark.json"),
		`${JSON.stringify(
			{
				benchmark,
				conditions,
				plannedTrials: plan.length,
				startedAt: new Date().toISOString(),
				// Names only. Which variables a file supplied is reproducibility metadata;
				// their values are not, and one of them is usually a credential.
				envFiles: envLoad.files,
				envFileKeys: Object.keys(envLoad.values).sort(),
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	const results: TrialResult[] = [];
	const concurrency = Math.max(1, options.concurrency ?? benchmark.concurrency);
	console.log("");

	let index = 0;
	async function worker(): Promise<void> {
		while (index < plan.length) {
			const current = index++;
			const request = plan[current]!;
			const label = `${request.task.id} ${request.condition} #${request.trial}`;
			console.log(`  [${current + 1}/${plan.length}] ${label} ...`);
			const result = await runTrial(request);
			results.push(result);
			const verdict = result.success ? "pass" : result.visiblePassed ? "visible-only" : "fail";
			const notes = [
				result.timedOut ? "timeout" : "",
				result.turnCapped ? "turn-cap" : "",
				result.error ? "error" : "",
			].filter(Boolean);
			console.log(
				`  [${current + 1}/${plan.length}] ${label}: ${verdict}  ${result.turns} turns  ${result.diffLines} diff lines  ${(result.durationMs / 1000).toFixed(0)}s${notes.length > 0 ? `  (${notes.join(", ")})` : ""}`,
			);
			writeFileSync(join(runDir, "results.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, plan.length) }, () => worker()));

	const summary = summarize(results);
	writeFileSync(join(runDir, "results.json"), `${JSON.stringify({ results, summary }, null, 2)}\n`, "utf8");
	console.log(renderReport(summary, results));
	console.log(`\nFull results: ${runDir}\n`);
}

main().catch((error) => {
	console.error(`\n${(error as Error).message}\n`);
	process.exit(1);
});
