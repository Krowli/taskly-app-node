import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MARKER, applyPublishOutcome, clean, coverageGaps, fromOriginalCode, renderComment } from '../render-comment.mjs'

const report = {
  verdict: 'ready',
  reason: '2 testable files changed, 3 uncovered changed lines, 0 failing tests',
  pr: 12,
  headSha: 'abc1234',
  runUrl: 'https://github.com/o/r/actions/runs/1',
  agent: {
    decisions: [{ file: 'backend/src/factory.ts', action: 'created', testFiles: ['backend/tests/factory.test.ts'], reason: 'ping @octocat <img src=x onerror=alert(1)> see [docs](https://evil.example/x)' }],
    impact: [{ changedFile: 'backend/src/features/todos/validators.ts:4', relatedFile: 'frontend/src/features/todos/utils/todos.ts', relatedLines: '9-10', kind: 'duplicated-rule', risk: 'frontend still rejects titles over 120', action: 'reported-only' }],
    suspectedBugs: [{ file: 'frontend/src/features/todos/utils/todos.ts', line: 61, question: 'Is it intended that a task due today counts as overdue?', evidence: 'doc says strictly before', snippet: "it('x', () => {\n  expect(isOverdue(todo)).toBe(false)\n})\n```\n![x](https://evil.example/pixel.png)" }],
    discardedTests: [],
    skillsUsed: ['analyzing-pr-changes', 'writing-backend-tests'],
    numTurns: 23, costUsd: 0.41, durationMs: 192000, resultSubtype: 'success', permissionDenials: 0,
  },
  verification: {
    patch: { files: ['backend/tests/factory.test.ts'], addedLines: 40, valid: true, violations: [] },
    assertionAudit: { changedExisting: 0, justified: 0, unjustified: [] },
    typecheck: { backend: 'pass', frontend: 'pass' },
    tests: { backend: { passed: 60, failed: 0, total: 60 }, frontend: { passed: 18, failed: 0, total: 18 } },
    requireAssertions: 'pass',
    pinsChange: { applicable: true, newTests: 6, failingOnBase: 4 },
    failsWithoutChange: { required: true, met: true, failing: 4, total: 6, exceptions: [], unexcepted: [] },
    stability: { runs: 5, shuffled: true, flaky: [] },
    coverage: {
      before: { backend: { lines: 33.02, branches: 20, functions: 30, statements: 31 }, frontend: { lines: 47.68, branches: 40, functions: 50, statements: 47 } },
      after: { backend: { lines: 61.2, branches: 55.5, functions: 70, statements: 60 }, frontend: { lines: 47.68, branches: 40, functions: 50, statements: 47 } },
      changedLines: { before: { covered: 7, total: 10 }, after: { covered: 10, total: 10 } },
    },
  },
}

test('starts with the sticky marker and shows measured facts before agent claims', () => {
  const body = renderComment(report)
  assert.ok(body.startsWith(MARKER))
  const measured = body.indexOf('Measured by the workflow')
  const reported = body.indexOf('Agent-reported (not verified)')
  assert.ok(measured > 0 && reported > measured)
  assert.match(body, /5 runs incl\. shuffled order, 0 flaky/)
  assert.match(body, /\| Fails without the change \| 4 of 6 tests in the agent's test files fail on the PR's base source ✅ \|/)
  assert.match(body, /\| Coverage backend \| lines 33\.02% → 61\.2% · branches 20% → 55\.5% · functions 30% → 70% · statements 31% → 60% \|/)
  assert.match(body, /\| Coverage frontend \| lines 47\.68% → 47\.68% · branches 40% → 40%/)
  assert.match(body, /7\/10 → 10\/10/)
  assert.match(body, /analyzing-pr-changes, writing-backend-tests/)
})

test('neutralises mentions, HTML, links and images in agent text', () => {
  const body = renderComment(report)
  // Snippets live inside a code fence, where GitHub renders nothing; check the rest.
  const prose = body.replace(/<details>[\s\S]*?<\/details>/g, '')
  assert.ok(!body.includes('@octocat'))
  assert.ok(!body.includes('<img'))
  assert.ok(!prose.includes('](https://evil.example'))
  assert.ok(!prose.includes('!['))
})

