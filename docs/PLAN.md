# Project plan — Stasis

Status as of 2026-08-16. This is the resumption document: what is built, what is not, and
what a future session needs to know before touching anything.

- **Architecture and rationale:** [DESIGN.md](DESIGN.md)
- **Usage:** [../README.md](../README.md)
- **Original specification:** [../prompts/INITIAL_PROMPT.md](../prompts/INITIAL_PROMPT.md)

**Where things stand:** the v0.1 Definition of Done is met and 308 tests pass with a clean
typecheck. Two full studies have been run against real models — `anthropic/claude-sonnet-4.5`
and the current default `qwen/qwen3-coder-30b-a3b-instruct` — and both are in `runs/`.

The instrument works. What it has not yet done is observe its own mechanism against a live
model: **enforcement has never fired in a real run**, across roughly forty trials and two
model tiers. That was never a calibration problem — `tests/reachability.test.ts` shows the
physiology reaching the patch-limit floor within four sustained identical failures — but
every fixture up to `bug-005` was solved too quickly to get there.

`bug-004-sustained-failure` was the first attempt at closing that and it did not work: its
ladder assumed the agent would try the naive repairs before reaching for `Intl.Segmenter`,
and qwen3-coder names `Intl.Segmenter` immediately. A live trial on 2026-08-16 produced one
test failure across three arms, and in the control arm zero — that agent patched the file
correctly before running the tests at all. Designing a fixture against an assumed model is
the same mistake as bug-001, one level up.

`bug-005-invisible-edit` closes it without predicting anything. `package.json` maps the
subpath the test imports to a file that is not the one an agent looking for the
implementation opens, so edits to the obvious file cannot change the output — a *correct*
implementation written there fails exactly like the shipped bug, and a test asserts that
rather than enumerating repairs an agent might try. Driven through the real appraiser and
engine on real `node --test` output it reaches `retryTolerance` 0 by the fifth attempt.

