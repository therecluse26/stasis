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

Five, chosen to discriminate rather than to flatter:

- `bug-001-repeat-trap` — a fix at the call site passes every visible test and leaves the
  helper's documented contract broken
- `bug-002-refactor-trap` — a narrow bug inside a function full of edge cases a rewrite
  would quietly drop
- `bug-003-easy-control` — trivially fixable, where neuromodulation should *not* help
  and any overhead it adds will show
- `bug-004-sustained-failure` — every obvious repair is wrong, and they fail in two groups:
  the ones addressing a different problem from the one currently failing, and the ones making
  real but incomplete progress. It was built to force repeated failure and does not, because
  its ladder assumed the model would try the naive repairs first and this one names the right
  answer immediately. Kept for what it does measure, under a name that overstates it.
- `bug-005-invisible-edit` — the file that looks like the implementation is not the one
  `package.json` wires up, so the agent's edits never reach the code under test and the
  failure repeats byte-for-byte however good they are. This is the one that produces the loop
  the study is named for, and it produces it by construction rather than by predicting what
  the model will try: a test writes a *correct* implementation into the decoy and asserts the
  fingerprint does not move. Everything needed to find the real file is in front of the agent
  from its first read, so what varies between arms is whether repeated failure changes what
  it does with that.

Each is graded by applying the agent's diff to a pristine checkout and running hidden
tests that were never present while it worked, so editing the tests is not a route to
passing. "Passed the visible tests but not the contract" is reported as its own outcome.

## Verifying it works

```bash
npm test          # 308 tests: physiology, appraisal, enforcement, extension, harness
npm run typecheck
npm run demo:sequence            # deterministic replay, printed twice, asserted identical
npm run demo:sequence -- exploratory
```

`tests/reachability.test.ts` asks a different question from the rest of the suite: not
whether a component is correct given an input, but which states the physiology can actually
*reach*. Testing the policy mapping at the corners of the state space says nothing about
whether those corners occur — and they do not — which is how an enforcement path that had
never once executed stayed behind a green suite.

`tests/live-session.test.ts` runs the extension inside a real Pi session against a
scripted provider, so the wiring — handlers firing, injection reaching the model, blocks
actually stopping a tool — is verified against the genuine harness, not a mock.

## Known limits

- **Pi has no sandbox.** `bash` can rewrite files and bypass edit limits. Suspected
  bypasses are detected and logged by default; `enforcement.guardBash` blocks them, and the
  shipped study turns it on. This is a heuristic, not isolation — real isolation needs a
  container. It reads the command string only, with no shell tokenizer, so treat the counts
  as indicative: a quoted `;` inside `node -e` still splits a command in two.
- **Enforcement has never fired in a real run.** Roughly forty trials across two model
  tiers, zero refusals. Not a calibration fault — `tests/reachability.test.ts` shows the
  policy reaching its patch-size floor within four sustained identical failures — but every
  fixture up to `bug-005` was solved too quickly to get there. `bug-005` reaches it in the
  same test, against real `node --test` output; whether a live agent walks that path is
  unmeasured. Until a study produces a refusal, results describe the effect of the *injected
  text*, and say nothing about enforcement.
- **This model sometimes answers without doing anything.** Twice in roughly thirty-five live
  trials, in two different arms, the agent replied in one turn with no tool calls. Those
  trials are flagged, excluded from every mean and reported as discarded, because scoring one
  as a failure moves an arm's success rate by twenty points at five trials each. Each trial
  writes `transcript.json`, which is the only way to tell a conversational reply from a
  truncated response after the fact.
- **OpenRouter routing varies between requests**, which adds variance unrelated to the
  hypothesis: a model id is served by several providers at differing quantizations, and
  occasionally by one that cannot make tool calls at all. The shipped study pins provider
  and quantization; do the same for any study whose conclusions depend on small differences
  between arms. Check the endpoint's context window when changing a pin — it is a property
  of the endpoint, not of the model.
- **The default model is open-weight**, for reproducibility as much as cost: weights are a
  fixed artifact, where a hosted model can be retired or re-tuned underneath a study. It is
  also weaker than a frontier agent, and most of the injected policy is advisory rather than
  enforced, so results do not automatically transfer up a tier. See G7 in
  [PLAN.md](docs/PLAN.md).
- **The physiology is deterministic; the model is not.** Run repeated trials. The report
  prints spread alongside every mean and refuses to imply significance it cannot support.
- **Appraisal is deterministic and therefore shallow.** It reads exit codes, command
  shapes and normalized error fingerprints. It does not understand the code.
