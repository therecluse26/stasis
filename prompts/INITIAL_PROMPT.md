# Build a Neuromodulated Coding Agent as a Pi Extension

Build an experimental **neuromodulation system for the Pi coding agent (`pi.dev`)**.

Do **not** build a new coding-agent harness. Pi is the host agent runtime. Extend Pi with a persistent synthetic physiology that causally modifies agent behavior in response to successes, failures, uncertainty, repetition, workload, and other events during software-engineering tasks.

The project has two major components:

1. **Pi Neuromodulation Extension** — used interactively inside normal Pi sessions.
2. **Experiment Runner** — uses the Pi SDK to run controlled comparisons between normal and neuromodulated Pi agents.

The primary research question is:

> Can a small set of persistent, homeostatic internal variables cause an otherwise identical coding agent to adapt its problem-solving behavior in measurable and useful ways?

Do not assume neuromodulation will improve performance. The system must make regressions and pathological behavior equally observable.

---

# 1. First Principle

The neuromodulation system must be **causal rather than theatrical**.

This is NOT sufficient:

```text
Your cortisol is high. Act more cautiously.
```

Instead:

```text
tool result
    ↓
event appraisal
    ↓
physiological state transition
    ↓
policy calculation
    ↓
prompt/context influence
    +
tool constraints
    +
harness enforcement
    ↓
next agent action
```

The model should experience the consequences of its internal state but must **not directly control that state**.

The LLM must never be able to output:

```text
stress = 0
confidence = 1
```

and thereby modify its physiology.

All physiological transitions are owned by deterministic application logic.

---

# 2. Use Pi Rather Than Reimplementing It

Use the installed/current version of:

```text
@earendil-works/pi-coding-agent
```

Before implementing Pi integration, inspect the installed package/types and current Pi documentation.

Treat the currently installed Pi APIs and TypeScript types as the source of truth.

Do not invent extension hooks or SDK methods based solely on this prompt if the current Pi version differs.

Prefer Pi's existing capabilities for:

* agent loop
* LLM providers
* model selection
* conversation/session management
* built-in coding tools
* terminal UI
* streaming
* context management
* extension lifecycle
* session persistence
* programmatic SDK execution

Our code should focus on:

* artificial physiology
* event appraisal
* homeostatic state transitions
* policy adaptation
* policy enforcement
* telemetry
* visualization
* experimentation

Do not fork Pi unless a concrete limitation makes an extension-based implementation impossible.

---

# 3. Overall Architecture

Implement approximately:

```text
                         USER
                           │
                           ▼
                  ┌─────────────────┐
                  │       Pi        │
                  │  Agent Runtime  │
                  └────────┬────────┘
                           │
               reasoning / tool calls
                           │
             ┌─────────────┴─────────────┐
             │                           │
             ▼                           ▼
       Pi LLM runtime               Pi tools
                                         │
                                         ▼
                                  tool result/event
                                         │
                                         ▼
                              ┌─────────────────────┐
                              │   Stasis Extension   │
                              │                     │
                              │ Event Appraisal     │
                              │ Failure Detection   │
                              │ Stasis Engine        │
                              │ Homeostasis         │
                              │ Policy Adapter      │
                              │ Enforcement         │
                              │ Telemetry           │
                              └──────────┬──────────┘
                                         │
                                  StasisState
                                         │
                                         ▼
                                  AgentPolicy
                                         │
                          ┌──────────────┼──────────────┐
                          │              │              │
                          ▼              ▼              ▼
                       context       tool rules      Pi UI
                       injection     enforcement     display
```

Additionally:

```text
                 ┌────────────────────┐
                 │ Experiment Runner  │
                 │      Pi SDK        │
                 └─────────┬──────────┘
                           │
                ┌──────────┴──────────┐
                ▼                     ▼
             CONTROL              NEUROMODULATED
               Pi                       Pi
                │                        │
                └──────────┬─────────────┘
                           ▼
                     Metrics/Analysis
```

---

# 4. StasisState

Start with a small state vector:

```ts
export interface StasisState {
  stress: number;
  confidence: number;
  noveltyDrive: number;
  fatigue: number;
  persistence: number;
}
```

Every value is normalized:

```text
0.0 <= value <= 1.0
```

Each variable has:

```ts
interface StasisVariableConfig {
  baseline: number;
  decayRate: number;
  min: number;
  max: number;
  maxDeltaPerEvent: number;
}
```

