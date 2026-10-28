# Threat model

Rule: no step of a run combines all three of:
1. untrusted input;
2. access to secrets;
3. the ability to change the repository.

Here every job has at most two.

| Job | Untrusted input | Secret | Can change the repository |
|---|---|---|---|
| `agent` (gh-aw sandbox) | Yes: the diff, the PR description, the code | The Copilot token, which the agent's commands cannot read (`run-tests.mjs` logs this check in every run) | No: a read-only token; output only through typed safe outputs |
| `detection`, gate step | Yes: the agent's patch and tests | No: the step gets no secret, and the gate unsets the OTLP variables | No |
| `detection`, AI threat scan | Yes: the patch, read as text | The Copilot token | No |
| `safe_outputs` | Only output that has already passed the gate; no code from the PR runs | The push token | Yes, but only test paths (`allowed-files`, `protected-files: blocked`) |
| Report (`workflow_run`, default branch) | Only the gate's report, rendered as data | `GITHUB_TOKEN` (`pull-requests: write`) | A PR comment only |

| Threat | Mitigation | Enforced in |
|---|---|---|
| Prompt injection through code, the diff or the PR description | The description reaches the agent as a sanitised file, never in the prompt template. Agent rule 6 says to ignore instructions and report them. AI threat scan. Deterministic signals (hidden characters, text addressed to AI agents in added lines) are listed in the report. Output is limited to test paths. | workflow, agent, detection |
| Edits outside test files | `allowed-files` and `protected-files: blocked` on publish; the gate validates the patch first | `safe_outputs`, gate |
| Weakened tests | Forbidden and weakening patterns in every added line (`.skip`, `.only`, matcher overrides, an early `return`, assertions only inside a conditional or `catch`, empty catches, `expect.assertions(0)` and others). An existing test file may only gain new test cases; any other change to an existing test, hook, file-scope mock or shared helper under the test paths must cite a changed source line in PR mode and is rejected in coverage mode. Every test in the patch's test files must assert (`--expect.requireAssertions`). In PR mode, when the PR modifies existing source, a test in the agent's test files must fail without the change, unless the agent declared an exception for every modified file; exceptions are listed in the report. | gate (`validate-patch.mjs`, `measure.sh`, `build-report.mjs`) |
| A test steals credentials or calls home | Tests run in `docker --network=none` with no secrets; patterns block `process.env`, network modules and `child_process` | gate |
| A PR changes the agent, skills or tooling to judge itself | gh-aw restores `.github/` from the base branch; analysis and gate use the base commit's `tools/unit-test-agent` | workflow |
| A forged report | Rendered by default-branch code. Measurement files are read as plain files under size caps. Agent claims are marked "not verified". The commit is shown only if its trailer matches the run. | report workflow |
| Runaway cost | A no-op ends the run before the model is called; `max-turns`; AI-credit caps per run and per day; one queued run per PR | workflow |
| A loop on the agent's own commits | A `commit-msg` hook adds a run trailer, and the analysis skips "agent commit at HEAD" | analysis |
| Untrusted code on the runner host | The host only runs `npm ci --ignore-scripts`; tests run in a container on throwaway copies; only regular result files are copied back | gate |
| Supply chain | Actions pinned by SHA, the container image by digest, no install scripts | workflows |

What the gate runs, per app, in network-less containers: the baseline full suite once with coverage on the commit the agent started from; then with the patch applied the typecheck once and the full suite once with coverage; for an app with test files in the patch, those files once with `--expect.requireAssertions` and three more times, and the full suite once in shuffled order; in PR mode, when the PR modifies testable source files, the patch's test files once more with those files restored to the merge base. Coverage percentages are for the files included in each app's Vitest coverage configuration. The report's skill and self-review rows are shown, not enforced.

Residual risks:
- A person with write access can edit the workflow files themselves. This model protects against the agent and against accidental edits, not against a malicious maintainer.
- A test can forge the measurement files it writes. Size caps and the earlier patch validation limit the damage.
- The pattern checks are line-based heuristics, not a parser: assertions made conditional through `&&`, `?:` or a helper, an early exit through `throw`, or code that misleads their bracket matching can pass them.
- "Fails without the change" counts every test in the agent's test files, including existing tests in a file the agent added to; a declared exception is the agent's claim, shown but not verified.
- PR code (dependency install without scripts, client generation, the baseline test run) executes in the agent job before the agent starts and before any credentials are configured. Only writers can trigger it; supporting fork PRs would require moving it to a separate job without secrets.
- The push token is a user token.
- gh-aw's sandbox and threat scan are trusted as documented, not audited here.
