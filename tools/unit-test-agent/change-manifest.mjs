// Computes the facts the unit-test agent starts from (contract: plans/000 §6):
// what changed, which changed lines are uncovered, existing tests, importers,
// where the old values of changed literals still live, failing tests, and the gate.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, appendFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { injectionSignals } from './lib/injection.mjs'
import { classify, CONTRACT_FILES } from './lib/paths.mjs'
import { assertRef, git, parseFileDiffs, parseNameStatus } from './lib/diff.mjs'
import { buildImportGraph, importLineOf, importersOf, testsImporting } from './lib/imports.mjs'
import { countLines, intersect, statementLines, summarize, toRanges, uncoveredBranchLines, uncoveredFunctions, uncoveredLines } from './lib/coverage.mjs'
import { parseVitestJson } from './lib/vitest-json.mjs'

const APPS = ['backend', 'frontend']
const DIFF_FILE = '.unit-test-agent/pr.diff'
const MAX_DIFF_BYTES = 200 * 1024
const MAX_HITS = 20
const NOISY_LITERAL_FILES = 15
const GREP_EXCLUDES = [':!.github/**', ':!*package-lock.json', ':!*.test.*', ':!backend/tests/**', ':!backend/src/generated/**', ':!*.md']

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

function coverageEntryKeys(repoRoot, path) {
  return [join(repoRoot, path), join(realpathSync(repoRoot), path)]
}

function uncoveredFor(coverage, repoRoot, path) {
  const key = coverageEntryKeys(repoRoot, path).find((candidate) => coverage[candidate])
  return key ? uncoveredLines(coverage, key) : []
}

function coveredKey(coverage, repoRoot, path) {
  return coverageEntryKeys(repoRoot, path).find((candidate) => coverage[candidate])
}

function statementsFor(coverage, repoRoot, path) {
  const key = coverageEntryKeys(repoRoot, path).find((candidate) => coverage[candidate])
  return key ? statementLines(coverage, key) : []
}

function existingTests(repoRoot, graph, path) {
  const name = basename(path).replace(/\.tsx?$/, '')
  const conventional = path.startsWith('backend/')
    ? [`backend/tests/${name}.test.ts`]
    : [join(dirname(path), `${name}.test.tsx`), join(dirname(path), `${name}.test.ts`)]
  const tests = new Set([...conventional.filter((test) => existsSync(join(repoRoot, test))), ...testsImporting(graph, path)])
  return [...tests].sort()
}

