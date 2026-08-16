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

export interface ConfigResolution {
	loaded: LoadedConfig;
	/** Non-fatal problems: files that could not be read or parsed, unknown profiles. */
	warnings: string[];
}

export interface ResolveOptions {
	cwd: string;
	/** Root of this package, used to find the shipped physiology and profiles. */
	packageRoot: string;
	profile?: string;
	mode?: StasisMode;
	env?: NodeJS.ProcessEnv;
	/** Extra overlay files, highest priority. Used by tests and the experiment runner. */
	extraFiles?: string[];
	/** Inline overlay applied last of all. Used by the experiment runner. */
	inline?: unknown;
}

const MODES: readonly StasisMode[] = ["active", "static", "observer", "off"];

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

export function resolveConfig(options: ResolveOptions): ConfigResolution {
	const env = options.env ?? process.env;
	const warnings: string[] = [];
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

	overlays.push({ label: "env", data: environmentOverlay(env, warnings) });
	if (options.mode) overlays.push({ label: "explicit-mode", data: { runtime: { mode: options.mode } } });
	if (options.inline !== undefined) overlays.push({ label: "inline", data: options.inline });

	try {
		return { loaded: buildConfig(overlays), warnings };
	} catch (error) {
		// A bad overlay must not prevent the session from starting. Fall back to the
		// built-in physiology and say loudly what was dropped, so a study is never
		// silently run on a configuration nobody chose.
		const detail = error instanceof StasisConfigError ? error.message : String(error);
		warnings.push(`Falling back to built-in physiology: ${detail}`);
		return { loaded: buildConfig(), warnings };
	}
}
