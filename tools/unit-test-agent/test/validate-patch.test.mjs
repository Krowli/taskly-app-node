import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validatePatch } from '../validate-patch.mjs'

function newFile(path, lines, mode = '100644') {
  return [
    `diff --git a/${path} b/${path}`,
    `new file mode ${mode}`,
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    '',
  ].join('\n')
}

function edit(path, hunks) {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunks.flatMap(({ header, lines }) => [header, ...lines]),
    '',
  ].join('\n')
}

const NEW_TEST = newFile('backend/tests/factory.test.ts', [
  "import { it, expect } from 'vitest'",
  "it('answers unknown routes with JSON 404', () => {",
  '  expect(404).toBe(404)',
  '})',
])

test('accepts a new test file in an allowed location', () => {
  const result = validatePatch(NEW_TEST)
  assert.equal(result.valid, true, result.violations.join('\n'))
  assert.deepEqual(result.files, ['backend/tests/factory.test.ts'])
  assert.equal(result.addedLines, 4)
})

test('rejects edits outside the allowed test paths', () => {
  const patch = edit('backend/src/factory.ts', [{ header: '@@ -1 +1 @@', lines: ['-const a = 1', '+const a = 2'] }])
  const result = validatePatch(patch)
  assert.equal(result.valid, false)
  assert.match(result.violations[0], /not an allowed test path: backend\/src\/factory\.ts/)
})

test('rejects focused tests, disabled checks and dangerous calls in added lines', () => {
  const result = validatePatch(newFile('frontend/src/lib/http.test.ts', ["it.only('x', () => {})", 'vi.setConfig({ expect: { requireAssertions: false } })']))
  assert.equal(result.valid, false)
  assert.equal(result.violations.length, 2)
  assert.match(result.violations[0], /frontend\/src\/lib\/http\.test\.ts:1 focused, skipped or todo test/)
})

test('allows the repo’s literal dynamic import of design-system mocks', () => {
  const result = validatePatch(newFile('frontend/src/x.test.tsx', ["vi.mock('../design-system', () => import('../design-system/mocks'))"]))
  assert.equal(result.valid, true, result.violations.join('\n'))
})

test('rejects deletions, renames, mode changes and binary content', () => {
  const deleted = 'diff --git a/backend/tests/a.test.ts b/backend/tests/a.test.ts\ndeleted file mode 100644\n--- a/backend/tests/a.test.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n'
  const renamed = 'diff --git a/backend/tests/a.test.ts b/backend/tests/b.test.ts\nsimilarity index 100%\nrename from backend/tests/a.test.ts\nrename to backend/tests/b.test.ts\n'
  const binary = 'diff --git a/backend/tests/a.bin.ts b/backend/tests/a.bin.ts\nnew file mode 100644\nGIT binary patch\nliteral 3\nabc\n'
  for (const [name, patch, reason] of [
    ['deleted', deleted, /deletes/],
    ['renamed', renamed, /renames/],
    ['executable', newFile('backend/tests/run.test.ts', ['x'], '100755'), /file mode/],
    ['binary', binary, /binary/],
  ]) {
    const result = validatePatch(patch)
    assert.equal(result.valid, false, name)
    assert.match(result.violations.join('\n'), reason, name)
  }
})

test('rejects oversized patches', () => {
  const result = validatePatch(newFile('backend/tests/big.test.ts', ['// ' + 'x'.repeat(310 * 1024)]))
  assert.equal(result.valid, false)
  assert.match(result.violations.join('\n'), /larger than/)
})

const manifest = { mode: 'pr', files: [{ path: 'backend/src/features/todos/validators.ts', kind: 'source', status: 'M', changedLines: [[4, 4]] }] }
const CHANGED_ASSERTION = edit('backend/tests/validators.test.ts', [{
  header: '@@ -12 +12 @@',
  lines: ["-    const input = { title: 'x'.repeat(120) }", "+    const input = { title: 'x'.repeat(200) }"],
}, {
  header: '@@ -19 +19 @@',
  lines: ["-    { title: 'x'.repeat(121) },", "+    { title: 'x'.repeat(201) },"],
}, {
  header: '@@ -30 +30 @@',
  lines: ['-  expect(createSchema.safeParse(input).success).toBe(false)', '+  expect(createSchema.safeParse(input).success).toBe(true)'],
}])

