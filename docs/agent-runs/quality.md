# Quality evaluation of the agent's tests

A controlled evaluation set for this repository: a benchmark of the current test suite, not proof that the agent finds every kind of bug in other projects. The agent did not see these bugs or mutants; they measure the tests it had already written.

## Why

Coverage only says that every line ran during the tests. A test with no real assertion also produces coverage. Two more questions were measured:
- **Do the tests notice when the code is wrong?**
- **Do the agent's tests notice it more often than the project's original tests?**

## What is compared

| | Commit | Tests |
|---|---|---|
| Original tests of the project | [`21ade40`](https://github.com/Krowli/taskly-app-node/commit/21ade40) (start of this repository) | backend 48, frontend 18 |
| Tests the agent wrote | [`a15d883`](https://github.com/Krowli/taskly-app-node/commit/a15d883) (after the coverage PR [#1](https://github.com/Krowli/taskly-app-node/pull/1) was merged) | backend 91, frontend 124 |

The application code is the same in both commits; only the tests differ.

Both checks run in a throw-away clone of the repository. They change source files only in that clone, one change at a time, and undo it. Nothing is committed, pushed or opened as a pull request.

## Check 1: planted bugs

**What a planted bug is.** A small, realistic mistake put into the source on purpose, to see whether the tests notice it.

**Where the 16 come from.** Chosen from the app's code and written down before anything was measured. Each breaks one rule that a user or an API client would notice: a length limit off by one, a wrong HTTP status, a reversed sort order, an inverted filter or label, the overdue rule, a lost error message, a cache not updated. `B1`–`B8` are in the backend and `F1`–`F8` in the frontend. The exact line and replacement of each are in [`quality/bugs.json`](quality/bugs.json).

**How it runs.** For each bug: apply it → run that app's full test suite → undo it. **Caught** means at least one test fails while the bug is in place; **missed** means every test still passes.

| Bug | What was broken | Original tests | Agent tests |
|---|---|---|---|
| B1 | Backend title limit 120 → 121 characters | caught | caught |
| B2 | Backend description limit 2000 → 2001 | caught | caught |
| B3 | Invalid JSON answered 400 instead of 422 | missed | caught |
| B4 | Shutdown timeout 10 s → 1 s | missed | caught |
| B5 | Deleting a missing task answered 400 instead of 404 | missed | caught |
| B6 | Task list sorted oldest first instead of newest first | caught | caught |
| B7 | "Created" date filled from the "updated" date | missed | **missed** |
| B8 | Database URL no longer converted for the driver | missed | caught |
| F1 | Frontend title limit check 120 → 121 | missed | caught |
| F2 | Frontend description limit rejects exactly 2000 | missed | caught |
| F3 | High and medium priority order swapped | caught | caught |
| F4 | A task due today counted as overdue during the day | missed | caught |
| F5 | The server's error message replaced by a generic one | missed | caught |
| F6 | A created task not added to the list until reload | missed | caught |
| F7 | "Completed" / "To do" labels swapped | caught | caught |
| F8 | "Completed" / "Active" filters swapped | caught | caught |
| **Total** | | **6 of 16** | **15 of 16** |

**Why B7 is missed.** The original tests already run that line, but their test task has the same "created" and "updated" date, so swapping them changes nothing. A coverage run gives the agent only code that no test runs yet, and it may not rewrite existing tests, so the agent never looked at this line. See "An audit mode for existing tests" in [SOLUTION.md](../../SOLUTION.md).

## Check 2: mutation testing

The same idea, automated and at scale. Stryker makes hundreds of tiny changes to the source (for example `<` → `<=`, `true` → `false`, a call removed, a string emptied), runs the tests for each, and counts how many changes the tests notice. The score is noticed ÷ all changes, including changes in code no test runs.

| App | Original tests | Agent tests | Weakest files with the agent's tests |
|---|---|---|---|
| Backend | 31.2 % (73 noticed, 146 in untested code) | **84.3 %** (198 of 235) | `factory.ts` 73 %, `database.ts` 80 %, `validators.ts` 81 % |
| Frontend | 29.0 % (129 noticed, 217 in untested code) | **89.4 %** (398 of 445) | `TodoFilters.tsx` 42 %, `TodoItem.tsx` 73 %, `TodoEmptyState.tsx` 78 % |

Most surviving changes are emptied strings (labels, messages and class names that no test reads: 30), emptied option objects (call arguments that are not asserted: 16) and conditions forced to true or false (15).

## How to repeat

Tools: Stryker 10.1.1 (`@stryker-mutator/core` + `@stryker-mutator/vitest-runner`, Apache-2.0), installed with `npm i --no-save` in the clone only. Settings per app: [`quality/backend.stryker.json`](quality/backend.stryker.json), [`quality/frontend.stryker.json`](quality/frontend.stryker.json) — `testRunner: vitest`, `coverageAnalysis: perTest`, and `mutate` equal to the app's Vitest coverage include and exclude lists. Environment used: `node:22` in Docker.

```sh
git clone https://github.com/Krowli/taskly-app-node /tmp/eval && cd /tmp/eval
git checkout a15d883            # or 21ade40 for the original tests
(cd backend && npm ci && npm run db:generate) && (cd frontend && npm ci)
node docs/agent-runs/quality/planted-bugs.mjs .   # prints the table and "Caught N of 16"
docs/agent-runs/quality/mutation.sh .             # prints each app's score
```

## Raw data

- [`quality/results-2026-10-28/raw-output.txt`](quality/results-2026-10-28/raw-output.txt): the scripts' output for both commits.
- [`quality/results-2026-10-28/mutation-summary.json`](quality/results-2026-10-28/mutation-summary.json): Stryker results per file for the agent's tests.
- [`quality/bugs.json`](quality/bugs.json): the 16 bugs with the exact original and replacement text.
