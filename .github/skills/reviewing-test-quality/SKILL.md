---
name: reviewing-test-quality
description: Checks each new or changed unit test against a short rubric before the run ends — oracle from the specification, existence is not a result, the whole result, distinct test data, no mock echo, only boundaries mocked, stubs that show their wiring, behaviour through the public interface, one behaviour per test, absence checked after presence, no early exits or conditional assertions, determinism, and a flip-the-condition check — and decides keep, revise or drop. Use after your tests pass and before reporting.
---

# Reviewing test quality

Passing tests can still be useless. Apply this checklist to every test you added or changed, after it passes and before you report.

## Checklist

1. **Oracle.** Expected values come from a source of truth: the PR description, a schema, `backend/openapi.json`, UI copy. Not from what the code returns today. If you copied a value from a failing run's output, find its source or drop the test.
2. **Existence is not a result.** `toBeDefined()`, `toBeTruthy()` or "is a function" only show that something exists. Assert the value itself against its source of truth.
3. **The whole result.** Assert everything the behaviour produces, not just one sign of it: the status **and** the body, the call **and** its arguments, the label **and** the state.
4. **Distinct test data.** Give different fields different values (two timestamps differ, two ids differ), so a swapped or dropped field fails the test.
5. **No mock echo.** Asserting only the value given to `mockResolvedValue` proves nothing. Also assert the call and its arguments, or the transformation.
6. **Only boundaries are mocked.** Mock only the module boundaries the `writing-backend-tests` and `writing-frontend-tests` skills name, never the module under test.
7. **Stubs show their wiring.** A stubbed child component renders the props the test checks and gives its controls an accessible role and name, so the test proves what the parent passed, not only that the stub rendered.
8. **Public interface.** Assert through an exported function, an HTTP response, rendered UI or a hook's result; never private state, class names or styles.
9. **One behaviour per test.** The name states it in the present tense ("rejects a whitespace-only title"). A boundary pair ("accepts n, rejects n+1") is two tests, and so is each step of a flow (open, save, close).
10. **Absence after presence.** Before asserting that something is absent or not called (`queryBy…` not in the document, `not.toHaveBeenCalled`), assert in the same test that its precondition happened. Otherwise the test also passes when nothing happens.
11. **Straight-line tests.** No early `return`, no `if` or `catch` around `expect`: every assertion runs on every run. The gate rejects early exits and conditional assertions.
12. **Deterministic.** Fake timers for dates, no order assumptions, mocks reset between tests in the file's existing style.
13. **Flip the condition.** Change the changed condition in your head (`<` to `<=`, drop the guard). If the test would still pass, strengthen or drop it. In pr mode, `--without-change` measures this.

## Verdict

Give each test one verdict:

- **keep**: every check holds.
- **revise**: fix the weak assertion or fixture, then re-run the file.
- **drop**: delete it and list it in `discardedTests` with the reason. Drop only tests you wrote, never a human's.
