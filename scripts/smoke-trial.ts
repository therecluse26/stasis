/**
 * Run one trial directly, bypassing the study runner.
 *
 *     npx tsx scripts/smoke-trial.ts [fixture-id] [condition]
 *
 * For checking the harness end to end against a real model without committing to a whole
 * study. Everything except the model call is exercised even with no credentials
 * configured, which makes this the fastest way to see that workspace preparation,
 * extension loading, grading and telemetry are wired correctly.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadFixture } from "../experiments/benchmark.ts";
import type { Condition, TrialRequest } from "../experiments/types.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const fixtureId = process.argv[2] ?? "bug-003-easy-control";
const condition = (process.argv[3] ?? "stasis") as Condition;

const fixture = loadFixture(join(PACKAGE_ROOT, "experiments", "fixtures", fixtureId));
const outputDir = mkdtempSync(join(tmpdir(), "stasis-smoke-"));

const request: TrialRequest = {
	benchmark: "smoke",
	task: { id: fixture.id, fixture: fixture.root },
	fixture,
	condition,
	trial: 1,
	model: {
		provider: process.env.PI_STASIS_SMOKE_PROVIDER ?? "openrouter",
		model: process.env.PI_STASIS_SMOKE_MODEL ?? "anthropic/claude-sonnet-4.5",
	},
	maxTurns: Number(process.env.PI_STASIS_SMOKE_TURNS ?? 20),
	timeoutSeconds: Number(process.env.PI_STASIS_SMOKE_TIMEOUT ?? 300),
	outputDir,
	packageRoot: PACKAGE_ROOT,
};

console.log(`fixture   ${fixture.id}`);
console.log(`condition ${condition}`);
console.log(`model     ${request.model.provider}/${request.model.model}`);
console.log(`output    ${outputDir}\n`);

const encoded = Buffer.from(JSON.stringify(request)).toString("base64");
const result = spawnSync("npx", ["tsx", join(PACKAGE_ROOT, "experiments", "trial.ts"), encoded], {
	cwd: PACKAGE_ROOT,
	stdio: "inherit",
	env: process.env,
});

process.exit(result.status ?? 1);