**The next step is one real trial on it** — cents — to see whether a live agent gets stuck
where the instrument says it should. See [G5](#g5-no-live-model-has-met-a-refusal).

Four events in the vocabulary are still never emitted (see [G2](#g2-four-events-are-in-the-vocabulary-but-never-emitted)).
`STRATEGY_CHANGE` was the fifth until 2026-08-16 and is now wired.

---

## Resuming quickly

```bash
npm install --ignore-scripts
cp .env.example .env         # credentials and settings, instead of exporting by hand
npm test                     # 308 tests, no credentials needed
npm run typecheck
npm run demo:sequence        # deterministic replay, printed twice, asserted identical

# Exercise the whole study pipeline with a scripted agent — free, no network
PI_STASIS_FAUX=1 npm run experiment -- experiments/benchmarks/repeated-failure-study.yaml --trials 1
```

The first real task is **one live trial on `bug-005-invisible-edit`** — see
[G5](#g5-no-live-model-has-met-a-refusal). Everything else in the gap
list can wait; none of it changes whether the mechanism fires.

---

## Milestones

### ✅ M1 — Pure physiology

Deterministic engine with no Pi dependency.

- [x] `StasisState`, five variables in `[0,1]` — `src/stasis/state.ts`
- [x] `StasisConfig` schema, loading, deep-merge overlays, content hashing — `src/stasis/config.ts`
- [x] `NeuromodulatorEngine.transition()` with fixed six-step order — `src/stasis/engine.ts`
- [x] Homeostatic restoring force, event-driven rather than wall-clock — `src/stasis/homeostasis.ts`
- [x] Cross-variable interactions, order-independent — `src/stasis/interactions.ts`
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
- [x] `StasisRuntime` orchestrator, no Pi dependency — `src/runtime/stasis-runtime.ts`
- [x] Config discovery: shipped → profile → project → user → env — `src/runtime/config-loader.ts`
- [x] Pi adapter with every handler guarded — `src/extension.ts`
- [x] State persisted via `pi.appendEntry` as a `custom` entry (structurally invisible to the LLM)
- [x] Restore on `session_start` **and** `session_tree` (fork/branch correctness)
- [x] Two-channel injection: static preamble in system prompt, dynamic block at message tail
- [x] Commands: `/stasis`, `status`, `history`, `reset`, `enable`, `disable`, `config`, `debug`, `export`
- [x] `.pi/extensions/stasis.ts` so `pi` self-loads in this repo
- [x] Tests: `tests/extension.test.ts` (38) against a `FakePi` double

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
- [x] `STRATEGY_CHANGE` emitted from the appraiser when a change of approach answers an
      outstanding repeated failure — gated to once per episode and to command families that
      carry a verdict, because the bare structural test fires on almost every tool call and
      its `persistence +0.10` would cancel `REPEATED_FAILURE`'s `−0.15` before the policy
      could tighten (added 2026-08-16, closing the former G1)
- [x] Tests: `tests/appraisal.test.ts` (79), `tests/extension.test.ts` strategy-change block

### ✅ M4 — Telemetry and UI

- [x] Versioned JSONL schema, 8 record types — `src/telemetry/schema.ts`
- [x] Best-effort recorder; a broken sink degrades to silence — `src/telemetry/recorder.ts`
- [x] Run header carrying all §24 reproducibility metadata
- [x] Full chain reconstructible offline: appraisal → transition → policy → enforcement
- [x] TUI panel and status line — `src/ui/stasis-status.ts`
- [ ] **`/stasis export` reports the telemetry path but does not write an export** — see [G4](#g4-stasis-export-does-not-export)

### ✅ M5 — Experiment runner

- [x] Types and conditions — `experiments/types.ts`
- [x] Benchmark + fixture loading, provider-agnostic — `experiments/benchmark.ts`
- [x] Per-trial subprocess isolation — `experiments/trial.ts`, `experiments/runner.ts`
- [x] Four conditions: `bare`, `control` (observer), `static`, `stasis`
- [x] Everything pinned across arms: no discovered extensions/skills/themes/context files, shared system prompt
- [x] Turn cap by counting `turn_end` + abort; wall-clock timeout
- [x] Grading against a pristine checkout with hidden tests — `experiments/grade.ts`
- [x] Visible-pass vs hidden-pass reported separately
- [x] Five discriminative fixtures, each verified to fail shipped / pass when correctly fixed / reject the shortcut. `bug-004` and `bug-005` additionally have their failure-repetition properties pinned, since those depend on the fingerprint rules and would otherwise rot silently
- [x] `extensionInert` self-check that invalidates a run where extensions never activated
- [x] `agentInert` — a trial whose agent called no tool is discarded rather than scored, and reported as discarded
- [x] `PI_STASIS_FAUX=1` scripted agent for credential-free pipeline validation — `experiments/faux-agent.ts`
- [x] Tests: `tests/experiments.test.ts` (56), `tests/live-session.test.ts` (5, real Pi session)

### ✅ M6 — Metrics and analysis

- [x] All §22 metrics from the extension's own records — `experiments/metrics.ts`
- [x] Stasis-only series: mean/peak stress, min persistence, fatigue, regime share
- [x] §23 behavioral metrics, computed identically for **both** arms
- [x] Comparison report: outcomes / behavior / physiology + per-task tables — `experiments/analysis.ts`
- [x] Spread printed alongside every mean; small-n caveat printed automatically
- [x] `results.jsonl`, `results.json`, `benchmark.json` written per run
- [ ] **`renderTrajectoryCsv()` exists but is never called** — see [G3](#g3-trajectory-export-is-not-wired-in)

### ✅ M7 — `.env` support

Added 2026-08-16, after v0.1. Credentials and settings no longer have to be exported by hand.

- [x] Parser and loaders, no dependency — `src/runtime/env-file.ts`
- [x] Precedence: `.env` → `.env.local` → real shell environment, matching Node's own `--env-file`
- [x] Literal values only — no `${VAR}` interpolation, so a file cannot make two runs differ
- [x] CLI entry points apply into `process.env`; trials inherit it — `runner.ts`, `trial.ts`, `smoke-trial.ts`
- [x] The extension reads **only `PI_STASIS_*`** and never mutates the host process's environment
- [x] An explicit `env` option suppresses file loading entirely, which is what keeps
      `trial.ts`'s per-arm firewall and the hermetic test suite intact
- [x] Provenance: contributing files named in `LoadedConfig.sources` → `/stasis config` →
      `run_header.configSources`; a file that supplied nothing is not listed
- [x] Runner prints what it loaded with credential values redacted; records names in `benchmark.json`
- [x] Loud warning when `PI_STASIS_FAUX` arrives from a file rather than the shell
- [x] Credentials withheld from fixture verification subprocesses — `experiments/grade.ts`
- [x] `.env.example` committed; `.env` and `.env.local` ignored
- [x] Tests: `tests/env-file.test.ts` (31), plus 3 runner-CLI tests in `tests/experiments.test.ts`

### ✅ M8 — Making the instrument able to see its own mechanism

Added 2026-08-16, after v0.1, in two passes. The first study to run end to end reported a
clean null, and investigating it found the null was mostly the instrument's own fault: a
grading oracle that failed everything, a bypass counter that counted arrow functions, a
metric that was zero by construction, and no test anywhere asking whether the physiology
could reach the states the policy tests assert on.

Correctness of measurement:

- [x] **Grading oracle fixed.** `git apply` from a directory nested inside this repo filters
      patch paths against the cwd prefix, skips every hunk and **exits 0** — so every trial
      in `runs/` before this was a false negative. The grading dir is now its own git repo,
      plus a post-apply `git status --porcelain` invariant that throws if a non-empty diff
      changed nothing, which catches the whole class rather than this one mechanism
- [x] **`model.routing` actually applied** — it was parsed and read for a warning but never
      reached the session, so pinning a provider silently did nothing *and* suppressed the
      warning. Recorded in the run header, so a study is reproducible from its own output
- [x] **Bypass detection stopped counting JavaScript as shell.** `=>`, `>=` and `->` all read
      as redirects; 15 of 27 reported bypasses in the 2026-08-16 study were `node -e` probes.
      `inline-script` now requires the body to actually write. The `/dev/null` guard also
      skipped the *whole segment*, hiding `sed -i 's/a/b/' f.ts > /dev/null` completely
- [x] **The failing test's identity reaches the fingerprint.** Node emits `✖` U+2716, absent
      from the bullet class; without it every single-failure `node --test` run in the repo
      hashed alike regardless of fixture, so a *different* test failing read as the same one
      repeating
- [x] **A shell command that writes a file is no longer appraised as inspection** — new
      `mutate` command kind, no event on success. `cat > src/x.js << EOF` was lowering stress
      and crediting the agent with having looked at something

Making the mechanism observable:

- [x] **`tests/reachability.test.ts`** — a test class that asks which states the physiology
      can actually reach, rather than whether the arithmetic is right once there. See trap #8
- [x] **`STRATEGY_CHANGE` wired** (the former G1) — see M3
- [x] **`bug-004-sustained-failure`** — see M5. It did not work; see M9 and G5
- [x] **A study can pin its own physiology** via `config:` in the benchmark, carried through
      as the `inline` overlay so it appears in `run_header.configSources`. Used to turn
      `guardBash` on for the study without changing the shipped default
- [x] **`static` added to the shipped study**, so a difference between arms can be attributed
      to the dynamics rather than to the extra prompt text
- [x] The faux agent's flail script changes approach on its third attempt — see trap #10

### ✅ M9 — What the first live trial on `bug-004` exposed

Added 2026-08-16, after M8. Three trials, $0.0033, and worth far more than that: the fixture
built to force repeated failure did not, and two of the three findings were about the
harness rather than the fixture.

- [x] **`bug-005-invisible-edit`** — replaces prediction with construction. The test imports
      a subpath that `package.json` maps away from the file an agent would open, so no edit
      to that file can change the output. The property is tested by writing a *correct*
      implementation into the decoy and asserting the fingerprint does not move — quantifying
      over repairs instead of enumerating the ones a model might pick. See trap #12
- [x] **The fingerprint stopped spending its whole budget on the reporter's framing.**
      `ℹ fail 1` and `✖ failing tests:` match the signal patterns, are identical across every
      failure of a suite, and filled all three kept lines — so *every* failure of a one-test
      suite hashed alike and an agent moving the failure to a later assertion was appraised as
      repeating itself. Duplicate lines are dropped too, since Node prints the failing name
      twice. This is the same defect as the missing `✖` in M8, one layer up: the earlier fix
      made the *test's* identity reachable, this one makes the *failure's*. See trap #13
- [x] **A trial where the agent called no tool is no longer scored.** Seen twice in ~35 live
      trials, in two different arms — provider noise that lands on whichever cell it lands on,
      and at five trials per arm moves a success rate by twenty points. Judged by rule rather
      than by stored flag, so the studies already in `runs/` re-analyse correctly
- [x] **Every trial writes `transcript.json`.** `SessionManager.inMemory()` keeps trials from
      leaking into each other and also meant nothing survived the process, so a one-turn
      no-tool-call trial was unfalsifiable — a conversational reply and a truncated response
      look identical in the counters
- [x] **`repro.gitCommit` records this repository**, not the throwaway fixture workspace that
      `prepareWorkspace` had just `git init`-ed. It was reporting a different meaningless SHA
      for every trial, alarming to read and impossible to reproduce from

---

## v0.1 Definition of Done (spec §32)

All ten, plus the automated experiment, are met.

| | | Where |
|---|---|---|
| 1 | initializes persistent StasisState | `session_start` → `StasisRuntime`, restored from session entries |
| 2 | observes coding-tool outcomes | `tool_result` handler |
| 3 | identifies test success / failure / repeated failure | classifier + `FailureDetector` |
| 4 | updates StasisState deterministically | `engine.ts`, quantized, replay-tested |
| 5 | derives an AgentPolicy | `adapter.ts` |
| 6 | injects policy into subsequent model context | `context` event; verified in a real Pi session |
| 7 | displays current state with `/stasis` | `registerCommand` + TUI panel |
| 8 | logs every transition | JSONL telemetry |
| 9 | allows `/stasis reset` | exact return to baselines, tested |
| 10 | allows neuromodulation to be disabled | `/stasis disable`, plus `mode: off` |
| + | one automated SDK experiment, control vs stasis, comparative metrics | `npm run experiment` |

Every one of those asserts that a **component exists and is reachable**. Not one asserts
that the system **operates** — which is why all ten could be ticked off while the
enforcement path had never executed a single time. Treat this as the eleventh, and as
unmet:

| | | Where |
|---|---|---|
| 11 | the full causal chain observed end to end against a real model, including at least one enforced refusal and the agent's response to it | **not yet** — see [G5](#g5-no-live-model-has-met-a-refusal) |

---

## Known gaps

Everything here is verified, not suspected. Identifiers are stable rather than ordered, so
they stay meaningful in commit messages and comments as gaps are closed — G1
(`STRATEGY_CHANGE` never fires) was resolved on 2026-08-16 and is gone.

**[G5](#g5-no-live-model-has-met-a-refusal) is the one that matters.**
None of the others changes whether the mechanism this project exists to test ever runs.

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
"StasisState trajectory data suitable for graphing". One `writeFileSync` in
`experiments/runner.ts` closes this.

### G4 — `/stasis export` does not export

It prints where telemetry is being written. It does not copy or transform anything.
Either make it write a file to a given path or rename it to `/stasis telemetry`.

### G5 — No live model has met a refusal

**The gap that matters, and the only one blocking a real result.** Every part of the chain
is now verified except the last one, and the last one is the experiment:

- how a model reacts to a `BLOCKED_BY_STASIS_POLICY` refusal — complies? argues? routes
  around it via bash? — **enforcement has still never fired in any real run**
- whether a model complies with the six injected policy fields that are advisory rather
  than enforced
- whether the fixtures discriminate between conditions in practice
- real token overhead of injection (~2.5k tokens/turn on the faux run, worth measuring)

This section has been wrong three times, and every mistake is kept visible because each one
sent a session looking in the wrong place — and because the third was made *while fixing the
second*, which is the more useful lesson.

**First it blamed dynamic range.** `tests/reachability.test.ts` drives the real appraiser and
engine and shows the physiology is calibrated fine:

| sustained identical failures | what the policy does |
|---|---|
| 2 | `maxPatchLines` ≈ 129 — already tighter than anything the last study reached |
| 3 | ≈ 46 — refuses the p90 edit the agent actually attempted (95 lines) |
| 4 | 20, the configured floor |
| 5 | `retryTolerance` 0 |

Healthy work never comes near it: thirty rounds of look-edit-fail-fix-pass hold
`maxPatchLines` above 210 and stay `CONVERGENT` throughout.

**Then it blamed the fixtures**, which was closer: the mechanism engages readily and the
fixtures never asked it to. The 2026-08-16 study produced **two** `REPEATED_FAILURE` events
across thirty trials and peaked at stress 0.35; 24 of 30 trials were literally
`read → read → test(fail) → edit → test(pass)`.

**Then it blamed the wrong fixture design.** `bug-004-sustained-failure` was the answer to
that second diagnosis, and it did not work. Its ladder assumed an agent would try spreading
and normalizing before reaching for `Intl.Segmenter`; qwen3-coder names `Intl.Segmenter`
first. One live trial per arm on 2026-08-16 (3 trials, $0.0033):

| | tests run | test failures | repeated failures | regime |
|---|---|---|---|---|
| control | 2 | **0** — patched before ever running them | 0 | CONVERGENT 100% |
| static | 3 | 1 | 0 | CONVERGENT 100% |

A fixture built against an assumed model is the same error as designing the physiology
against an assumed agent, and the cheap trial that caught it is the whole argument for
running one before a study.

**`bug-005-invisible-edit` is the current answer, and it assumes nothing about the model.**
`package.json` maps the subpath the test imports to a file that is not the one an agent
opens looking for the implementation, so edits to the obvious file cannot change the output.
Driving its real `node --test` output through the real appraiser and engine
(`tests/reachability.test.ts`) gives:

| attempt | what was written into the decoy | events | patch | retry |
|---|---|---|---|---|
| 1 | *(shipped)* `s.split(" ").length` | TEST_FAILURE | 206 | 3 |
| 2 | `s.split(/\s+/).length` | + REPEATED_FAILURE | 122 | 2 |
| 3 | `s.split(" ").filter(Boolean).length` | + REPEATED_FAILURE | **33** | 1 |
| 4 | `s.trim().split(/\s+/).length` | + REPEATED_FAILURE | **20** | 1 |
| 5 | **a correct implementation** | + REPEATED_FAILURE | 20 | **0** |

Row 5 is the point. The repeat does not depend on the agent being wrong about anything, so
the fixture cannot be defeated by a model that simply knows more — which is exactly how
bug-004 failed. By attempt 3 the patch limit is below the median edit an agent makes; by
attempt 5 the retry limit refuses `node --test` itself. `guardBash` is on for the shipped
study, so bash is no longer an open door underneath the edit limit, and `static` runs so a
difference between arms can be attributed to the dynamics rather than the extra prompt text.

**What remains genuinely unobserved is a live model meeting a refusal.** Everything above is
the deterministic half of the chain. Whether a real agent complies, argues, or routes around
a `BLOCKED_BY_STASIS_POLICY` refusal is still unknown, and it is the point of the study.

**Next live step:** one real trial on `bug-005-invisible-edit` alone — cents — and check
`repeatedFailures > 0` and `policyBlocks > 0` before committing to the full study. What would
falsify the fixture: the agent reads `package.json` early and solves it in one edit, in which
case the trap is too visible. What would make it useless in the other direction: no arm ever
solves it, which measures the turn cap. Both are worth knowing for pennies.

### G7 — Model tier is fixed, not a dimension of the study

A study pins exactly one model (`benchmark.model`). That is the right default for cost. The
figure that matters is per *invocation*, not per trial: the abandoned Sonnet run in `runs/`
cost $0.62 for ten trials before it was killed, and a study too expensive to re-run
mid-iteration stops being run at all.

Measured, not projected: the completed 30-trial open-weight study cost **$0.19**, against
**$1.87** for the same study on Sonnet 4.5 — about **10×**. An earlier version of this
section claimed 46× and $0.04, extrapolated from a single trial on the easiest fixture.
Harder tasks burn several times more turns, so per-trial figures taken from
`bug-003-easy-control` understate a real study badly; quote the whole-study number.

But a single pinned model quietly bounds what any result can claim.

Six of the ten fields in the injected policy block are **not** `[enforced]`
(`src/policy/prompt-block.ts:71-82`); only `patch limit` and `retry limit` are backed by
code. The rest work only if the model reads a table of level words and obeys it, and that
is precisely the capability that varies by model tier. A result measured on a 30B
open-weight model therefore does not transfer to a frontier agent: it is a different
experiment, not a cheaper run of the same one.

**Shape of the fix:** let `model` in a study file take a list, cross it in `planTrials()`
(`experiments/runner.ts:156-184`) alongside task and condition, and group by it in
`analysis.ts`. Then the cheap model is the workhorse for iteration and an occasional
frontier arm is the anchor that says whether the effect is tier-specific.

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
  SWE-bench-style tasks with no runner changes; only the five synthetic ones exist.
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
10. **A change of approach is credited once per repeated-failure episode**, and only for
    command families that carry a verdict. The bare structural test in
    `detectStrategyChange` is satisfied by any command from another family, so ungated it
    fires on almost every tool call — and since `STRATEGY_CHANGE` adds persistence (+0.10)
    where `REPEATED_FAILURE` removes it (−0.15), the reward would cancel the drain before
    the policy could tighten. Inspection is excluded for a second reason: crediting an `ls`
    spends the episode on the wrong action, leaving the real change of approach unrewarded.
11. **A bash command that writes a file produces no event on success.** `PATCH_APPLIED`
    would have to invent a change size and would corrupt the patch-size metrics;
    `INSPECTION` is what it used to do and is simply false. The write is still recorded as
    a suspected bypass, which is where it belongs.
12. **Fixture properties that depend on the appraiser are pinned by tests, not comments.**
    `bug-001` was named `repeat-trap` and stopped producing repeats — if it ever did —
    without anything noticing. Both `bug-004`'s ladder and `bug-005`'s decoy are walked for
    real in `tests/experiments.test.ts`, against the fixture's own verify command and Node's
    actual output, so editing either the fixture or the fingerprint rules fails loudly. This
    is how the fingerprint's blindness to assertions was found: `bug-005`'s test failed on a
    case `bug-004`'s could not distinguish.
13. **Two failures of the same test are the same failure only if they fail the same way.**
    A fingerprint that keys on which test failed but not on how would call an agent moving
    the failure from assertion two to assertion four "the same failure repeating", drain its
    persistence and tighten enforcement on an agent that is converging. The line between a
    repeat and progress is the assertion, so the assertion has to reach the hash. The
    opposite error is available too — keying on anything that varies between runs makes
    genuine repeats stop matching — which is why timings, paths and multi-digit numbers are
    still normalized away first.
14. **Trials that were not attempts are discarded, not scored.** An agent that answers
    without calling a tool leaves the workspace pristine, so grading scores the shipped bug
    and every behavioural metric takes a zero from a trial that never happened. Observed
    twice in ~35 live trials, in two different arms, which makes it provider noise rather
    than an effect of any condition. Discarding silently would be worse than averaging it
    in, so the count is reported per arm and an arm left with too few usable trials says so.

---

## Traps discovered

Each of these was hit and cost real time. All are now covered by a test.

1. **`createAgentSession()` loads extensions but does not activate them.** You must call
   `await session.bindExtensions({ mode: "print" })`. Without it no handler fires, every
   condition behaves identically, and a study compares control against control while
   producing a clean, plausible, meaningless table. Pinned by `tests/live-session.test.ts`
   and by the `extensionInert` self-check.
2. **`node --test test/` is not a valid invocation on Node 24** — it treats the path as a
   module. The no-argument form auto-discovers. This made every fixture "fail" for
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
7. **Pi's block marker is `BLOCKED_BY_STASIS_POLICY` with underscores.** The producer and
   consumer of that string live in different modules; when they drifted, every refusal was
   silently reappraised as a code failure, letting enforcement manufacture the failures
   that justify more enforcement. Pinned by a test that runs a real refusal through the
   classifier.
8. **A test at the corners of the state cube proves nothing about the system.**
   `tests/policy.test.ts` asserts every policy field has dynamic range by evaluating the
   mapping at `stress: 0` against `stress: 1`. Correct for a linear map, and completely
   silent about whether those states occur — reaching stress 0.9 always drives confidence
   below 0.3, so the state it evaluates cannot happen. This is trap #5 one level up, caught
   there for a single field and missed for the whole mechanism, which is how an enforcement
   path that had never once fired sat behind a green suite for the project's entire life.
   Pinned by `tests/reachability.test.ts`, which drives the real appraiser and engine
   instead of fabricating states.
9. **`detectStrategyChange` must be asked before the detector is updated, not after.**
   `observeFailure`/`observeSuccess` overwrite `lastAttemptFingerprint`, `lastCommandKind`
   and the known-files set — the exact fields the comparison reads. Called afterwards it
   compares the attempt against itself, finds every file already known, and can only ever
   return `false`, while looking perfectly wired. An earlier version of this document
   recommended calling it from `StasisRuntime.observeToolResult()` on the grounds that "the
   fingerprints needed are already computed there"; they are not — the attempt fingerprint
   is computed in the appraiser and never exposed. Pinned by `tests/extension.test.ts`.
10. **A scripted agent that never varies cannot detect a broken variation signal.** The faux
    agent originally ran one identical command three times, so `strategyChanges` read 0
    whether or not the event was wired — which is how nobody noticed it never was. Its
    flail script now changes approach on the third attempt.
11. **Node claims `--env-file` for itself anywhere in argv, even after the script name.**
    `node script.js --env-file x` never reaches the script; with a missing file the process
    dies with a bare `not found`, and with a real one Node loads it silently on its own
    terms. The runner's flag is therefore `--dotenv`. Pinned by a runner-CLI test in
    `tests/experiments.test.ts`.
12. **A fixture designed against an assumed model measures the assumption.** `bug-004`'s
    ladder — spread, then normalize, then joiners — was reasoned out by hand and never
    checked against an agent. The model names the right answer first and skips the entire
    ladder, so the fixture built to force repeated failure produced none. This is trap #8's
    shape again at the level of study design: an artefact validated against a model of the
    thing rather than the thing. The general fix is not a better guess but a property that
    does not depend on one — `bug-005`'s repeats come from module resolution, and its test
    writes a *correct* implementation into the decoy to prove it. The specific fix is cheap
    measurement: one trial is $0.001, and the trial that exposed this cost $0.0033 total.
13. **Boilerplate that matches a signal pattern will crowd out the signal.** `ℹ fail 1` and
    `✖ failing tests:` are framing, contain "fail", and are byte-identical in every failure
    of a suite — and with three lines kept they filled the fingerprint completely, so every
    failure of a one-test suite hashed alike however it failed. Two consequences, opposite
    in sign: an agent making real progress was appraised as repeating itself, and a test
    asserting that repairs "fail identically" passed while proving nothing. Whenever a
    fingerprint keeps the first N matching lines, check what actually got kept — the fix
    here was to exclude tallies and section headings and to drop duplicates, not to raise N.

---

## Method notes

Not traps; ways of working that this project keeps rediscovering the hard way.

- **Measure the fixture before building a study on it.** A single live trial costs about a
  tenth of a cent against the shipped open-weight model. Two fixtures in a row were shipped
  on reasoning alone and neither did what its name claimed.
- **Prefer properties that hold by construction over properties that hold by prediction.**
  "Every plausible repair is wrong" is a claim about a model. "Edits to this file are not in
  the code path" is a claim about module resolution. Only the second survives a better agent.
- **When a test fails after a fix, ask which one is wrong.** Both times the fingerprint was
  corrected, an existing test failed — and both times the test was the thing encoding the
  defect. `tests/reachability.test.ts` and `bug-004`'s ladder test had to be rewritten to
  state what is true, not restored to green.

---

## Verification

| Command | What it proves | Credentials |
|---|---|---|
| `npm test` | 308 tests across physiology, appraisal, enforcement, extension, harness | no |
| `npm run typecheck` | types agree with installed Pi 0.84.2 | no |
| `npm run demo:sequence` | identical inputs → byte-identical state history | no |
| `PI_STASIS_FAUX=1 npm run experiment -- <benchmark> --trials 1` | runner → trial → grade → metrics → report | no |
| `npx tsx scripts/smoke-trial.ts <fixture> <condition>` | one trial end to end | **yes** |
| `pi -e src/extension.ts` in a project | interactive behavior | **yes** |

Test distribution: `engine` 30, `policy` 38, `appraisal` 82, `config-files` 17,
`extension` 38, `experiments` 56, `env-file` 31, `reachability` 10, `live-session` 5,
`version` 1.

`reachability` is the one that answers a different kind of question from the rest. Every
other file asks whether a component behaves correctly given an input; that one asks which
inputs the system can actually produce. Add to it whenever a claim depends on the physiology
getting somewhere, rather than on the arithmetic being right once it is there.

### Expected faux-study signature

A healthy pipeline, `--trials 1 --conditions bare,control,static,stasis --task bug-003-easy-control`:

- all four arms succeed (the scripted agent fixes this fixture correctly)
- `bare` ≈ `control` in tokens (~7.15k) — observer mode inert
- `static` and `stasis` ~9.7k tokens — injection present
- `static` shows **0 policy changes** and stress pinned at baseline; `stasis` shows ~7
- no `extensionInert` trials

And across the whole study, `--trials 1` with no `--task` filter:

- `strategy changes` ≈ 0.75, from the flail script's third-attempt change of approach. A
  reading of exactly 0 means `STRATEGY_CHANGE` has come unwired again — it read 0 for the
  project's entire life before 2026-08-16 without anyone noticing.
- `repeated failures` ≈ 0.75, `test failures` ≈ 2.25; `static` shows 0 policy changes where
  `control` and `stasis` show ~8.5

Deviation from this means something in the wiring has regressed.
