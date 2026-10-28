import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildReport, parseExecution, parseUsage } from '../build-report.mjs'

const script = fileURLToPath(new URL('../build-report.mjs', import.meta.url))

const execution = [
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'analyzing-pr-changes' } }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Skill', input: { skill: 'running-unit-tests' } }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'running-unit-tests' } }] } },
  { type: 'result', subtype: 'success', num_turns: 23, total_cost_usd: 0.41, duration_ms: 192000, permission_denials: [{ tool_name: 'Bash' }] },
]

test('reads skills used, turns, cost, outcome and denials from the execution log', () => {
  assert.deepEqual(parseExecution(execution), {
    skillsUsed: ['analyzing-pr-changes', 'running-unit-tests'],
    numTurns: 23, costUsd: 0.41, durationMs: 192000, resultSubtype: 'success', permissionDenials: 1,
  })
  assert.deepEqual(parseExecution([]), { skillsUsed: [], numTurns: null, costUsd: null, durationMs: null, resultSubtype: null, permissionDenials: null })
})

const manifest = {
  gate: { runAgent: true, reason: '1 testable files changed' },
  files: [{ path: 'backend/src/factory.ts', testable: true, status: 'M', changedLines: [[1, 10]], uncoveredChangedLines: [[1, 3]] }],
  coverageBefore: { backend: { lines: 33.02 }, frontend: { lines: 47.68 } },
}
const green = { numPassedTests: 5, numFailedTests: 0, numTotalTests: 5, testResults: [] }
const red = { numPassedTests: 4, numFailedTests: 1, numTotalTests: 5, testResults: [{ name: '/repo/backend/tests/factory.test.ts', assertionResults: [{ fullName: 'flaky one', status: 'failed', failureMessages: ['boom'] }] }] }

function inputs(overrides = {}) {
  return {
    repoRoot: '/repo',
    manifest,
    manifestAfter: { ...manifest, files: [{ ...manifest.files[0], uncoveredChangedLines: [] }] },
    agentOutput: { decisions: [], impact: [], assertionChanges: [], suspectedBugs: [], discardedTests: [] },
    execution,
    patchValidation: { valid: true, files: ['backend/tests/factory.test.ts'], addedLines: 30, violations: [], assertionAudit: { changedExisting: 0, justified: 0, unjustified: [] } },
    typecheck: { backend: 'pass', frontend: 'pass' },
    results: { backend: green, frontend: green },
    stabilityRuns: [green, green, green, green],
    requireAssertions: 'pass',
    pinsChange: { applicable: true, newTests: 3, failingOnBase: 2 },
    coverageAfter: { backend: { lines: 50 }, frontend: { lines: 47.68 } },
    ...overrides,
  }
}

test('is ready only when every measured check passes', () => {
  const report = buildReport(inputs())
  assert.equal(report.verdict, 'ready')
  assert.deepEqual(report.verification.coverage.changedLines, { before: { covered: 7, total: 10 }, after: { covered: 10, total: 10 } })
  assert.deepEqual(report.verification.stability, { runs: 5, shuffled: true, flaky: [] })
  assert.deepEqual(report.agent.skillsUsed, ['analyzing-pr-changes', 'running-unit-tests'])
})

test('fails on flaky, failing, untyped or assertion-free tests and rejects invalid patches', () => {
  assert.equal(buildReport(inputs({ stabilityRuns: [green, red, green, green] })).verdict, 'failed')
  assert.deepEqual(buildReport(inputs({ stabilityRuns: [green, red, green, green] })).verification.stability.flaky, ['backend/tests/factory.test.ts › flaky one'])
  assert.equal(buildReport(inputs({ results: { backend: red, frontend: green } })).verdict, 'failed')
  assert.equal(buildReport(inputs({ typecheck: { backend: 'fail', frontend: 'pass' } })).verdict, 'failed')
  assert.equal(buildReport(inputs({ requireAssertions: 'fail' })).verdict, 'failed')
  assert.equal(buildReport(inputs({ patchValidation: { valid: false, files: ['backend/src/x.ts'], addedLines: 1, violations: ['not an allowed test path'], assertionAudit: { changedExisting: 0, justified: 0, unjustified: [] } } })).verdict, 'rejected')
})

