---
name: running-unit-tests
description: How to run, debug and verify unit tests and coverage for backend/ and frontend/ with the repo's run-tests script — the only way the agent runs tests. Use whenever you need to execute tests, check that a test fails without the PR's change, check which lines of a source file are still uncovered, typecheck, or decide whether to fix or discard a failing test.
---

# Running unit tests

`./.unit-test-agent/bin/run-tests.mjs` is the only way to run tests and the typecheck. It wraps Vitest (with `--expect.requireAssertions`) and `tsc`, and prints totals, then each failure with its message and the repo frames of the stack. Treat it as a black box; `--help` prints usage and examples. Call it exactly as `./.unit-test-agent/bin/run-tests.mjs …` from the repository root: `node <script>`, shell variables or chained commands are denied by the sandbox. Paths are repo-relative (`backend/tests/x.test.ts`, not `tests/x.test.ts`).

## The loop

1. After writing or editing a test file, run just that file: `./.unit-test-agent/bin/run-tests.mjs backend -- backend/tests/<name>.test.ts`.
2. In pr mode, run the tests of changed behaviour with `./.unit-test-agent/bin/run-tests.mjs <app> --without-change -- <files>`. A test that `passes without the change` does not detect it: strengthen its assertions on the new behaviour. When the PR modifies existing behaviour, at least one new test must fail here, unless you declared a per-file exception (`analyzing-pr-changes`).
3. Add `--coverage <source file>` to print that file's still-uncovered lines, branches and functions. It finds what is not exercised yet; it does not tell you what to assert.
4. Triage each failure:
   - **Test bug** (wrong import, wrong query, missing `await`, setup): fix the test.
   - **Wrong expectation**: re-read the source and `.unit-test-agent/pr.diff`. If the PR description (`.unit-test-agent/pr-description.md`) states the expected behaviour, keep that expectation, drop the test and report it in `suspectedBugs`. Otherwise change the expectation only if the code's behaviour is clearly intended (names, docs, diff).
   - **Environment problem** (e.g. the generated Prisma client is missing, or a dependency is not installed): stop and report it in your summary. Never work around it in the test.
5. Allow at most 3 fix attempts per file, then discard it: overwrite a new file with empty content, or restore an edited file's original text, and list it in `discardedTests`.
6. Before finishing, run your touched test files with `--repeat 3` (`./.unit-test-agent/bin/run-tests.mjs <app> --repeat 3 -- <files>`). Fix or drop every test it reports as `flaky:`; the gate rejects the whole run for one flaky test.
7. After the test review, run each app you touched once without file arguments (the whole suite) and once with `--typecheck`.

Frontend test files new in this PR are formatted with Prettier when you run them (`reformatted: <path>`); re-read a file before editing it after a run.

The run also checks your changes with the gate's own rules and prints `policy:` lines; fix every one before you finish.

`./.unit-test-agent/bin/run-tests.mjs --check-output` checks `.unit-test-agent/agent-output.json` against its schema and prints each error; run it after writing that file and fix every error.

## Reading results

- `X passed, Y failed, Z total`: Y must be 0.
- `FAIL <file> (file failed to load)` is an import or syntax error, so nothing in that file ran.
- `expected any number of assertion, but got none`: the test has no `expect`. Add a real assertion; don't add a trivial one.

## Common mistakes

- Running the whole suite after every edit (slow). Run the file, then the suite once at the end.
- Weakening an assertion until it passes. The agent rules forbid it, and the workflow audits changed tests.