test('accepts a changed assertion in an existing test when it cites a changed source line', () => {
  const agentOutput = { assertionChanges: [{ testFile: 'backend/tests/validators.test.ts', testName: 'x', sourceRef: 'backend/src/features/todos/validators.ts:4', why: 'limit raised to 200' }] }
  const result = validatePatch(CHANGED_ASSERTION, { manifest, agentOutput })
  assert.equal(result.valid, true, result.violations.join('\n'))
  assert.deepEqual(result.assertionAudit, { changedExisting: 1, justified: 1, unjustified: [] })
})

test('rejects a changed assertion in an existing test without a valid justification', () => {
  for (const assertionChanges of [
    [],
    [{ testFile: 'backend/tests/validators.test.ts', testName: 'x', sourceRef: 'backend/src/features/todos/validators.ts:9', why: 'line 9 did not change' }],
    [{ testFile: 'backend/tests/other.test.ts', testName: 'x', sourceRef: 'backend/src/features/todos/validators.ts:4', why: 'wrong file' }],
  ]) {
    const result = validatePatch(CHANGED_ASSERTION, { manifest, agentOutput: { assertionChanges } })
    assert.equal(result.valid, false)
    assert.equal(result.assertionAudit.unjustified.length, 1)
    assert.match(result.violations.join('\n'), /unjustified assertion change in backend\/tests\/validators\.test\.ts/)
  }
})

test('a new top-level test case in an existing test file is not a change to existing tests', () => {
  const before = ['import { it, expect } from "vitest"', ...Array.from({ length: 38 }, (_, i) => `// line ${i + 2}`), '']
  const patch = edit('backend/tests/validators.test.ts', [{ header: '@@ -39,0 +40,2 @@', lines: ["+it('accepts 200', () => {", "+  expect(createSchema.parse({ title: 'x' }).title).toBe('x') })"] }])
  const result = validatePatch(patch, { manifest, agentOutput: { assertionChanges: [] }, original: () => before.join('\n') })
  assert.equal(result.valid, true, result.violations.join('\n'))
  assert.equal(result.assertionAudit.changedExisting, 0)
})

test('treats adding names to an existing import as an addition, not a change to the test', () => {
  const patch = edit('frontend/src/features/todos/utils/todos.test.ts', [{
    header: '@@ -1,2 +1,2 @@',
    lines: [
      "-import { describe, expect, it } from 'vitest'",
      "-import { selectTodos } from './todos'",
      "+import { afterEach, describe, expect, it, vi } from 'vitest'",
      "+import { isDueBefore, selectTodos } from './todos'",
    ],
  }, { header: '@@ -40,0 +41,3 @@', lines: ["+it('x', () => {", '+  expect(isDueBefore(base, "2026-10-15")).toBe(false)', '+})'] }])
  const before = ["import { describe, expect, it } from 'vitest'", "import { selectTodos } from './todos'", ...Array.from({ length: 38 }, () => ''), '']
  const result = validatePatch(patch, { manifest, agentOutput: { assertionChanges: [] }, original: () => before.join('\n') })
  assert.equal(result.valid, true, result.violations.join('\n'))
  assert.equal(result.assertionAudit.changedExisting, 0)
})

test('still audits an import that switches module or drops names', () => {
  for (const added of ["+import { selectTodos } from './fakeTodos'", "+import { other } from './todos'"]) {
    const patch = edit('frontend/src/features/todos/utils/todos.test.ts', [{ header: '@@ -2 +2 @@', lines: ["-import { selectTodos } from './todos'", added] }])
    const result = validatePatch(patch, { manifest, agentOutput: { assertionChanges: [] } })
    assert.equal(result.valid, false, added)
    assert.equal(result.assertionAudit.changedExisting, 1, added)
  }
})

test('rejects diff headers it cannot parse, such as git-quoted paths', () => {
  const quoted = 'diff --git "a/backend/src/\\303\\251.ts" "b/backend/src/\\303\\251.ts"\nnew file mode 100644\n--- /dev/null\n+++ "b/backend/src/\\303\\251.ts"\n@@ -0,0 +1 @@\n+export const x = 1\n'
  const result = validatePatch(quoted + NEW_TEST)
  assert.equal(result.valid, false)
  assert.match(result.violations.join('\n'), /unparseable diff header/)
})

