// Builds report.json (plans/000 §8) from what the workflow measured. Agent claims are
// carried along for display only; the verdict depends on measurements alone.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkOutput } from './lib/check-output.mjs'
import { countLines, summarize } from './lib/coverage.mjs'
import { parseVitestJson } from './lib/vitest-json.mjs'
import { renderComment } from './render-comment.mjs'

const APPS = ['backend', 'frontend']
// The gate extracts the schema from the same trusted commit as this folder.
const SCHEMA = fileURLToPath(new URL('../../.github/agents/unit-test-agent.schema.json', import.meta.url))

function* walk(value) {
  if (Array.isArray(value)) for (const item of value) yield* walk(item)
  else if (value && typeof value === 'object') {
    yield value
    for (const child of Object.values(value)) yield* walk(child)
  }
}

const TEST_SCRIPT = '/run-tests.mjs'

// Copilot CLI session log (agent-session.jsonl): one event per line, tool calls paired by id.
function parseCopilotSession(events) {
  const skillsUsed = []
  const testCalls = new Set()
  const testResults = []
  let permissionDenials = 0
  for (const { type, data } of events) {
    if (type === 'tool.execution_start' && data?.toolName === 'skill') {
      const skill = data.arguments?.skill
      // The name is model-controlled text: only plain strings, and not an unbounded list.
      if (typeof skill === 'string' && skill && skillsUsed.length < 20 && !skillsUsed.includes(skill)) skillsUsed.push(skill)
    }
    if (type === 'tool.execution_start' && data?.toolName === 'bash' && String(data.arguments?.command).includes(TEST_SCRIPT)) {
      testCalls.add(data.toolCallId)
    }
    if (type === 'tool.execution_complete' && testCalls.has(data?.toolCallId)) {
      testResults.push(data.success === true && data.shellExecution?.exitCode === 0)
    }
    if (type === 'permission.completed' && String(data?.result?.kind).startsWith('denied')) permissionDenials++
  }
  return {
    skillsUsed, numTurns: null, costUsd: null, durationMs: null, resultSubtype: null, permissionDenials,
    testRuns: { total: testResults.length, failed: testResults.filter((passed) => !passed).length, lastPassed: testResults.at(-1) ?? false },
  }
}

// The session log format is not documented; read it defensively.
export function parseExecution(execution) {
  if (Array.isArray(execution) && execution.some((event) => event?.type === 'tool.execution_start')) {
    return parseCopilotSession(execution)
  }
  const skillsUsed = []
  let result = null
  for (const node of walk(execution ?? [])) {
    if (node.type === 'tool_use' && node.name === 'Skill') {
      const skill = node.input?.skill ?? node.input?.command ?? node.input?.name
      if (skill && !skillsUsed.includes(skill)) skillsUsed.push(skill)
    }
    if (node.type === 'result') result = node
  }
  return {
    skillsUsed,
    numTurns: result?.num_turns ?? null,
    costUsd: result?.total_cost_usd ?? null,
    durationMs: result?.duration_ms ?? null,
    resultSubtype: result?.subtype ?? null,
    permissionDenials: Array.isArray(result?.permission_denials) ? result.permission_denials.length : null,
  }
}

// gh-aw's agent_usage.json. Facts for the report only: anything unexpected is dropped, never a reason to change the verdict.
export function parseUsage(usage) {
  const credits = usage?.ai_credits
  if (typeof credits !== 'number' || !Number.isFinite(credits) || credits < 0) return null
  return { aiCredits: Math.round(credits * 10) / 10, model: typeof usage.primary_model === 'string' ? usage.primary_model : null }
}

function changedLineCoverage(manifest) {
  const files = (manifest?.files ?? []).filter((file) => file.testable && file.status !== 'D' && Array.isArray(file.uncoveredChangedLines))
  if (!files.length) return null
  // Only lines that hold code can be covered; blank lines and comments are not counted.
  const total = files.reduce((sum, file) => sum + countLines(file.coverableChangedLines ?? file.changedLines), 0)
  const uncovered = files.reduce((sum, file) => sum + countLines(file.uncoveredChangedLines), 0)
  return { covered: total - uncovered, total }
}

export const NO_FAILING_TEST_REASONS = ['no-behaviour-change', 'suspected-bug', 'not-unit-testable']

