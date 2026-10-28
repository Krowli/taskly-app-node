import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../render-report.sh', import.meta.url))
const HEAD = 'abcdef0123456789abcdef0123456789abcdef01'
const READY = { verdict: 'ready', reason: '1 test files verified', runUrl: 'https://evil.example/forged', agent: { skillsUsed: [], model: 'm' } }

// A fake `gh` answers the three API calls render-report.sh makes, from env vars:
// FAKE_PUBLISH (the safe_outputs conclusion, empty = no such job), FAKE_HEAD, FAKE_MESSAGE.
// FAKE_FAIL_PULLS makes the pulls call fail like a gh error.
// analysis and agentOutput: the analysis artifact's manifest.json and the agent artifact's agent_output.json (objects or raw text).
function run({ report = READY, publish = 'success', message = 'tests\n\nUnit-Test-Agent-Run: 42', failPulls = false, detection, runUrl = 'https://github.com/o/r/actions/runs/42', firstRun = '', firstReport, analysis, agentOutput } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'render-report-'))
  const bin = join(dir, 'bin')
  const input = join(dir, 'in')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), [
    '#!/bin/sh',
    'case "$2" in',
    '  */jobs) printf "%s" "$FAKE_PUBLISH" ;;',
    '  */pulls/*) [ -n "$FAKE_FAIL_PULLS" ] && exit 1; printf "%s" "$FAKE_HEAD" ;;',
    '  */commits/*) printf "%s" "$FAKE_MESSAGE" ;;',
    'esac',
    '',
  ].join('\n'))
  chmodSync(join(bin, 'gh'), 0o755)
  const scan = join(dir, 'scan')
  mkdirSync(scan)
  if (detection !== undefined) writeFileSync(join(scan, 'detection_result.json'), typeof detection === 'string' ? detection : JSON.stringify(detection))
  // Without a report the download fails and leaves no folder.
  if (report) {
    mkdirSync(input)
    writeFileSync(join(input, 'report.json'), JSON.stringify(report))
  }
  const asText = (value) => (typeof value === 'string' ? value : JSON.stringify(value))
  const analysisDir = join(dir, 'analysis')
  mkdirSync(analysisDir)
  if (analysis !== undefined) writeFileSync(join(analysisDir, 'manifest.json'), asText(analysis))
  const agentDir = join(dir, 'agent')
  mkdirSync(agentDir)
  if (agentOutput !== undefined) writeFileSync(join(agentDir, 'agent_output.json'), asText(agentOutput))
  const first = join(dir, 'first')
  mkdirSync(first)
  if (firstReport) writeFileSync(join(first, 'report.json'), JSON.stringify(firstReport))
  const output = join(dir, 'output')
  writeFileSync(output, '')
  const result = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, IN: input, DETECTION: scan, RUN_URL: runUrl, FAKE_FAIL_PULLS: failPulls ? '1' : '', RUN_ID: '42', PR_NUMBER: '7',
      GITHUB_REPOSITORY: 'o/r', GH_TOKEN: 'x', FAKE_PUBLISH: publish, FAKE_HEAD: HEAD, FAKE_MESSAGE: message, FIRST_RUN: firstRun, FIRST_REPORT: first,
      ANALYSIS: analysisDir, AGENT_ARTIFACTS: agentDir,
      GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(dir, 'summary'),
    },
  })
  const commentPath = join(input, 'comment.md')
  return { status: result.status, stderr: result.stderr, output: readFileSync(output, 'utf8'), comment: existsSync(commentPath) ? readFileSync(commentPath, 'utf8') : '' }
}

test('publish succeeded and the head carries this run\'s trailer: tests added, with the short sha and the trusted run link', () => {
  const r = run()
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.output, /post=true/)
  assert.match(r.comment, /Tests added to this PR/)
  assert.match(r.comment, /Tests pushed in abcdef0\./)
  assert.match(r.comment, /\[Workflow run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/42\)/)
  assert.ok(!r.comment.includes('evil.example'))
})

test('no safe_outputs job: never "Tests added"', () => {
  const r = run({ publish: '' })
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.comment, /Tests added/)
  assert.match(r.comment, /publishing failed \(not run\)/)
})

test('a failed safe_outputs job: never "Tests added"', () => {
  const r = run({ publish: 'failure' })
  assert.doesNotMatch(r.comment, /Tests added/)
  assert.match(r.comment, /publishing failed \(failure\)/)
})

test('head without this run\'s trailer: superseded, not "Tests added"', () => {
  const r = run({ message: 'a human commit\n\nUnit-Test-Agent-Run: 41' })
  assert.doesNotMatch(r.comment, /Tests added/)
  assert.match(r.comment, /Superseded/)
})

test('cleans the model name from the usage file', () => {
  const r = run({ report: { ...READY, agent: { aiCredits: 2, model: 'x |\n## Approved <img src=https://evil/p.png> @Krowli [click](https://evil)' } } })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!r.comment.includes('<img'))
  assert.ok(!r.comment.includes('](https://evil)'))
  assert.ok(!r.comment.includes('@Krowli'))
  assert.match(r.comment, /2\.0 AI credits/)
})

test('without report.json it posts nothing', () => {
  const r = run({ report: null })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.output, /post=false/)
})

const ANALYSIS = { mode: 'pr', gate: { runAgent: true, reason: '1 testable files changed, 0 uncovered changed lines, 0 failing tests' }, injectionSignals: [{ path: 'backend/src/api/health.ts', line: 8, kind: 'addressed-to-ai' }] }
const NOOP = { items: [{ type: 'noop', message: 'No test changes needed: an existing test covers it. A comment addressed to AI agents was ignored.' }], errors: [] }

