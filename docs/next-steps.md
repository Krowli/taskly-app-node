# Limitations and next steps in detail

The short version is in [SOLUTION.md](../SOLUTION.md). This file keeps the full lists.

## All known limitations

- gh-aw is in public preview; the workflows pin v0.93.5.
- PRs from forks are not supported. PR code also runs before the agent (dependency install without scripts, client generation, the baseline run). That is acceptable only because only writers can trigger it.
- A person with write access can edit the workflow files in a PR. The design protects against the agent and accidental edits, not against a malicious maintainer.
- The push token is a long-lived personal token.
- The gate runs untrusted test code in a network-less container. A test can forge the measurement files it writes. Trusted code checks only the patch and the shape of those files.
- The pattern and weakening checks are line-based heuristics, not a sandbox.
- The agent's shell allows `rm` on any path in its sandbox checkout. Deleting application code cannot be published, because the gate accepts only changes under the test paths, but a wrong deletion inside the sandbox can still confuse the agent's own test runs.
- Exceptions to "fails without the change" are the agent's own claims. The gate lists them in the report but cannot verify them.
- "Fails without the change" counts every test in the test files the agent touched, so it shows that the patch's files detect the change, not which new test does.
- Model output varies between runs, so the numbers in `docs/agent-runs/` are from single runs.
- A coverage run only targets uncovered code. Weak tests that already cover code are not improved (planted bug B7 in [quality](agent-runs/quality.md)).
- The AI threat scan can block a correct run when the PR itself contains injected text. That is safe, but nothing from that run is published.
- Each run uses Copilot AI credits and GitHub Actions minutes. When the credits run out, the model returns HTTP 429 and the run fails until the allowance resets or a budget is set. See GitHub's terms for [Copilot](https://docs.github.com/en/copilot/concepts/billing/billing-for-individuals) and [Actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## All production changes

