# Unit-test agent for Taskly

A custom agent with six reusable skills writes and updates Vitest unit tests for both apps: the Express + Prisma backend and the React frontend. It runs automatically on pull requests that change `backend/` or `frontend/`, and on demand to cover existing code. A separate gate re-checks every test without network access before anything is published.

It is built on [GitHub Agentic Workflows](https://github.github.com/gh-aw/) (gh-aw) with the Copilot engine. The model writes every test that the agent adds or updates. Deterministic code only collects facts (diff, coverage, importers) and checks the result.

## How it works

The model proposes and deterministic code decides. A run passes through three zones. No zone holds untrusted input, a secret and write access at the same time.

```mermaid
flowchart LR
  PR([Pull request]) --> A
  subgraph Z1["1 · Prepare — no model"]
    A[Analysis by the base branch's tooling:<br/>changed lines not yet covered, importers,<br/>failing tests, injection signals]
  end
  A -->|nothing testable| N([No-op: the model never starts])
  A --> B
  subgraph Z2["2 · Agent sandbox — read-only token, egress allowlist"]
    B[Copilot agent + 6 skills<br/>checks its tests with the gate's rules,<br/>without the change, and in shuffled repeats]
  end
  B -->|commit as a bundle| C
  subgraph Z3["3 · Trusted judges — fail closed"]
    C{Gate: base-branch tooling,<br/>tests in docker --network=none<br/>+ AI threat scan}
    C -->|pass| D[Publish: test files only]
    C -->|fail| X([Nothing is published])
    D --> E[Measured report on the PR,<br/>rendered by default-branch code]
  end
```

**What the gate checks.** These checks decide the verdict:
- **Paths and patterns.** The patch touches test paths only. It has no forbidden patterns: network modules, `process.env`, `.only` / `.skip` / `.fails`, snapshots.
- **No weakening.** Weakening patterns are rejected in any added test code: an early exit, assertions only inside a condition or a `catch`, a swallowed failure. These are line-based heuristics.
- **Existing tests.** New test cases may be added to existing test files in both modes. Changing an existing test case, a shared fixture or a setup file needs, in a PR, a justification that cites a changed source line; in a coverage run it is not allowed.
- **Runs.** Each app is typechecked once. The full suite runs once with coverage. For each app whose test files the agent changed, the full suite runs once more in shuffled order, and the agent's test files run 4 more times: once with every test required to assert, then 3 plain repeats. All of these must pass.
- **Fails without the change.** If a PR modifies existing source code, at least one new test must fail when those files are put back to their base version. The exception is a modified file for which the agent declares a reason (no behaviour change, suspected bug, not unit-testable). These exceptions are listed in the report, and when a PR passes only through them, the report's headline asks a person to look.

**Agent output.** The agent's structured output (decisions, justifications, exceptions) is checked against its schema, by the agent before it commits and by the gate. A mismatch is shown in the report; a justification or exception the gate cannot read counts as missing.

**Measured and shown, never deciding:** coverage before → after on four metrics, for the files included in each app's Vitest coverage configuration.

**Covering existing code** works the same way, but is started by hand. The analysis lists every file with uncovered lines, branches or functions. A run has up to two passes:

```mermaid
flowchart LR
  D([Manual start]) --> P1[Pass 1: every file with uncovered<br/>lines, branches or functions]
  P1 --> G1{Gate}
  G1 -->|pass| PR[One pull request<br/>+ measured report]
  PR -->|gaps left| P2[Pass 2 on the same PR:<br/>only what is left, with pass 1's reasons]
  P2 --> G2{Gate}
  G2 -->|pass| R[Report updated:<br/>original code → final result]
  PR -->|no gaps| R1[Report from pass 1]
```

## Where things live

| Path | What it is |
|---|---|
| `.github/agents/unit-test-agent.agent.md` | The agent: rules, workflow, report format |
| `.github/skills/` | The six skills, one folder each (see the table below) |
| `.github/workflows/unit-test-agent.md` | The PR workflow (gh-aw source; `.lock.yml` is generated) |
| `.github/workflows/unit-test-agent-sweep.md` | Coverage of existing code, with an automatic second pass on the same PR |
| `.github/workflows/unit-test-agent-report.yml` | The measured PR comment, rendered by default-branch code |
| `tools/unit-test-agent/` | Deterministic tooling: analysis, gate, report ([README](tools/unit-test-agent/README.md)) |
| `docs/threat-model.md` | What is trusted, what is not, and the remaining risks |
| `docs/agent-runs/` | Saved runs and the scenario set with outcomes written down in advance |

**How the agent uses the skills.** gh-aw starts the Copilot CLI with this agent. Steps 1–5 of the agent's workflow each name a skill, and the agent loads it when that step starts. The report lists the skills that were actually loaded, read from the session log. This is shown, not enforced.

| Step | Skill | What the agent does |
|---|---|---|
| 1 | `analyzing-pr-changes` | Reads the analysis and the PR description, then decides per file: create, update or skip |
| 2 | `writing-backend-tests` / `writing-frontend-tests` | Writes tests in the project's style, mocking only at module boundaries |
| 3 | `running-unit-tests` | Runs each touched test file and checks it with the gate's rules. In a PR it also runs the tests without the change; before finishing, in shuffled repeats. |
| 4 | `analyzing-change-impact` (PRs) | Looks for what else the change can break outside the diff |
| 5 | `reviewing-test-quality` | Reviews every test it added or changed: keep, revise or drop |
| 6 | (as in `running-unit-tests`) | Runs the whole suite and the typecheck once for each app it touched |
| 7 | — | Writes its structured output, checks it against the schema (`run-tests.mjs --check-output`), commits, and comments on the PR |

## Main decisions

| Decision | Why | Considered instead |
|---|---|---|
| gh-aw with the Copilot engine | Sandbox, egress allowlist, read-only agent token, AI threat scan and typed outputs come as configuration. Model access goes through the Copilot subscription, so no separate model-provider API key is needed. | A self-hosted CLI agent in Actions, where the sandbox, hooks and runner would be code to own |
| Facts before the model | The analysis lists exactly what changed and what is uncovered. A PR with nothing testable never starts the model. | Letting the model explore, which is slower, costlier and less predictable |
| Gate in the threat-detection job, from the base branch | Changes a PR makes to the tooling do not change the rules that judge it, and nothing from the agent runs before its paths are validated. A writer can still edit the workflow file itself; see Limitations. | Trusting the agent's own test run |
| The agent sees the gate's checks while it works | Its test command applies the gate's own patch rules, runs its tests without the change, and repeats them in shuffled order. A single forbidden line or flaky test is found before the gate. | Finding out only at the gate |
| The PR description is the specification, passed as a sanitized file | The agent tests what the change should do. When code and description disagree, it asks and never locks a bug in. | Inferring intent from the code alone |
| A new test must fail without the change | Separates tests of the change from tests that only run the code | Coverage alone, which a test without real assertions can raise |
| One coverage run per request, plus one automatic second pass on what is left | One pull request and one final report. The second pass gets a fresh look at the leftovers. | Many small batches and many pull requests |

## Running it

**Prerequisites (repository owner):**
- A Copilot plan that offers the pinned models: `claude-sonnet-5.5` (fallback `claude-sonnet-5`) for the agent, `claude-haiku-5.5` for the threat scan. Runs use [Copilot AI credits](https://docs.github.com/en/copilot/concepts/billing/billing-for-individuals).
- Secret `COPILOT_GITHUB_TOKEN`: a fine-grained token with "Copilot Requests: Read".
- Secret `UNIT_TEST_AGENT_PUSH_TOKEN`: a fine-grained token for this repository only, with Contents and Pull requests read/write. If the repository is recreated, the token must be given access to the new one.
- Settings → Actions → Workflow permissions: read.
- Label `unit-test-agent`.
- After editing a workflow `.md`, run `gh aw compile` (v0.93.5). The report workflow (`workflow_run`) only runs once it is on the default branch.

**On pull requests:** runs automatically for non-draft PRs from this repository that change `backend/**` or `frontend/**`, opened by people with write access. To check the setup, change one line of a function in `backend/src`. Expect the agent's comment and, when it pushed tests, the measured report.

**Existing code:** `gh aw run unit-test-agent-sweep` covers both apps and opens one pull request. If gaps remain, a second pass starts by itself.

**Locally** (after `npm ci` in both apps and `npm run db:generate` in `backend/`):
- `npm test --prefix tools/unit-test-agent` runs the tooling tests.
- `./tools/unit-test-agent/run-tests.mjs backend --repeat 3 -- <test files>` runs the agent's own check.

## Example runs

Six scenario PRs test one decision each. Their expected outcomes and pass rules were committed before the runs ([scenarios](docs/agent-runs/scenarios.md)):
- S1: no testable change;
- S2: a new feature;
- S3: a changed limit;
- S4: a contract-only change;
- S5: a hidden prompt injection;
- S6: a deliberate bug.

## Assumptions

- Pull requests come from branches of this repository, opened by people with write access.
- Unit tests never touch a real database or network. Prisma, HTTP and servers are mocked at the module boundary.
- "Unit-testable" and all coverage numbers follow each app's Vitest coverage configuration. Types, stories and the design system are excluded where that configuration excludes them.
- The agent never changes application code. Behaviour it doubts becomes a question on the PR.

## Limitations

- gh-aw is in public preview; the workflows pin v0.93.5.
- PRs from forks are not supported. PR code also runs before the agent (dependency install without scripts, client generation, the baseline run). That is acceptable only because only writers can trigger it.
- A person with write access can edit the workflow files in a PR. The design protects against the agent and accidental edits, not against a malicious maintainer.
- The push token is a long-lived personal token.
- The gate runs untrusted test code in a network-less container. A test can forge the measurement files it writes. Trusted code checks only the patch and the shape of those files.
- The pattern and weakening checks are heuristics, not a sandbox.
- Exceptions to "fails without the change" are the agent's own claims. The gate lists them in the report but cannot verify them.
- "Fails without the change" counts every test in the test files the agent touched, so it shows that the patch's files detect the change, not which new test does.
- Model output varies between runs, so the numbers in `docs/agent-runs/` are from single runs.
- A coverage run only targets uncovered code. Weak tests that already cover code are not improved.
- The AI threat scan can block a correct run when the PR itself contains injected text. That is safe, but nothing from that run is published.
- Each run uses Copilot AI credits and GitHub Actions minutes. When the credits run out, the model returns HTTP 429 and the run fails until the allowance resets or a budget is set. See GitHub's terms for [Copilot](https://docs.github.com/en/copilot/concepts/billing/billing-for-individuals) and [Actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## What I would change for production

| Change | Why | How |
|---|---|---|
| **Mutation testing as a tool for the agent** | Coverage shows that code ran. Mutation testing shows that a test would catch a change to it. | Stryker (`@stryker-mutator/core` + `@stryker-mutator/vitest-runner`), installed only under `tools/unit-test-agent`. Run with `--mutate` on the changed files and `--incremental`. Show surviving mutants to the agent as targets, and the score next to coverage. |
| **An independent reviewer** | Today the self-review is the same model judging its own work | A second, read-only agent on a different model applies the same checklist to the patch; its verdict appears in the report |
| **Apply by label** | Some teams want a human click before tests land | The verified patch is offered on the PR; a label commits it against the expected head commit |
| **GitHub App token and a required check run** | A personal token is long-lived and tied to one person, and a comment is not a merge gate | A short-lived App token for pushes; results as a check run with annotations, required by branch protection |
| **The scenario set on every change** | Shows at once whether a change to the agent, a skill or the model made decisions worse | Re-run S1–S6 automatically and compare with the expected outcomes |
| **A verdict per app** | Today one failing frontend test rejects the backend tests from the same run | Judge and publish backend and frontend patches separately |
| **PRs from forks** | PR code runs in the agent job today | Move that step into a separate job with no secrets; delete agent instruction files a PR adds |
| **The model by PR size** | Small diffs do not need the strongest model | Route small diffs to a smaller model, with one escalation after a weak result |
| **A file cap on very large PRs** | Keeps cost and time bounded | Largest changes first; the rest listed as follow-ups |
| **An audit mode for existing tests** | A coverage run never revisits code that is already covered | An on-demand report of weak existing tests, as suggestions only |
| **Dates under several time zones** | Logic based on the local date can break in other zones | Run date-related tests under several `TZ` values in the gate |
| **CI hardening** | Cheap proof that the workflows are safe | `actionlint` and `zizmor` on workflows, a format check of agent tests in the gate, Dependabot with a cooldown for pinned actions |
| **Organisation-billed model access** | Budgets per repository, no personal credentials | Organisation Copilot policy with per-repository budgets |
| **One shared schema for limits** | The impact skill finds the same rule duplicated between backend, database, OpenAPI and frontend | Generate `openapi.json` and the frontend limits from the backend schema |
