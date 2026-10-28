---
name: writing-backend-tests
description: Conventions, module-boundary mocks and techniques for Vitest unit tests in backend/ — supertest against Express routers and the app, the Prisma client without a database, modules that read the environment at import time, entrypoints that start servers or connect to the database, process hooks, timers and error branches. Use before creating or editing any file under backend/tests, or when a backend test fails for setup reasons.
---

# Writing backend tests

Backend tests are fast unit tests: no database, no network, no `.env`. Match the existing compact style (semicolons, short top-level `it`s). Choose the cases with `analyzing-pr-changes`; this skill covers how to write them.

## Conventions

- Location `backend/tests/<source-basename>.test.ts`. Import sources with the `.ts` extension: `import { createSchema } from '../src/features/todos/validators.ts'`.
- Import from Vitest explicitly: `import { it, expect, vi } from 'vitest'` (no globals). Top-level `it(...)`; `describe` only to group; `it.each` for tables.
- Shared data: `record` (Prisma row) and `todo` (API JSON) from `backend/tests/fixture.ts`. Make variants with spread (`{ ...record, completed: true }`) instead of editing the fixture.
- Environment: `vi.stubEnv` for every variable a case depends on (an empty string clears one) and `vi.unstubAllEnvs()` in `afterEach`. Never read or write `process.env` in a test; the gate rejects it.

## Boundaries

- **Database.** Build the real client and spy on its delegates, so the types stay real and no PostgreSQL is needed (as in `backend/tests/repository.test.ts`):

  ```ts
  const database = createDatabase('postgresql://test:test@localhost:5432/test');
  vi.spyOn(database.todo, 'findMany').mockResolvedValue([record]);
  afterEach(() => vi.restoreAllMocks());
  ```

- **HTTP.** Call Express in memory with `supertest`. A router: mount it on a bare `express()` app with a fake store of `vi.fn()` (as in `backend/tests/router.test.ts`). The whole app: build it with its factory and the spied client above.
- **Collaborator modules.** `vi.mock('../src/<path>.ts', () => ({ … }))` is hoisted and applies to the whole file. A case that needs a different mock goes in its own file, or uses `vi.doMock` before a dynamic import.

## Hard-to-reach code

- **Reads configuration at import time** (loads `.env`, reads variables at top level): stub the inputs first, then `vi.resetModules()` and `await import('../src/<module>.ts')` inside the test (a literal path). A `.env` loaded on import can fill any variable you did not stub, so stub them all.
- **Entrypoints that start servers or connect to the database:** mock what they create or connect to at the module boundary (the database factory returns a fake with `$connect`/`$disconnect`), import the entrypoint inside the test, `vi.resetModules()` between cases. Either let the server listen on port `0` and close it in `afterEach`, or fake whatever creates it, assert the `listen` arguments and trigger its callback or `error` event yourself. Never connect to a real server.
- **Process hooks:** capture signal handlers without registering them, `vi.spyOn(process, 'once').mockImplementation(() => process)`, then call the captured handler; stub `process.exit` the same way. Never call `process.removeAllListeners`.
- **Error branches:** make the boundary reject (`mockRejectedValue`); Express 5 forwards rejected async handlers to the error handler. Assert the status, the body and the log (`vi.spyOn(console, 'error').mockImplementation(() => {})`). When a startup step fails, assert that cleanup ran and the error was rethrown.
- **Client factories:** mock the constructor or module and assert the arguments it received.
- **Time:** `expect.any(Date)` for generated timestamps, or `vi.useFakeTimers({ now: new Date('2026-10-15T12:00:00Z') })` with `vi.useRealTimers()` in `afterEach`. For timeouts, advance to just before the deadline and exactly to it.
- **A defensive branch no public input can reach:** name it and say why in `decisions`, instead of forcing it.

## Common mistakes

- Typing fakes as `any` and losing the contract.
- Tests that depend on run order or on another test's mocks (restore mocks in `afterEach`).
- Snapshot assertions on JSON bodies (the gate rejects snapshots). Assert the fields that matter.