Do not spread magic constants throughout the codebase.

All physiological behavior belongs in configuration.

---

# 5. Meaning of Initial Variables

## Stress

Represents threat/error/uncertainty pressure.

High stress should generally increase:

* verification
* code inspection
* conservatism
* attention to anomalies

And reduce:

* speculative changes
* patch size
* unchecked assumptions

---

## Confidence

Represents accumulated evidence that the agent's current understanding is correct.

High confidence can permit:

* larger coherent changes
* fewer redundant checks
* stronger commitment to a hypothesis

Confidence must decrease when evidence contradicts the current strategy.

Do not treat confidence as a reward score.

---

## Novelty Drive

Controls willingness to explore unfamiliar approaches.

Higher novelty may increase:

* alternative hypotheses
* architectural exploration
* searching unrelated-but-plausible code
* strategy branching

Lower novelty should favor known repository patterns.

---

## Fatigue

Represents accumulated cognitive/workload pressure.

Increase fatigue from:

* long sessions
* repeated reasoning loops
* many tool calls
* broad code exploration
* large changes

High fatigue should reduce unnecessary branching and encourage:

* summarization
* established approaches
* context compression
* convergence

Fatigue must not simply make the model "worse."

It should change resource allocation.

---

## Persistence

Controls willingness to continue the current strategy.

Repeated failure should gradually lower persistence.

Low persistence should cause:

* assumption reconsideration
* strategy abandonment
* broader diagnosis
* escalation rather than identical retries

This variable is especially important for preventing repetitive agent loops.

---

# 6. Stasis Engine

Implement the physiology independently from Pi.

The core API should resemble:

```ts
interface NeuromodulatorEngine {
  transition(
    current: StasisState,
    event: AppraisedEvent,
    context: TransitionContext
  ): StasisTransition;
}
```

Where:

```ts
interface StasisTransition {
  before: StasisState;
  delta: StasisStateDelta;
  homeostasis: StasisStateDelta;
  interactions: StasisStateDelta;
  after: StasisState;
  reasons: TransitionReason[];
}
```

Given identical:

```text
initial state
+
event sequence
+
configuration
```

the resulting state history must be deterministic.

---

# 7. Homeostasis

Every state variable should naturally move toward a baseline.

Conceptually:

```text
state(t+1) =
    state(t)
    + event delta
    + interactions
    + decayRate * (baseline - state(t))
```

Apply:

* bounds
* damping
* maximum deltas
* sanity checks

Prevent runaway positive feedback.

For example, high stress may increase verification, but verification must not itself automatically generate more stress merely because verification occurred.

---

# 8. Events

Create a typed event model.

Examples:

```ts
type AgentEventType =
  | "TEST_SUCCESS"
  | "TEST_FAILURE"
  | "REPEATED_FAILURE"
  | "BUILD_SUCCESS"
  | "BUILD_FAILURE"
  | "LINT_SUCCESS"
  | "LINT_FAILURE"
  | "TYPECHECK_SUCCESS"
  | "TYPECHECK_FAILURE"
  | "PATCH_APPLIED"
  | "PATCH_REJECTED"
  | "REVERT"
  | "STRATEGY_CHANGE"
  | "ASSUMPTION_INVALIDATED"
  | "TOOL_ERROR"
  | "LARGE_CHANGE"
  | "HIGH_UNCERTAINTY"
  | "TASK_SUCCESS"
  | "TASK_FAILURE";
```

Create:

```ts
interface AppraisedEvent {
  type: AgentEventType;
  severity: number;
  uncertainty: number;
  novelty: number;
  repeated: boolean;
  evidence: EventEvidence;
}
```

---

# 9. Appraisal Engine

Separate:

```text
what happened
```

from:

```text
how physiology responds
```

The appraisal engine identifies events.

The stasis engine determines their physiological effects.

Prefer deterministic appraisal whenever possible.

Examples:

```text
test exit code != 0
→ TEST_FAILURE

test exit code == 0
→ TEST_SUCCESS

compiler failure
→ BUILD_FAILURE

successful revert
→ REVERT
```

Only use an LLM classifier when semantic interpretation is actually necessary.

Examples:

```text
Did the agent substantially change strategy?

Is this error effectively identical to the last three failures?

Did new evidence invalidate the agent's previous hypothesis?
```

LLM appraisal output must use validated structured data.

---

# 10. Repeated-Failure Detection

This is a major experimental feature.

Track failures using information such as:

