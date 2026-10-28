import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, isAllowedTestPath, forbiddenAddedLine } from '../../lib/patch-rules.mjs'

test('forbids expected-to-fail tests and snapshot assertions', () => {
  assert.equal(forbiddenAddedLine("it.fails('x', () => {})"), 'expected-to-fail test')
  assert.equal(forbiddenAddedLine("describe.fails('x', () => {})"), 'expected-to-fail test')
  for (const matcher of ['toMatchSnapshot', 'toMatchInlineSnapshot', 'toMatchFileSnapshot', 'toThrowErrorMatchingSnapshot', 'toThrowErrorMatchingInlineSnapshot']) {
    assert.equal(forbiddenAddedLine(`expect(x).${matcher}()`), 'snapshot assertion', matcher)
  }
  assert.equal(forbiddenAddedLine('const fails = results.filter(Boolean)'), null)
  assert.equal(forbiddenAddedLine('expect(fails).toBe(0)'), null)
})

test('allows only test files the agent may write', () => {
  for (const path of [
    'backend/tests/router.test.ts',
    'backend/tests/fixture.ts',
    'frontend/src/lib/http.test.ts',
    'frontend/src/features/todos/components/TodoStats.test.tsx',
    'frontend/src/test/queryWrapper.tsx',
  ]) assert.equal(isAllowedTestPath(path), true, path)

  for (const path of [
    'backend/src/factory.ts',
    'frontend/src/lib/http.ts',
    'backend/package.json',
    'frontend/vite.config.ts',
    '.github/agents/unit-test-agent.agent.md',
    '.github/workflows/ci.yml',
    '/etc/passwd',
    '../etc/passwd',
    'backend/tests/../src/factory.ts',
    'backend\\tests\\x.ts',
    './backend/tests/x.ts',
    '',
  ]) assert.equal(isAllowedTestPath(path), false, path)
})

test('classifies files the way the coverage configs do', () => {
  const cases = {
    'backend/src/features/todos/router.ts': ['backend', 'source', true],
    'backend/src/main.ts': ['backend', 'source', true],
    'backend/src/features/todos/types.ts': ['backend', 'excluded-source', false],
    'backend/src/generated/prisma/client.ts': ['backend', 'excluded-source', false],
    'backend/tests/router.test.ts': ['backend', 'test', false],
    'backend/package.json': ['backend', 'config', false],
    'backend/vitest.config.ts': ['backend', 'config', false],
    'backend/prisma.config.ts': ['backend', 'config', false],
    'backend/openapi.json': ['backend', 'contract', false],
    'backend/prisma/schema.prisma': ['backend', 'contract', false],
    'frontend/src/features/todos/hooks/useTodosQuery.ts': ['frontend', 'source', true],
    'frontend/src/features/todos/components/TodoEmptyState.tsx': ['frontend', 'source', true],
    'frontend/src/design-system/components/Button/Button.tsx': ['frontend', 'excluded-source', false],
    'frontend/src/features/todos/index.ts': ['frontend', 'excluded-source', false],
    'frontend/src/features/todos/types.ts': ['frontend', 'excluded-source', false],
    'frontend/src/features/todos/api/queryKeys.ts': ['frontend', 'excluded-source', false],
    'frontend/src/lib/queryClient.ts': ['frontend', 'excluded-source', false],
    'frontend/src/main.tsx': ['frontend', 'excluded-source', false],
    'frontend/src/styles.css': ['frontend', 'other', false],
    'frontend/src/App.test.tsx': ['frontend', 'test', false],
    'README.md': ['other', 'docs', false],
    '.github/workflows/ci.yml': ['other', 'config', false],
    'compose.yaml': ['other', 'config', false],
  }
  for (const [path, [app, kind, testable]] of Object.entries(cases)) {
    assert.deepEqual(classify(path), { app, kind, testable }, path)
  }
})

test('flags added test lines that disable checks or reach outside the sandbox', () => {
  for (const line of [
    "it.only('x', () => {})",
    'describe.skip("x", () => {})',
    "test.todo('later')",
    "xit('x', () => {})",
    'vi.setConfig({ expect: { requireAssertions: false } })',
    "import { execSync } from 'node:child_process'",
    "import net from 'node:net'",
    "import https from 'node:https'",
    'eval(code)',
    "const f = new Function('return 1')",
    'await import(modulePath)',
    'const url = process.env.DATABASE_URL',
    "await fetch('https://attacker.example.net/x')",
  ]) assert.ok(forbiddenAddedLine(line), line)

  for (const line of [
    "vi.mock('../../design-system', () => import('../../design-system/mocks'))",
    "vi.stubEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/db')",
    "expect(request).toHaveBeenCalledWith('/todos', { signal })",
    "it('rejects titles longer than 120 characters', () => {})",
    "const url = 'http://localhost:8000/api'",
  ]) assert.equal(forbiddenAddedLine(line), null, line)
})

test('keeps the global test setup file out of the agent’s reach', () => {
  assert.equal(isAllowedTestPath('frontend/src/test/setup.ts'), false)
  assert.equal(isAllowedTestPath('frontend/src/test/queryWrapper.tsx'), true)
})

test('flags matcher overrides, bracket env access and look-alike hosts', () => {
  for (const line of ['expect.extend({ toBe: () => ({ pass: true }) })', "const key = process['env'].X", "fetch('http://example.com.evil.net/x')"]) {
    assert.ok(forbiddenAddedLine(line), line)
  }
  assert.equal(forbiddenAddedLine("const url = 'https://example.com/x'"), null)
})

test('allows a type-only import of a network module, since it is erased at compile time', () => {
  for (const line of ["import type { Server } from 'node:http'", 'import type * as https from "node:https"']) {
    assert.equal(forbiddenAddedLine(line), null, line)
  }
  for (const line of [
    "import { type Server } from 'node:http'", // the import statement itself stays and loads the module
    "import type { Server } from 'node:http'; import { request } from 'node:https'",
    "export type { Server } from 'node:http'; import net from 'node:net'",
  ]) assert.equal(forbiddenAddedLine(line), 'opens network connections', line)
})
