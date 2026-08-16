# Project plan — pi-neuro

Status as of 2026-08-16. This is the resumption document: what is built, what is not, and
what a future session needs to know before touching anything.

- **Architecture and rationale:** [DESIGN.md](DESIGN.md)
- **Usage:** [../README.md](../README.md)
- **Original specification:** [../prompts/INITIAL_PROMPT.md](../prompts/INITIAL_PROMPT.md)

**Where things stand:** the v0.1 Definition of Done is met. 216 tests pass, typecheck is
clean, and the full study pipeline has been run end to end with a scripted agent. The
system has **never been run against a real model** — there are no provider credentials on
this machine. Several events in the vocabulary are still never emitted; the significant
one is `STRATEGY_CHANGE`.

---

## Resuming quickly

```bash
npm install --ignore-scripts
npm test                     # 216 tests, no credentials needed
npm run typecheck
npm run demo:sequence        # deterministic replay, printed twice, asserted identical

# Exercise the whole study pipeline with a scripted agent — free, no network
PI_NEURO_FAUX=1 npm run experiment -- experiments/benchmarks/repeated-failure-study.yaml --trials 1
```

The first real task is almost certainly **[G1](#g1-strategy_change-never-fires)** below,
then a live smoke run.

---

## Milestones

### ✅ M1 — Pure physiology

Deterministic engine with no Pi dependency.

- [x] `NeuroState`, five variables in `[0,1]` — `src/neuro/state.ts`
- [x] `NeuroConfig` schema, loading, deep-merge overlays, content hashing — `src/neuro/config.ts`
- [x] `NeuromodulatorEngine.transition()` with fixed six-step order — `src/neuro/engine.ts`
- [x] Homeostatic restoring force, event-driven rather than wall-clock — `src/neuro/homeostasis.ts`
- [x] Cross-variable interactions, order-independent — `src/neuro/interactions.ts`
- [x] `PolicyAdapter`: ten policy fields from one bounded linear form — `src/policy/adapter.ts`
- [x] Quantization to 6dp so replays cannot drift
- [x] `config/default.yaml` + 6 named profiles, pinned to the built-in defaults by test
- [x] `validateDynamics()` rejects couplings that would overpower their target
- [x] Coefficient **sign constraints** validated at load, encoding the spec's behavioral requirements
- [x] Tests: `tests/engine.test.ts` (30), `tests/policy.test.ts` (38), `tests/config-files.test.ts` (17)
- [x] `npm run demo:sequence` — deterministic replay demonstration
- [x] `docs/DESIGN.md`

### ✅ M2 — Pi extension

- [x] Deterministic command classification and outcome reading — `src/appraisal/command-classifier.ts`
- [x] Appraiser: tool outcome → events, no LLM — `src/appraisal/appraiser.ts`
- [x] `NeuroRuntime` orchestrator, no Pi dependency — `src/runtime/neuro-runtime.ts`
- [x] Config discovery: shipped → profile → project → user → env — `src/runtime/config-loader.ts`
- [x] Pi adapter with every handler guarded — `src/extension.ts`
- [x] State persisted via `pi.appendEntry` as a `custom` entry (structurally invisible to the LLM)
- [x] Restore on `session_start` **and** `session_tree` (fork/branch correctness)
- [x] Two-channel injection: static preamble in system prompt, dynamic block at message tail
- [x] Commands: `/neuro`, `status`, `history`, `reset`, `enable`, `disable`, `config`, `debug`, `export`
- [x] `.pi/extensions/neuro.ts` so `pi` self-loads in this repo
- [x] Tests: `tests/extension.test.ts` (32) against a `FakeExtensionAPI`

### ✅ M3 — Enforcement

- [x] Failure fingerprinting with noise normalization — `src/appraisal/fingerprints.ts`
- [x] Repeated-failure detection, bounded rolling window — `src/appraisal/failure-detector.ts`
- [x] `REPEATED_FAILURE` with severity rising in repeat count
- [x] `ASSUMPTION_INVALIDATED` when a failure survives an edit to the files it implicates
- [x] Patch-size limit, computed pre-execution with no disk I/O — `src/policy/enforcement.ts`
- [x] Retry limit on equivalent failing commands
- [x] Verification gate (mutation to a file unread since the last failure)
- [x] Safety valves: max consecutive blocks, never double-block one call, fail open
- [x] Bash bypass detection (logged by default, `guardBash` to block)
- [x] Tests: `tests/appraisal.test.ts` (66)

### ✅ M4 — Telemetry and UI

- [x] Versioned JSONL schema, 8 record types — `src/telemetry/schema.ts`
- [x] Best-effort recorder; a broken sink degrades to silence — `src/telemetry/recorder.ts`
- [x] Run header carrying all §24 reproducibility metadata
- [x] Full chain reconstructible offline: appraisal → transition → policy → enforcement
- [x] TUI panel and status line — `src/ui/neuro-status.ts`
- [ ] **`/neuro export` reports the telemetry path but does not write an export** — see [G4](#g4-neuro-export-does-not-export)

### ✅ M5 — Experiment runner

- [x] Types and conditions — `experiments/types.ts`
- [x] Benchmark + fixture loading, provider-agnostic — `experiments/benchmark.ts`
- [x] Per-trial subprocess isolation — `experiments/trial.ts`, `experiments/runner.ts`
- [x] Four conditions: `bare`, `control` (observer), `static`, `neuro`
- [x] Everything pinned across arms: no discovered extensions/skills/themes/context files, shared system prompt
- [x] Turn cap by counting `turn_end` + abort; wall-clock timeout
- [x] Grading against a pristine checkout with hidden tests — `experiments/grade.ts`
- [x] Visible-pass vs hidden-pass reported separately
- [x] Three discriminative fixtures, each verified to fail shipped / pass when correctly fixed / reject the shortcut
- [x] `extensionInert` self-check that invalidates a run where extensions never activated
- [x] `PI_NEURO_FAUX=1` scripted agent for credential-free pipeline validation — `experiments/faux-agent.ts`
- [x] Tests: `tests/experiments.test.ts` (27), `tests/live-session.test.ts` (5, real Pi session)

### ✅ M6 — Metrics and analysis

- [x] All §22 metrics from the extension's own records — `experiments/metrics.ts`
- [x] Neuro-only series: mean/peak stress, min persistence, fatigue, regime share
- [x] §23 behavioral metrics, computed identically for **both** arms
- [x] Comparison report: outcomes / behavior / physiology + per-task tables — `experiments/analysis.ts`
- [x] Spread printed alongside every mean; small-n caveat printed automatically
- [x] `results.jsonl`, `results.json`, `benchmark.json` written per run
- [ ] **`renderTrajectoryCsv()` exists but is never called** — see [G3](#g3-trajectory-export-is-not-wired-in)

---

## v0.1 Definition of Done (spec §32)

All ten, plus the automated experiment, are met.

| | | Where |
|---|---|---|
| 1 | initializes persistent NeuroState | `session_start` → `NeuroRuntime`, restored from session entries |
| 2 | observes coding-tool outcomes | `tool_result` handler |
| 3 | identifies test success / failure / repeated failure | classifier + `FailureDetector` |
| 4 | updates NeuroState deterministically | `engine.ts`, quantized, replay-tested |
| 5 | derives an AgentPolicy | `adapter.ts` |
| 6 | injects policy into subsequent model context | `context` event; verified in a real Pi session |
| 7 | displays current state with `/neuro` | `registerCommand` + TUI panel |
| 8 | logs every transition | JSONL telemetry |
| 9 | allows `/neuro reset` | exact return to baselines, tested |
| 10 | allows neuromodulation to be disabled | `/neuro disable`, plus `mode: off` |
| + | one automated SDK experiment, control vs neuro, comparative metrics | `npm run experiment` |

---

## Known gaps

Ordered by how much they matter. Everything here is verified, not suspected.

### G1 — `STRATEGY_CHANGE` never fires

**The most significant gap.** `FailureDetector.detectStrategyChange()` and
`NeuroRuntime.noteStrategyChange()` both exist and are unit-tested, but **neither has a
call site in the extension**. Nothing detects a change of approach during a real session.

Consequences:
- the configured event mapping (`persistence +0.10`, `noveltyDrive −0.05`) never applies,
  so the physiology never rewards abandoning a failed strategy — arguably the single most
  interesting dynamic in the design
- `strategyChanges` in §22 metrics always reads 0
- `turnsToStrategyChange` in §23 behavioral metrics is always `null`
- the repeated-failure → strategy-change loop the study is built around is only half wired

**To fix:** call `detectStrategyChange(attempt, kind, files)` from
`NeuroRuntime.observeToolResult()` — the fingerprints needed are already computed there —
and emit via `noteStrategyChange()` when it returns true. Add extension-level tests
alongside the existing detector unit tests, and confirm the metric moves in a faux run.

### G2 — Four events are in the vocabulary but never emitted

`REVERT`, `HIGH_UNCERTAINTY`, `TASK_SUCCESS`, `TASK_FAILURE`. Each has a config mapping
that is currently dead.

- `REVERT` — needs content-hash or git-state tracking across edits. Pi's own
  `examples/extensions/git-checkpoint.ts` is the reference pattern.
- `TASK_SUCCESS` / `TASK_FAILURE` — the runner knows the grading outcome but the
  extension does not. Needs an end-of-run signal fed back in, or `agent_settled` plus a
  verification run.
- `HIGH_UNCERTAINTY` — no source of an uncertainty signal exists. Deterministic appraisal
  cannot really produce this; it is the natural first customer for an LLM appraiser.

None of these break anything today. They are unrealized capability, and the config
entries should be treated as aspirational until wired.

### G3 — Trajectory export is not wired in

`renderTrajectoryCsv()` in `experiments/analysis.ts` is written and correct, but the
runner never calls it, so no `trajectories.csv` is produced. Spec §30 asks for
"NeuroState trajectory data suitable for graphing". One `writeFileSync` in
`experiments/runner.ts` closes this.

### G4 — `/neuro export` does not export

It prints where telemetry is being written. It does not copy or transform anything.
Either make it write a file to a given path or rename it to `/neuro telemetry`.

### G5 — Never run against a real model

There are no OpenRouter credentials on this machine, so the entire live path is unproven:
real model, real tool loop, real cost, real timing. Everything that *can* be verified
without a model has been. What has not been observed even once:

- whether an LLM actually complies with the injected policy block
- how it reacts to a `BLOCKED_BY_NEURO_POLICY` refusal (complies? argues? routes around
  it via bash?)
- whether the fixtures discriminate between conditions in practice
- real token overhead of injection (the faux run suggests ~2.5k tokens/turn, which is
  substantial and worth measuring properly)

**First live step:**

```bash
export OPENROUTER_API_KEY=...
npx tsx scripts/smoke-trial.ts bug-003-easy-control neuro
```

Then one interactive session, then `--trials 1` across all conditions before scaling.

### G6 — No LLM appraiser, and no seam for one yet

Spec §9 permits an LLM classifier for genuinely semantic judgments. The `Appraiser`
interface exists (`appraise()` + `detector`) but there is **no structured-output schema
and no classifier**. An earlier session's summary described this as "an interface with a
validated structured-output shape" — that overstated it; only the plain interface exists.

Deliberately deferred: non-determinism in appraisal leaks straight into the physiology.
If added, it belongs behind a config flag with the deterministic path as the default.

---

## Backlog

Not gaps — things the spec allows for that were never in scope for v0.1.

- **Profile comparison study** (§27): six profiles ship and are tested, but no benchmark
  varies them. "Same model, same task, different physiology" is a study waiting to be run
  and only needs a new YAML.
- **`pi.registerFlag`** for CLI configuration. Config is currently files + env only.
- **Significance testing.** Reporting is deliberately descriptive; with realistic trial
  counts that is honest. Revisit only with enough trials to justify it.
- **`terminate` on enforcement results.** Pi's `ToolCallEventResult` supports it; we never
  set it. Could stop a batch after a block rather than letting the rest run.
- **Real-repo fixtures.** The benchmark loader is fixture-shaped and would take
  SWE-bench-style tasks with no runner changes; only the three synthetic ones exist.
- **Container isolation.** The only real answer to bash bypass. Pi documents the pattern
  in `docs/containerization.md`.

---

## Decisions already made

Recorded so they are not relitigated. Rationale is in [DESIGN.md](DESIGN.md).

1. **Interaction strength is a `displacement`**, not a raw per-step gain — stated relative
   to the target's own restoring force, so a coupling can never overpower the variable it
   acts on, and profiles that change decay rates rescale automatically.
2. **Injection is two-channel**: static protocol text in the system prompt (cacheable),
   dynamic numbers at the message tail (recomputed every LLM call). Putting the numbers in
   the system prompt would break prompt caching on every turn.
3. **`context`, not `before_agent_start`**, for the dynamic block — it fires before *every*
   model call, so a failing test reaches the model within the same turn.
4. **`appendEntry` (`custom` entry)** for state, not a file on disk — structurally
   excluded from LLM context, branch-correct for free, and out of reach of bash.
5. **`control` is observer mode, not "no extension"** — both arms are then measured by
   identical code. `bare` exists solely to confirm observer mode is inert.
6. **`static` condition** isolates the effect of the dynamics from the effect of the extra
   prompt text. A plain control cannot separate those.
7. **Appraisal is deterministic.** Non-determinism there would leak into the physiology.
8. **Enforcement fails open, always.** A throw inside Pi's `tool_call` handler blocks the
   tool, so every handler is wrapped and the fallback is "allow".
9. **Hidden grading tests**, applied to a pristine checkout, so editing tests is not a
   route to passing and patching around the cause is a distinct reported outcome.

---

## Traps discovered

Each of these was hit and cost real time. All are now covered by a test.

1. **`createAgentSession()` loads extensions but does not activate them.** You must call
   `await session.bindExtensions({ mode: "print" })`. Without it no handler fires, every
   condition behaves identically, and a study compares control against control while
   producing a clean, plausible, meaningless table. Pinned by `tests/live-session.test.ts`
   and by the `extensionInert` self-check.
2. **`node --test test/` is not a valid invocation on Node 24** — it treats the path as a
   module. The no-argument form auto-discovers. This made all three fixtures "fail" for
   the wrong reason, which would have graded every trial as failure regardless of the
   agent's work.
3. **A command the classifier does not recognize is appraised as a generic tool error**,
   not a test failure — the physiology barely responds. `node --test` was originally
   unrecognized, which is exactly what the fixtures use. Pinned by a test asserting every
   fixture's verify command classifies as `test`.
4. **Every interaction gain originally overwhelmed its target's restoring force.** Fatigue
   alone drove persistence to zero after a few hundred turns with no failures at all.
   Caught by a property test; fixed by the displacement representation.
5. **A policy field can sit clamped against its bound in the baseline state** and look
   configured while carrying no signal. Two fields did. Pinned by "no dead field at
   baseline" and "usable dynamic range" tests.
6. **`before_provider_request` does not fire for the faux provider** (it makes no HTTP
   call). Capture the context inside a `FauxResponseFactory` instead — which is a better
   check anyway, since it is what the model actually received.
7. **Pi's block marker is `BLOCKED_BY_NEURO_POLICY` with underscores.** The producer and
   consumer of that string live in different modules; when they drifted, every refusal was
   silently reappraised as a code failure, letting enforcement manufacture the failures
   that justify more enforcement. Pinned by a test that runs a real refusal through the
   classifier.

---

## Verification

| Command | What it proves | Credentials |
|---|---|---|
| `npm test` | 216 tests across physiology, appraisal, enforcement, extension, harness | no |
| `npm run typecheck` | types agree with installed Pi 0.84.2 | no |
| `npm run demo:sequence` | identical inputs → byte-identical state history | no |
| `PI_NEURO_FAUX=1 npm run experiment -- <benchmark> --trials 1` | runner → trial → grade → metrics → report | no |
| `npx tsx scripts/smoke-trial.ts <fixture> <condition>` | one trial end to end | **yes** |
| `pi -e src/extension.ts` in a project | interactive behavior | **yes** |

Test distribution: `engine` 30, `policy` 38, `appraisal` 66, `config-files` 17,
`extension` 32, `experiments` 27, `live-session` 5, `version` 1.

### Expected faux-study signature

A healthy pipeline, `--trials 1 --conditions bare,control,static,neuro --task bug-003-easy-control`:

- all four arms succeed (the scripted agent fixes this fixture correctly)
- `bare` ≈ `control` in tokens (~7.15k) — observer mode inert
- `static` and `neuro` ~9.7k tokens — injection present
- `static` shows **0 policy changes** and stress pinned at baseline; `neuro` shows ~7
- no `extensionInert` trials

Deviation from this means something in the wiring has regressed.