```text
command
test name
exit code
error type
normalized error message
stack trace fingerprints
files modified
recent hypothesis
recent strategy
```

Detect when the agent is producing effectively the same unsuccessful outcome repeatedly.

Emit:

```text
REPEATED_FAILURE
```

with increasing severity.

Repeated failure should generally:

```text
stress        ↑
confidence    ↓
persistence   ↓
noveltyDrive  ↑ initially
```

Eventually the policy should force a meaningful strategy change rather than allow infinite local retries.

---

# 11. AgentPolicy

Never expose raw state without translating it into operational behavior.

Implement:

```ts
export interface AgentPolicy {
  maxPatchLines: number;

  verificationLevel: number;

  explorationLevel: number;

  inspectionDepth: number;

  retryTolerance: number;

  strategyBranchCount: number;

  assumptionVerificationLevel: number;

  testFrequency: number;

  contextExpansionLevel: number;

  changeRiskTolerance: number;
}
```

Implement:

```ts
interface PolicyAdapter {
  derive(state: StasisState): AgentPolicy;
}
```

Policy generation should itself be deterministic and testable.

---

# 12. Three Levels of Behavioral Influence

Use three levels.

## Level 1 — Context Influence

Inject current physiology and policy into the LLM context.

Example:

```text
CURRENT INTERNAL STATE

stress:       0.72
confidence:   0.31
novelty:      0.64
fatigue:      0.42
persistence:  0.28

CURRENT OPERATING POLICY

verification: HIGH
exploration: MODERATE
patch limit: 60 lines
similar retry limit: 1
inspection depth: 6
strategy branches: 3
```

Avoid anthropomorphic instructions such as:

```text
You feel anxious.
```

Prefer operational descriptions.

---

## Level 2 — Tool Policy

Use Pi extension hooks to inspect tool calls.

Examples:

* detect excessively large edits
* detect repeated equivalent commands
* require additional inspection before risky mutation
* constrain repeated retries
* influence what tools/actions are currently available where practical

---

## Level 3 — Hard Enforcement

Where technically practical, enforce policy in code.

Example:

```text
policy.maxPatchLines = 50
```

If the agent attempts a 400-line mutation:

```text
BLOCKED_BY_STASIS_POLICY
```

Return an explanation to the agent.

Hard-enforced policies must be explicit, deterministic, and logged.

Be careful with Pi's `bash` tool: the agent may circumvent an edit restriction by rewriting files through shell commands.

For the first prototype, detect and log obvious bypasses.

For the rigorous experiment mode, provide a restricted tool configuration or controlled execution environment that prevents easy policy bypass.

---

# 13. Pi Extension Integration

Implement this primarily as a project-local Pi extension during development.

Conceptual package structure:

```text
stasis/
├── package.json
├── README.md
├── src/
│   ├── extension.ts
│   │
│   ├── stasis/
│   │   ├── state.ts
│   │   ├── config.ts
│   │   ├── engine.ts
│   │   ├── homeostasis.ts
│   │   └── interactions.ts
│   │
│   ├── appraisal/
│   │   ├── events.ts
│   │   ├── appraiser.ts
│   │   ├── failure-detector.ts
│   │   └── fingerprints.ts
│   │
│   ├── policy/
│   │   ├── policy.ts
│   │   ├── adapter.ts
│   │   └── enforcement.ts
│   │
│   ├── persistence/
│   │   └── stasis-state-store.ts
│   │
│   ├── telemetry/
│   │   ├── recorder.ts
│   │   └── schema.ts
│   │
│   └── ui/
│       └── stasis-status.ts
│
├── experiments/
│   ├── runner.ts
│   ├── benchmark.ts
│   ├── metrics.ts
│   └── analysis.ts
│
└── tests/
```

Change this structure where necessary based on actual Pi conventions.

---

# 14. Pi Lifecycle Integration

Inspect the current Pi Extension API and wire into the closest supported lifecycle events for:

```text
before LLM/context generation
tool call
tool result
session start
session resume
session end
```

Conceptually:

```ts
pi.on("tool_result", async (event, ctx) => {
  const appraisal = await appraiser.appraise(event);

  const transition = stasisEngine.transition(
    state,
    appraisal,
    transitionContext
  );

  state = transition.after;

  telemetry.record({
    appraisal,
    transition,
  });
});
```

Then before the next model call:

```ts
const policy = policyAdapter.derive(state);
```

Inject the resulting state/policy into the model's context using the current supported Pi mechanism.