function literalsIn(lines) {
  const literals = new Set()
  for (const { text } of lines) {
    for (const [number] of text.matchAll(/\b\d{2,}\b/g)) literals.add(number)
    for (const [, , string] of text.matchAll(/(['"`])([^'"`\n]{4,60})\1/g)) literals.add(string)
  }
  return literals
}

function grepLiteral(repoRoot, literal) {
  try {
    return git(['grep', '-n', '-w', '-F', '-e', literal, '--', '.', ...GREP_EXCLUDES], repoRoot)
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(':').slice(0, 2).join(':'))
  } catch (error) {
    if (error.status === 1) return [] // git grep: no match
    throw error
  }
}

// Where do the values a PR changed still appear? Old (removed) values first: after
// 120 → 200 the stale copies elsewhere still say 120.
function findLiteralHits(repoRoot, diffs, files) {
  const results = []
  for (const file of files.filter((entry) => entry.testable || entry.kind === 'contract')) {
    const diff = diffs.get(file.path)
    if (!diff) continue
    const removed = literalsIn(diff.removed)
    const added = literalsIn(diff.added)
    for (const [side, lines, own, other] of [['removed', diff.removed, removed, added], ['added', diff.added, added, removed]]) {
      for (const literal of own) {
        if (other.has(literal)) continue
        const hits = grepLiteral(repoRoot, literal).filter((hit) => {
          const [path, line] = hit.split(':')
          return !(path === file.path && file.changedLines.some(([start, end]) => Number(line) >= start && Number(line) <= end))
        })
        if (!hits.length || new Set(hits.map((hit) => hit.split(':')[0])).size > NOISY_LITERAL_FILES) continue
        const source = lines.find(({ text }) => literalsIn([{ text }]).has(literal))
        results.push({ literal, side, from: `${file.path}:${source.line}`, hits: hits.slice(0, MAX_HITS) })
      }
    }
  }
  return results.sort((a, b) => (a.side === b.side ? 0 : a.side === 'removed' ? -1 : 1))
}

function failingTests(repoRoot, requireResults) {
  const failures = []
  for (const app of APPS) {
    const path = join(repoRoot, `.unit-test-agent/results-${app}.json`)
    const report = readJson(path)
    if (!report) {
      if (requireResults) throw new Error(`Missing test results: ${path}`)
      continue
    }
    for (const failure of parseVitestJson(report, repoRoot).failures) failures.push({ app, ...failure })
  }
  return failures
}

function coverageData(repoRoot) {
  return Object.fromEntries(APPS.map((app) => [app, readJson(join(repoRoot, `${app}/coverage/coverage-final.json`))]))
}

function coverageBefore(repoRoot) {
  return Object.fromEntries(APPS.map((app) => {
    const summary = readJson(join(repoRoot, `${app}/coverage/coverage-summary.json`))
    return [app, summary ? summarize(summary) : null]
  }))
}

function describeFile(repoRoot, graph, coverage, { path, status, changedLines }) {
  const { app, kind, testable } = classify(path)
  const appCoverage = coverage[app]
  const measurable = testable && status !== 'D'
  const uncoveredChangedLines = measurable && appCoverage ? intersect(changedLines, uncoveredFor(appCoverage, repoRoot, path)) : measurable ? null : []
  const coverableChangedLines = measurable && appCoverage ? intersect(changedLines, statementsFor(appCoverage, repoRoot, path)) : measurable ? null : []
  const isSource = (kind === 'source' || kind === 'excluded-source') && status !== 'D'
  const { direct, transitive } = isSource ? importersOf(graph, path) : { direct: [], transitive: [] }
  return {
    path, status, app, kind, testable, changedLines, uncoveredChangedLines, coverableChangedLines,
    existingTests: isSource ? existingTests(repoRoot, graph, path) : [],
    importers: direct,
    importLines: Object.fromEntries(direct.map((importer) => [importer, importLineOf(repoRoot, importer, path, graph)])),
    transitiveImporters: transitive,
  }
}

function prGate({ skipLabel, headIsAgentCommit, files, failing, contractFilesChanged }) {
  if (skipLabel) return { runAgent: false, reason: 'label unit-test-agent:skip' }
  if (headIsAgentCommit) return { runAgent: false, reason: 'agent commit at HEAD' }
  const testable = files.filter((file) => file.testable && file.status !== 'D')
  if (testable.length || failing.length) {
    const uncovered = testable.some((file) => file.uncoveredChangedLines === null)
      ? 'unknown'
      : testable.reduce((sum, file) => sum + countLines(file.uncoveredChangedLines), 0)
    return { runAgent: true, reason: `${testable.length} testable files changed, ${uncovered} uncovered changed lines, ${failing.length} failing tests` }
  }
  if (contractFilesChanged.length) return { runAgent: true, reason: 'contract files changed (impact analysis only)' }
  return { runAgent: false, reason: 'no testable source or contract changes (docs/config/tests only)' }
}

function buildPrManifest({ repoRoot, base, head, skipLabel = false, requireResults = false }) {
  assertRef(base)
  assertRef(head)
  const diffs = parseFileDiffs(git(['diff', '-U0', '--no-color', `${base}...${head}`], repoRoot))
  const graph = buildImportGraph(repoRoot)
  const coverage = coverageData(repoRoot)
  const files = parseNameStatus(git(['diff', '--name-status', '-M', '--no-color', `${base}...${head}`], repoRoot))
    .map(({ path, status }) => describeFile(repoRoot, graph, coverage, { path, status, changedLines: diffs.get(path)?.ranges ?? [] }))
  const headIsAgentCommit = /^Unit-Test-Agent-Run:/m.test(git(['log', '-1', '--format=%B', head], repoRoot))
  const failing = failingTests(repoRoot, requireResults)
  const contractFilesChanged = files.map((file) => file.path).filter((path) => CONTRACT_FILES.includes(path))
  return {
    version: 1, mode: 'pr', base, head, headIsAgentCommit,
    gate: prGate({ skipLabel, headIsAgentCommit, files, failing, contractFilesChanged }),
    diffFile: DIFF_FILE,
    files,
    literalHits: findLiteralHits(repoRoot, diffs, files),
    injectionSignals: injectionSignals(diffs),
    contractFilesChanged,
    skipLabel,
    failingTests: failing,
    coverageBefore: coverageBefore(repoRoot),
  }
}

function uncoveredTotal(file) {
  return countLines(file.uncoveredChangedLines) + countLines(file.uncoveredBranchLines) + file.uncoveredFunctions.length
}

function buildCoverageManifest({ repoRoot, apps = APPS, maxFiles = 8 }) {
  const graph = buildImportGraph(repoRoot)
  const coverage = coverageData(repoRoot)
  const candidates = []
  for (const app of apps) {
    if (!coverage[app]) throw new Error(`Missing coverage: ${app}/coverage/coverage-final.json`)
    for (const path of git(['ls-files', '--', `${app}/src`], repoRoot).split('\n').filter(Boolean)) {
      if (!classify(path).testable) continue
      const uncovered = uncoveredFor(coverage[app], repoRoot, path)
      const key = coveredKey(coverage[app], repoRoot, path)
      const branchLines = key ? uncoveredBranchLines(coverage[app], key) : []
      const functions = key ? uncoveredFunctions(coverage[app], key) : []
      if (!uncovered.length && !branchLines.length && !functions.length) continue
      const lineCount = readFileSync(join(repoRoot, path), 'utf8').split('\n').length
      candidates.push({
        ...describeFile(repoRoot, graph, coverage, { path, status: null, changedLines: [[1, lineCount]] }),
        uncoveredChangedLines: toRanges(uncovered),
        uncoveredBranchLines: toRanges(branchLines),
        uncoveredFunctions: functions,
        coverableChangedLines: toRanges(statementsFor(coverage[app], repoRoot, path)),
      })
    }
  }
  const files = candidates
    .sort((a, b) => uncoveredTotal(b) - uncoveredTotal(a))
    .slice(0, maxFiles)
  return {
    version: 1, mode: 'coverage', base: null, head: null, headIsAgentCommit: false,
    gate: files.length
      ? { runAgent: true, reason: `${files.length} files with uncovered code` }
      : { runAgent: false, reason: 'no uncovered testable files' },
    diffFile: null,
    files,
    literalHits: [],
    contractFilesChanged: [],
    skipLabel: false,
    failingTests: [],
    coverageBefore: coverageBefore(repoRoot),
  }
}

export function buildManifest(options) {
  return options.mode === 'coverage' ? buildCoverageManifest(options) : buildPrManifest(options)
}

function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string', default: 'pr' },
      base: { type: 'string' },
      head: { type: 'string' },
      apps: { type: 'string', default: 'backend,frontend' },
      'max-files': { type: 'string', default: '8' },
      'skip-label': { type: 'string', default: 'false' },
      'require-results': { type: 'boolean', default: false },
      'baseline-into': { type: 'boolean', default: false },
      out: { type: 'string', default: '.unit-test-agent/manifest.json' },
    },
  })
  const repoRoot = process.cwd()
  if (values['baseline-into']) {
    // Gate, coverage sweep: keep the trusted manifest at --out and only add what the baseline run measured.
    const outPath = resolve(repoRoot, values.out)
    const manifest = JSON.parse(readFileSync(outPath, 'utf8'))
    manifest.failingTests = failingTests(repoRoot, true)
    manifest.coverageBefore = coverageBefore(repoRoot)
    writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`)
    return
  }
  const apps = values.apps === 'both' ? APPS : values.apps.split(',').filter((app) => APPS.includes(app))
  const manifest = buildManifest({
    repoRoot,
    mode: values.mode === 'coverage' ? 'coverage' : 'pr',
    base: values.base,
    head: values.head,
    apps,
    maxFiles: Number(values['max-files']) || 8,
    skipLabel: values['skip-label'] === 'true',
    requireResults: values['require-results'],
  })
  const outPath = resolve(repoRoot, values.out)
  mkdirSync(dirname(outPath), { recursive: true })
  if (manifest.diffFile) {
    const diff = git(['diff', '--no-color', `${manifest.base}...${manifest.head}`, '--', 'backend', 'frontend'], repoRoot)
    const capped = Buffer.byteLength(diff) > MAX_DIFF_BYTES
      ? `${Buffer.from(diff).subarray(0, MAX_DIFF_BYTES).toString('utf8')}\n# TRUNCATED\n`
      : diff
    mkdirSync(dirname(join(repoRoot, manifest.diffFile)), { recursive: true })
    writeFileSync(join(repoRoot, manifest.diffFile), capped)
  }
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run_agent=${manifest.gate.runAgent}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Unit test agent — analysis\n\nGate: **${manifest.gate.runAgent ? 'run agent' : 'skip'}** — ${manifest.gate.reason}\n`)
  }
  console.log(`gate: ${manifest.gate.runAgent ? 'run agent' : 'skip'} — ${manifest.gate.reason}`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
