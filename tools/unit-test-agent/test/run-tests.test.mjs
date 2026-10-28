import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cpSync, existsSync, mkdirSync, mkdtempSync, copyFileSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { applyPlan, classifyRuns, credentialsVisible, mergeBase, readPrManifest, restorePlan, formatFrontendTests, policyFindings, printCoverage, trimFailure } from '../run-tests.mjs'

const script = fileURLToPath(new URL('../run-tests.mjs', import.meta.url))

function run(...args) {
  const result = spawnSync('node', [script, ...args], { encoding: 'utf8' })
  return { status: result.status, out: result.stdout + result.stderr }
}

test('prints usage with examples', () => {
  const { status, out } = run('--help')
  assert.equal(status, 0)
  assert.match(out, /Usage: \.\/\.unit-test-agent\/bin\/run-tests\.mjs <backend\|frontend>/)
  assert.match(out, /Examples:/)
})

test('rejects an unknown app and says what to do instead', () => {
  const { status, out } = run('api')
  assert.equal(status, 2)
  assert.match(out, /first argument must be backend or frontend/)
})

test('rejects test paths outside the allowed test locations', () => {
  for (const path of ['backend/src/factory.ts', '../../etc/passwd', 'backend/tests/../src/factory.ts']) {
    const { status, out } = run('backend', '--', path)
    assert.equal(status, 2, path)
    assert.match(out, /not a test file this agent may run/, path)
  }
})

test('suggests the repo-relative path for an app-relative test path', () => {
  const { status, out } = run('backend', '--', 'tests/router.test.ts')
  assert.equal(status, 2)
  assert.match(out, /did you mean backend\/tests\/router\.test\.ts\?/)
})

test('rejects coverage targets outside the app sources', () => {
  const { status, out } = run('frontend', '--coverage', 'backend/src/factory.ts')
  assert.equal(status, 2)
  assert.match(out, /--coverage expects a source file under frontend\/src/)
})

test('keeps the assertion and repo frames but drops library stack frames', () => {
  const message = [
    'AssertionError: expected 2 to be 3 // Object.is equality',
    '    at /repo/backend/tests/zz-demo.test.ts:2:42',
    '    at file:///repo/backend/node_modules/@vitest/runner/dist/chunk-artifact.js:302:11',
    '    at new Promise (<anonymous>)',
    '    at processTicksAndRejections (node:internal/process/task_queues:103:5)',
  ].join('\n')
  assert.equal(trimFailure(message), 'AssertionError: expected 2 to be 3 // Object.is equality\n    at /repo/backend/tests/zz-demo.test.ts:2:42')
})

test('reports whether the model credential reached the subprocess, never its value', () => {
  assert.equal(credentialsVisible({}), false)
  assert.equal(credentialsVisible({ COPILOT_GITHUB_TOKEN: 'github_pat_x' }), true)
})

const realFrontend = fileURLToPath(new URL('../../../frontend/', import.meta.url))
const hasPrettier = existsSync(join(realFrontend, 'node_modules/.bin/prettier'))

// A throwaway repo root whose frontend/ has the real Prettier config and binary. With
// `tracked`, a.test.ts is committed (so it exists at HEAD).
function fakeRoot(t, source, { tracked = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'format-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'frontend/src'), { recursive: true })
  copyFileSync(join(realFrontend, '.prettierrc.json'), join(root, 'frontend/.prettierrc.json'))
  symlinkSync(join(realFrontend, 'node_modules'), join(root, 'frontend/node_modules'))
  writeFileSync(join(root, 'frontend/src/a.test.ts'), source)
  if (tracked) {
    const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root })
    git('init', '-q')
    git('add', 'frontend/src/a.test.ts')
    git('commit', '-q', '-m', 'init')
  }
  return root
}

function logged(fn) {
  const log = mock.method(console, 'log', () => {})
  try {
    fn()
    return log.mock.calls.map((c) => c.arguments[0])
  } finally {
    log.mock.restore()
  }
}

