/**
 * Configuration discovery for a live session.
 *
 * Layers, each merged onto the last:
 *
 *   1. the physiology shipped with the extension (`config/default.yaml`)
 *   2. a named profile, if one was requested
 *   3. a project overlay, `<cwd>/.pi/stasis.yaml`
 *   4. a user overlay, `~/.pi/agent/stasis.yaml`
 *   5. an explicit file from `PI_STASIS_CONFIG`
 *   6. environment overrides for the few knobs a runner needs to set per trial
 *
 * Environment variables are the last layer because they are the only channel available
 * to the SDK experiment runner, which has no CLI flags to pass.
 *
 * `PI_STASIS_*` variables may also come from a `.env` file, ranked below the real
 * environment. Nothing else in a `.env` is read: a project this extension is visiting is
 * far more likely to keep its own secrets there than anything meant for Stasis.
 *
 * Loading never throws. A broken overlay is reported and skipped rather than taking down
 * the host session — a malformed YAML file in someone's home directory should not stop
 * them using Pi.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type LoadedConfig,
	type StasisMode,
	StasisConfigError,
	buildConfig,
	parseConfigSource,
} from "../stasis/config.ts";
import { envFileCandidates, readEnvFiles } from "./env-file.ts";

export interface ConfigResolution {
	loaded: LoadedConfig;
	/** Non-fatal problems: files that could not be read or parsed, unknown profiles. */
	warnings: string[];
	/** `.env` files that supplied at least one `PI_STASIS_*` value. */
	envFiles: string[];
}

export interface ResolveOptions {
	cwd: string;
	/** Root of this package, used to find the shipped physiology and profiles. */
	packageRoot: string;
	profile?: string;
	mode?: StasisMode;
	env?: NodeJS.ProcessEnv;
	/**
	 * `.env` files to consult, overriding the conventional candidates. Supplying this is
	 * the only way to combine an explicit `env` with file loading, which is what lets tests
	 * exercise the layering without depending on the checkout they run in.
	 */
	envFiles?: string[];
	/** Extra overlay files, highest priority. Used by tests and the experiment runner. */
	extraFiles?: string[];
	/** Inline overlay applied last of all. Used by the experiment runner. */
	inline?: unknown;
}

const MODES: readonly StasisMode[] = ["active", "static", "observer", "off"];

const STASIS_VARIABLE = /^PI_STASIS_/;

function readOverlay(path: string, warnings: string[]): { label: string; data: unknown } | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return { label: path, data: parseConfigSource(readFileSync(path, "utf8"), path) };
	} catch (error) {
		warnings.push(`Ignoring ${path}: ${(error as Error).message}`);
		return undefined;
	}
}

/** Overrides a runner or a user can set without editing a file. */
function environmentOverlay(env: NodeJS.ProcessEnv, warnings: string[]): unknown {
	const runtime: Record<string, unknown> = {};
	const enforcement: Record<string, unknown> = {};

	const mode = env.PI_STASIS_MODE;
	if (mode) {
		if ((MODES as readonly string[]).includes(mode)) runtime.mode = mode;
		else warnings.push(`Ignoring PI_STASIS_MODE=${mode}: expected one of ${MODES.join(", ")}`);
	}

	const display = env.PI_STASIS_DISPLAY;
	if (display) {
		if (["panel", "status", "off"].includes(display)) runtime.display = display;
		else warnings.push(`Ignoring PI_STASIS_DISPLAY=${display}: expected panel, status or off`);
	}

	if (env.PI_STASIS_TELEMETRY_DIR) runtime.telemetryDir = env.PI_STASIS_TELEMETRY_DIR;
	if (env.PI_STASIS_TELEMETRY === "0") runtime.telemetryEnabled = false;
	if (env.PI_STASIS_ENFORCE === "0") enforcement.enabled = false;
	if (env.PI_STASIS_GUARD_BASH === "1") enforcement.guardBash = true;

	const overlay: Record<string, unknown> = {};
	if (Object.keys(runtime).length > 0) overlay.runtime = runtime;
	if (Object.keys(enforcement).length > 0) overlay.enforcement = enforcement;
	return overlay;
}

