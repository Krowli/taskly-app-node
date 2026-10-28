// Renders report.json (plans/000 §8) as the sticky PR comment / job summary.
// Everything the agent wrote is untrusted text: it is cleaned before rendering and
// shown apart from the facts the workflow measured itself.
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

export const MARKER = '<!-- unit-test-agent -->'
const MAX_BODY = 60_000
const HEADLINES = {
  ready: '✅ Tests verified',
  pushed: '✅ Tests added to this PR',
  'no-changes': 'ℹ️ No test changes needed',
  skipped: '⏭️ Skipped',
  rejected: '⛔ Agent output rejected',
  failed: '❌ Verification failed',
  superseded: '⏭️ Superseded by a newer push',
  blocked: '🛡️ Blocked by the threat scan — nothing was published',
}

// The detection result's boolean flags; anything else in it (including the model's free-text reasons) is never shown.
export const THREAT_FLAGS = {
  prompt_injection: 'possible prompt injection',
  secret_leak: 'possible secret leak',
  malicious_patch: 'possibly malicious patch',
}

// The known flags set to true in detection_result.json text; unreadable or unexpected content gives none.
export function threatFlagsFrom(text) {
  try {
    const result = JSON.parse(text)
    return Object.keys(THREAT_FLAGS).filter((flag) => result?.[flag] === true)
  } catch {
    return []
  }
}