test('reports an empty patch and a skipped gate without running checks', () => {
  assert.equal(buildReport(inputs({ patchValidation: { valid: true, files: [], addedLines: 0, violations: [], assertionAudit: { changedExisting: 0, justified: 0, unjustified: [] } } })).verdict, 'no-changes')
  const skipped = buildReport({ repoRoot: '/repo', manifest: { ...manifest, gate: { runAgent: false, reason: 'label unit-test-agent:skip' } }, verdictHint: 'skipped' })
  assert.equal(skipped.verdict, 'skipped')
  assert.equal(skipped.reason, 'label unit-test-agent:skip')
})

test('fails when a measurement is missing instead of calling it verified', () => {
  const report = buildReport(inputs({ typecheck: undefined, results: {}, stabilityRuns: [], requireAssertions: undefined }))
  assert.equal(report.verdict, 'failed')
  assert.match(report.reason, /missing/)
})

test('does not blame the agent for tests that already failed before it ran', () => {
  const withPreexisting = { ...manifest, failingTests: [{ app: 'backend', file: 'backend/tests/factory.test.ts', name: 'flaky one', message: 'boom' }] }
  const report = buildReport(inputs({ manifest: withPreexisting, results: { backend: red, frontend: green } }))
  assert.equal(report.verdict, 'ready')
  assert.match(report.reason, /1 test was already failing before the agent/)
})

test('counts changed-line coverage over lines that hold code only', () => {
  const coverable = { ...manifest, files: [{ ...manifest.files[0], changedLines: [[1, 30]], coverableChangedLines: [[1, 10]], uncoveredChangedLines: [[1, 10]] }] }
  const after = { ...coverable, files: [{ ...coverable.files[0], uncoveredChangedLines: [] }] }
  assert.deepEqual(buildReport(inputs({ manifest: coverable, manifestAfter: after })).verification.coverage.changedLines, { before: { covered: 0, total: 10 }, after: { covered: 10, total: 10 } })
})

test('counts stability runs per app, not per result file', () => {
  const frontendGreen = { ...green, testResults: [{ name: '/repo/frontend/src/x.test.ts', assertionResults: [] }] }
  const backendGreen = { ...green, testResults: [{ name: '/repo/backend/tests/x.test.ts', assertionResults: [] }] }
  const report = buildReport(inputs({ stabilityRuns: [backendGreen, backendGreen, backendGreen, backendGreen, frontendGreen, frontendGreen, frontendGreen, frontendGreen] }))
  assert.equal(report.verification.stability.runs, 5)
})

// Copilot CLI session log (agent-session.jsonl), as gh-aw uploads it.
const copilotSession = [
  { type: 'tool.execution_start', data: { toolCallId: 's1', toolName: 'skill', arguments: { skill: 'analyzing-pr-changes' } } },
  { type: 'tool.execution_start', data: { toolCallId: 'b1', toolName: 'bash', arguments: { command: 'cat .unit-test-agent/pr.diff' } } },
  { type: 'tool.execution_complete', data: { toolCallId: 'b1', success: true, shellExecution: { exitCode: 0 } } },
  { type: 'tool.execution_start', data: { toolCallId: 'b2', toolName: 'bash', arguments: { command: './tools/unit-test-agent/run-tests.mjs frontend -- a.test.tsx' } } },
  { type: 'tool.execution_complete', data: { toolCallId: 'b2', success: true, shellExecution: { exitCode: 1 } } },
  { type: 'permission.completed', data: { result: { kind: 'denied-no-approval-rule-and-could-not-request-from-user' } } },
  { type: 'tool.execution_start', data: { toolCallId: 's2', toolName: 'skill', arguments: { skill: 'writing-frontend-tests' } } },
  { type: 'tool.execution_start', data: { toolCallId: 'b3', toolName: 'bash', arguments: { command: './.unit-test-agent/bin/run-tests.mjs frontend' } } },
  { type: 'tool.execution_complete', data: { toolCallId: 'b3', success: true, shellExecution: { exitCode: 0 } } },
]

