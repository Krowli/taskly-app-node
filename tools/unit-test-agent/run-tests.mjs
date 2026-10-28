#!/usr/bin/env node
// The unit-test agent's only shell command: runs Vitest (and optionally tsc) for one
// app and prints a compact, agent-friendly result. Self-contained (no npm deps,
// one shared import for the allowed test paths).
import { spawnSync } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
// The one list of allowed test paths, shared with the workflow tooling.
import { isAllowedTestPath } from './lib/test-paths.mjs'
import { validatePatch } from './validate-patch.mjs'
import { withoutChangePlan } from './lib/without-change.mjs'
import { uncoveredBranchLines, uncoveredFunctions, uncoveredLines } from './lib/coverage.mjs'
import { checkOutput } from './lib/check-output.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
// Called as an executable so Copilot's shell permission can name this exact file. The workflow
// copies it from the base commit into the git-ignored scratch folder before the agent starts.
const SELF = './.unit-test-agent/bin/run-tests.mjs'
// The schema --check-output reads comes from the same trusted copy as this script: the workflow installs
// it next to the agent's copy; run from tools/, it is this repository's own.
const HERE = fileURLToPath(new URL('./', import.meta.url))
const SCHEMA = HERE === join(ROOT, '.unit-test-agent/bin/') ? join(HERE, 'unit-test-agent.schema.json') : join(ROOT, '.github/agents/unit-test-agent.schema.json')
const OUTPUT = '.unit-test-agent/agent-output.json'
const USAGE = `Usage: ${SELF} <backend|frontend> [--typecheck] [--coverage <src-file>]... [--without-change] [--repeat <n>] [-- <test-file>...]
       ${SELF} --check-output

Runs Vitest (with --expect.requireAssertions) for one app. Paths are relative to the repo root.
Frontend test files that are new in this PR are formatted with Prettier first.
Without test files it runs the whole app suite. Exit code: 0 all passed, 1 failures, 2 usage error.
--without-change (PR mode, needs test files) runs those files against the code as it was before the PR's
change and reports per test whether it fails there. It is a report: exit 0 unless the restore failed (2).
--repeat <n> (2-10, needs test files) runs those files n times in shuffled order with a different seed each
run and reports tests that failed in some runs only (flaky) or in every run. Exit 1 if any run had a failure.
It cannot be combined with --coverage, --typecheck or --without-change.
--check-output checks ${OUTPUT} against the output schema and prints each error. Exit 1 on any error.

Examples:
  ${SELF} backend -- backend/tests/factory.test.ts
  ${SELF} frontend --coverage frontend/src/lib/http.ts -- frontend/src/lib/http.test.ts
  ${SELF} frontend --typecheck
  ${SELF} backend --without-change -- backend/tests/factory.test.ts
  ${SELF} backend --repeat 3 -- backend/tests/factory.test.ts
  ${SELF} --check-output`

function usageError(message) {
  console.error(`${message}\n\n${USAGE}`)
  process.exit(2)
}

function validate(app, testFiles, coverageFiles) {
  if (app !== 'backend' && app !== 'frontend') usageError('The first argument must be backend or frontend.')
  for (const file of testFiles) {
    if (!isAllowedTestPath(file) || !file.startsWith(`${app}/`)) {
      const guess = `${app}/${file}`
      const hint = isAllowedTestPath(guess) && existsSync(join(ROOT, guess)) ? ` — did you mean ${guess}?` : ''
      usageError(`${file} is not a test file this agent may run for ${app}${hint}`)
    }
    if (!existsSync(join(ROOT, file))) usageError(`${file} does not exist. Create it first, or check the path.`)
  }
  for (const file of coverageFiles) {
    if (!file.startsWith(`${app}/src/`) || posix.normalize(file) !== file || !existsSync(join(ROOT, file))) {
      usageError(`--coverage expects a source file under ${app}/src, got ${file}`)
    }
  }
}

// The agent's commands must never see a model credential; this proves it in every run log.
export function credentialsVisible(env) {
  return Boolean(env.COPILOT_GITHUB_TOKEN)
}