test('formats a new frontend test file with the repo Prettier config', { skip: !hasPrettier }, (t) => {
  const root = fakeRoot(t, 'const a = "x";\n')
  const out = logged(() => formatFrontendTests(root, ['frontend/src/a.test.ts']))
  assert.deepEqual(out, ['reformatted: frontend/src/a.test.ts'])
  assert.equal(readFileSync(join(root, 'frontend/src/a.test.ts'), 'utf8'), "const a = 'x'\n")
})

test('leaves a test file that exists at HEAD untouched', { skip: !hasPrettier }, (t) => {
  const root = fakeRoot(t, 'const a = "x";\n', { tracked: true })
  const out = logged(() => formatFrontendTests(root, ['frontend/src/a.test.ts']))
  assert.deepEqual(out, [])
  assert.equal(readFileSync(join(root, 'frontend/src/a.test.ts'), 'utf8'), 'const a = "x";\n')
})

test('uses the manifest head to decide which files already exist', { skip: !hasPrettier }, (t) => {
  const root = fakeRoot(t, 'const a = "x";\n', { tracked: true })
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  mkdirSync(join(root, '.unit-test-agent'))
  writeFileSync(join(root, '.unit-test-agent/manifest.json'), JSON.stringify({ head }))
  writeFileSync(join(root, 'frontend/src/b.test.ts'), 'const b = "y";\n')
  const out = logged(() => formatFrontendTests(root, ['frontend/src/a.test.ts', 'frontend/src/b.test.ts']))
  assert.deepEqual(out, ['reformatted: frontend/src/b.test.ts'])
})

test('prints nothing when a new file is already formatted', { skip: !hasPrettier }, (t) => {
  const root = fakeRoot(t, "const a = 'x'\n")
  assert.deepEqual(logged(() => formatFrontendTests(root, ['frontend/src/a.test.ts'])), [])
})

test('does not run Prettier when no test files are given', { skip: !hasPrettier }, (t) => {
  const root = fakeRoot(t, 'const a = "x";\n')
  assert.deepEqual(logged(() => formatFrontendTests(root, [])), [])
  assert.equal(readFileSync(join(root, 'frontend/src/a.test.ts'), 'utf8'), 'const a = "x";\n')
})

test('printCoverage reports uncovered lines, branches and functions per file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cov-'))
  const at = (line) => ({ start: { line }, end: { line } })
  writeFileSync(join(dir, 'coverage-final.json'), JSON.stringify({
    '/r/frontend/src/a.ts': {
      statementMap: { 0: at(3), 1: at(4) }, s: { 0: 0, 1: 0 },
      branchMap: { 0: { loc: at(12), locations: [at(12), at(40)] } }, b: { 0: [1, 0] },
      fnMap: { 0: { name: 'onToggle', decl: at(47), loc: at(47) } }, f: { 0: 0 },
    },
    '/r/frontend/src/b.ts': { statementMap: { 0: at(1) }, s: { 0: 1 }, branchMap: {}, b: {}, fnMap: {}, f: {} },
  }))
  const lines = []
  const log = mock.method(console, 'log', (line) => lines.push(line))
  try {
    printCoverage('frontend', dir, ['src/a.ts', 'src/b.ts', 'src/c.ts'])
  } finally {
    log.mock.restore()
  }
  assert.deepEqual(lines, [
    'coverage: src/a.ts uncovered lines 3-4; uncovered branches at lines 40; uncovered functions: onToggle (line 47)',
    'coverage: src/b.ts all lines, branches and functions covered',
    'coverage: src/c.ts was not loaded by these tests',
  ])
})