// PR mode: when the PR modifies existing testable source, at least one test in the agent's test files
// must fail with that source restored to the base (measure.sh), unless the agent declared an exception
// (decision.noFailingTest) for every such file. Exceptions are agent claims: accepted, but always listed.
export function failsWithoutChange(manifest, pinsChange, decisions) {
  const modified = manifest?.mode === 'pr' ? (manifest.files ?? []).filter((file) => file.testable && file.status === 'M').map((file) => file.path) : []
  const exceptions = (Array.isArray(decisions) ? decisions : [])
    .filter((d) => typeof d?.file === 'string' && NO_FAILING_TEST_REASONS.includes(d.noFailingTest?.reason) && typeof d.noFailingTest.detail === 'string' && d.noFailingTest.detail.trim())
    .map(({ file, noFailingTest: { reason, detail } }) => ({ file, reason, detail }))
  const failing = Number(pinsChange?.failingOnBase) || 0
  const unexcepted = modified.filter((path) => !exceptions.some((e) => e.file === path))
  const required = modified.length > 0
  return { required, met: !required || failing > 0 || !unexcepted.length, failing, total: Number(pinsChange?.newTests) || 0, exceptions, unexcepted }
}

export function buildReport(inputs) {
  const { repoRoot, manifest, verdictHint, reason, pr = null, headSha = null, runUrl = null, inputErrors = [] } = inputs
  const base = { pr, headSha, runUrl, gate: manifest?.gate ?? null, injectionSignals: manifest?.injectionSignals ?? [], ...(inputErrors.length ? { inputErrors } : {}) }
  if (verdictHint === 'skipped') return { verdict: 'skipped', reason: reason ?? manifest?.gate?.reason ?? 'skipped', ...base }

  const output = inputs.agentOutput ?? {}
  const agent = {
    decisions: output.decisions ?? [],
    impact: output.impact ?? [],
    assertionChanges: output.assertionChanges ?? [],
    suspectedBugs: output.suspectedBugs ?? [],
    discardedTests: output.discardedTests ?? [],
    ...parseExecution(inputs.execution),
    ...(parseUsage(inputs.usage) ?? {}),
    // Shown, never a verdict: the checks that read these fields already fail closed; this says why they found nothing.
    ...(inputs.agentOutput !== undefined && inputs.schema ? { schemaErrors: checkOutput(inputs.agentOutput, inputs.schema) } : {}),
  }
  if (verdictHint === 'failed' || verdictHint === 'rejected') return { verdict: verdictHint, reason: reason ?? verdictHint, ...base, agent }

  const patch = inputs.patchValidation
  const verification = { patch, assertionAudit: patch?.assertionAudit }
  if (!patch?.valid) {
    return { verdict: 'rejected', reason: `Patch rejected: ${(patch?.violations ?? ['missing validation']).slice(0, 3).join('; ')}`, ...base, agent, verification }
  }
  if (!patch.files.length) return { verdict: 'no-changes', reason: 'The agent decided no test changes were needed.', ...base, agent, verification }

  verification.typecheck = inputs.typecheck
  verification.tests = Object.fromEntries(APPS.filter((app) => inputs.results?.[app]).map((app) => {
    const { passed, failed, total } = parseVitestJson(inputs.results[app], repoRoot)
    return [app, { passed, failed, total }]
  }))
  verification.requireAssertions = inputs.requireAssertions
  verification.pinsChange = inputs.pinsChange ?? { applicable: false, newTests: 0, failingOnBase: 0 }
  verification.failsWithoutChange = failsWithoutChange(manifest, verification.pinsChange, agent.decisions)
  const stabilityRuns = inputs.stabilityRuns ?? []
  const flaky = [...new Set(stabilityRuns.flatMap((run) => parseVitestJson(run, repoRoot).failures.map((f) => `${f.file} › ${f.name}`)))]
  const runsPerApp = Object.values(Object.groupBy(stabilityRuns, (run) => APPS.find((app) => run.testResults?.[0]?.name?.includes(`/${app}/`)) ?? 'unknown'))
  verification.stability = { runs: 1 + Math.max(0, ...runsPerApp.map((runs) => runs.length)), shuffled: stabilityRuns.length > 0, flaky }
  verification.coverage = {
    before: manifest?.coverageBefore ?? null,
    after: inputs.coverageAfter ?? null,
    changedLines: { before: changedLineCoverage(manifest), after: changedLineCoverage(inputs.manifestAfter) },
  }

  // Tests already failing on the PR head before the agent ran are reported, not blamed on the agent.
  const preexisting = new Set((manifest?.failingTests ?? []).map((f) => `${f.file} › ${f.name}`))
  const newFailures = APPS.flatMap((app) => (inputs.results?.[app] ? parseVitestJson(inputs.results[app], repoRoot).failures : []))
    .map((f) => `${f.file} › ${f.name}`)
    .filter((id) => !preexisting.has(id))
  const missing = [
    ...APPS.filter((app) => !inputs.typecheck?.[app]).map((app) => `typecheck (${app})`),
    ...APPS.filter((app) => !inputs.results?.[app]).map((app) => `tests (${app})`),
    ...(inputs.requireAssertions ? [] : ['assertion check']),
    ...(stabilityRuns.length ? [] : ['stability runs']),
  ]
  // A measurement input that could not be read is a problem, not a silently smaller set of runs.
  const unreadable = inputErrors.filter((e) => /^(results-|stability-|typecheck-|require-assertions|pins-change|coverage-after)/.test(e))
  const problems = [
    ...(unreadable.length ? [`unreadable measurements: ${unreadable.join(', ')}`] : []),
    ...(missing.length ? [`missing measurements: ${missing.join(', ')}`] : []),
    ...Object.entries(verification.typecheck ?? {}).filter(([, state]) => state !== 'pass').map(([app]) => `${app} typecheck failed`),
    ...(newFailures.length ? [`${newFailures.length} failing tests`] : []),
    ...(verification.requireAssertions === 'fail' ? ['some tests have no assertion'] : []),
    ...(flaky.filter((id) => !preexisting.has(id)).length ? [`${flaky.length} flaky tests`] : []),
    ...(verification.failsWithoutChange.met ? [] : [`no agent test fails without the change (required: ${verification.failsWithoutChange.unexcepted.length} modified source files have no exception)`]),
  ]
  const known = [...preexisting].length
  const note = known ? `; ${known} test${known === 1 ? ' was' : 's were'} already failing before the agent` : ''
  return {
    verdict: problems.length ? 'failed' : 'ready',
    reason: (problems.length ? problems.join('; ') : `${patch.files.length} test files verified`) + note,
    ...base,
    agent,
    verification,
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line)) // JSON Lines
  }
}