// Assertion text plus stack frames from the repo; library and runtime frames are noise.
export function trimFailure(message) {
  return message
    .split('\n')
    .filter((line) => !/^\s+at /.test(line) || !/node_modules|node:internal|<anonymous>/.test(line))
    .slice(0, 25)
    .join('\n')
}

function ranges(lines) {
  const out = []
  for (const line of lines) {
    const last = out.at(-1)
    if (last && line === last[1] + 1) last[1] = line
    else out.push([line, line])
  }
  return out.map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`)).join(', ')
}

export function printCoverage(app, coverageDir, files) {
  const report = JSON.parse(readFileSync(join(coverageDir, 'coverage-final.json'), 'utf8'))
  for (const file of files) {
    const path = Object.keys(report).find((key) => key.endsWith(`/${file}`))
    if (!path) {
      console.log(`coverage: ${file} was not loaded by these tests`)
      continue
    }
    const lines = uncoveredLines(report, path)
    const branches = [...new Set(uncoveredBranchLines(report, path))]
    const functions = uncoveredFunctions(report, path)
    const parts = [
      lines.length && `uncovered lines ${ranges(lines)}`,
      branches.length && `uncovered branches at lines ${branches.join(', ')}`,
      functions.length && `uncovered functions: ${functions.map(({ name, line }) => `${name} (line ${line})`).join(', ')}`,
    ].filter(Boolean)
    console.log(`coverage: ${file} ${parts.length ? parts.join('; ') : 'all lines, branches and functions covered'}`)
  }
}

// The PR head the agent started from: the manifest's, else HEAD.
function headRef(root) {
  try {
    const head = JSON.parse(readFileSync(join(root, '.unit-test-agent/manifest.json'), 'utf8')).head
    if (typeof head === 'string' && /^[0-9a-f]{7,64}$/i.test(head)) return head
  } catch {
    // no manifest: use HEAD
  }
  return 'HEAD'
}

function existsAtHead(root, head, file) {
  return spawnSync('git', ['cat-file', '-e', `${head}:${file}`], { cwd: root }).status === 0
}

function readJson(root, path) {
  try {
    return JSON.parse(readFileSync(join(root, path), 'utf8'))
  } catch {
    return undefined
  }
}

// The gate's own validation, run on the agent's current changes to these test files (working
// tree against the PR head). `failures` fail the run; `notes` do not.
export function policyFindings(root, testFiles) {
  const head = headRef(root)
  const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout ?? ''
  const patch = testFiles
    .map((file) => existsAtHead(root, head, file)
      ? git(['diff', '--no-color', head, '--', file])
      : git(['diff', '--no-color', '--no-index', '--', '/dev/null', file]))
    .join('')
  const { violations } = validatePatch(patch, {
    manifest: readJson(root, '.unit-test-agent/manifest.json'),
    agentOutput: readJson(root, '.unit-test-agent/agent-output.json'),
    original: (file) => (existsAtHead(root, head, file) ? git(['show', `${head}:${file}`]) : undefined),
  })
  const failures = []
  const notes = []
  for (const violation of violations) {
    if (violation.startsWith('unjustified assertion change')) {
      notes.push(`note: ${violation}. Record it in assertionChanges with the changed source line when you write agent-output.json.`)
    } else {
      failures.push(`policy: ${violation} — the gate rejects the whole run with this; fix it before you finish.`)
    }
  }
  return { failures, notes }
}

// Formatting is mechanical, not the agent's job: Prettier rewrites the test files the agent
// created, using the frontend config. Files that already exist at the PR head keep their own
// formatting, since any rewritten old line would count as a changed existing test. A Prettier
// failure (e.g. a syntax error) is shown, and Vitest then reports the real error.
export function formatFrontendTests(root, testFiles) {
  const prettier = join(root, 'frontend/node_modules/.bin/prettier')
  if (!testFiles.length || !existsSync(prettier)) return
  const head = headRef(root)
  const fresh = testFiles.filter((file) => !existsAtHead(root, head, file))
  if (!fresh.length) return
  const before = new Map(fresh.map((file) => [file, readFileSync(join(root, file), 'utf8')]))
  const result = spawnSync(prettier, ['--write', '--', ...fresh.map((file) => relative('frontend', file))], {
    cwd: join(root, 'frontend'), encoding: 'utf8', timeout: 60_000,
  })
  if (result.status !== 0) {
    const reason = result.status === null ? result.error?.message : `exit ${result.status}:\n${result.stderr}`
    console.log(`prettier failed (${reason})`.trim())
    return
  }
  for (const [file, text] of before) {
    if (readFileSync(join(root, file), 'utf8') !== text) console.log(`reformatted: ${file}`)
  }
}

function execVitest(app, testFiles, coverageFiles, extraArgs = []) {
  const work = mkdtempSync(join(tmpdir(), 'run-tests-'))
  const outputFile = join(work, 'results.json')
  const args = ['run', '--expect.requireAssertions', '--reporter=json', `--outputFile=${outputFile}`]
  if (coverageFiles.length) {
    args.push('--coverage.enabled', '--coverage.reporter=json', `--coverage.reportsDirectory=${join(work, 'coverage')}`)
  }
  args.push(...extraArgs, ...testFiles.map((file) => relative(app, file)))
  const result = spawnSync(join(ROOT, app, 'node_modules/.bin/vitest'), args, {
    cwd: join(ROOT, app), encoding: 'utf8', timeout: 300_000, env: { ...process.env, CI: '1' },
  })
  if (!existsSync(outputFile)) {
    console.log(`${app}: Vitest did not produce results (exit ${result.status}). Output tail:`)
    console.log(`${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-25).join('\n'))
    return { work }
  }
  return { work, report: JSON.parse(readFileSync(outputFile, 'utf8')) }
}