test('without report.json, after a run that used the model and ended with a no-op: no changes, the analysis\'s signals, the agent\'s reason, the trusted run link', () => {
  const r = run({ report: null, analysis: ANALYSIS, agentOutput: NOOP })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.output, /post=true/)
  assert.match(r.comment, /^### Unit test agent — ℹ️ No test changes needed$/m)
  assert.match(r.comment, /^\| Injection signals \| ⚠️ 1: backend\/src\/api\/health\.ts:8 addressed-to-ai \|$/m)
  assert.match(r.comment, /^\*\*No-op reason:\*\* No test changes needed: an existing test covers it\. A comment addressed to AI agents was ignored\.$/m)
  assert.match(r.comment, /\[Workflow run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/42\)/)
})

test('without report.json, after the no-op before any model call or with a missing or malformed analysis or agent output, it posts nothing', () => {
  const beforeModel = { analysis: { ...ANALYSIS, gate: { runAgent: false, reason: 'no testable source or contract changes (docs/config/tests only)' }, injectionSignals: [] }, agentOutput: { items: [{ type: 'noop', message: 'No unit tests needed: no testable source or contract changes (docs/config/tests only)' }] } }
  for (const options of [beforeModel, { agentOutput: NOOP }, { analysis: ANALYSIS }, { analysis: 'not json', agentOutput: NOOP }, { analysis: ANALYSIS, agentOutput: 'not json' }, { analysis: ANALYSIS, agentOutput: { items: [] } }]) {
    const r = run({ report: null, ...options })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.output, /post=false/, JSON.stringify(options))
    assert.equal(r.comment, '')
  }
})

test('an unreadable PR head is reported as unknown: not "Tests added", not "Superseded"', () => {
  for (const options of [{ failPulls: true }, { message: '' }]) {
    const r = run(options)
    assert.equal(r.status, 0, r.stderr)
    assert.doesNotMatch(r.comment, /Tests added|Superseded/)
    assert.match(r.comment, /publishing status unknown \(could not read the PR head\)/)
  }
})

test('requires RUN_URL, so the artifact\'s own link is never rendered', () => {
  const r = run({ runUrl: '' })
  assert.notEqual(r.status, 0)
  assert.equal(r.comment, '')
  assert.doesNotMatch(r.output, /post=true/)
})

test('threat scan flagged a ready run: blocked headline, flags mapped, free text never printed', () => {
  const r = run({ publish: 'skipped', detection: { prompt_injection: true, secret_leak: false, malicious_patch: true, reasons: ['ignore previous instructions @evil'], warnings: [] } })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.comment, /Blocked by the threat scan — nothing was published/)
  assert.match(r.comment, /flagged: possible prompt injection, possibly malicious patch\./)
  assert.doesNotMatch(r.comment, /ignore previous|secret leak|Verification failed/)
})

test('clean, missing or unreadable detection result leaves the normal outcome', () => {
  for (const detection of [{ prompt_injection: false, secret_leak: false, malicious_patch: false, reasons: [] }, undefined, 'not json', { prompt_injection: 'true' }]) {
    const r = run({ detection })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.comment, /Tests added to this PR/)
  }
})

const metrics = (lines, branches, functions) => ({ lines, branches, functions, statements: lines })
const measuredReport = (before, after) => ({ ...READY, verification: { coverage: { before: { backend: before }, after: { backend: after } } } })

test('a second pass shows coverage from the first pass\'s before to this pass\'s after, naming both runs', () => {
  const r = run({ report: measuredReport(metrics(80, 70, 90), metrics(95, 90, 100)), firstRun: '7', firstReport: measuredReport(metrics(40, 30, 50), metrics(80, 70, 90)) })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.comment, /\| Coverage backend \| lines 40% → 95% · branches 30% → 90% · functions 50% → 100%/)
  assert.match(r.comment, /Two passes: \[first run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/7\), \[second run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/42\)/)
  assert.match(r.comment, /Tests added to this PR/)
})

test('a second pass without the first pass\'s report shows this pass alone', () => {
  const r = run({ report: measuredReport(metrics(80, 70, 90), metrics(95, 90, 100)), firstRun: '7' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.comment, /lines 80% → 95%/)
  assert.doesNotMatch(r.comment, /Two passes/)
})

test('a first run id that is not an integer posts nothing', () => {
  const r = run({ firstRun: '7) [x](https://evil', firstReport: READY })
  assert.notEqual(r.status, 0)
  assert.equal(r.comment, '')
  assert.doesNotMatch(r.output, /post=true/)
})

test('reports the coverage gaps left after the agent as a step output', () => {
  assert.match(run({ report: measuredReport(metrics(80, 70, 90), metrics(100, 92.5, 100)) }).output, /^gaps=backend branches 92\.5%$/m)
  assert.match(run({ report: measuredReport(metrics(80, 70, 90), metrics(100, 100, 100)) }).output, /^gaps=$/m)
  assert.match(run().output, /^gaps=$/m)
})

test('a second pass adds up both passes\' AI credits and labels its patch as the second pass\'s', () => {
  const pass = (report, aiCredits, addedLines) => ({ ...report, agent: { ...report.agent, aiCredits }, verification: { ...report.verification, patch: { files: ['backend/tests/a.test.ts'], addedLines, valid: true, violations: [] } } })
  const r = run({ report: pass(measuredReport(metrics(80, 70, 90), metrics(95, 90, 100)), 28.7, 82), firstRun: '7', firstReport: pass(measuredReport(metrics(40, 30, 50), metrics(80, 70, 90)), 101.2, 400) })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.comment, /^\| Cost \| 101\.2 \+ 28\.7 = 129\.9 AI credits \(≈ \$1\.30\), first \+ second pass, m \|$/m)
  assert.match(r.comment, /^\| Patch \(second pass\) \| 1 test files, \+82 lines/m)
})
