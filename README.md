# Stasis

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
pi -e /path/to/stasis/src/extension.ts
```

Then work normally. A panel above the editor shows current state and policy.

| Command | |
|---|---|
| `/stasis` | current state and derived policy |
| `/stasis history [n]` | recent state transitions |
| `/stasis debug [n]` | appraisals, transitions and enforcement, with reasons |
| `/stasis config` | active physiology, its source files and content hash |
| `/stasis reset` | return to configured baselines |
| `/stasis disable` / `/stasis enable` | toggle without changing anything else |
| `/stasis export` | where telemetry is being written |

Every transition is logged to `.pi/stasis/telemetry/<sessionId>.jsonl`. The authoritative
account of why the agent behaved as it did lives there, not in the model's self-report.

## Configure the physiology

Everything lives in [`config/default.yaml`](config/default.yaml) — variable baselines and
decay rates, the event map, cross-variable couplings, and the coefficients that turn state
into policy. Named profiles in `config/profiles/` are overlays:

```bash
PI_STASIS_PROFILE=risk-averse pi -e /path/to/stasis/src/extension.ts
```

`balanced`, `risk-averse`, `exploratory`, `high-persistence`, `stress-sensitive`,
`fast-recovery`. They are parameter sets, not personalities.

Project and user overlays are picked up from `.pi/stasis.yaml` and
`~/.pi/agent/stasis.yaml`. Environment overrides: `PI_STASIS_MODE`, `PI_STASIS_DISPLAY`,
`PI_STASIS_ENFORCE=0`, `PI_STASIS_GUARD_BASH=1`, `PI_STASIS_TELEMETRY=0`.

## `.env`

Copy [`.env.example`](.env.example) to `.env` and fill in what you need — credentials, a
profile, whatever you would otherwise be exporting by hand. `.env` and `.env.local` are
gitignored.

Precedence, lowest first: `.env` → `.env.local` → whatever is already in your shell. So a
one-off still overrides the file:

```bash
PI_STASIS_MODE=off npm run experiment -- <benchmark>   # wins over .env
```

Values are literal: no `${VAR}` interpolation and no shell evaluation, because a
configuration channel that can compute is one that can differ between two runs of the same
study. A live `pi` session reads only the `PI_STASIS_*` variables from a `.env` and never
alters its own environment, so a project's own secrets stay where they are. `/stasis config`
names any file that actually contributed, and so does the telemetry run header.

The study runner prints what it loaded, with credential values redacted, and takes
`--dotenv PATH` or `--no-dotenv`. (`--dotenv`, not the obvious `--env-file`, because Node
claims that name for itself anywhere in the command line.)

## Run a study

```bash
# See the plan without running anything
npm run experiment -- experiments/benchmarks/repeated-failure-study.yaml --dry-run

# Validate the whole pipeline with a scripted agent — no credentials, no cost
PI_STASIS_FAUX=1 npm run experiment -- experiments/benchmarks/repeated-failure-study.yaml --trials 1

# The real thing. Needs OPENROUTER_API_KEY in .env or the environment —
# or run `pi` once and `/login openrouter`, which stores a token Pi finds itself.
npm run experiment -- experiments/benchmarks/repeated-failure-study.yaml --trials 5
```

Start small. Check the plan and the cost before committing to a full study.

Keep `PI_STASIS_FAUX` out of `.env`. A stale `1` there would run an entire study against
the scripted agent while every trial looked healthy; the runner warns when it finds that
variable in a file rather than in your shell, but the warning is the last line of defence.

### Conditions

| | injection | enforcement | for |
|---|---|---|---|
| `bare` | — | — | confirming `control` is genuinely inert |
| `control` | none | none | the control: identical telemetry, zero influence |
| `static` | frozen at baseline | constant | separating the dynamics from the extra prompt text |
| `stasis` | live | live | the experimental arm |

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
npm test          # 250 tests: physiology, appraisal, enforcement, extension, harness
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