export function clean(text, max = 300) {
  return String(text ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/!\[/g, '[')
    .replace(/@/g, '@​')
    .replace(/#(\d)/g, '#​$1')
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .slice(0, max)
}

function snippet(code) {
  const lines = String(code ?? '').split('\n').slice(0, 40).join('\n')
  // A run of 4+ backticks would close the fence early.
  return lines.replace(/`{4,}/g, (run) => run.split('').join('​'))
}

const ok = (pass) => (pass ? '✅' : '❌')
const pct = (value) => (value == null ? 'n/a' : `${value}%`)

// firstReport: a two-pass comment's first pass; this report is then the second pass.
function measured(report, firstReport) {
  const v = report.verification ?? {}
  const rows = []
  const signals = Array.isArray(report.injectionSignals) ? report.injectionSignals : []
  rows.push(['Injection signals', signals.length
    ? `⚠️ ${signals.length}: ${signals.slice(0, 5).map((s) => `${clean(s.path, 120)}:${Number(s.line) || '?'} ${clean(s.kind, 30)}`).join('; ')}`
    : 'none'])
  if (v.patch) {
    rows.push([firstReport ? 'Patch (second pass)' : 'Patch', `${v.patch.files.length} test files, +${v.patch.addedLines} lines ${v.patch.valid ? '✅ only allowed paths and patterns' : `❌ ${v.patch.violations.slice(0, 5).map((x) => clean(x, 200)).join('; ')}`}`])
  }
  if (v.assertionAudit) {
    const audit = v.assertionAudit
    rows.push(['Changed existing tests', audit.changedExisting ? `${audit.justified}/${audit.changedExisting} files justified by a changed source line ${ok(!audit.unjustified.length)}` : 'none'])
  }
  const schemaErrors = Array.isArray(report.agent?.schemaErrors) ? report.agent.schemaErrors : []
  if (schemaErrors.length) {
    const more = schemaErrors.length > 3 ? `; and ${schemaErrors.length - 3} more` : ''
    rows.push(['Agent output', `❌ does not match the schema: ${schemaErrors.slice(0, 3).map((e) => clean(e, 200)).join('; ')}${more}`])
  }
  if (v.typecheck) rows.push(['Typecheck', Object.entries(v.typecheck).map(([app, state]) => `${app} ${ok(state === 'pass')}`).join(', ')])
  if (v.tests) rows.push(['Tests', Object.entries(v.tests).map(([app, t]) => `${app} ${t.passed}/${t.total} ${ok(!t.failed)}`).join(', ')])
  if (v.requireAssertions) rows.push(['Every test has an assertion', ok(v.requireAssertions === 'pass')])
  if (v.stability) {
    rows.push(['Stability', `${v.stability.runs} runs${v.stability.shuffled ? ' incl. shuffled order' : ''}, ${v.stability.flaky.length} flaky ${ok(!v.stability.flaky.length)}${v.stability.flaky.length ? `: ${v.stability.flaky.slice(0, 5).map((x) => clean(x, 150)).join('; ')}` : ''}`])
  }
  const failsWithoutChange = v.failsWithoutChange
  if (failsWithoutChange?.required) {
    const counted = `${Number(failsWithoutChange.failing) || 0} of ${Number(failsWithoutChange.total) || 0} tests in the agent's test files fail on the PR's base source`
    const missing = (Array.isArray(failsWithoutChange.unexcepted) ? failsWithoutChange.unexcepted : []).slice(0, 5).map((file) => `\`${clean(file, 120)}\``).join(', ')
    rows.push(['Fails without the change', !failsWithoutChange.met ? `required ❌: ${counted}; no exception for ${missing}`
      : Number(failsWithoutChange.failing) > 0 ? `${counted} ✅` : `${counted}; accepted: every modified source file has an exception ⚠️`])
  }
  const exceptions = Array.isArray(failsWithoutChange?.exceptions) ? failsWithoutChange.exceptions : []
  if (exceptions.length) {
    rows.push(['Exceptions (agent-declared)', exceptions.slice(0, 10).map((e) => `\`${clean(e.file, 120)}\` — ${clean(e.reason, 30)} — ${clean(e.detail, 200)}`).join('; ')])
  }
  if (v.coverage?.before && v.coverage?.after) {
    for (const app of Object.keys(v.coverage.after)) {
      const [before, after] = [v.coverage.before[app], v.coverage.after[app]]
      if (!before || !after) continue
      rows.push([`Coverage ${app}`, ['lines', 'branches', 'functions', 'statements'].map((metric) => `${metric} ${pct(before[metric])} → ${pct(after[metric])}`).join(' · ')])
    }
  }
  const changed = v.coverage?.changedLines
  if (changed?.before && changed?.after) rows.push(['Changed lines covered', `${changed.before.covered}/${changed.before.total} → ${changed.after.covered}/${changed.after.total}`])
  const a = report.agent
  if (a) {
    // The report may come from a forged artifact: numbers are coerced and dropped unless finite, text is cleaned.
    const num = (value) => (value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value))
    const credits = num(a.aiCredits)
    const turns = num(a.numTurns)
    const cost = num(a.costUsd)
    const duration = num(a.durationMs)
    const denials = num(a.permissionDenials)
    const testRuns = num(a.testRuns?.total)
    // Two passes: each report's own credits and their sum; without the first pass's, the row is the second pass's alone.
    const firstCredits = firstReport ? num(firstReport.agent?.aiCredits) : null
    const both = credits != null && firstCredits != null
    const total = both ? firstCredits + credits : credits
    const spend = [
      credits != null && `${both ? `${firstCredits.toFixed(1)} + ${credits.toFixed(1)} = ` : ''}${total.toFixed(1)} AI credits (≈ $${(total / 100).toFixed(2)})${both ? ', first + second pass' : ''}${a.model ? `, ${clean(a.model, 60)}` : ''}`,
      turns != null && `${turns} turns`,
      cost != null && `$${cost.toFixed(2)}`,
      duration != null && `${Math.round(duration / 1000)}s`,
    ].filter(Boolean)
    if (spend.length) rows.push([firstReport && !both ? 'Cost (second pass)' : 'Cost', spend.join(', ')])
    if (v.patch?.files?.length) {
      rows.push(['Self-review', Array.isArray(a.skillsUsed) && a.skillsUsed.includes('reviewing-test-quality')
        ? '✅ reviewing-test-quality loaded'
        : '⚠️ not loaded: the agent did not run its test review'])
    }
    rows.push(['Skills used', Array.isArray(a.skillsUsed) && a.skillsUsed.length ? a.skillsUsed.slice(0, 20).map((skill) => clean(skill, 60)).join(', ') : 'none'])
    const ownRuns = [
      testRuns != null && `ran its tests ${testRuns} times${testRuns ? `, last run ${a.testRuns.lastPassed === true ? 'passed' : 'failed'}` : ''}`,
      denials != null && `${denials} permission denials`,
      a.resultSubtype && clean(a.resultSubtype, 30),
    ].filter(Boolean)
    if (ownRuns.length) rows.push(["Agent's own test runs", ownRuns.join('; ')])
  }
  if (!rows.length) return ''
  return ['#### Measured by the workflow', '', '| Check | Result |', '|---|---|', ...rows.map(([k, val]) => `| ${k} | ${val} |`), ''].join('\n')
}