/**
 * The environment to read, and which `.env` files shaped it.
 *
 * An explicitly supplied `env` is authoritative and complete — no file is consulted for
 * it. That is the seam that keeps a trial hermetic: `experiments/trial.ts` passes `{}`
 * precisely so no ambient variable can change one arm of a study, and it is what stops the
 * test suite depending on whichever `.env` happens to sit in this checkout.
 *
 * Only `PI_STASIS_*` keys are taken from a file, and only where the real environment has
 * not already spoken.
 */
function resolveEnv(options: ResolveOptions): { env: NodeJS.ProcessEnv; files: string[]; warnings: string[] } {
	if (options.env !== undefined && options.envFiles === undefined) {
		return { env: options.env, files: [], warnings: [] };
	}

	const load = readEnvFiles(options.envFiles ?? envFileCandidates([options.packageRoot, options.cwd]));
	const fromFile: Record<string, string> = {};
	const files: string[] = [];
	for (const [key, value] of Object.entries(load.values)) {
		if (!STASIS_VARIABLE.test(key)) continue;
		fromFile[key] = value;
		const source = load.sources[key];
		// Name only the files that actually contributed. A `.env` holding nothing but a
		// provider key did not shape this configuration and must not be listed as if it had.
		if (source !== undefined && !files.includes(source)) files.push(source);
	}

	return { env: { ...fromFile, ...(options.env ?? process.env) }, files, warnings: load.warnings };
}

export function resolveConfig(options: ResolveOptions): ConfigResolution {
	const ambient = resolveEnv(options);
	const env = ambient.env;
	const envFiles = ambient.files;
	const warnings: string[] = [...ambient.warnings];
	const overlays: Array<{ label: string; data: unknown }> = [];

	const shipped = readOverlay(join(options.packageRoot, "config", "default.yaml"), warnings);
	if (shipped) overlays.push(shipped);

	const profileName = options.profile ?? env.PI_STASIS_PROFILE;
	if (profileName) {
		const path = join(options.packageRoot, "config", "profiles", `${profileName}.yaml`);
		const profile = readOverlay(path, warnings);
		if (profile) overlays.push(profile);
		else warnings.push(`Unknown stasis profile "${profileName}" (looked in ${path})`);
	}

	for (const candidate of [
		join(options.cwd, ".pi", "stasis.yaml"),
		join(homedir(), ".pi", "agent", "stasis.yaml"),
		...(env.PI_STASIS_CONFIG ? [env.PI_STASIS_CONFIG] : []),
		...(options.extraFiles ?? []),
	]) {
		const overlay = readOverlay(candidate, warnings);
		if (overlay) overlays.push(overlay);
	}

	// The label carries provenance into `LoadedConfig.sources`, which is what `/stasis
	// config` prints and what the telemetry run header records. A value that came from a
	// file should never look like one that came from the shell.
	const envLabel = envFiles.length > 0 ? `env (+ ${envFiles.join(", ")})` : "env";
	overlays.push({ label: envLabel, data: environmentOverlay(env, warnings) });
	if (options.mode) overlays.push({ label: "explicit-mode", data: { runtime: { mode: options.mode } } });
	if (options.inline !== undefined) overlays.push({ label: "inline", data: options.inline });

	try {
		return { loaded: buildConfig(overlays), warnings, envFiles };
	} catch (error) {
		// A bad overlay must not prevent the session from starting. Fall back to the
		// built-in physiology and say loudly what was dropped, so a study is never
		// silently run on a configuration nobody chose.
		const detail = error instanceof StasisConfigError ? error.message : String(error);
		warnings.push(`Falling back to built-in physiology: ${detail}`);
		return { loaded: buildConfig(), warnings, envFiles };
	}
}