test('reads skills used, test runs and denials from a Copilot session log', () => {
  assert.deepEqual(parseExecution(copilotSession), {
    skillsUsed: ['analyzing-pr-changes', 'writing-frontend-tests'],
    numTurns: null, costUsd: null, durationMs: null, resultSubtype: null, permissionDenials: 1,
    testRuns: { total: 2, failed: 1, lastPassed: true },
  })
})

test('reports no test runs when the agent never ran the test script', () => {
  assert.deepEqual(parseExecution(copilotSession.slice(0, 3)).testRuns, { total: 0, failed: 0, lastPassed: false })
})

test('still writes the report when an input file is not valid JSON, and names it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-report-'))
  const file = (name, value) => {
    writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value))
    return join(dir, name)
  }
  const result = spawnSync(process.execPath, [script,
    '--manifest', file('manifest.json', manifest),
    '--agent-output', file('agent-output.json', '{"decisions": [oops'),
    '--patch-validation', file('patch-validation.json', inputs().patchValidation),
    '--typecheck-backend', 'pass', '--typecheck-frontend', 'pass',
    '--results-backend', file('results-backend.json', green), '--results-frontend', file('results-frontend.json', green),
    '--stability', file('stability.json', green), '--require-assertions', 'pass',
    '--out', join(dir, 'report.json'),
  ], { cwd: dir, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
  assert.equal(report.verdict, 'ready')
  assert.deepEqual(report.inputErrors, ['agent-output: invalid JSON'])
})

test('a malformed stability file fails the verdict even when other measurements pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-report-'))
  const file = (name, value) => {
    writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value))
    return join(dir, name)
  }
  const result = spawnSync(process.execPath, [script,
    '--manifest', file('manifest.json', manifest),
    '--patch-validation', file('patch-validation.json', inputs().patchValidation),
    '--typecheck-backend', 'pass', '--typecheck-frontend', 'pass',
    '--results-backend', file('results-backend.json', green), '--results-frontend', file('results-frontend.json', green),
    '--stability', file('run-1.json', green), '--stability', file('run-2.json', '{"testResults": [oops'),
    '--require-assertions', 'pass', '--out', join(dir, 'report.json'),
  ], { cwd: dir, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
  assert.equal(report.verdict, 'failed')
  assert.match(report.reason, /stability-run-2\.json: invalid JSON/)
})

test('reads AI credits (rounded to 1 decimal) and the model from the usage file', () => {
  const usage = { input_tokens: 8592, ai_credits: 13.00783, primary_model: 'model-a' }
  assert.deepEqual(parseUsage(usage), { aiCredits: 13, model: 'model-a' })
  assert.equal(parseUsage({ ai_credits: 1.26 }).aiCredits, 1.3)
  const report = buildReport(inputs({ usage }))
  assert.equal(report.verdict, 'ready')
  assert.equal(report.agent.aiCredits, 13)
  assert.equal(report.agent.model, 'model-a')
  for (const bad of [null, [], 'x', { ai_credits: 'many' }, { ai_credits: -1 }, {}]) assert.equal(parseUsage(bad), null)
})

test('a malformed usage file is named in inputErrors and does not change the verdict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-report-'))
  const file = (name, value) => {
    writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value))
    return join(dir, name)
  }
  const run = (usage) => {
    const result = spawnSync(process.execPath, [script,
      '--manifest', file('manifest.json', manifest),
      '--patch-validation', file('patch-validation.json', inputs().patchValidation),
      '--typecheck-backend', 'pass', '--typecheck-frontend', 'pass',
      '--results-backend', file('results-backend.json', green), '--results-frontend', file('results-frontend.json', green),
      '--stability', file('stability.json', green), '--require-assertions', 'pass',
      '--usage', file('usage.json', usage), '--out', join(dir, 'report.json'),
    ], { cwd: dir, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
  }
  for (const bad of ['{oops', '{"ai_credits": "lots"}']) {
    const report = run(bad)
    assert.equal(report.verdict, 'ready')
    assert.equal(report.agent.aiCredits, undefined)
    assert.match(report.inputErrors.join(), /^usage: /)
  }
  const good = run({ ai_credits: 2.04, primary_model: 'm' })
  assert.equal(good.agent.aiCredits, 2)
  assert.equal(good.inputErrors, undefined)
})