function runVitest(app, testFiles, coverageFiles) {
  const { work, report } = execVitest(app, testFiles, coverageFiles)
  if (!report) return false
  let failed = report.numFailedTests ?? 0
  const failures = []
  for (const file of report.testResults ?? []) {
    const name = relative(ROOT, file.name)
    if (file.status === 'failed' && !(file.assertionResults ?? []).length) {
      failed++
      failures.push(`FAIL ${name} (file failed to load)\n  ${trimFailure(String(file.message)).split('\n').join('\n  ')}`)
    }
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status !== 'failed') continue
      const message = trimFailure((assertion.failureMessages ?? []).join('\n')).split('\n').join('\n  ')
      failures.push(`FAIL ${name} › ${assertion.fullName}\n  ${message}`)
    }
  }
  const scope = testFiles.length ? testFiles.join(', ') : 'whole suite'
  console.log(`${app}: ${report.numPassedTests} passed, ${failed} failed, ${report.numTotalTests} total (${scope})`)
  for (const failure of failures) console.log(failure)
  if (coverageFiles.length) printCoverage(app, join(work, 'coverage'), coverageFiles)
  return failed === 0
}

// runs: one list of { name, status } per run. A test that failed in some but not all runs is flaky.
export function classifyRuns(runs) {
  const failures = new Map()
  const seen = new Set()
  for (const run of runs) {
    for (const { name, status } of run) {
      if (status === 'skipped' || status === 'pending' || status === 'todo') continue
      seen.add(name)
      if (status === 'failed') failures.set(name, (failures.get(name) ?? 0) + 1)
    }
  }
  const flaky = []
  const alwaysFailing = []
  for (const [name, failed] of failures) {
    if (failed === runs.length) alwaysFailing.push({ name, runs: runs.length })
    else flaky.push({ name, failed, runs: runs.length })
  }
  return { flaky, alwaysFailing, total: seen.size }
}