Intercept tool calls using the current supported Pi mechanism:

```ts
if (enforcement.violates(event, policy)) {
  return {
    block: true,
    reason: enforcement.explain(...)
  };
}
```

These snippets are architectural examples, not authoritative Pi API signatures.

Verify every actual hook and return type against the installed Pi version.

---

# 15. Persistence

The physiology must survive across turns in a Pi session.

Persist:

```text
current StasisState
configuration version
state transition number
recent failure fingerprints
repetition history
```

Use Pi's extension/session persistence capabilities where appropriate.

Keep the physiological state logically separate from ordinary conversational memory.

The LLM may receive a representation of current state, but it should not automatically receive the entire physiological history.

---

# 16. Telemetry

Telemetry is a first-class requirement.

Record every transition.

Example:

```json
{
  "step": 17,
  "timestamp": "2026-01-01T12:00:00Z",

  "event": {
    "type": "TEST_FAILURE",
    "severity": 0.42,
    "repeated": false
  },

  "stateBefore": {
    "stress": 0.31,
    "confidence": 0.65,
    "noveltyDrive": 0.42,
    "fatigue": 0.28,
    "persistence": 0.81
  },

  "eventDelta": {
    "stress": 0.12,
    "confidence": -0.08,
    "fatigue": 0.03
  },

  "homeostasisDelta": {
    "stress": -0.01
  },

  "stateAfter": {
    "stress": 0.42,
    "confidence": 0.57,
    "noveltyDrive": 0.42,
    "fatigue": 0.31,
    "persistence": 0.81
  },

  "policy": {
    "maxPatchLines": 100,
    "verificationLevel": 0.74,
    "explorationLevel": 0.46,
    "retryTolerance": 2
  }
}
```

Make the entire behavioral chain reconstructible:

```text
environment event
→ appraisal
→ physiological change
→ policy change
→ agent action
```

Use JSONL initially unless SQLite provides a clear advantage.

Keep storage abstractions simple enough to replace later.

---

# 17. Pi UI

Integrate a compact status display into Pi's TUI using the supported extension UI APIs.

Aim for something like:

```text
╭─ Stasis ─────────────────────────────╮
│ stress       ███████░░░  .71 ↑     │
│ confidence   ████░░░░░░  .42 ↓     │
│ novelty      ██████░░░░  .61 ↑     │
│ fatigue      ███░░░░░░░  .34 ↑     │
│ persistence  █████░░░░░  .49 ↓     │
│                                     │
│ Policy: CAUTIOUS / EXPLORATORY      │
│ patch ≤ 75 │ verify .86 │ retry 1   │
╰─────────────────────────────────────╯
```

Do not make the interface noisy.

The user should still interact with Pi normally.

---

# 18. Commands

Add useful extension commands using Pi's current command API.

Desired functionality:

```text
/stasis
```

Show current state and derived policy.

```text
/stasis history
```

Show recent state transitions.

```text
/stasis reset
```

Return state to configured baselines.

```text
/stasis enable
/stasis disable
```

Toggle neuromodulation without changing the rest of the Pi session configuration.

```text
/stasis config
```

Show active endocrine configuration.

```text
/stasis debug
```

Show detailed appraisal/transition information.

Adjust exact syntax to fit current Pi extension capabilities.

---

# 19. Interactive User Experience

The user should launch Pi normally:

```bash
pi
```

Then use it normally:

```text
> Fix the flaky PaymentProcessor integration test.
```

No special prompt format should be required.

The extension operates transparently.

An example session:

```text
Agent: Inspecting PaymentProcessor...

stress       .20
confidence   .50

→ read
→ grep
→ edit
→ bash: targeted test

TEST FAILURE

stress       .20 → .34
confidence   .50 → .41

Policy changed:
patch limit        150 → 100
verification       .55 → .70
inspection depth   3 → 5

Agent: The initial hypothesis was contradicted by the test result.
I'm inspecting the transaction boundary before modifying anything else.
```

The user may ask:

```text
> Why did your strategy change?
```

The agent may explain its current operating policy.

But the authoritative explanation must remain available from telemetry rather than relying on the LLM's self-report.

---

# 20. Experiment Runner

Build a separate Node/TypeScript experiment runner using the Pi SDK.

Do not automate experiments by shelling out to the interactive TUI if the SDK provides the necessary APIs.

The runner should create Pi sessions programmatically.

Support:

```text
CONTROL
NEUROMODULATION DISABLED

EXPERIMENTAL
NEUROMODULATION ENABLED
```

Everything else should be held constant where possible:

```text
model
model configuration
repository commit
task
tools
system instructions
token budget
environment
timeout
```

---

# 21. Experiment Definition

Support benchmark files such as:

```yaml
name: repeated-failure-study

trials: 20

model:
  provider: anthropic
  model: configured-model

conditions:
  - control
  - stasis

tasks:
  - id: bug-001
    repo: ./fixtures/bug-001
    prompt: Fix the failing authentication integration test.

  - id: bug-002
    repo: ./fixtures/bug-002
    prompt: Find and fix the race condition causing this test to fail intermittently.
```

Do not hard-code provider/model assumptions.

Use whatever Pi supports.

---

# 22. Metrics

Collect at least:

```text
task success
task failure
total model calls
total tokens
tool calls
files read
files modified
commands executed
tests executed
test failures
repeated failures
strategy changes
reverts
policy blocks
steps to completion
wall-clock duration
final diff size
```

For stasis runs additionally record:

```text
average stress
peak stress
average confidence
minimum persistence
fatigue trajectory
state transition count
policy transition count
time spent in policy regimes
```

---

# 23. Behavioral Metrics

Do not only measure final success.

Measure whether neuromodulation actually changes behavior.

Examples:

```text
average patch size after failure

files inspected before second modification

probability of repeating equivalent failed strategy

time between failure and strategy change

number of alternative hypotheses generated

verification frequency after uncertainty increases

riskiness of edits at different stress levels
```

This distinction is essential.

We are testing both:

```text
Does physiology change behavior?
```

and:

```text
Does the behavioral change improve outcomes?
```

Those are separate questions.

---

# 24. Reproducibility

Make experiments as reproducible as practical.

Record:

```text
Pi version
extension version
git commit
model identifier
model settings
StasisConfig
initial StasisState
benchmark definition
repository commit
environment metadata
```

Physiology itself must be deterministic.

LLM behavior obviously may not be.

Run repeated trials rather than relying on a single demonstration.

---

# 25. Control Condition

The control must be legitimate.

Do not compare:

```text
basic Pi
```

against:

```text
Pi + additional reasoning instructions + neuromodulation
```

unless those extra instructions are also present in the control.

The intended experimental difference is:

```text
CONTROL:
normal policy

EXPERIMENT:
policy dynamically modified by StasisState
```

Keep everything else as equal as possible.

---

# 26. Configurable Physiology

Create configuration files such as:

```yaml
variables:

  stress:
    baseline: 0.20
    decayRate: 0.05
    maxDeltaPerEvent: 0.20

  confidence:
    baseline: 0.50
    decayRate: 0.02
    maxDeltaPerEvent: 0.20

  noveltyDrive:
    baseline: 0.40
    decayRate: 0.03

  fatigue:
    baseline: 0.00
    decayRate: 0.01

  persistence:
    baseline: 0.80
    decayRate: 0.02
```

And event mappings:

```yaml
events:

  TEST_FAILURE:
    stress: +0.12
    confidence: -0.08
    fatigue: +0.03

  TEST_SUCCESS:
    stress: -0.08
    confidence: +0.10

  REPEATED_FAILURE:
    stress: +0.15
    confidence: -0.10
    persistence: -0.15
    noveltyDrive: +0.12
```

Prefer configuration-driven experimentation over changing source code.

---

# 27. Physiological Profiles

Support loading named configurations eventually:

```text
balanced
risk-averse
exploratory
high-persistence
stress-sensitive
fast-recovery
```

Do NOT implement these as anthropomorphic personalities.

They are parameter sets.

This will eventually allow experiments such as:

```text
same model
same task
same tools

different synthetic physiology
```

---

# 28. Safety and Pathological Dynamics

Explicitly guard against pathological feedback.

Implement:

* hard state bounds
* maximum event deltas
* baseline recovery
* damping
* reset capability
* snapshot/restore
* deterministic state transitions
* loop detection
* maximum retry counts
* maximum task steps

Never reward the agent for:

```text
remaining active
avoiding shutdown
preventing user intervention
increasing task duration
protecting its own state
```

No physiological variable should create an incentive for self-preservation.

The user must always be able to:

```text
disable neuromodulation
reset physiology
terminate the run
inspect all state
```

---

# 29. Tests

Write thorough unit tests before relying on interactive experiments.