function policyRoot(t, source) {
  const root = mkdtempSync(join(tmpdir(), 'policy-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'backend/tests'), { recursive: true })
  writeFileSync(join(root, 'backend/tests/a.test.ts'), source)
  spawnSync('git', ['init', '-q'], { cwd: root })
  return root
}

test('policyFindings reports a forbidden import in a new test file with file and line', (t) => {
  const root = policyRoot(t, "import { test } from 'vitest'\nimport net from 'node:net'\n")
  const { failures, notes } = policyFindings(root, ['backend/tests/a.test.ts'])
  assert.equal(failures.length, 1)
  assert.match(failures[0], /^policy: backend\/tests\/a\.test\.ts:2 .*the gate rejects the whole run/)
  assert.deepEqual(notes, [])
})

// An existing test file, committed, with the agent's edit in the working tree; manifest mode as given.
function policyRootWithHistory(t, before, after, mode) {
  const root = policyRoot(t, before)
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8' })
  git('add', '.')
  git('commit', '-qm', 'base')
  mkdirSync(join(root, '.unit-test-agent'))
  writeFileSync(join(root, '.unit-test-agent/manifest.json'), JSON.stringify({ mode, files: [] }))
  writeFileSync(join(root, 'backend/tests/a.test.ts'), after)
  return root
}

test('policyFindings reads the original of an existing test file: a new test case passes, a changed test fails in coverage mode', (t) => {
  const before = "import { expect, it } from 'vitest'\n\nit('x', () => {\n  expect(1).toBe(1)\n})\n"
  const added = policyRootWithHistory(t, before, `${before}\nit('y', () => {\n  expect(2).toBe(2)\n})\n`, 'coverage')
  assert.deepEqual(policyFindings(added, ['backend/tests/a.test.ts']), { failures: [], notes: [] })
  const changed = policyRootWithHistory(t, before, before.replace('  expect(1).toBe(1)\n', '  expect(1).toBe(1)\n  expect(0).toBe(0)\n'), 'coverage')
  assert.match(policyFindings(changed, ['backend/tests/a.test.ts']).failures.join('\n'), /coverage mode: existing test file backend\/tests\/a\.test\.ts must not change/)
})

test('policyFindings reports nothing for a clean new test file', (t) => {
  const root = policyRoot(t, "import { test } from 'vitest'\ntest('x', () => {})\n")
  assert.deepEqual(policyFindings(root, ['backend/tests/a.test.ts']), { failures: [], notes: [] })
})

test('--without-change needs test files', () => {
  const { status, out } = run('backend', '--without-change')
  assert.equal(status, 2)
  assert.match(out, /needs explicit test files/)
})

test('--without-change refuses without a manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'wc-'))
  assert.throws(() => readPrManifest(root), /manifest\.json, which is missing/)
  rmSync(root, { recursive: true, force: true })
})

test('--without-change refuses a manifest that is not PR mode', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wc-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.unit-test-agent'))
  writeFileSync(join(root, '.unit-test-agent/manifest.json'), JSON.stringify({ mode: 'sweep', files: [] }))
  assert.throws(() => readPrManifest(root), /only works in PR mode/)
})

test('without the change: modified source is the base content, added file is hidden, and both come back', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wc-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8' })
  mkdirSync(join(root, 'backend/src'), { recursive: true })
  git('init', '-q')
  writeFileSync(join(root, 'backend/src/a.ts'), 'old\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD').stdout.trim()
  writeFileSync(join(root, 'backend/src/a.ts'), 'new\n')
  writeFileSync(join(root, 'backend/src/b.ts'), 'added\n')
  git('add', '.')
  git('commit', '-qm', 'head')
  const head = git('rev-parse', 'HEAD').stdout.trim()
  assert.equal(mergeBase(root, { base, head }), base)

  const touched = []
  const plan = [{ path: 'backend/src/a.ts', action: 'restore' }, { path: 'backend/src/b.ts', action: 'hide' }]
  applyPlan(root, plan, base, touched)
  assert.equal(readFileSync(join(root, 'backend/src/a.ts'), 'utf8'), 'old\n')
  assert.equal(existsSync(join(root, 'backend/src/b.ts')), false)
  assert.equal(existsSync(join(root, 'backend/src/b.ts.without-change')), true)

  assert.deepEqual(restorePlan(root, touched), [])
  assert.equal(readFileSync(join(root, 'backend/src/a.ts'), 'utf8'), 'new\n')
  assert.equal(readFileSync(join(root, 'backend/src/b.ts'), 'utf8'), 'added\n')
  assert.equal(existsSync(join(root, 'backend/src/b.ts.without-change')), false)
})