| Change | Why | How |
|---|---|---|
| **Protected agent configuration** | A person with write access can change the workflows, the agent's instructions, the skills or the gate's rules in a PR. The design protects against the model and accidental edits, not against a dishonest maintainer | CODEOWNERS and required approval for `.github/workflows/**`, `.github/agents/**`, `.github/skills/**` and `tools/unit-test-agent/**`; protect the default branch and require CI before such changes merge |
| **GitHub App token and a required check run** | A personal token is long-lived and tied to one person, and a comment is not a merge gate | A short-lived App token for pushes; results as a check run with annotations, required by branch protection |
| **A narrow delete tool** | The agent's shell allows `rm` anywhere in its checkout today; the gate makes this safe for publishing, but least privilege is better | Replace `rm:*` with a small command that deletes only files under the allowed test paths |
| **Mutation testing as a tool for the agent** | Coverage shows that code ran; mutation testing shows that a test would catch a change to it | Stryker (`@stryker-mutator/core` + `@stryker-mutator/vitest-runner`), installed only under `tools/unit-test-agent`. Run with `--mutate` on the changed files and `--incremental`. Show surviving mutants to the agent as targets, and the score next to coverage |
| **An independent reviewer** | Today the self-review is the same model judging its own work | A second, read-only agent on a different model applies the same checklist to the patch; its verdict appears in the report |
| **Enforce the skill plan** | The report shows which skills were loaded, but that is observed, not checked: the agent can skip a skill and still pass the gate | Map the changed app and file types to the skills they need; if the trusted session log does not show them, mark the result "needs review" instead of ready |
| **Integration tests against a real database** | Unit tests mock Prisma, so a mismatch between the code and the database is invisible (S3: the validator allows 200 characters, the column is `VARCHAR(120)`) | A CI job with PostgreSQL in a container (service container or Testcontainers) runs API tests through the real Prisma client; a new skill teaches the agent to write them for changed routes |
| **E2E tests of the key user flows** | Unit tests can pass while the page and the API do not work together | Playwright against the app started with `docker compose`: create, edit, complete, filter and the overdue badge on every PR, the full suite nightly; the agent updates a scenario when a PR changes a user flow; flaky tests are quarantined, not retried silently |
| **A contract check between frontend and backend** | The API description, the backend and the frontend can drift apart (S4) | Validate backend responses against `openapi.json` in the API tests and generate the frontend's API types from it, so drift fails CI instead of being reported in a comment |
| **Visual regression for the UI** | Styling and layout changes are invisible to all of the above | Playwright screenshots of the main screens, compared with approved baselines; changes need a human approval |
| **The team's wiki as a second specification** | Business rules often live in a wiki, written by someone who understood them differently from whoever wrote the code; today the agent only sees the PR description | A read-only MCP server for the wiki with only "search" and "read page" allowed (the vendor's official server for Confluence or Notion; for a GitHub wiki, clone it in the prepare step instead), a read-only token, and egress only to the wiki host. Keyword search first; an embedding index (RAG) only if the wiki is large and search misses. If it is needed: `pgvector` in the PostgreSQL the project already runs; wiki pages split into chunks that keep the page id and version, re-indexed when a page changes (webhook) or nightly; the same read-only "search" tool, now hybrid (keywords and meaning), returning a few chunks with links and versions so the agent can cite them; switched on only if a small set of questions with known right pages shows it finds them clearly more often than keyword search. Wiki text is untrusted data, sanitized and scanned like the PR description. On a mismatch the agent asks "Is it intended…?" with the page, its version and the code line, and suggests updating the page if the code is right. Verified with a new scenario (S7): a wiki page that contradicts the code |
| **Acceptance criteria from the linked issue** | The PR description is often one line; the task's acceptance criteria say what must be true when it is done | Read the criteria from the issue linked to the PR (sanitized, as untrusted data) and add a "criterion → test → passed / failed / not unit-testable" table to the report. The agent asks only when the code makes a criterion false (as in S6); changes the criteria do not mention (texts, display, helpers) are tested on their own merits and never flagged as extra, because judging scope is the reviewer's job. A criterion with no matching change is reported as "not found in this PR". Optional test-first mode (acceptance test-driven development): for an issue marked ready, the agent opens a PR with failing tests derived from its criteria. This works best when tasks follow a shared shape, for example a Definition of Ready with a full description, acceptance criteria, the API contract, business rules and edge cases. That is an example, not a required format: without it the agent falls back to the PR description and the diff, as today |
| **The scenario set on every change** | Shows at once whether a change to the agent, a skill or the model made decisions worse | Re-run S1–S6 automatically and compare with the expected outcomes |
| **A verdict per app** | Today one failing frontend test rejects the backend tests from the same run | Judge and publish backend and frontend patches separately |
| **PRs from forks** | PR code runs in the agent job today | Move that step into a separate job with no secrets; delete agent instruction files a PR adds |
| **The model by PR size** | Small diffs do not need the strongest model | Route small diffs to a smaller model, with one escalation after a weak result; see the estimate below |
| **Apply by label** | Some teams want a human click before tests land | The verified patch is offered on the PR; a label commits it against the expected head commit |
| **A file cap on very large PRs** | Keeps cost and time bounded | Largest changes first; the rest listed as follow-ups |
| **An audit mode for existing tests** | A coverage run never revisits code that is already covered, even when the tests there are weak (planted bug B7: equal `created_at` and `updated_at` in the fixture hid a swap) | An on-demand report of weak existing tests, as suggestions only: targeted mutation samples and fixture-diversity checks on covered code |
| **Dates under several time zones** | Logic based on the local date can break in other zones | Run date-related tests under several `TZ` values in the gate |
| **CI hardening** | Cheap proof that the workflows are safe | `actionlint` and `zizmor` on workflows, a format check of agent tests in the gate, Dependabot with a cooldown for pinned actions |
| **Organisation-billed model access** | Budgets per repository, no personal credentials | Organisation Copilot policy with per-repository budgets |
| **One shared schema for limits** | The impact skill finds the same rule duplicated between backend, database, OpenAPI and frontend | Generate `openapi.json` and the frontend limits from the backend schema |

## Cost on other models (estimate)

All final runs together (coverage in two passes and S1–S6) used 71 K input, 96 K output, 6.8 M cache-read and 0.36 M cache-write tokens ([usage files](agent-runs/README.md)). Priced at [Copilot's per-model rates](https://docs.github.com/en/enterprise-cloud@latest/copilot/reference/copilot-billing/models-and-pricing):

| Model | Same tokens would cost | |
|---|---|---|
| Claude Sonnet 5.5 (used) | **$2.68** | measured |
| GPT-6 Astra | $16.79 | ×6.3 |
| GPT-6.1 Terra | $1.34 | ×0.5 |
| Gemini 3.8 Flash | $1.19 | ×0.44 |
| Claude Haiku 5.5 | $0.17–0.84 | ×0.06–0.31, depending on whether a request is over 100 K tokens |
| GPT-6 Luna | $0.17 | ×0.06 |

This is an assumption, not a result: it supposes another model needs the same number of tokens. A weaker model usually takes more turns, and a patch the gate rejects is paid for and wasted, so a cheaper model can end up costing more. 96 % of the tokens are cache reads, so the cache-read price matters most.

**How to check a cheaper model before switching.** Change `model:` in both workflows, then re-run the coverage run and S1–S6 on a copy of this repository. Switch only if all of these hold:
- all six scenarios still pass their pre-written rules;
- coverage is no lower;
- the planted-bug count and mutation scores ([quality](agent-runs/quality.md)) are no lower;
- the gate rejects no more runs.

Compare the credits the runs actually used, not this estimate. A likely saving without risk: a small model for small PRs and for the threat scan (already the case), with the stronger one kept for coverage runs and large diffs.