function runRepeated(app, testFiles, count) {
  const first = randomInt(1, 1_000_000)
  const seeds = Array.from({ length: count }, (_, i) => first + i)
  console.log(`${app}: ${count} shuffled runs, seeds ${seeds.join(', ')}`)
  const runs = []
  for (const seed of seeds) {
    const { report } = execVitest(app, testFiles, [], ['--sequence.shuffle.files', '--sequence.shuffle.tests', `--sequence.seed=${seed}`])
    if (!report) return false
    const results = []
    for (const file of report.testResults ?? []) {
      const name = relative(ROOT, file.name)
      if (file.status === 'failed' && !(file.assertionResults ?? []).length) results.push({ name: `${name} (file failed to load)`, status: 'failed' })
      for (const assertion of file.assertionResults ?? []) results.push({ name: `${name} › ${assertion.fullName}`, status: assertion.status })
    }
    runs.push(results)
  }
  const { flaky, alwaysFailing, total } = classifyRuns(runs)
  for (const { name, failed, runs: n } of flaky) console.log(`flaky: ${name} (failed in ${failed} of ${n} runs)`)
  for (const { name, runs: n } of alwaysFailing) console.log(`fails every run: ${name} (${n} of ${n} runs)`)
  console.log(`${app}: ${total} tests x ${count} runs, ${flaky.length} flaky, ${alwaysFailing.length} failing every run`)
  return !flaky.length && !alwaysFailing.length
}

export const HIDDEN_SUFFIX = '.without-change'