test('in coverage mode no existing test may change', () => {
  const coverageManifest = { mode: 'coverage', files: [{ path: 'backend/src/features/todos/validators.ts', kind: 'source', status: null, changedLines: [[1, 30]] }] }
  const agentOutput = { assertionChanges: [{ testFile: 'backend/tests/validators.test.ts', testName: 'x', sourceRef: 'backend/src/features/todos/validators.ts:4', why: 'w' }] }
  const result = validatePatch(CHANGED_ASSERTION, { manifest: coverageManifest, agentOutput })
  assert.equal(result.valid, false)
  assert.match(result.violations.join('\n'), /coverage mode/)
})

test('a justification must cite a changed line of a source file, not docs or contracts', () => {
  const prManifest = { mode: 'pr', files: [{ path: 'README.md', kind: 'docs', status: 'M', changedLines: [[1, 5]] }] }
  const agentOutput = { assertionChanges: [{ testFile: 'backend/tests/validators.test.ts', testName: 'x', sourceRef: 'README.md:2', why: 'w' }] }
  assert.equal(validatePatch(CHANGED_ASSERTION, { manifest: prManifest, agentOutput }).valid, false)
})

test('audits file-level mocks and hooks added to an existing test file', () => {
  const original = () => ['import { it } from "vitest"', '', '', '', '', ''].join('\n')
  for (const line of ["+vi.mock('../src/core/database.ts', () => ({}))", '+beforeEach(() => { vi.spyOn(Math, "random") })', "+vi.spyOn(console, 'error')"]) {
    const patch = edit('backend/tests/router.test.ts', [{ header: '@@ -5,0 +6 @@', lines: [line] }])
    const result = validatePatch(patch, { manifest, agentOutput: { assertionChanges: [] }, original })
    assert.equal(result.assertionAudit.changedExisting, 1, line)
    assert.equal(result.valid, false, line)
  }
  const insideNewTest = edit('backend/tests/router.test.ts', [{ header: '@@ -5,0 +6,4 @@', lines: ["+it('logs the error', () => {", "+  vi.spyOn(console, 'error').mockImplementation(() => {})", '+  expect(1).toBe(1)', '+})'] }])
  assert.equal(validatePatch(insideNewTest, { manifest, agentOutput: { assertionChanges: [] }, original }).valid, true)
})

// gh-aw hands over `git format-patch` output: a mail header per commit and a "-- " signature.
function formatPatch(...diffs) {
  return diffs.map((diff, i) => [
    `From ${String(i + 1).repeat(40)} Mon Sep 17 00:00:00 2001`,
    'From: Agent <agent@example.com>',
    `Subject: [PATCH] test: commit ${i + 1}`,
    '',
    '---',
    ' backend/tests/todos.test.ts | 1 +',
    '',
    diff,
    '-- ',
    '2.54.0',
    '',
  ].join('\n')).join('\n')
}

const TODOS_BEFORE = ["it('lists', async () => {", '  const res = await list()', '  expect(res.status).toBe(200)', '})', ''].join('\n')
const ADD_TO_EXISTING = edit('backend/tests/todos.test.ts', [{
  header: '@@ -4,0 +5 @@',
  lines: ["+it('lists none', async () => expect((await list()).body).toEqual([]))"],
}])

test('ignores the mail header and "-- " signature of git format-patch output', () => {
  const result = validatePatch(formatPatch(ADD_TO_EXISTING), { manifest: { mode: 'pr', files: [] }, original: () => TODOS_BEFORE })
  assert.equal(result.valid, true, result.violations.join('\n'))
  assert.equal(result.assertionAudit.changedExisting, 0)
  assert.equal(result.addedLines, 1)
})

test('rejects a patch with more than one commit', () => {
  const result = validatePatch(formatPatch(NEW_TEST, ADD_TO_EXISTING))
  assert.equal(result.valid, false)
  assert.match(result.violations.join('\n'), /2 commits; the agent must make exactly one/)
})