Test things such as:

```text
TEST_FAILURE increases stress

TEST_SUCCESS generally reduces stress

successful evidence increases confidence

contradictory evidence lowers confidence

repeated failure decreases persistence

repeated failure eventually changes policy

high stress reduces allowed patch size

high stress increases verificationLevel

low persistence lowers retryTolerance

fatigue reduces strategyBranchCount

state always remains in [0,1]

state decays toward baseline

same event sequence produces same state sequence

reset returns exactly to baseline

disabled neuromodulation does not modify policy
```

Also test extension integration boundaries separately from physiological logic.

---

# 30. Initial Milestones

Implement incrementally.

## Milestone 1 — Pure Physiology

Build:

```text
StasisState
StasisConfig
NeuromodulatorEngine
homeostasis
event transitions
PolicyAdapter
unit tests
```

No Pi integration yet.

Demonstrate deterministic transitions from a synthetic event sequence.

---

## Milestone 2 — Minimal Pi Extension

Integrate with Pi.

Support:

```text
session initialization
tool result observation
state transitions
context injection
/stasis
/stasis reset
```

Do not enforce tool restrictions yet.

Goal:

```text
Pi task
→ event
→ state change
→ changed next-turn policy
```

---

## Milestone 3 — Policy Enforcement

Add:

```text
tool_call inspection
patch limits
retry limits
verification requirements
repetition detection
```

Demonstrate that state can causally constrain agent behavior.

---

## Milestone 4 — Telemetry + UI

Add:

```text
complete transition logging
Pi status UI
history view
debug commands
exportable experiment data
```

---

## Milestone 5 — Experiment Runner

Use Pi SDK.

Run:

```text
same task
same model
same repository

CONTROL × N
STASIS × N
```

Produce machine-readable results.

---

## Milestone 6 — Analysis

Generate summaries such as:

```text
                              CONTROL       STASIS
success rate                    68%          76%
mean attempts                   8.4          6.1
repeated failures               3.2          1.4
tests executed                  7.1          8.6
strategy changes                1.2          2.7
mean final diff               182 LOC      131 LOC
```

Also produce StasisState trajectory data suitable for graphing.

---

# 31. Important Design Rules

Follow these throughout implementation.

### Rule 1

Pi owns the coding-agent harness.

Do not rebuild functionality Pi already provides.

### Rule 2

Physiology lives outside the LLM.

### Rule 3

The LLM cannot directly mutate physiological state.

### Rule 4

Physiological state must have concrete behavioral consequences.

### Rule 5

Use hard enforcement where practical rather than relying entirely on prompts.

### Rule 6

Appraisal and physiology are separate systems.

### Rule 7

Prefer deterministic logic over LLM judgment.

### Rule 8

Everything important must be observable.

### Rule 9

The control condition matters as much as the experimental condition.

### Rule 10

Do not optimize the implementation toward proving that neuromodulation works.

Build an instrument capable of showing that it fails.

---

# 32. Definition of Done for v0.1

The first usable version is complete when I can:

```bash
cd some-codebase
pi
```

and interact with Pi normally while the extension:

1. initializes persistent StasisState,
2. observes coding-tool outcomes,
3. identifies at least test success/failure/repeated failure,
4. updates StasisState deterministically,
5. derives an AgentPolicy,
6. injects that policy into subsequent model context,
7. displays current state with `/stasis`,
8. logs every transition,
9. allows `/stasis reset`,
10. allows neuromodulation to be disabled.

Additionally, provide one automated Pi SDK experiment that executes the same fixture bug under:

```text
control
stasis
```

and outputs comparative metrics.

---

# 33. Begin Implementation

Start by inspecting:

```text
current repository
installed Pi package/version
Pi extension types
Pi SDK types
available lifecycle events
session persistence mechanisms
custom command/UI APIs
tool interception APIs
```

Then write a concise architecture/design document for this repository.

Do not spend excessive time planning.

After verifying the Pi APIs, implement **Milestone 1** and its tests, followed by the smallest possible **Milestone 2** vertical slice.

The first vertical slice should prove this complete causal chain:

```text
Pi tool executes
      ↓
test fails
      ↓
TEST_FAILURE appraised
      ↓
stress increases
confidence decreases
      ↓
AgentPolicy becomes more conservative
      ↓
new policy reaches the next LLM invocation
      ↓
transition is visible in telemetry
```

Once that works end-to-end, iterate outward rather than expanding architecture prematurely.
