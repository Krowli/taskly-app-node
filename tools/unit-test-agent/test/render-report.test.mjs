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
function run({ report = READY, publish = 'success', message = 'tests\n\nUnit-Test-Agent-Run: 42', failPulls = false, detection, runUrl = 'https://github.com/o/r/actions/runs/42', firstRun = '', firstReport } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'render-report-'))
  const bin = join(dir, 'bin')
  const input = join(dir, 'in')
  mkdirSync(bin)
  mkdirSync(input)
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
  if (report) writeFileSync(join(input, 'report.json'), JSON.stringify(report))
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