// Diffs between two versions of one file, as git writes them (the gate diffs the agent's commit the same way).
function gitDiff(path, before, after) {
  const dir = mkdtempSync(join(tmpdir(), 'validate-'))
  try {
    writeFileSync(join(dir, 'a'), before)
    writeFileSync(join(dir, 'b'), after)
    const { stdout } = spawnSync('git', ['diff', '--no-index', '--no-color', 'a', 'b'], { cwd: dir, encoding: 'utf8' })
    const lines = stdout.split('\n')
    return [`diff --git a/${path} b/${path}`, lines[1], `--- a/${path}`, `+++ b/${path}`, ...lines.slice(4)].join('\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const coverage = { mode: 'coverage', files: [] }
const justified = (testFile) => ({ assertionChanges: [{ testFile, testName: 'x', sourceRef: 'backend/src/features/todos/validators.ts:4', why: 'limit changed' }] })
// Validates the change of one existing file from `before` to `after`.
function check(path, before, after, { mode = coverage, agentOutput } = {}) {
  return validatePatch(gitDiff(path, before, after), { manifest: mode, agentOutput, original: (p) => (p === path ? before : undefined) })
}

const EXISTING = `import { describe, expect, it, beforeEach } from 'vitest'
import { parse } from '../src/parse.ts'

let calls = 0
beforeEach(() => {
  calls = 0
})

describe('parse', () => {
  beforeEach(() => {
    calls++
  })

  it('reads a number', () => {
    expect(parse('1')).toBe(1)
  })
})

it('rejects text', () => {
  expect(() => parse('x')).toThrow(/not a number \\(/)
})
`
const FILE = 'backend/tests/parse.test.ts'
const insert = (after, lines) => EXISTING.replace(after, `${after}${lines}`)

test('coverage mode accepts new top-level test cases, a new describe with its own hooks, helpers and widened imports', () => {
  const after = EXISTING
    .replace("import { describe, expect, it, beforeEach } from 'vitest'", "import { describe, expect, it, beforeEach, vi } from 'vitest'")
    .replace("import { parse } from '../src/parse.ts'\n", "import { parse } from '../src/parse.ts'\nimport { format } from '../src/format.ts'\n\nconst twice = (text: string) => `${text}${text}`\nfunction big(n: number) {\n  return { value: n * 1000 }\n}\n")
    + `
it('reads a negative number', () => {
  expect(parse('-1')).toBe(-1)
})

describe('format', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it.each([[1, '1'], [big(2).value, '2000']])('formats %s', (n, text) => {
    expect(format(n)).toBe(text)
    expect(twice(text)).toHaveLength(text.length * 2)
  })
})
`
  const result = check(FILE, EXISTING, after)
  assert.equal(result.valid, true, result.violations.join('\n'))
  assert.equal(result.assertionAudit.changedExisting, 0)
})

test('a new test case inside an existing describe is not a change to existing tests', () => {
  const after = insert("    expect(parse('1')).toBe(1)\n  })\n", "\n  it('reads zero', () => {\n    expect(parse('0')).toBe(0)\n  })\n")
  const result = check(FILE, EXISTING, after)
  assert.equal(result.valid, true, result.violations.join('\n'))
})

test('tolerates git placing a shared closing line of a new test after the new lines', () => {
  // git may show the old test's "})" as added and reuse the old one as the new test's end.
  const patch = edit(FILE, [{ header: '@@ -20,2 +20,6 @@', lines: ["   expect(() => parse('x')).toThrow(/not a number \\(/)", '+})', '+', "+it('rejects empty text', () => {", "+  expect(() => parse('')).toThrow()", ' })'] }])
  const result = validatePatch(patch, { manifest: coverage, original: () => EXISTING })
  assert.equal(result.valid, true, result.violations.join('\n'))
})

test('an added line inside an existing test needs a justification in PR mode and is rejected in coverage mode', () => {
  const after = insert("    expect(parse('1')).toBe(1)\n", "    expect(parse('01')).toBe(1)\n")
  const pr = { mode: 'pr', files: [{ path: 'backend/src/features/todos/validators.ts', kind: 'source', status: 'M', changedLines: [[4, 4]] }] }
  assert.match(check(FILE, EXISTING, after, { mode: pr, agentOutput: { assertionChanges: [] } }).violations.join('\n'), /unjustified assertion change in backend\/tests\/parse\.test\.ts/)
  assert.equal(check(FILE, EXISTING, after, { mode: pr, agentOutput: justified(FILE) }).valid, true)
  const sweep = check(FILE, EXISTING, after)
  assert.equal(sweep.valid, false)
  assert.match(sweep.violations.join('\n'), /coverage mode: existing test file backend\/tests\/parse\.test\.ts must not change/)
})

test('coverage mode rejects every other change to existing tests and hooks', () => {
  for (const [name, after] of [
    ['line in a file-scope hook', insert('  calls = 0\n', '  calls = 1\n')],
    ['line in a nested hook', insert('    calls++\n', '    calls++\n')],
    ['edited hook line', EXISTING.replace('    calls++\n', '    calls += 2\n')],
    ['new file-scope hook', insert("import { parse } from '../src/parse.ts'\n", "\nbeforeAll(() => {\n  calls = 5\n})\n")],
    ['new hook in an existing describe', insert("describe('parse', () => {\n", "  afterEach(() => {\n    calls = 0\n  })\n")],
    ['new file-scope mock', insert("import { parse } from '../src/parse.ts'\n", "\nvi.mock('../src/format.ts', () => ({ format: () => '' }))\n")],
    ['mock inside a new describe (hoisted)', `${EXISTING}\ndescribe('mocked', () => {\n  vi.mock('../src/format.ts')\n  it('x', () => {\n    expect(1).toBe(1)\n  })\n})\n`],
    ['file-scope statement', insert("import { parse } from '../src/parse.ts'\n", '\nvi.useFakeTimers()\n')],
    ['file-scope assignment', insert("import { parse } from '../src/parse.ts'\n", '\nglobalThis.fetch = vi.fn()\n')],
    ['load-time spy in a declaration', insert("import { parse } from '../src/parse.ts'\n", "\nconst warn = vi.spyOn(console, 'warn')\n")],
    ['helper inside an existing describe', insert("describe('parse', () => {\n", '  const input = "2"\n')],
    ['new describe wrapping existing tests', EXISTING.replace("it('rejects text'", "describe('wrapped', () => {\n  beforeEach(() => {\n    calls = 9\n  })\nit('rejects text'") + '})\n'],
    ['removed assertion', EXISTING.replace("    expect(parse('1')).toBe(1)\n", '')],
  ]) {
    const result = check(FILE, EXISTING, after)
    assert.equal(result.valid, false, name)
    assert.equal(result.assertionAudit.changedExisting, 1, name)
  }
})

test('an existing test file whose original cannot be read or does not match the diff counts as changed', () => {
  const patch = gitDiff(FILE, EXISTING, `${EXISTING}\nit('x', () => {\n  expect(1).toBe(1)\n})\n`)
  assert.equal(validatePatch(patch, { manifest: coverage }).assertionAudit.changedExisting, 1)
  assert.equal(validatePatch(patch, { manifest: coverage, original: () => EXISTING.replace("it('rejects text'", "it('rejects words'") }).assertionAudit.changedExisting, 1)
  assert.equal(validatePatch(patch, { manifest: coverage, original: () => EXISTING }).assertionAudit.changedExisting, 0)
})

test('existing shared helpers under the test paths: any change needs a justification in PR mode and is rejected in coverage mode', () => {
  const pr = { mode: 'pr', files: [{ path: 'backend/src/features/todos/validators.ts', kind: 'source', status: 'M', changedLines: [[4, 4]] }] }
  for (const path of ['backend/tests/support.ts', 'frontend/src/test/builders.ts']) {
    const before = 'export const item = { id: 1 }\n'
    const after = `${before}export const other = { id: 2 }\n`
    assert.equal(check(path, before, after).valid, false, path)
    assert.match(check(path, before, after, { mode: pr, agentOutput: { assertionChanges: [] } }).violations.join('\n'), /unjustified assertion change/, path)
    assert.equal(check(path, before, after, { mode: pr, agentOutput: justified(path) }).valid, true, path)
  }
  assert.equal(validatePatch(newFile('backend/tests/builders.ts', ['export const item = { id: 1 }']), { manifest: coverage }).valid, true)
})

// Weakening patterns are checked in every added test line, in new and existing files.
function newTest(...body) {
  return validatePatch(newFile('backend/tests/w.test.ts', ["import { expect, it, vi } from 'vitest'", "it('w', async () => {", ...body.map((line) => `  ${line}`), '})']), { manifest: coverage })
}

test('rejects an early exit before a test\'s assertions', () => {
  for (const body of [
    ['const value = read()', 'if (!value) return', 'expect(value).toBe(1)'],
    ['return', 'expect(read()).toBe(1)'],
    ['if (skip) {', '  return', '}', 'expect(read()).toBe(1)'],
  ]) {
    const result = newTest(...body)
    assert.equal(result.valid, false, body.join('; '))
    assert.match(result.violations.join('\n'), /backend\/tests\/w\.test\.ts:\d+ returns before the test's assertions \(heuristic\)/, body.join('; '))
  }
})

test('accepts returns that are not an early exit from the test', () => {
  for (const body of [
    ['return expect(read()).resolves.toBe(1)'],
    ['const fetch = vi.fn((url) => {', "  if (url === '/a') return 1", '  return 2', '})', 'expect(fetch("/a")).toBe(1)'],
    ['expect(read()).toBe(1)', 'return'],
  ]) {
    const result = newTest(...body)
    assert.equal(result.valid, true, `${body.join('; ')}: ${result.violations.join('\n')}`)
  }
})

test('rejects tests whose assertions are all inside a conditional or a catch', () => {
  for (const body of [
    ['if (ready) {', '  expect(read()).toBe(1)', '}'],
    ['if (ready) expect(read()).toBe(1)'],
    ['try {', '  await read()', '} catch (error) {', '  expect(error).toBeInstanceOf(Error)', '}'],
    ['if (ready) {', '  expect(read()).toBe(1)', '} else {', '  expect(read()).toBe(2)', '}'],
  ]) {
    const result = newTest(...body)
    assert.equal(result.valid, false, body.join('; '))
    assert.match(result.violations.join('\n'), /backend\/tests\/w\.test\.ts:2 asserts only inside a conditional or catch \(heuristic\)/, body.join('; '))
  }
})

test('accepts a conditional assertion next to an unconditional one, or with a counted number of assertions', () => {
  for (const body of [
    ['expect(read()).toBeDefined()', 'if (ready) {', '  expect(read()).toBe(1)', '}'],
    ['expect.assertions(1)', 'try {', '  await read()', '} catch (error) {', '  expect(error).toBeInstanceOf(Error)', '}'],
    ['for (const input of ["", " "]) {', '  expect(parse(input)).toBe(false)', '}'],
    ['await waitFor(() => {', '  expect(read()).toBe(1)', '})'],
  ]) {
    const result = newTest(...body)
    assert.equal(result.valid, true, `${body.join('; ')}: ${result.violations.join('\n')}`)
  }
})

test('rejects swallowed failures and zero expected assertions', () => {
  for (const [line, reason] of [
    ['await read().catch(() => {})', /swallows a failure/],
    ['await read().catch((error) => undefined)', /swallows a failure/],
    ['try { await read() } catch (error) {}', /swallows a failure/],
    ['expect.assertions(0)', /expects zero assertions/],
  ]) {
    const result = newTest(line, 'expect(read()).toBe(1)')
    assert.equal(result.valid, false, line)
    assert.match(result.violations.join('\n'), reason, line)
  }
})

test('strings, comments, regular expressions and template literals do not confuse the test structure', () => {
  const result = newTest(
    "const text = 'return } if (x) {'",
    '// return early if (x) {',
    '/* } */ const re = /\\(\\{/',
    'const label = `${text} ) } ${`nested ${re.source}`}`',
    'expect(label).toMatch(/\\(/)',
  )
  assert.equal(result.valid, true, result.violations.join('\n'))
})

test('weakening added to an existing test is rejected even with a justification', () => {
  const after = insert("  it('reads a number', () => {\n", '    if (calls > 5) return\n')
  const pr = { mode: 'pr', files: [{ path: 'backend/src/features/todos/validators.ts', kind: 'source', status: 'M', changedLines: [[4, 4]] }] }
  const result = check(FILE, EXISTING, after, { mode: pr, agentOutput: justified(FILE) })
  assert.equal(result.valid, false)
  assert.match(result.violations.join('\n'), /parse\.test\.ts:15 returns before the test's assertions/)
})

test('weak patterns that were already in an existing test are not blamed on the agent', () => {
  const weak = `${EXISTING}\nit('old and weak', () => {\n  if (calls) return\n  expect(calls).toBe(0)\n})\n`
  const result = check(FILE, weak, `${weak}\nit('new', () => {\n  expect(1).toBe(1)\n})\n`)
  assert.equal(result.valid, true, result.violations.join('\n'))
})

test('reads JSX: self-closing and closing tags are not regular expressions', () => {
  const before = `import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'

it('shows the title', () => {
  const { rerender } = render(<Header title="a" />)
  rerender(<p>b</p>)
  expect(screen.getByText('b')).toBeVisible()
})
`
  const after = `${before}\nit('shows another title', () => {\n  render(<Header title={'c'} />)\n  expect(screen.getByText('c')).toBeVisible()\n})\n`
  const result = check('frontend/src/Header.test.tsx', before, after)
  assert.equal(result.valid, true, result.violations.join('\n'))
})