test('keeps only string skill names from the session log, at most 20', () => {
  const skill = (name) => ({ type: 'tool.execution_start', data: { toolName: 'skill', arguments: { skill: name } } })
  const names = Array.from({ length: 30 }, (_, i) => `s${i}`)
  const { skillsUsed } = parseExecution([skill({ evil: 1 }), skill(7), skill(null), ...names.map(skill)])
  assert.deepEqual(skillsUsed, names.slice(0, 20))
})

test('copies the manifest injection signals into the report', () => {
  const signals = [{ path: 'a.ts', line: 1, kind: 'hidden-characters' }]
  const report = buildReport({ manifest: { gate: {}, injectionSignals: signals }, verdictHint: 'skipped' })
  assert.deepEqual(report.injectionSignals, signals)
  assert.deepEqual(buildReport({ manifest: { gate: {} }, verdictHint: 'skipped' }).injectionSignals, [])
})

// PR mode: when the PR modifies existing source, at least one of the agent's tests must fail on the base source.
const prManifest = {
  ...manifest,
  mode: 'pr',
  files: [
    { ...manifest.files[0], path: 'backend/src/factory.ts', status: 'M' },
    { ...manifest.files[0], path: 'backend/src/router.ts', status: 'M' },
    { ...manifest.files[0], path: 'backend/src/new.ts', status: 'A' },
    { path: 'README.md', kind: 'docs', testable: false, status: 'M', changedLines: [[1, 1]] },
  ],
}
const exception = (file, reason = 'no-behaviour-change', detail = 'only renames a local variable') => ({ file, action: 'skipped', testFiles: [], reason: 'r', noFailingTest: { reason, detail } })
const withDecisions = (decisions) => ({ decisions, impact: [], assertionChanges: [], suspectedBugs: [], discardedTests: [] })

test('PR mode: a modified source file needs at least one agent test that fails without the change', () => {
  const report = buildReport(inputs({ manifest: prManifest, pinsChange: { applicable: true, newTests: 7, failingOnBase: 0 } }))
  assert.equal(report.verdict, 'failed')
  assert.match(report.reason, /no agent test fails without the change/)
  assert.deepEqual(report.verification.failsWithoutChange, {
    required: true, met: false, failing: 0, total: 7, exceptions: [], unexcepted: ['backend/src/factory.ts', 'backend/src/router.ts'],
  })
  const pinned = buildReport(inputs({ manifest: prManifest, pinsChange: { applicable: true, newTests: 7, failingOnBase: 3 } }))
  assert.equal(pinned.verdict, 'ready', pinned.reason)
  assert.equal(pinned.verification.failsWithoutChange.met, true)
})

test('PR mode: missing pins-change measurements count as no failing test', () => {
  assert.equal(buildReport(inputs({ manifest: prManifest, pinsChange: undefined })).verdict, 'failed')
})

test('an exception for every modified source file is accepted and listed; one missing still fails', () => {
  const zero = { applicable: true, newTests: 7, failingOnBase: 0 }
  const all = buildReport(inputs({ manifest: prManifest, pinsChange: zero, agentOutput: withDecisions([exception('backend/src/factory.ts'), exception('backend/src/router.ts', 'not-unit-testable', 'starts the server')]) }))
  assert.equal(all.verdict, 'ready', all.reason)
  assert.deepEqual(all.verification.failsWithoutChange.exceptions, [
    { file: 'backend/src/factory.ts', reason: 'no-behaviour-change', detail: 'only renames a local variable' },
    { file: 'backend/src/router.ts', reason: 'not-unit-testable', detail: 'starts the server' },
  ])
  const one = buildReport(inputs({ manifest: prManifest, pinsChange: zero, agentOutput: withDecisions([exception('backend/src/factory.ts')]) }))
  assert.equal(one.verdict, 'failed')
  assert.deepEqual(one.verification.failsWithoutChange.unexcepted, ['backend/src/router.ts'])
})