// The manifest the agent started from; throws a message for the usage error.
export function readPrManifest(root) {
  const manifest = readJson(root, '.unit-test-agent/manifest.json')
  if (!manifest) throw new Error('--without-change needs .unit-test-agent/manifest.json, which is missing or unreadable.')
  if (manifest.mode !== 'pr' || !manifest.base || !manifest.head) throw new Error('--without-change only works in PR mode (the manifest needs mode "pr", base and head).')
  return manifest
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr).trim()}`)
  return result.stdout
}

export function mergeBase(root, manifest) {
  return String(git(root, ['merge-base', manifest.base, manifest.head])).trim()
}

// Puts the tree into its pre-change state. Every path's original bytes are recorded before it is
// touched, so restorePlan can undo a half-applied plan.
export function applyPlan(root, plan, baseRev, touched) {
  for (const { path, action } of plan) {
    const full = join(root, path)
    touched.push({ path, action, bytes: readFileSync(full) })
    if (action === 'restore') writeFileSync(full, git(root, ['show', `${baseRev}:${path}`]))
    else renameSync(full, full + HIDDEN_SUFFIX)
  }
}

// Writes back every touched path, then verifies it. Returns the paths that could not be restored.
export function restorePlan(root, touched) {
  const failed = []
  for (const { path, bytes } of touched) {
    const full = join(root, path)
    try {
      if (existsSync(full + HIDDEN_SUFFIX)) renameSync(full + HIDDEN_SUFFIX, full)
      else if (!existsSync(full) || !readFileSync(full).equals(bytes)) writeFileSync(full, bytes)
      if (existsSync(full + HIDDEN_SUFFIX) || !readFileSync(full).equals(bytes)) failed.push(path)
    } catch {
      failed.push(path)
    }
  }
  return failed
}

function runWithoutChange(app, testFiles) {
  const manifest = readPrManifest(ROOT)
  const touched = []
  let restored = false
  const restore = () => {
    if (restored) return []
    restored = true
    return restorePlan(ROOT, touched)
  }
  const onSignal = (signal) => {
    const failed = restore()
    for (const path of failed) console.log(`restore failed: ${path}`)
    process.exit(failed.length ? 2 : 128 + (signal === 'SIGINT' ? 2 : 15))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  let report
  try {
    applyPlan(ROOT, withoutChangePlan(manifest, app), mergeBase(ROOT, manifest), touched)
    report = execVitest(app, testFiles, []).report
  } finally {
    const failed = restore()
    for (const path of failed) console.log(`restore failed: ${path}`)
    if (failed.length) process.exitCode = 2
  }
  if (process.exitCode === 2 || !report) return
  let failing = 0
  let total = 0
  for (const file of report.testResults ?? []) {
    const name = relative(ROOT, file.name)
    if (file.status === 'failed' && !(file.assertionResults ?? []).length) {
      total++
      failing++
      console.log(`fails without the change: ${name} (file failed to load; its tests count as failing)`)
    }
    for (const assertion of file.assertionResults ?? []) {
      total++
      const fails = assertion.status === 'failed'
      if (fails) failing++
      console.log(`${fails ? 'fails' : 'passes'} without the change: ${name} › ${assertion.fullName}`)
    }
  }
  console.log(`${app}: ${failing} of ${total} tests fail without the change, ${total - failing} pass`)
  if (failing < total) console.log('Tests that pass without the change do not detect it; strengthen their assertions on the changed behaviour.')
}

function runTypecheck(app) {
  const result = spawnSync(join(ROOT, app, 'node_modules/.bin/tsc'), ['--noEmit'], { cwd: join(ROOT, app), encoding: 'utf8', timeout: 300_000 })
  const output = `${result.stdout}${result.stderr}`.trim()
  console.log(`${app} typecheck: ${result.status === 0 ? 'pass' : 'fail'}`)
  if (result.status !== 0) console.log(output.split('\n').slice(0, 40).join('\n'))
  return result.status === 0
}

// The fields the gate reads must be where the schema puts them, or it finds no justification or exception.
function checkAgentOutput() {
  let output
  try {
    output = JSON.parse(readFileSync(join(ROOT, OUTPUT), 'utf8'))
  } catch (error) {
    console.log(`${OUTPUT} cannot be read as JSON: ${error.message}`)
    return false
  }
  const errors = checkOutput(output, JSON.parse(readFileSync(SCHEMA, 'utf8')))
  for (const error of errors) console.log(error)
  if (!errors.length) console.log(`${OUTPUT} matches the schema`)
  return !errors.length
}

function main() {
  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: { help: { type: 'boolean' }, typecheck: { type: 'boolean' }, coverage: { type: 'string', multiple: true }, 'without-change': { type: 'boolean' }, repeat: { type: 'string' }, 'check-output': { type: 'boolean' } },
    })
  } catch (error) {
    usageError(error.message)
  }
  const { values, positionals } = parsed
  if (values.help) {
    console.log(USAGE)
    return
  }
  if (values['check-output']) {
    if (positionals.length || Object.keys(values).length > 1) usageError('--check-output takes no other arguments.')
    process.exitCode = checkAgentOutput() ? 0 : 1
    return
  }
  const [app, ...testFiles] = positionals
  const coverageFiles = values.coverage ?? []
  if (values.repeat !== undefined) {
    if (!/^\d+$/.test(values.repeat) || Number(values.repeat) < 2 || Number(values.repeat) > 10) usageError('--repeat expects an integer from 2 to 10.')
    if (!testFiles.length) usageError('--repeat needs explicit test files after --.')
    if (values.typecheck || coverageFiles.length || values['without-change']) usageError('--repeat cannot be combined with --typecheck, --coverage or --without-change.')
    validate(app, testFiles, coverageFiles)
    process.exitCode = runRepeated(app, testFiles, Number(values.repeat)) ? 0 : 1
    return
  }
  if (values['without-change']) {
    if (!testFiles.length) usageError('--without-change needs explicit test files after --.')
    if (values.typecheck || coverageFiles.length) usageError('--without-change cannot be combined with --typecheck or --coverage.')
    validate(app, testFiles, coverageFiles)
    try {
      readPrManifest(ROOT)
    } catch (error) {
      usageError(error.message)
    }
    runWithoutChange(app, testFiles)
    return
  }
  validate(app, testFiles, coverageFiles)
  console.log(`env-check: model-credentials-visible=${credentialsVisible(process.env)}`)
  let ok = true
  if (testFiles.length) {
    const { failures, notes } = policyFindings(ROOT, testFiles)
    for (const line of [...failures, ...notes]) console.log(line)
    if (failures.length) ok = false
  }
  if (app === 'frontend') formatFrontendTests(ROOT, testFiles)
  if (values.typecheck) ok = runTypecheck(app) && ok
  if (!values.typecheck || testFiles.length || coverageFiles.length) ok = runVitest(app, testFiles, coverageFiles) && ok
  process.exitCode = ok ? 0 : 1
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