// An input that cannot be read or parsed (e.g. malformed agent claims) counts as missing, so the
// verdict still comes from the measurements; it is named in the report instead of crashing it.
function readJson(path, inputErrors = [], label = path) {
  if (!path || !existsSync(path)) return undefined
  try {
    return parseJson(readFileSync(path, 'utf8'))
  } catch (error) {
    inputErrors.push(`${label}: ${error instanceof SyntaxError ? 'invalid JSON' : 'unreadable'}`)
    return undefined
  }
}

function main() {
  const { values } = parseArgs({
    options: Object.fromEntries([
      ...['manifest', 'manifest-after', 'agent-output', 'execution-file', 'usage', 'patch-validation', 'typecheck-backend', 'typecheck-frontend',
        'results-backend', 'results-frontend', 'require-assertions', 'pins-change', 'coverage-after-root', 'verdict-hint', 'reason',
        'run-url', 'pr', 'head-sha', 'out'].map((name) => [name, { type: 'string' }]),
      ['stability', { type: 'string', multiple: true }],
    ]),
  })
  const inputErrors = []
  const read = (name) => readJson(values[name], inputErrors, name)
  const usage = read('usage')
  // Not a measurement input (see `unreadable` above): named in the report, the verdict stays as is.
  if (usage !== undefined && !parseUsage(usage)) inputErrors.push('usage: unexpected shape')
  const coverageAfter = values['coverage-after-root']
    ? Object.fromEntries(APPS.map((app) => {
      const summary = readJson(join(values['coverage-after-root'], `${app}/coverage/coverage-summary.json`), inputErrors, `coverage-after ${app}`)
      return [app, summary ? summarize(summary) : null]
    }))
    : undefined
  const report = buildReport({
    repoRoot: process.cwd(),
    manifest: read('manifest'),
    manifestAfter: read('manifest-after'),
    agentOutput: read('agent-output'),
    schema: readJson(SCHEMA, inputErrors, 'schema'),
    execution: read('execution-file'),
    usage,
    patchValidation: read('patch-validation'),
    typecheck: values['typecheck-backend'] ? { backend: values['typecheck-backend'], frontend: values['typecheck-frontend'] } : undefined,
    results: { backend: read('results-backend'), frontend: read('results-frontend') },
    stabilityRuns: (values.stability ?? []).map((path) => readJson(path, inputErrors, `stability-${basename(path)}`)).filter(Boolean),
    requireAssertions: values['require-assertions'],
    pinsChange: read('pins-change'),
    coverageAfter,
    inputErrors,
    verdictHint: values['verdict-hint'],
    reason: values.reason,
    runUrl: values['run-url'],
    pr: values.pr ? Number(values.pr) : null,
    headSha: values['head-sha'],
  })
  if (values.out) writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${renderComment(report)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
