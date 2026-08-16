# pi-neuro — design

A synthetic physiology for the [Pi coding agent](https://pi.dev). A small set of
persistent, homeostatic variables observe what happens during a coding task and
causally constrain what the agent may do next.

The research question:

> Can a small set of persistent, homeostatic internal variables cause an otherwise
> identical coding agent to adapt its problem-solving behavior in measurable and
> useful ways?

This is not built to prove that they can. The instrument is designed so that
regressions and pathological behavior are as visible as improvements — see
[Control conditions](#control-conditions) and the `bug-003-easy-control` fixture.

## First principle: causal, not theatrical

Telling a model "your cortisol is high, act cautiously" is decoration. The chain here
is mechanical:

```
tool result
    ↓
event appraisal            deterministic classification of what happened
    ↓
state transition           bounded, homeostatic, owned entirely by application code
    ↓
policy derivation          state translated into named operational constraints
    ↓
context injection  +  tool constraints  +  harness enforcement
    ↓
next agent action
```

The model experiences the consequences of its internal state. It cannot set that state.
There is no tool that writes to physiology, `/neuro reset` is dispatched only from user
input, and the state of record lives in memory plus session entries Pi owns. If the
model emits `stress = 0`, nothing happens.

## Layering

| Layer | Location | Depends on Pi? |
|---|---|---|
| Physiology | `src/neuro/` | no |
| Policy | `src/policy/policy.ts`, `adapter.ts` | no |
| Appraisal | `src/appraisal/` | types only |
| Enforcement | `src/policy/enforcement.ts` | types only |
| Integration | `src/extension.ts`, `src/ui/` | yes |
| Experiments | `experiments/` | yes (SDK) |

Everything above the integration line is pure and testable without a harness, a model,
or a network. That is what makes the physiology reproducible while the agent around it
is not.

## The state vector

Five variables, each in `[0,1]`:

| Variable | Represents | Rises with | Effect when high |
|---|---|---|---|
| `stress` | threat, error and uncertainty pressure | failures, contradictions, uncertainty | more verification and inspection, smaller patches, less speculation |
| `confidence` | accumulated evidence the current understanding holds | passing checks, applied patches | larger coherent changes, fewer redundant checks |
| `noveltyDrive` | willingness to try unfamiliar approaches | repeated failure, invalidated assumptions | broader search, more strategy branches |
| `fatigue` | accumulated workload | every tool call, large changes, elapsed turns | narrower branching, context compression, convergence |
| `persistence` | willingness to continue the current strategy | strategy changes that stick | higher tolerance for retrying an equivalent approach |

Each has a `baseline`, `decayRate`, bounds, and `maxDeltaPerEvent`. All of it is
configuration; none of it is in source.

## Transition order

Fixed, and load-bearing for reproducibility:

1. **event delta** — configured magnitude scaled by appraised severity
2. **modulators** — continuous contributions from the event's `uncertainty` and `novelty`
3. **clamp** — per-variable cap on how far one event may move anything
4. **interactions** — cross-variable coupling, computed from the *pre-transition* state
5. **homeostasis** — `decayRate × (baseline − before)`, also from the pre-transition state
6. **bound and quantize** — clamp into range, then round to six decimals

Steps 4 and 5 read only `before`, so they commute with everything else and with each
other; rule declaration order cannot change the result. Step 6 makes every value
exactly representable, so a replay of the same event sequence cannot drift.

Decay is driven by *events*, not wall-clock time. A `TICK` event at the end of each turn
supplies time-like decay without putting a clock into the maths.

## Guarding against pathological dynamics

Bounds and per-event caps are the obvious protections. Two subtler ones matter more,
and both were added after property tests caught the failures they prevent.

**Verification must not manufacture the stress that demanded it.** High stress raises
verification; if inspecting then raised stress, a cautious policy would escalate its own
caution without limit. So `INSPECTION` carries a small *negative* stress term, and
successful checks lower stress. The loop is negative by construction, and a test asserts
that fifty consecutive inspections leave stress below where they started.

**A coupling must never overpower the variable it acts on.** A variable pushed
continuously by `a` per transition against decay `d` settles at `baseline + a/d`. With
raw per-step gains, every interaction in the first draft had a ratio near or above 1 —
meaning fatigue alone drove persistence to zero after a few hundred turns, with no
failures at all. Interaction strength is therefore stated as a **displacement**: how far
the rule may shift its target's resting point, in units of that variable's range. The
engine converts it using the target's own decay rate. Two consequences:

- the number is self-describing — `-0.25` means "shifts where this variable rests by a
  quarter of its range"
- a profile that changes a decay rate rescales its couplings automatically, instead of
  silently turning a gentle bias into an override

`validateDynamics()` enforces the remaining cases at load time: no rule may exceed
`maxDisplacementPerRule`, nothing may target a variable with no restoring force, and
`TICK` may not settle any variable outside its bounds — because `TICK` is the one event
that fires in every session regardless of what the agent does.

Failing at load beats clamping at runtime: a study should refuse to start rather than
quietly run on a physiology that saturates.

## From state to policy

Raw state never reaches a decision path. Everything reads `AgentPolicy`:

```
maxPatchLines  verificationLevel  explorationLevel  inspectionDepth  retryTolerance
strategyBranchCount  assumptionVerificationLevel  testFrequency
contextExpansionLevel  changeRiskTolerance
```

Every field uses one bounded linear form:

```
unit  = clamp01(intercept + Σ terms[v] · state[v])
value = min + unit · (max − min)          rounded when the field is a count
```

One shape for all ten fields buys three things:

- the whole policy layer is a pure function, testable without a harness
- **coefficient signs encode the spec's behavioral requirements** and are validated at
  load, so a flipped sign fails loudly instead of silently inverting a study
- an experiment reshapes behavior by editing YAML rather than source

Two test-enforced properties keep the fields honest: none may sit clamped against a
bound in the baseline state (a "dead" field looks configured but carries no signal), and
each must move meaningfully across the state space.

## Three levels of influence

**Level 1 — context.** A static protocol preamble goes into the system prompt once per
user turn; the changing numbers go into a single ephemeral message at the tail of the
message array, recomputed before *every* LLM call. So a failing test changes the policy
the model sees on the very next call inside the same turn. Keeping the dynamic part at
the tail also leaves prompt caching intact, which putting it in the system prompt would
destroy. The wording is operational — `verification: HIGH, patch limit: 60 lines` —
never anthropomorphic.

**Level 2 — tool policy.** Tool calls are inspected before execution: oversized edits,
equivalent repeated commands, mutations to files that have not been read since the last
failure.

**Level 3 — enforcement.** Where practical the policy is enforced in code rather than
suggested in prose, with an explanation returned to the agent and a telemetry record
written. Safety valves are mandatory: at most `maxConsecutiveBlocks` refusals in a row
before the next call is allowed through and the relaxation logged, never two blocks for
the same reason on one call, and any internal error fails open. The agent can never be
trapped, and a bug in this extension must never break the host agent.

Pi has no sandbox — its own documentation says so — and `bash` can rewrite files. By
default suspected bypasses (`>`, `sed -i`, heredocs, `patch`, `git checkout`) are
detected and logged; `enforcement.guardBash` upgrades that to blocking for rigorous
runs. This is a heuristic, not isolation. Real isolation needs a container.

## Persistence

Physiological state is kept logically separate from conversational memory.
`pi.appendEntry("neuro:state", …)` writes a `CustomEntry`, which Pi's
`sessionEntryToContextMessages()` drops when assembling LLM context — so it is
structurally impossible for the stored history to reach the model. Entries are ordinary
tree nodes, so forking and `/tree` navigation scope them correctly for free.

The model receives a representation of the *current* state, never the whole history.

## Control conditions

The control matters as much as the experimental arm. Four modes, of which two are
required for a valid study:

| Mode | Injection | Enforcement | Purpose |
|---|---|---|---|
| `off` | — | — | extension inert; confirms observer mode is truly inert |
| `observer` | none | none | identical telemetry, **zero** behavioral influence — the control |
| `static` | same block, frozen at baseline | constant policy | isolates the effect of *dynamics* from the effect of the extra text |
| `active` | live | live | the experimental condition |

`observer` exists so both arms produce the same behavioral metrics. `static` answers the
question a plain control cannot: was it the physiology, or just the scaffolding?

## Reproducibility

The physiology is deterministic. The model is not, so studies run repeated trials.
Every run records Pi version, extension version, git commit, model identifier and
settings, the full config and its content hash, the initial state, the benchmark
definition, and environment metadata.

Config is hashed at load. A file that changes mid-session is logged and ignored rather
than silently mixed into a run.

## What is deliberately absent

- **No LLM appraisal in v0.1.** Classification is deterministic — exit codes, command
  patterns, normalized error fingerprints. The `Appraiser` interface leaves room for a
  structured-output classifier for genuinely semantic judgments later, but the
  deterministic path stays the baseline.
- **No reward for self-continuation.** No variable increases with session length,
  resource acquisition, or avoiding shutdown. Fatigue moves the *opposite* way. Nothing
  in the design creates an incentive toward self-preservation, and the user can always
  disable, reset, inspect, or terminate.
