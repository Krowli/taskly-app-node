import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildImportGraph, importLineOf, importersOf, testsImporting } from '../../lib/imports.mjs'

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const graph = buildImportGraph(repoRoot)

test('finds direct importers across both resolution styles of this repo', () => {
  // frontend: extensionless specifiers ('../../../lib/http')
  assert.ok(importersOf(graph, 'frontend/src/lib/http.ts').direct.includes('frontend/src/features/todos/api/todos.ts'))
  // backend: NodeNext '.js' specifiers that point at '.ts' files ('./validators.js')
  const validatorImporters = importersOf(graph, 'backend/src/features/todos/validators.ts').direct
  assert.ok(validatorImporters.includes('backend/src/features/todos/mappers.ts'))
  assert.ok(validatorImporters.includes('backend/src/features/todos/router.ts'))
})

test('walks transitive importers and never lists test files as importers', () => {
  const { direct, transitive } = importersOf(graph, 'frontend/src/lib/http.ts')
  assert.ok(transitive.includes('frontend/src/features/todos/hooks/useTodosQuery.ts'))
  assert.ok(![...direct, ...transitive].some((path) => /\.test\.tsx?$/.test(path)))
  assert.ok(!transitive.includes('frontend/src/lib/http.ts'))
})

test('maps a source file to the test files that import it', () => {
  assert.ok(testsImporting(graph, 'backend/src/features/todos/router.ts').includes('backend/tests/router.test.ts'))
  assert.ok(testsImporting(graph, 'frontend/src/features/todos/api/todos.ts').includes('frontend/src/features/todos/api/todos.test.ts'))
})

test('gives the 1-based line of the import that resolves to the target, and is stable across calls', () => {
  const validators = 'backend/src/features/todos/validators.ts'
  const router = 'backend/src/features/todos/router.ts'
  assert.equal(importLineOf(repoRoot, router, validators, graph), 3)
  assert.equal(importLineOf(repoRoot, router, validators, graph), 3)
  assert.equal(importLineOf(repoRoot, 'backend/src/features/todos/mappers.ts', validators, graph), 1)
})

test('returns null when the file does not import the target', () => {
  assert.equal(importLineOf(repoRoot, 'frontend/src/lib/http.ts', 'backend/src/features/todos/validators.ts', graph), null)
})

test('gives the line where a multi-line import starts, not its from clause', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'imports-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'importer.ts'), "// header\n\nimport {\n  a,\n  b,\n} from './target'\n")
  assert.equal(importLineOf(root, 'importer.ts', 'target.ts', new Set(['importer.ts', 'target.ts'])), 3)
})
