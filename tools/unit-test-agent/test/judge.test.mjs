import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const judge = fileURLToPath(new URL('../judge.sh', import.meta.url))
// judge.sh needs bash 4+ (empty arrays under `set -u`); macOS ships 3.2, CI runs Linux.
const bashMajor = Number(spawnSync('bash', ['-c', 'echo ${BASH_VERSINFO[0]}'], { encoding: 'utf8' }).stdout)
const skip = bashMajor < 4 && `bash ${bashMajor} is too old for judge.sh`

const OUTSIDE_TESTS = [
  'diff --git a/backend/src/app.ts b/backend/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/backend/src/app.ts',
  '+++ b/backend/src/app.ts',
  '@@ -1,1 +1,2 @@',
  ' export {}',
  '+export const x = 1',
  '',
].join('\n')

const TESTS_ONLY = [
  'diff --git a/backend/tests/y.test.ts b/backend/tests/y.test.ts',
  'new file mode 100644',
  'index 0000000..2222222',
  '--- /dev/null',
  '+++ b/backend/tests/y.test.ts',
  '@@ -0,0 +1,2 @@',
  "+import { test } from 'vitest'",
  "+test('y', () => {})",
  '',
].join('\n')

function runJudge({ patch, generate = 'success', measure = 'success', extraEnv = {}, claims = true, prepare } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'judge-'))
  const input = join(dir, 'in')
  mkdirSync(join(input, 'analysis/.unit-test-agent'), { recursive: true })
  mkdirSync(join(input, 'agent'), { recursive: true })
  writeFileSync(join(input, 'analysis/.unit-test-agent/manifest.json'), JSON.stringify({ mode: 'pr', files: [] }))
  if (patch) writeFileSync(join(input, 'agent/agent.patch'), patch)
  if (claims) writeFileSync(join(input, 'agent/agent-output.json'), JSON.stringify({ assertionChanges: [] }))
  prepare?.(input)
  const output = join(dir, 'github-output')
  writeFileSync(output, '')
  const result = spawnSync('bash', [judge], {
    encoding: 'utf8',
    env: { ...process.env, IN: input, GENERATE_RESULT: generate, MEASURE_RESULT: measure, HEAD_SHA: 'abc', RUN_URL: 'https://run', PR_NUMBER: '7', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(dir, 'summary'), ...extraEnv },
  })
  const report = JSON.parse(readFileSync(join(input, 'out/report.json'), 'utf8'))
  return { status: result.status, report, output: readFileSync(output, 'utf8') }
}

test('lets the run publish when the agent changed no tests', { skip }, () => {
  const { status, report, output } = runJudge()
  assert.equal(status, 0)
  assert.equal(report.verdict, 'no-changes')
  assert.match(output, /verdict=no-changes/)
})

test('blocks publishing when the agent job failed', { skip }, () => {
  const { status, report } = runJudge({ generate: 'failure' })
  assert.equal(status, 1)
  assert.equal(report.verdict, 'failed')
  assert.match(report.reason, /agent job did not finish successfully \(failure\)/)
})

test('blocks publishing when the measure job did not finish', { skip }, () => {
  const { status, report } = runJudge({ patch: TESTS_ONLY, measure: 'cancelled' })
  assert.equal(status, 1)
  assert.match(report.reason, /Measuring the agent's tests did not finish \(cancelled\)/)
})

test('blocks publishing when the patch touches a file outside the test paths', { skip }, () => {
  const { status, report } = runJudge({ patch: OUTSIDE_TESTS })
  assert.equal(status, 1)
  assert.equal(report.verdict, 'rejected')
  assert.match(report.reason, /not an allowed test path: backend\/src\/app\.ts/)
})

test('reports a rejected patch as rejected, not failed, when measurement was skipped', { skip }, () => {
  const { status, report } = runJudge({ patch: OUTSIDE_TESTS, measure: 'skipped' })
  assert.equal(status, 1)
  assert.equal(report.verdict, 'rejected')
})

test('passes the caller\'s explicit verdict and reason through', { skip }, () => {
  const { status, report } = runJudge({
    measure: 'skipped',
    extraEnv: { VERDICT_HINT: 'rejected', REASON: 'agent commits do not build on the PR head' },
  })
  assert.equal(status, 1)
  assert.equal(report.verdict, 'rejected')
  assert.match(report.reason, /agent commits do not build on the PR head/)
})

test('still computes a verdict when the claims file is missing', { skip }, () => {
  const { status, report } = runJudge({ patch: TESTS_ONLY, measure: 'cancelled', claims: false })
  assert.equal(status, 1)
  assert.equal(report.verdict, 'failed')
})

test('reads no measurement files when the verdict is already failed or rejected', { skip }, () => {
  const { report } = runJudge({
    patch: TESTS_ONLY,
    extraEnv: { VERDICT_HINT: 'failed', REASON: 'measurements contain links' },
    prepare: (input) => {
      mkdirSync(join(input, 'measurements'), { recursive: true })
      writeFileSync(join(input, 'measurements/typecheck-backend'), 'pass')
      writeFileSync(join(input, 'measurements/typecheck-frontend'), 'pass')
      writeFileSync(join(input, 'measurements/results-backend.json'), '{oops')
    },
  })
  assert.equal(report.verdict, 'failed')
  assert.equal(report.inputErrors, undefined)
})

test('passes the usage file to the report only when it is there', { skip }, () => {
  const withUsage = runJudge({ patch: TESTS_ONLY, prepare: (input) => writeFileSync(join(input, 'agent/usage.json'), '{"ai_credits": 13.00783, "primary_model": "m"}') })
  assert.equal(withUsage.report.agent.aiCredits, 13)
  assert.equal(withUsage.report.agent.model, 'm')
  assert.equal(runJudge({ patch: TESTS_ONLY }).report.agent.aiCredits, undefined)
})