function reported(agent, noopReason) {
  const out = ['#### Agent-reported (not verified)', '']
  if (noopReason) out.push(`**No-op reason:** ${clean(noopReason, 500)}`, '')
  if (agent?.decisions?.length) {
    out.push('**Decisions**', '', '| File | Action | Tests | Reason |', '|---|---|---|---|')
    for (const d of agent.decisions) out.push(`| \`${clean(d.file, 120)}\` | ${clean(d.action, 20)} | ${(d.testFiles ?? []).map((f) => `\`${clean(f, 120)}\``).join('<br>') || '—'} | ${clean(d.reason)} |`)
    out.push('')
  }
  if (agent?.impact?.length) {
    out.push('**Impact outside the diff**', '')
    for (const i of agent.impact) out.push(`- \`${clean(i.changedFile, 120)}\` → \`${clean(i.relatedFile, 120)}${i.relatedLines ? `:${clean(i.relatedLines, 20)}` : ''}\` (${clean(i.kind, 30)}, ${clean(i.action, 20)}): ${clean(i.risk)}`)
    out.push('')
  }
  if (agent?.suspectedBugs?.length) {
    out.push('**Is this intended?**', '')
    for (const bug of agent.suspectedBugs.slice(0, 3)) {
      out.push(`- ${clean(bug.question)} (\`${clean(bug.file, 120)}:${Number(bug.line) || '?'}\`) — ${clean(bug.evidence)}`)
      if (bug.snippet) out.push('', '  <details><summary>Runnable test</summary>', '', '````ts', snippet(bug.snippet), '````', '', '  </details>')
    }
    out.push('')
  }
  if (agent?.discardedTests?.length) {
    out.push('**Discarded tests**', '')
    for (const t of agent.discardedTests) out.push(`- \`${clean(t.testFile, 120)}\`: ${clean(t.reason)}`)
    out.push('')
  }
  return out.length > 2 ? out.join('\n') : ''
}

// The judge says "ready"; what reaches the PR depends on what publish did.
// The artifact is not trusted for the outcome: "pushed" and "superseded" only come from the facts passed in here.
export function applyPublishOutcome(report, { result, superseded, commitSha, status, threatFlags } = {}) {
  const { commitSha: _forged, ...rest } = report
  report = rest
  if (report.verdict === 'pushed' || report.verdict === 'superseded') return { ...report, verdict: 'failed', reason: 'invalid verdict in report' }
  if (report.verdict !== 'ready') return report
  const flags = Object.keys(THREAT_FLAGS).filter((flag) => (threatFlags ?? []).includes(flag))
  if (flags.length) return { ...report, verdict: 'blocked', reason: `The AI threat scan flagged: ${flags.map((flag) => THREAT_FLAGS[flag]).join(', ')}.` }
  if (status === 'unknown') return { ...report, verdict: 'failed', reason: 'Verified; publishing status unknown (could not read the PR head). Check the PR\'s commits.' }
  if (superseded === 'true') return { ...report, verdict: 'superseded', reason: 'The PR changed while the agent worked; the newer run reports.' }
  if (result === 'success' && commitSha) return { ...report, verdict: 'pushed', commitSha }
  return { ...report, verdict: 'failed', reason: `Verified, but publishing failed (${result || 'not run'}).` }
}

// A run without a patch has no gate report. When the model ran, the comment is built from the analysis manifest
// (uploaded before the model started: the facts) and the agent's no-op message (its claim). Null means post nothing:
// the analysis ended the run before any model call, a push means the gate reports, or an input is missing or malformed.
export function noPatchReport(manifest, agentOutput) {
  if (manifest?.gate?.runAgent !== true || !Array.isArray(manifest.injectionSignals) || !Array.isArray(agentOutput?.items)) return null
  if (agentOutput.items.some((item) => item?.type === 'push_to_pull_request_branch')) return null
  const noop = agentOutput.items.find((item) => item?.type === 'noop')
  if (typeof noop?.message !== 'string' || !noop.message.trim()) return null
  return { verdict: 'no-changes', reason: 'The agent ran and pushed no tests.', injectionSignals: manifest.injectionSignals, noopReason: noop.message }
}

// Coverage left after the agent: "<app> <metric> <pct>%" for every line, branch or function metric below 100.
// Unmeasured or non-numeric values are no gap; app names that are not plain words are dropped (the list goes into a step output).
export function coverageGaps(report) {
  const after = report?.verification?.coverage?.after ?? {}
  return Object.entries(after)
    .filter(([app, metrics]) => /^[\w-]+$/.test(app) && metrics)
    .flatMap(([app, metrics]) => ['lines', 'branches', 'functions']
      .filter((metric) => typeof metrics[metric] === 'number' && metrics[metric] < 100)
      .map((metric) => `${app} ${metric} ${metrics[metric]}%`))
}