test('keeps suspected-bug snippets inside one closed code fence', () => {
  const body = renderComment(report)
  assert.match(body, /Is it intended that a task due today counts as overdue\?/)
  const details = body.slice(body.indexOf('<details>'), body.indexOf('</details>'))
  assert.equal((details.match(/^````/gm) ?? []).length, 2)
})

test('does not create cross-references to issues or other repositories', () => {
  assert.ok(!/(^|\s)#12\b/.test(clean('see #12')))
  assert.ok(!clean('octo/repo#3').includes('repo#3'))
})

test('cleans and caps single fields', () => {
  assert.equal(clean('a\n|b|', 300), 'a \\|b\\|')
  assert.equal(clean('x'.repeat(400), 300).length, 300)
})

test('caps the whole body', () => {
  const huge = { ...report, agent: { ...report.agent, decisions: Array.from({ length: 30 }, () => ({ ...report.agent.decisions[0], reason: 'y'.repeat(300) })) } }
  const body = renderComment(huge, { maxLength: 5000 })
  assert.ok(body.length <= 5000)
  assert.match(body, /truncated/)
})

test('explains a skipped run in one line', () => {
  const body = renderComment({ verdict: 'skipped', reason: 'no testable source or contract changes (docs/config/tests only)', runUrl: 'u' })
  assert.match(body, /Skipped/)
  assert.match(body, /no testable source or contract changes/)
  assert.ok(!body.includes('Measured by the workflow'))
})

test('turns the judge\'s ready into what publish actually did', () => {
  const ready = { verdict: 'ready', reason: '2 test files verified' }
  assert.deepEqual(applyPublishOutcome(ready, { result: 'success', commitSha: 'abc1234' }), { verdict: 'pushed', reason: '2 test files verified', commitSha: 'abc1234' })
  assert.equal(applyPublishOutcome(ready, { result: 'success', superseded: 'true' }).verdict, 'superseded')
  assert.equal(applyPublishOutcome(ready, { result: 'failure' }).verdict, 'failed')
  assert.equal(applyPublishOutcome({ verdict: 'rejected', reason: 'x' }, { result: 'skipped' }).verdict, 'rejected')
})

test("shows cost with the model, the skills and the agent's own test runs on separate rows", () => {
  const body = renderComment({ ...report, agent: { ...report.agent, aiCredits: 13, model: 'model-a', skillsUsed: ['writing-backend-tests'], testRuns: { total: 3, failed: 2, lastPassed: true } } })
  assert.match(body, /\| Cost \| 13\.0 AI credits \(≈ \$0\.13\), model-a\b/)
  assert.match(body, /\| Skills used \| writing-backend-tests \|/)
  assert.match(body, /\| Agent's own test runs \| ran its tests 3 times, last run passed/)
  assert.ok(!renderComment(report).includes('AI credits'))
})

test('neutralises HTML, links, mentions and issue references in rendered reasons and suspected bugs', () => {
  const payload = '<img src=x> [link](https://evil) @someone #12'
  const hostile = { ...report, agent: { ...report.agent,
    decisions: [{ ...report.agent.decisions[0], reason: payload }],
    suspectedBugs: [{ file: 'a.ts', line: 1, question: payload, evidence: payload }] } }
  const body = renderComment(hostile)
  assert.ok(!body.includes('<img'))
  assert.ok(!body.includes('](https://evil)'))
  assert.ok(!body.includes('@someone'))
  assert.ok(!/(^|[^\w])#12\b/.test(body))
})

test('tells the reader CI runs on the pushed commit automatically', () => {
  const body = renderComment({ ...report, verdict: 'pushed', commitSha: 'abc1234' })
  assert.match(body, /Tests pushed in abc1234\. CI runs on it automatically\./)
})

test('cleans skill names, which are model-controlled text', () => {
  const hostile = 'x |\n\n## ✅ Approved <img src=https://evil/p.png> @Krowli [click](https://evil)'
  const body = renderComment({ ...report, agent: { ...report.agent, skillsUsed: [hostile, 'ok-skill'] } })
  const row = body.split('\n').find((line) => line.startsWith('| Skills used'))
  assert.ok(row && !row.includes('<img') && !row.includes('](https://evil)') && !row.includes('@Krowli'))
  assert.ok(!body.includes('\n## '))
  assert.match(row, /ok-skill/)
})

test('a forged pushed or superseded verdict, or commit sha, cannot produce "Tests added"', () => {
  for (const verdict of ['pushed', 'superseded']) {
    const out = applyPublishOutcome({ verdict, commitSha: 'deadbee', reason: 'x' }, { result: 'success', commitSha: 'abc1234' })
    assert.equal(out.verdict, 'failed')
    assert.equal(out.reason, 'invalid verdict in report')
  }
  const forged = applyPublishOutcome({ verdict: 'ready', commitSha: 'deadbee', reason: 'x' }, { result: 'success', commitSha: 'abc1234' })
  assert.equal(forged.commitSha, 'abc1234')
  assert.doesNotMatch(renderComment({ ...forged, verdict: 'failed', commitSha: undefined }), /Tests added/)
})

test('non-numeric agent facts are dropped instead of crashing or injecting text', () => {
  const agent = { ...report.agent, aiCredits: '<img src=x>', costUsd: 'free', numTurns: '@x', testRuns: { total: '<b>9</b>', lastPassed: true } }
  const body = renderComment({ ...report, agent })
  assert.ok(!body.includes('<img') && !body.includes('<b>') && !body.includes('@x'))
  assert.ok(!body.includes('AI credits') && !body.includes('ran its tests'))
  assert.match(renderComment({ ...report, agent: { ...agent, aiCredits: '13', testRuns: { total: '3', lastPassed: true } } }), /13\.0 AI credits[\s\S]*ran its tests 3 times/)
})

test('an empty publish result reads as not run', () => {
  assert.match(applyPublishOutcome({ verdict: 'ready', reason: 'x' }, { result: '', commitSha: '' }).reason, /publishing failed \(not run\)/)
})

test('an unknown publish status is neither pushed nor superseded', () => {
  const out = applyPublishOutcome({ verdict: 'ready', reason: 'x' }, { result: 'success', commitSha: '', status: 'unknown' })
  assert.equal(out.verdict, 'failed')
  assert.match(out.reason, /publishing status unknown \(could not read the PR head\)\. Check the PR's commits\./)
  assert.doesNotMatch(renderComment({ ...out, runUrl: 'u' }), /Tests added|Superseded/)
})

test('shows injection signals as a measured row', () => {
  assert.match(renderComment(report), /\| Injection signals \| none \|/)
  const body = renderComment({ ...report, injectionSignals: [{ path: 'a|b<i>.ts', line: 3, kind: 'hidden-characters' }] })
  assert.match(body, /\| Injection signals \| ⚠️ 1: a\\\|b\.ts:3 hidden-characters \|/)
})

test('shows whether the agent ran its test review', () => {
  assert.match(renderComment({ ...report, agent: { ...report.agent, skillsUsed: ['reviewing-test-quality'] } }), /\| Self-review \| ✅ reviewing-test-quality loaded \|/)
  assert.match(renderComment(report), /\| Self-review \| ⚠️ not loaded: the agent did not run its test review \|/)
})

test('a ready verdict with threat flags is blocked by the threat scan, not a failed publish', () => {
  const ready = { verdict: 'ready', reason: '2 test files verified', runUrl: 'https://github.com/o/r/actions/runs/1' }
  const outcome = applyPublishOutcome(ready, { result: 'skipped', threatFlags: ['prompt_injection', 'malicious_patch'] })
  assert.equal(outcome.verdict, 'blocked')
  const body = renderComment(outcome)
  assert.match(body, /🛡️ Blocked by the threat scan — nothing was published/)
  assert.match(body, /The AI threat scan flagged: possible prompt injection, possibly malicious patch\./)
  assert.doesNotMatch(body, /Verification failed|publishing failed/)
})

test('threat flags: unknown names are ignored, and none left means the normal outcome', () => {
  const ready = { verdict: 'ready', reason: 'ok', runUrl: 'u' }
  const secret = applyPublishOutcome(ready, { result: 'skipped', threatFlags: ['secret_leak', 'reasons', '<img>'] })
  assert.match(secret.reason, /^The AI threat scan flagged: possible secret leak\.$/)
  assert.equal(applyPublishOutcome(ready, { result: 'skipped', threatFlags: ['reasons', 'x'] }).verdict, 'failed')
  assert.equal(applyPublishOutcome(ready, { result: 'success', commitSha: 'abc1234', threatFlags: [] }).verdict, 'pushed')
})

test('threat flags do not change a verdict that is not ready', () => {
  assert.equal(applyPublishOutcome({ verdict: 'failed', reason: 'x' }, { threatFlags: ['prompt_injection'] }).verdict, 'failed')
})

test('lists every app metric among lines, branches and functions below 100% after the agent', () => {
  assert.deepEqual(coverageGaps(report), ['backend lines 61.2%', 'backend branches 55.5%', 'backend functions 70%', 'frontend lines 47.68%', 'frontend branches 40%', 'frontend functions 50%'])
  const full = { lines: 100, branches: 100, functions: 100, statements: 90 }
  assert.deepEqual(coverageGaps({ verification: { coverage: { after: { backend: full, frontend: { ...full, branches: 99.9 } } } } }), ['frontend branches 99.9%'])
  assert.deepEqual(coverageGaps({ verification: { coverage: { after: { backend: full, frontend: full } } } }), [])
})

test('unmeasured, unknown or forged coverage is no gap', () => {
  for (const after of [undefined, null, { backend: null }, { backend: { lines: 'Unknown', branches: null } }, { 'x\ny=1': { lines: 5 } }]) {
    assert.deepEqual(coverageGaps({ verification: { coverage: { after } } }), [])
  }
  assert.deepEqual(coverageGaps({}), [])
})

test('a second pass shows coverage from before the first pass to after the second', () => {
  const first = { ...report, verification: { ...report.verification, coverage: { ...report.verification.coverage, before: { backend: { lines: 10, branches: 5, functions: 8, statements: 9 } } } } }
  const merged = fromOriginalCode(first, report)
  assert.deepEqual(merged.verification.coverage.before, { backend: { lines: 10, branches: 5, functions: 8, statements: 9 } })
  assert.deepEqual(merged.verification.coverage.after, report.verification.coverage.after)
  assert.equal(merged.verdict, report.verdict)
  assert.equal(report.verification.coverage.before.backend.lines, 33.02) // inputs stay unchanged
})

test('without the first pass\'s coverage before, or this pass\'s coverage, there is nothing to merge', () => {
  assert.equal(fromOriginalCode({ verification: {} }, report), null)
  assert.equal(fromOriginalCode(null, report), null)
  assert.equal(fromOriginalCode(report, { ...report, verification: {} }), null)
})

test('names both runs of a two-pass comment, only from the trusted link passed in', () => {
  const body = renderComment({ ...report, verdict: 'pushed', commitSha: 'abc1234' }, { firstRunUrl: 'https://github.com/o/r/actions/runs/7' })
  assert.match(body, /Two passes: \[first run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/7\), \[second run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\)\. Coverage runs from the code before the first pass\./)
  assert.ok(body.indexOf('Two passes') < body.indexOf('Measured by the workflow'))
  assert.doesNotMatch(renderComment({ ...report, firstRunUrl: 'https://forged.example' }), /Two passes|forged/)
})

test('shows when a failing test without the change was required but missing, and which files lack an exception', () => {
  const failsWithoutChange = { required: true, met: false, failing: 0, total: 6, exceptions: [], unexcepted: ['backend/src/a.ts', 'backend/src/b.ts'] }
  const body = renderComment({ ...report, verdict: 'failed', verification: { ...report.verification, failsWithoutChange } })
  assert.match(body, /\| Fails without the change \| required ❌: 0 of 6 tests in the agent's test files fail on the PR's base source; no exception for `backend\/src\/a\.ts`, `backend\/src\/b\.ts` \|/)
  assert.doesNotMatch(body, /\| Exceptions/)
})

test('lists every declared exception, cleaned like other agent text, and marks an accepted exception', () => {
  const exceptions = [
    { file: 'backend/src/a.ts', reason: 'no-behaviour-change', detail: 'rename only @octocat <img src=x> [x](https://evil.example)' },
    { file: 'backend/src/b|c.ts', reason: 'not-unit-testable', detail: 'starts the server' },
  ]
  const failsWithoutChange = { required: true, met: true, failing: 0, total: 6, exceptions, unexcepted: [] }
  const body = renderComment({ ...report, verification: { ...report.verification, failsWithoutChange } })
  assert.match(body, /\| Fails without the change \| 0 of 6 tests in the agent's test files fail on the PR's base source; accepted: every modified source file has an exception ⚠️ \|/)
  const row = body.split('\n').find((line) => line.startsWith('| Exceptions (agent-declared)'))
  assert.ok(row, body)
  assert.match(row, /`backend\/src\/a\.ts` — no-behaviour-change — rename only/)
  assert.match(row, /`backend\/src\/b\\\|c\.ts` — not-unit-testable — starts the server/)
  assert.ok(!row.includes('@octocat') && !row.includes('<img') && !row.includes('](https://evil'))
})

test('shows no fails-without-the-change row when it is not required', () => {
  const failsWithoutChange = { required: false, met: true, failing: 0, total: 0, exceptions: [], unexcepted: [] }
  const body = renderComment({ ...report, verification: { ...report.verification, pinsChange: { applicable: false, newTests: 0, failingOnBase: 0 }, failsWithoutChange } })
  assert.doesNotMatch(body, /Fails without the change|Exceptions/)
})

test('shows agent output that does not match the schema as a measured row: the first 3 errors, cleaned', () => {
  const schemaErrors = ['assertionChanges[0]: missing required "testFile"', 'assertionChanges[0]: missing required "why"', '(root): unexpected property "@octocat|<b>x</b>"', 'summary: expected string, got number']
  const body = renderComment({ ...report, verdict: 'rejected', agent: { ...report.agent, schemaErrors } })
  const row = body.split('\n').find((line) => line.startsWith('| Agent output |'))
  assert.equal(row, '| Agent output | ❌ does not match the schema: assertionChanges[0]: missing required "testFile"; assertionChanges[0]: missing required "why"; (root): unexpected property "@\u200Boctocat\\|x"; and 1 more |')
  assert.doesNotMatch(renderComment(report), /\| Agent output \|/)
  assert.doesNotMatch(renderComment({ ...report, agent: { ...report.agent, schemaErrors: [] } }), /\| Agent output \|/)
})

test('a two-pass comment adds up both passes\' AI credits and labels the patch as the second pass\'s', () => {
  const second = { ...report, agent: { ...report.agent, numTurns: null, costUsd: null, durationMs: null, aiCredits: 28.7, model: 'model-a' } }
  const firstRunUrl = 'https://github.com/o/r/actions/runs/7'
  const body = renderComment(second, { firstRunUrl, firstReport: { agent: { aiCredits: 101.2 } } })
  assert.match(body, /^\| Cost \| 101\.2 \+ 28\.7 = 129\.9 AI credits \(≈ \$1\.30\), first \+ second pass, model-a \|$/m)
  assert.match(body, /^\| Patch \(second pass\) \| 1 test files, \+40 lines ✅/m)
  for (const firstReport of [{ agent: {} }, { agent: { aiCredits: 'x' } }, {}]) {
    assert.match(renderComment(second, { firstRunUrl, firstReport }), /^\| Cost \(second pass\) \| 28\.7 AI credits \(≈ \$0\.29\), model-a \|$/m, JSON.stringify(firstReport))
  }
  const single = renderComment(second)
  assert.match(single, /^\| Cost \| 28\.7 AI credits \(≈ \$0\.29\), model-a \|$/m)
  assert.match(single, /^\| Patch \| 1 test files/m)
})

test('asks for a human look in the headline when tests were accepted only through agent-declared exceptions', () => {
  const exceptions = [{ file: 'backend/src/a.ts', reason: 'suspected-bug', detail: 'reported as a question' }]
  const viaExceptions = { required: true, met: true, failing: 0, total: 6, exceptions, unexcepted: [] }
  for (const verdict of ['pushed', 'ready']) {
    const body = renderComment({ ...report, verdict, verification: { ...report.verification, failsWithoutChange: viaExceptions } })
    assert.match(body.split('\n')[1], /^### Unit test agent — ⚠️ .* — agent-declared exceptions need a human look$/, verdict)
  }
  const withFailingTest = { ...viaExceptions, failing: 2 }
  const body = renderComment({ ...report, verdict: 'pushed', verification: { ...report.verification, failsWithoutChange: withFailingTest } })
  assert.equal(body.split('\n')[1], '### Unit test agent — ✅ Tests added to this PR')
})
