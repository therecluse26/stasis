/**
 * Grading.
 *
 * The agent works in a copy of `workspace/`. Grading takes the diff it produced, applies
 * it to a *pristine* copy, overlays the fixture's hidden tests, and runs them there.
 *
 * Two properties follow, and both matter:
 *
 *  - the grading tests are never present while the agent works, so editing the tests is
 *    not a route to passing
 *  - grading runs the visible tests too, so a change that fixes the reported bug by
 *    breaking something else is a failure rather than a success
 *
 * Visible and hidden outcomes are reported separately, because "passed the tests it could
 * see but not the contract" is a distinct and interesting result, not just a failure.
 */

import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isCredentialKey } from "../src/runtime/env-file.ts";
import type { FixtureDefinition } from "./types.ts";

/**
 * The environment a fixture's verification command runs in.
 *
 * Credentials are withheld. A fixture's tests exist to judge the agent's diff, they are
 * not part of the trusted harness, and once a provider key is loaded from `.env` it would
 * otherwise be sitting in the environment of every graded subprocess. Fixtures are offline
 * by construction, so there is nothing legitimate to take away.
 */
function gradingEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!isCredentialKey(key)) env[key] = value;
	}
	env.CI = "1";
	env.NO_COLOR = "1";
	return env;
}

export interface GradeResult {
	/** Hidden grading tests, plus the visible ones, all pass. */
	success: boolean;
	/** Only the tests the agent could see. */
	visiblePassed: boolean;
	diff: string;
	diffLines: number;
	filesModified: number;
	detail?: string;
}

function run(command: string, cwd: string, timeoutMs: number): { code: number; output: string } {
	try {
		const output = execSync(command, {
			cwd,
			timeout: timeoutMs,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: gradingEnv(),
		});
		return { code: 0, output };
	} catch (error) {
		const err = error as { status?: number; stdout?: string; stderr?: string; message?: string };
		return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}` };
	}
}

/** Prepare a fresh working copy of the fixture as a git repository. */
export function prepareWorkspace(fixture: FixtureDefinition, destination: string): void {
	rmSync(destination, { recursive: true, force: true });
	mkdirSync(destination, { recursive: true });
	cpSync(join(fixture.root, "workspace"), destination, { recursive: true });

	// A git repo gives a precise diff of what the agent changed, and lets grading apply
	// exactly that to a clean tree.
	execFileSync("git", ["init", "-q"], { cwd: destination });
	execFileSync("git", ["config", "user.email", "harness@stasis.local"], { cwd: destination });
	execFileSync("git", ["config", "user.name", "stasis harness"], { cwd: destination });
	execFileSync("git", ["add", "-A"], { cwd: destination });
	execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: destination });
}

/** The agent's changes, as a patch against the fixture's initial state. */
export function captureDiff(workdir: string): { diff: string; diffLines: number; filesModified: number } {
	try {
		execFileSync("git", ["add", "-A"], { cwd: workdir });
		const diff = execFileSync("git", ["diff", "--cached", "--", ".", ":!.pi"], {
			cwd: workdir,
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
		});
		const names = execFileSync("git", ["diff", "--cached", "--name-only", "--", ".", ":!.pi"], {
			cwd: workdir,
			encoding: "utf8",
		})
			.split("\n")
			.filter(Boolean);
		const diffLines = diff
			.split("\n")
			.filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")))
			.length;
		return { diff, diffLines, filesModified: names.length };
	} catch (error) {
		return { diff: "", diffLines: 0, filesModified: 0, ...{ error } };
	}
}

export function grade(fixture: FixtureDefinition, workdir: string, gradingDir: string): GradeResult {
	const captured = captureDiff(workdir);
	const timeoutMs = Math.max(60_000, fixture.timeoutSeconds * 1000);

	rmSync(gradingDir, { recursive: true, force: true });
	mkdirSync(gradingDir, { recursive: true });
	cpSync(join(fixture.root, "workspace"), gradingDir, { recursive: true });

	if (captured.diff.trim().length > 0) {
		const patchPath = join(gradingDir, ".agent.patch");
		writeFileSync(patchPath, captured.diff, "utf8");
		const applied = run(`git apply --whitespace=nowarn "${patchPath}"`, gradingDir, timeoutMs);
		rmSync(patchPath, { force: true });
		if (applied.code !== 0) {
			return {
				success: false,
				visiblePassed: false,
				...captured,
				detail: `could not apply the agent's diff to a clean tree: ${applied.output.slice(0, 500)}`,
			};
		}
	}

	// Visible tests first, on exactly what the agent left behind.
	const visible = run(fixture.verify, gradingDir, timeoutMs);

	// Then overlay the hidden tests and run everything together.
	const hidden = join(fixture.root, "grading");
	if (existsSync(hidden) && readdirSync(hidden).length > 0) {
		cpSync(hidden, gradingDir, { recursive: true });
	}
	const full = run(fixture.verify, gradingDir, timeoutMs);

	return {
		success: full.code === 0,
		visiblePassed: visible.code === 0,
		...captured,
		detail: full.code === 0 ? undefined : full.output.slice(-2000),
	};
}