test('an exception needs a known reason and a detail, and only counts for the file it names', () => {
  const zero = { applicable: true, newTests: 7, failingOnBase: 0 }
  for (const bad of [
    [exception('backend/src/factory.ts', 'looks fine'), exception('backend/src/router.ts')],
    [exception('backend/src/factory.ts', 'suspected-bug', ''), exception('backend/src/router.ts')],
    [{ ...exception('backend/src/factory.ts'), noFailingTest: 'no-behaviour-change' }, exception('backend/src/router.ts')],
    [exception('backend/src/new.ts'), exception('backend/src/router.ts')],
  ]) {
    assert.equal(buildReport(inputs({ manifest: prManifest, pinsChange: zero, agentOutput: withDecisions(bad) })).verdict, 'failed', JSON.stringify(bad[0]))
  }
})

test('declared exceptions are listed even when a test does fail without the change', () => {
  const report = buildReport(inputs({ manifest: prManifest, agentOutput: withDecisions([exception('backend/src/router.ts', 'suspected-bug', 'see suspectedBugs')]) }))
  assert.equal(report.verdict, 'ready', report.reason)
  assert.deepEqual(report.verification.failsWithoutChange.exceptions, [{ file: 'backend/src/router.ts', reason: 'suspected-bug', detail: 'see suspectedBugs' }])
})

test('not required in coverage mode or when the PR only adds source files', () => {
  const zero = { applicable: false, newTests: 0, failingOnBase: 0 }
  const onlyAdded = { ...prManifest, files: prManifest.files.filter((file) => file.status === 'A') }
  for (const m of [{ ...prManifest, mode: 'coverage' }, onlyAdded]) {
    const report = buildReport(inputs({ manifest: m, pinsChange: zero }))
    assert.equal(report.verdict, 'ready', report.reason)
    assert.equal(report.verification.failsWithoutChange.required, false)
  }
})

const schema = JSON.parse(readFileSync(new URL('../../../.github/agents/unit-test-agent.schema.json', import.meta.url), 'utf8'))
// A real run's claims: assertionChanges entries in the wrong shape, so the gate found no justification.
const wrongShape = { summary: 'x', decisions: [], impact: [], assertionChanges: [{ file: 'backend/tests/a.test.ts', sourceRef: 'backend/src/a.ts:4', reason: 'r' }], suspectedBugs: [], discardedTests: [] }

test('lists where the agent output does not match the schema, without changing the verdict', () => {
  const rejected = { valid: false, files: ['backend/tests/a.test.ts'], addedLines: 3, violations: ['unjustified assertion change in backend/tests/a.test.ts'], assertionAudit: { changedExisting: 1, justified: 0, unjustified: ['backend/tests/a.test.ts'] } }
  const report = buildReport(inputs({ schema, agentOutput: wrongShape, patchValidation: rejected }))
  assert.equal(report.verdict, 'rejected')
  assert.deepEqual(report.agent.schemaErrors.slice(0, 2), ['assertionChanges[0]: missing required "testFile"', 'assertionChanges[0]: missing required "testName"'])
  const ready = buildReport(inputs({ schema, agentOutput: { ...wrongShape, assertionChanges: [] } }))
  assert.equal(ready.verdict, 'ready', ready.reason)
  assert.deepEqual(ready.agent.schemaErrors, [])
  assert.equal(buildReport(inputs({ schema, agentOutput: undefined })).agent.schemaErrors, undefined)
})

test('checks the agent output against the schema of its own copy of the tooling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-report-'))
  const file = (name, value) => {
    writeFileSync(join(dir, name), JSON.stringify(value))
    return join(dir, name)
  }
  const result = spawnSync(process.execPath, [script,
    '--manifest', file('manifest.json', manifest), '--agent-output', file('agent-output.json', wrongShape),
    '--patch-validation', file('patch-validation.json', inputs().patchValidation), '--out', join(dir, 'report.json'),
  ], { cwd: dir, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')).agent.schemaErrors.length, 5)
})
