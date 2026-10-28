---
name: analyzing-change-impact
description: Finds behaviour outside the diff that a change can break — importers, business rules duplicated between backend and frontend, database schema and OpenAPI contracts, API request/response shapes, query cache keys — and reports evidence-backed findings. Use in every pr-mode run after deciding tests, and always when a change touches limits, enums, validation, dates, status codes, response fields, SQL/Prisma schema, openapi.json or query keys.
---

# Analyzing change impact

## Overview

Import graphs only see code that imports code. In this repo one business rule can live in places that never import each other: backend validators, the Prisma schema, raw SQL, `openapi.json`, frontend validation and frontend messages. A change to one copy silently breaks the others. Find those places, prove them with file and line, and say what a user would experience.

## Method (in order)

1. **Importers.** For each changed source file, take `importers` and `transitiveImporters` from the manifest and grep the changed exported symbol in them. Cite as `relatedLines` the usage line(s) your grep finds, falling back to `importLines[importer]` when the importer only re-exports or the usage is the import itself. If an importer's behaviour provably changes and is unit-testable in the same app, add a test (`action: tested`).
2. **Old values first.** Start from manifest `literalHits` with `side: removed`: after `N` → `M`, stale copies elsewhere still say `N`. Then check `side: added` hits. Ignore hits where the same literal means something else (an HTTP status, a design-system variant).
3. **Your own search.** Grep both apps for the enum values, field names, limits, error messages and date handling the diff touched.
4. **Persistence and docs.** Files no import graph sees: `backend/prisma/schema.prisma`, the raw DDL in `backend/src/core/database.ts`, `backend/openapi.json`.
5. **API contract.** Backend router, validators and mappers against the frontend's types, its API module (which fields are sent) and `frontend/src/lib/http.ts` (how statuses and error bodies are handled).
6. **Cache and state.** Frontend query keys against what each mutation reads, writes or invalidates.

## Evidence rule

Every finding has: the changed `file:line`, the related `file` and `lines`, a `kind`, and one concrete scenario ("a value one character over the old limit now passes the validator but not the database column, so saving fails with 500"). No grep hit, no finding. At most 5 findings, highest user impact first.

Report only what is at risk. An importer you checked and found unaffected is not a finding, and neither is "no stale copy found". When nothing is at risk, return an empty `impact` array; the summary can say what you checked. Cite the real lines (`9-10`), never a placeholder range like `1-200`.

## Test or report?

- Write a test (`tested`) only when the impact sits inside one app and the test would protect agreed behaviour now.
- A cross-app or code-vs-schema mismatch is `reported-only`. A unit test cannot span both apps, and choosing which side is right is a human decision.

## Common mistakes

- Searching only the new value.
- Reporting "might affect X" without a line that proves it.
- Writing a test that asserts one side of a mismatch as correct.