test('restore undoes a half-applied plan and reports what it cannot restore', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wc-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'a.ts'), 'x')
  const touched = []
  assert.throws(() => applyPlan(root, [{ path: 'a.ts', action: 'hide' }, { path: 'missing.ts', action: 'hide' }], 'HEAD', touched))
  assert.deepEqual(restorePlan(root, touched), [])
  assert.equal(readFileSync(join(root, 'a.ts'), 'utf8'), 'x')
  assert.deepEqual(restorePlan(root, [{ path: 'nodir/zz.ts', action: 'hide', bytes: Buffer.from('q') }]), ['nodir/zz.ts'])
})

test('--repeat needs an integer from 2 to 10', () => {
  for (const n of ['1', '11', '3.5', 'x']) {
    const { status, out } = run('backend', '--repeat', n, '--', 'backend/tests/factory.test.ts')
    assert.equal(status, 2, n)
    assert.match(out, /--repeat expects an integer from 2 to 10/, n)
  }
})

test('--repeat needs explicit test files', () => {
  const { status, out } = run('backend', '--repeat', '3')
  assert.equal(status, 2)
  assert.match(out, /--repeat needs explicit test files/)
})

test('--repeat cannot be combined with --coverage, --typecheck or --without-change', () => {
  for (const flag of [['--coverage', 'backend/src/factory.ts'], ['--typecheck'], ['--without-change']]) {
    const { status, out } = run('backend', '--repeat', '3', ...flag, '--', 'backend/tests/factory.test.ts')
    assert.equal(status, 2, flag[0])
    assert.match(out, /--repeat cannot be combined with --typecheck, --coverage or --without-change/, flag[0])
  }
})

test('usage documents --repeat with an example', () => {
  const { out } = run('--help')
  assert.match(out, /--repeat <n>/)
  assert.match(out, /backend --repeat 3 -- /)
})

test('classifyRuns separates flaky tests from consistent failures and counts the rest', () => {
  const run = (a, b, c) => [
    { name: 'f.test.ts › steady', status: 'passed' },
    { name: 'f.test.ts › sometimes', status: a },
    { name: 'f.test.ts › broken', status: b },
    { name: 'f.test.ts › skipped one', status: c },
  ]
  const result = classifyRuns([run('passed', 'failed', 'skipped'), run('failed', 'failed', 'skipped'), run('passed', 'failed', 'skipped')])
  assert.deepEqual(result.flaky, [{ name: 'f.test.ts › sometimes', failed: 1, runs: 3 }])
  assert.deepEqual(result.alwaysFailing, [{ name: 'f.test.ts › broken', runs: 3 }])
  assert.equal(result.total, 3)
})

test('classifyRuns: all passing is clean', () => {
  const result = classifyRuns([[{ name: 'a', status: 'passed' }], [{ name: 'a', status: 'passed' }]])
  assert.deepEqual(result, { flaky: [], alwaysFailing: [], total: 1 })
})

const schemaFile = fileURLToPath(new URL('../../../.github/agents/unit-test-agent.schema.json', import.meta.url))
const realRunOutput = { summary: 'x', decisions: [], impact: [], assertionChanges: [{ file: 'backend/tests/a.test.ts', sourceRef: 'backend/src/a.ts:4', reason: 'r' }], suspectedBugs: [], discardedTests: [] }

