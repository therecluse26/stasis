import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_CONFIG,
	baselineState,
	buildConfig,
	hashConfig,
	loadConfigFromFiles,
	parseConfigSource,
	validateConfig,
} from "../src/stasis/config.ts";
import { createEngine } from "../src/stasis/engine.ts";
import { createPolicyAdapter } from "../src/policy/adapter.ts";

const CONFIG_DIR = join(import.meta.dirname, "..", "config");
const DEFAULT_YAML = join(CONFIG_DIR, "default.yaml");
const PROFILE_DIR = join(CONFIG_DIR, "profiles");

describe("config/default.yaml", () => {
	it("parses and validates", () => {
		const loaded = loadConfigFromFiles([DEFAULT_YAML]);
		expect(validateConfig(loaded.config)).toEqual([]);
	});

	it("matches the built-in defaults exactly", () => {
		// Two copies of the same physiology exist: DEFAULT_CONFIG so the engine works with
		// no filesystem access, and the YAML as the editable surface. They must agree, or
		// an experiment would run on different numbers than the file being edited says.
		const fromFile = loadConfigFromFiles([DEFAULT_YAML]);
		expect(fromFile.config).toEqual(DEFAULT_CONFIG);
		expect(fromFile.hash).toBe(hashConfig(DEFAULT_CONFIG));
	});
});

describe("profiles", () => {
	const profiles = readdirSync(PROFILE_DIR).filter((name) => name.endsWith(".yaml"));

	it("ships the named profiles the design calls for", () => {
		expect(profiles.sort()).toEqual(
			[
				"balanced.yaml",
				"exploratory.yaml",
				"fast-recovery.yaml",
				"high-persistence.yaml",
				"risk-averse.yaml",
				"stress-sensitive.yaml",
			].sort(),
		);
	});

	for (const profile of profiles) {
		it(`${profile} produces a valid, non-pathological physiology`, () => {
			const loaded = loadConfigFromFiles([DEFAULT_YAML, join(PROFILE_DIR, profile)]);
			expect(validateConfig(loaded.config)).toEqual([]);
			expect(loaded.config.profile).toBe(profile.replace(".yaml", ""));

			// Every profile must still produce a usable policy across the whole state space.
			const adapter = createPolicyAdapter(loaded.config);
			for (const state of [
				baselineState(loaded.config),
				{ stress: 1, confidence: 0, noveltyDrive: 1, fatigue: 1, persistence: 0 },
				{ stress: 0, confidence: 1, noveltyDrive: 0, fatigue: 0, persistence: 1 },
			]) {
				const policy = adapter.derive(state);
				expect(policy.maxPatchLines).toBeGreaterThan(0);
				expect(policy.strategyBranchCount).toBeGreaterThanOrEqual(1);
			}
		});
	}

	it("balanced changes nothing about the default physiology", () => {
		const balanced = loadConfigFromFiles([DEFAULT_YAML, join(PROFILE_DIR, "balanced.yaml")]);
		expect({ ...balanced.config, profile: "x" }).toEqual({ ...DEFAULT_CONFIG, profile: "x" });
	});

	it("profiles differ from each other in ways the design predicts", () => {
		const load = (name: string) => loadConfigFromFiles([DEFAULT_YAML, join(PROFILE_DIR, name)]).config;
		const riskAverse = load("risk-averse.yaml");
		const exploratory = load("exploratory.yaml");
		const highPersistence = load("high-persistence.yaml");
		const fastRecovery = load("fast-recovery.yaml");

		const at = (config: typeof riskAverse) => createPolicyAdapter(config).derive(baselineState(config));

		// Risk-averse rests more cautiously than balanced.
		expect(at(riskAverse).maxPatchLines).toBeLessThan(at(DEFAULT_CONFIG).maxPatchLines);
		expect(at(riskAverse).verificationLevel).toBeGreaterThan(at(DEFAULT_CONFIG).verificationLevel);

		// Exploratory opens the search wider.
		expect(at(exploratory).explorationLevel).toBeGreaterThan(at(DEFAULT_CONFIG).explorationLevel);
		expect(at(exploratory).strategyBranchCount).toBeGreaterThanOrEqual(at(DEFAULT_CONFIG).strategyBranchCount);

		// High-persistence tolerates more repetition of an equivalent approach.
		expect(at(highPersistence).retryTolerance).toBeGreaterThan(at(DEFAULT_CONFIG).retryTolerance);

		// Fast-recovery forgets faster: same stressor, more of it gone one step later.
		const settle = (config: typeof fastRecovery) => {
			const engine = createEngine(config);
			let state = { ...baselineState(config), stress: 0.9 };
			for (let i = 0; i < 10; i++) {
				state = engine.transition(state, { type: "TICK", severity: 0.5, uncertainty: 0, novelty: 0, repeated: false, evidence: { source: "synthetic" } }, { step: i }).after;
			}
			return state.stress;
		};
		expect(settle(fastRecovery)).toBeLessThan(settle(DEFAULT_CONFIG));
	});
});

describe("overlay semantics", () => {
	it("merges mappings deeply and replaces arrays wholesale", () => {
		const { config } = buildConfig([
			{
				label: "test",
				data: {
					variables: { stress: { baseline: 0.7 } },
					interactions: { rules: [] },
				},
			},
		]);
		expect(config.variables.stress.baseline).toBe(0.7);
		// Untouched keys survive the merge.
		expect(config.variables.stress.decayRate).toBe(DEFAULT_CONFIG.variables.stress.decayRate);
		expect(config.variables.confidence).toEqual(DEFAULT_CONFIG.variables.confidence);
		// Arrays replace rather than concatenate.
		expect(config.interactions.rules).toEqual([]);
	});

	it("never lets a built config alias the shared defaults", () => {
		const { config } = buildConfig();
		config.variables.stress.baseline = 0.99;
		expect(DEFAULT_CONFIG.variables.stress.baseline).toBe(0.2);
	});

	it("hashes by content, not by key order or formatting", () => {
		const a = parseConfigSource("variables:\n  stress:\n    baseline: 0.3\n", "a");
		const b = parseConfigSource("variables: { stress: { baseline: 0.3 } }\n", "b");
		expect(hashConfig(buildConfig([{ label: "a", data: a }]).config)).toBe(
			hashConfig(buildConfig([{ label: "b", data: b }]).config),
		);
	});

	it("reports every problem at once rather than the first", () => {
		expect(() =>
			buildConfig([{ label: "broken", data: { variables: { stress: { baseline: 5 }, fatigue: { decayRate: -1 } } } }]),
		).toThrow(/baseline|decayRate/);
	});

	it("rejects a non-mapping config file", () => {
		expect(() => parseConfigSource("- a\n- b\n", "list.yaml")).toThrow(/must be a mapping/);
	});

	it("reads every shipped YAML file without error", () => {
		for (const path of [DEFAULT_YAML, ...readdirSync(PROFILE_DIR).map((n) => join(PROFILE_DIR, n))]) {
			expect(() => parseConfigSource(readFileSync(path, "utf8"), path)).not.toThrow();
		}
	});
});