// A second pass on the same PR is measured from the first pass's result; the reader wants it from the original code:
// coverage before comes from the first pass's report, everything else from the second. Null when either side is missing.
export function fromOriginalCode(first, second) {
  const before = first?.verification?.coverage?.before
  const coverage = second?.verification?.coverage
  if (!before || !coverage) return null
  return { ...second, verification: { ...second.verification, coverage: { ...coverage, before } } }
}

// Tests accepted only through agent-declared exceptions are published, but the headline asks a person to look.
function headline(report) {
  const text = HEADLINES[report.verdict] ?? clean(report.verdict, 30)
  const failsWithoutChange = report.verification?.failsWithoutChange
  const viaExceptions = failsWithoutChange?.required && failsWithoutChange.met && !(Number(failsWithoutChange.failing) > 0) && Array.isArray(failsWithoutChange.exceptions) && failsWithoutChange.exceptions.length > 0
  return viaExceptions && ['pushed', 'ready'].includes(report.verdict) ? `${text.replace(/^✅/, '⚠️')} — agent-declared exceptions need a human look` : text
}

export function renderComment(report, { maxLength = MAX_BODY, firstRunUrl, firstReport } = {}) {
  const parts = [MARKER, `### Unit test agent — ${headline(report)}`, '', clean(report.reason, 500), '']
  if (firstRunUrl) parts.push(`Two passes: [first run](${firstRunUrl}), [second run](${report.runUrl}). Coverage runs from the code before the first pass.`, '')
  if (!['skipped', 'superseded'].includes(report.verdict)) parts.push(measured(report, firstReport), reported(report.agent, report.noopReason))
  const footer = [`[Workflow run](${report.runUrl})`]
  if (report.verdict === 'pushed' && report.commitSha) {
    footer.push(`Tests pushed in ${report.commitSha}. CI runs on it automatically.`)
  }
  parts.push('---', footer.join(' · '))
  const body = parts.filter((part) => part !== '').join('\n')
  if (body.length <= maxLength) return body
  const note = '\n\n_(comment truncated; full report in the workflow artifacts)_'
  return body.slice(0, maxLength - note.length) + note
}

// Usage: node render-comment.mjs <report.json> [--run-url u --publish-status unknown --publish-result r --superseded true|false --commit-sha s --threat-flags prompt_injection,secret_leak]
//   [--first-report first-pass/report.json --first-run-url u] [--out comment.md]
// A run without a patch: node render-comment.mjs --manifest manifest.json --agent-output agent_output.json --run-url u [--out comment.md];
//   exits 1 and writes nothing when there is no comment to post (see noPatchReport).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'publish-result': { type: 'string' }, 'run-url': { type: 'string' }, 'publish-status': { type: 'string' }, superseded: { type: 'string' }, 'commit-sha': { type: 'string' }, 'threat-flags': { type: 'string' }, 'first-report': { type: 'string' }, 'first-run-url': { type: 'string' }, manifest: { type: 'string' }, 'agent-output': { type: 'string' }, out: { type: 'string' } },
  })
  const readOrNull = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
  let report = values.manifest
    ? noPatchReport(readOrNull(values.manifest), readOrNull(values['agent-output'] ?? ''))
    : applyPublishOutcome(JSON.parse(readFileSync(positionals[0], 'utf8')), {
      result: values['publish-result'], superseded: values.superseded, commitSha: values['commit-sha'], status: values['publish-status'], threatFlags: (values['threat-flags'] ?? '').split(','),
    })
  if (!report) {
    console.error('No comment: the model never started, the agent pushed a patch, or the analysis or the agent output is missing or malformed.')
    process.exit(1)
  }
  // The link comes from the workflow event, not from the artifact.
  if (values['run-url']) report.runUrl = values['run-url']
  const first = values['first-report'] ? JSON.parse(readFileSync(values['first-report'], 'utf8')) : null
  const merged = first ? fromOriginalCode(first, report) : null
  if (values['first-report'] && !merged) console.error('The first pass\'s report has no coverage before; the comment shows this pass alone.')
  if (merged) report = merged
  const body = `${renderComment(report, merged ? { firstRunUrl: values['first-run-url'], firstReport: first } : {})}\n`
  if (values.out) writeFileSync(values.out, body)
  else process.stdout.write(body)
}