// A checkout with the agent's copy as the workflows install it: the command, what it imports and the schema in .unit-test-agent/bin/.
function installedRoot(t, agentOutput) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'check-output-'))) // the real path, or the script's entry check does not match on macOS
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, '.unit-test-agent/bin')
  cpSync(fileURLToPath(new URL('../lib/', import.meta.url)), join(bin, 'lib'), { recursive: true })
  for (const name of ['run-tests.mjs', 'validate-patch.mjs']) copyFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), join(bin, name))
  copyFileSync(schemaFile, join(bin, 'unit-test-agent.schema.json'))
  if (agentOutput !== undefined) writeFileSync(join(root, '.unit-test-agent/agent-output.json'), typeof agentOutput === 'string' ? agentOutput : JSON.stringify(agentOutput))
  return root
}

function checkOutputIn(root, ...args) {
  const result = spawnSync('node', [join(root, '.unit-test-agent/bin/run-tests.mjs'), '--check-output', ...args], { encoding: 'utf8' })
  return { status: result.status, out: result.stdout + result.stderr }
}

test('--check-output prints each schema error, using the installed schema, not the checkout\'s', (t) => {
  const root = installedRoot(t, realRunOutput)
  mkdirSync(join(root, '.github/agents'), { recursive: true })
  writeFileSync(join(root, '.github/agents/unit-test-agent.schema.json'), '{}')
  const { status, out } = checkOutputIn(root)
  assert.equal(status, 1)
  assert.deepEqual(out.trim().split('\n'), [
    'assertionChanges[0]: missing required "testFile"',
    'assertionChanges[0]: missing required "testName"',
    'assertionChanges[0]: missing required "why"',
    'assertionChanges[0]: unexpected property "file"',
    'assertionChanges[0]: unexpected property "reason"',
  ])
})

test('--check-output prints one line when the output matches the schema', (t) => {
  const output = { ...realRunOutput, assertionChanges: [{ testFile: 'backend/tests/a.test.ts', testName: 'x', sourceRef: 'backend/src/a.ts:4', why: 'w' }] }
  const { status, out } = checkOutputIn(installedRoot(t, output))
  assert.equal(status, 0, out)
  assert.equal(out, '.unit-test-agent/agent-output.json matches the schema\n')
})

test('--check-output fails on a missing or unparsable file and takes no other arguments', (t) => {
  for (const content of [undefined, '{"summary": oops']) {
    const { status, out } = checkOutputIn(installedRoot(t, content))
    assert.equal(status, 1, out)
    assert.match(out, /^\.unit-test-agent\/agent-output\.json cannot be read as JSON: /, out)
  }
  const { status, out } = checkOutputIn(installedRoot(t, realRunOutput), 'backend')
  assert.equal(status, 2)
  assert.match(out, /--check-output takes no other arguments/)
})

test('usage documents --check-output', () => {
  assert.match(run('--help').out, /--check-output/)
})

// The agent's command and the gate run only the base commit's copy, so each workflow must install every module the
// command imports and the schema next to it, and give the gate the schema too.
test('both workflows install every module the agent command imports, and the schema', () => {
  const modules = new Set()
  const visit = (path) => {
    if (modules.has(path)) return
    modules.add(path)
    const source = readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
    for (const [, spec] of source.matchAll(/^import .* from '(\.[^']+)'/gm)) visit(posix.join(posix.dirname(path), spec))
  }
  visit('run-tests.mjs')
  assert.ok(modules.has('lib/check-output.mjs'))
  for (const name of ['unit-test-agent.md', 'unit-test-agent-sweep.md']) {
    const workflow = readFileSync(fileURLToPath(new URL(`../../../.github/workflows/${name}`, import.meta.url)), 'utf8')
    for (const path of modules) assert.ok(workflow.includes(`"$RUNNER_TEMP/trusted/tools/unit-test-agent/${path}"`), `${name}: ${path}`)
    assert.match(workflow, /"\$RUNNER_TEMP\/trusted\/\.github\/agents\/unit-test-agent\.schema\.json" \.unit-test-agent\/bin\//, name)
    assert.match(workflow, /archive "\$BASE_SHA" tools\/unit-test-agent \.github\/agents\/unit-test-agent\.schema\.json \|/, name)
  }
})
