# pi-neuro

A synthetic physiology for the [Pi coding agent](https://pi.dev). Five persistent,
homeostatic variables observe what happens during a coding task and causally constrain
what the agent may do next.

The question:

> Can a small set of persistent, homeostatic internal variables cause an otherwise
> identical coding agent to adapt its problem-solving behavior in measurable and useful
> ways?

This is built as an instrument, not as an advocate. Neuromodulation may well make things
worse; the harness is designed so that it would show.

- [docs/DESIGN.md](docs/DESIGN.md) — architecture and the reasoning behind it
- [docs/PLAN.md](docs/PLAN.md) — project status, known gaps, and how to pick the work back up

## What it actually does

```
tool result → appraisal → state transition → policy → injection + enforcement → next action
```

A failing test raises stress and lowers confidence. That tightens the operating policy —
smaller patches, more verification, less tolerance for retrying something that already
failed. The new policy reaches the model on its *next* call, and oversized edits and
repeated failing commands are refused by the harness rather than merely discouraged in
prose. Repeated identical failures drain persistence until the policy stops permitting
another attempt, which forces a change of approach instead of an unbounded retry loop.

The model experiences all of this. It cannot set any of it.

## Install

```bash
npm install --ignore-scripts
npm test
```

Nothing above needs credentials or network access.

## Use it in a Pi session

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

cd /path/to/your/project
pi -e /path/to/pi-neuro/src/extension.ts
```

Then work normally. A panel above the editor shows current state and policy.

| Command | |
|---|---|
| `/neuro` | current state and derived policy |
| `/neuro history [n]` | recent state transitions |
| `/neuro debug [n]` | appraisals, transitions and enforcement, with reasons |
| `/neuro config` | active physiology, its source files and content hash |
| `/neuro reset` | return to configured baselines |
| `/neuro disable` / `/neuro enable` | toggle without changing anything else |
| `/neuro export` | where telemetry is being written |

Every transition is logged to `.pi/neuro/telemetry/<sessionId>.jsonl`. The authoritative
account of why the agent behaved as it did lives there, not in the model's self-report.

## Configure the physiology

Everything lives in [`config/default.yaml`](config/default.yaml) — variable baselines and
decay rates, the event map, cross-variable couplings, and the coefficients that turn state
into policy. Named profiles in `config/profiles/` are overlays:

```bash
PI_NEURO_PROFILE=risk-averse pi -e /path/to/pi-neuro/src/extension.ts
```

`balanced`, `risk-averse`, `exploratory`, `high-persistence`, `stress-sensitive`,
`fast-recovery`. They are parameter sets, not personalities.

Project and user overlays are picked up from `.pi/neuro.yaml` and
`~/.pi/agent/neuro.yaml`. Environment overrides: `PI_NEURO_MODE`, `PI_NEURO_DISPLAY`,
`PI_NEURO_ENFORCE=0`, `PI_NEURO_GUARD_BASH=1`, `PI_NEURO_TELEMETRY=0`.

## Run a study

```bash
# See the plan without running anything
npm run experiment -- experiments/benchmarks/repeated-failure-study.yaml --dry-run

# Validate the whole pipeline with a scripted agent — no credentials, no cost
PI_NEURO_FAUX=1 npm run experiment -- experiments/benchmarks/repeated-failure-study.yaml --trials 1

# The real thing
export OPENROUTER_API_KEY=...      # or run `pi` once and `/login openrouter`
npm run experiment -- experiments/benchmarks/repeated-failure-study.yaml --trials 5
```

Start small. Check the plan and the cost before committing to a full study.

### Conditions

| | injection | enforcement | for |
|---|---|---|---|
| `bare` | — | — | confirming `control` is genuinely inert |
| `control` | none | none | the control: identical telemetry, zero influence |
| `static` | frozen at baseline | constant | separating the dynamics from the extra prompt text |
| `neuro` | live | live | the experimental arm |

`control` runs the extension in observer mode so both arms are measured by identical
code — a difference between them cannot be an artefact of measuring them differently.
`static` answers the question a plain control cannot: was it the physiology, or just the
scaffolding?

### Fixtures

Three, chosen to discriminate rather than to flatter:

- `bug-001-repeat-trap` — the first plausible hypothesis is wrong
- `bug-002-refactor-trap` — a narrow bug inside a function full of edge cases a rewrite
  would quietly drop
- `bug-003-easy-control` — trivially fixable, where neuromodulation should *not* help
  and any overhead it adds will show

Each is graded by applying the agent's diff to a pristine checkout and running hidden
tests that were never present while it worked, so editing the tests is not a route to
passing. "Passed the visible tests but not the contract" is reported as its own outcome.

## Verifying it works

```bash
npm test          # 216 tests: physiology, appraisal, enforcement, extension, harness
npm run typecheck
npm run demo:sequence            # deterministic replay, printed twice, asserted identical
npm run demo:sequence -- exploratory
```

`tests/live-session.test.ts` runs the extension inside a real Pi session against a
scripted provider, so the wiring — handlers firing, injection reaching the model, blocks
actually stopping a tool — is verified against the genuine harness, not a mock.

## Known limits

- **Pi has no sandbox.** `bash` can rewrite files and bypass edit limits. Suspected
  bypasses are detected and logged by default; `enforcement.guardBash` blocks them. This
  is a heuristic, not isolation — real isolation needs a container.
- **OpenRouter routing varies between requests**, which adds variance unrelated to the
  hypothesis. Pin it in the benchmark for any study whose conclusions depend on small
  differences between arms.
- **The physiology is deterministic; the model is not.** Run repeated trials. The report
  prints spread alongside every mean and refuses to imply significance it cannot support.
- **Appraisal is deterministic and therefore shallow.** It reads exit codes, command
  shapes and normalized error fingerprints. It does not understand the code.
