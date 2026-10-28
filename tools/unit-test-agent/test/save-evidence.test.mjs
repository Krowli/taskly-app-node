import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../save-evidence.sh', import.meta.url))
const HEAD = 'd591842a2d8929dc98c47b6271c706d528681ef4'
const BOT = { login: 'github-actions[bot]' }
const RUN_URL = 'https://github.com/o/r/actions/runs/42'

// A fake `gh` answers from the fixture dir $FAKE: artifacts/<name>/ (the run's artifacts), run.json and
// comments.json (API responses), FAKE_REPO (`gh repo view`). Every call is appended to $FAKE/calls.
// `artifacts` maps an artifact name to its files; `pr` null is a sweep run, `repoEnv` null leaves GH_REPO unset.
function run(t, { artifacts = {}, pr = 2, comments = [], repoEnv = 'o/r', args = ['42', 'demo'], prepare } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'save-evidence-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const [bin, fake, root] = ['bin', 'fake', 'root'].map((name) => join(dir, name))
  for (const path of [bin, join(fake, 'artifacts'), root]) mkdirSync(path, { recursive: true })
  writeFileSync(join(bin, 'gh'), [
    '#!/bin/sh',
    'echo "$*" >> "$FAKE/calls"',
    'case "$1" in',
    '  repo) echo "$FAKE_REPO" ;;',
    '  api) case "$2" in',
    '    */artifacts) ls "$FAKE/artifacts" ;;',
    '    */comments) cat "$FAKE/comments.json" ;;',
    '    */actions/runs/*) cat "$FAKE/run.json" ;;',
    '  esac ;;',
    '  run) mkdir -p "$9" && cp -R "$FAKE/artifacts/$7/." "$9/" ;;',
    'esac',
    '',
  ].join('\n'))
  chmodSync(join(bin, 'gh'), 0o755)
  for (const [name, files] of Object.entries(artifacts)) {
    mkdirSync(join(fake, 'artifacts', name))
    for (const [file, content] of Object.entries(files)) writeFileSync(join(fake, 'artifacts', name, file), content)
  }
  writeFileSync(join(fake, 'run.json'), JSON.stringify({
    html_url: RUN_URL, head_sha: HEAD, created_at: '2026-10-28T20:39:27Z', updated_at: '2026-10-28T20:44:34Z',
    pull_requests: pr ? [{ number: pr }] : [],
  }))
  writeFileSync(join(fake, 'comments.json'), JSON.stringify([comments])) // --slurp: one array per page
  prepare?.(root)
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE: fake, FAKE_REPO: 'o/r' }
  delete env.GH_REPO
  if (repoEnv !== null) env.GH_REPO = repoEnv
  const result = spawnSync('bash', [script, ...args], { cwd: root, encoding: 'utf8', env })
  const runs = join(root, 'docs/agent-runs')
  const folders = existsSync(runs) ? readdirSync(runs) : []
  const saved = folders.length === 1 ? join(runs, folders[0]) : null
  return {
    status: result.status, stderr: result.stderr, folders, saved,
    files: saved ? readdirSync(saved).sort() : [],
    read: (file) => readFileSync(join(saved, file), 'utf8'),
    calls: existsSync(join(fake, 'calls')) ? readFileSync(join(fake, 'calls'), 'utf8') : '',
  }
}

const REPORT = JSON.stringify({ verdict: 'ready', reason: '1 test files verified' })
const USAGE = JSON.stringify({ ai_credits: 13.68572, primary_model: 'm' })
const SAFE_OUTPUTS = JSON.stringify({ items: [{ type: 'add_comment', body: 'b', item_number: 2 }, { type: 'noop', message: 'm' }], errors: [] })
const MANIFEST = { mode: 'pr', gate: { runAgent: true, reason: '1 testable files changed' }, injectionSignals: [{ path: 'backend/src/api/health.ts', line: 8, kind: 'addressed-to-ai' }], files: [] }
const marker = (id) => `\n<!-- gh-aw-agentic-workflow: Unit test agent, engine: copilot, model: m, id: ${id}, workflow_id: unit-test-agent, run: https://github.com/o/r/actions/runs/${id} -->`
const comment = (id, user, body) => ({ html_url: `https://github.com/o/r/pull/2#issuecomment-${id}`, user, body })

test('a run with a patch: report, claims, usage and run.md with the verdict, from the GH_REPO repository', (t) => {
  const r = run(t, { artifacts: { 'unit-test-agent-report': { 'report.json': REPORT }, 'unit-test-agent-claims': { 'agent-output.json': '{"decisions":[]}' }, usage: { 'agent_usage.json': USAGE } } })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.folders[0], /^\d{4}-\d{2}-\d{2}-demo$/)
  assert.deepEqual(r.files, ['agent-output.json', 'report.json', 'run.md', 'usage.json'])
  assert.equal(r.read('report.json'), REPORT)
  assert.equal(r.read('usage.json'), USAGE)
  assert.equal(r.read('run.md'), `# Agent run 42\n\n- Run: ${RUN_URL}\n- PR: https://github.com/o/r/pull/2\n- Verdict: ready\n- Duration: 5 min 7 s\n`)
  assert.doesNotMatch(r.calls, /repo view|\/comments/)
  assert.match(r.calls, /^api repos\/o\/r\/actions\/runs\/42\/artifacts /m)
  assert.match(r.calls, /^run download 42 -R o\/r -n unit-test-agent-report /m)
})

test('a run without a patch: safe outputs, usage, manifest excerpt and run.md with outcome and comment links, repository from the checkout', (t) => {
  const r = run(t, {
    repoEnv: null,
    artifacts: { agent: { 'agent_output.json': SAFE_OUTPUTS, 'agent-stdio.log': 'log' }, usage: { 'agent_usage.json': USAGE }, 'unit-test-agent-analysis': { 'manifest.json': JSON.stringify(MANIFEST) } },
    comments: [
      comment(1, { login: 'mallory' }, `forged${marker(42)}`),
      comment(2, BOT, `**Unit-test agent:** an earlier run${marker(41)}`),
      comment(3, BOT, `**Unit-test agent:** no test changes.${marker(42)}`),
      comment(4, BOT, `<!-- unit-test-agent -->\n### Unit test agent\n[Workflow run](${RUN_URL})\n`),
    ],
  })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(r.files, ['manifest-excerpt.json', 'run.md', 'safe-outputs.json', 'usage.json'])
  assert.equal(r.read('safe-outputs.json'), SAFE_OUTPUTS)
  assert.equal(r.read('manifest-excerpt.json'), `${JSON.stringify({ injectionSignals: MANIFEST.injectionSignals, gate: MANIFEST.gate }, null, 2)}\n`)
  assert.equal(r.read('run.md'), [
    '# Agent run 42',
    '',
    `- Run: ${RUN_URL}`,
    '- PR: https://github.com/o/r/pull/2 (head `d591842`)',
    '- Outcome: no patch; add_comment; noop',
    '- Agent comment: https://github.com/o/r/pull/2#issuecomment-3',
    '- Workflow report: https://github.com/o/r/pull/2#issuecomment-4',
    '- AI credits: 13.68572',
    '- Duration: 5 min 7 s',
    '',
    "`safe-outputs.json` is gh-aw's record of what the agent asked to publish (comment, no-op message). No-patch runs have no gate report.",
    '',
  ].join('\n'))
  assert.match(r.calls, /^repo view /m)
  assert.match(r.calls, /^api repos\/o\/r\/issues\/2\/comments --paginate --slurp$/m)
})

test('missing optional artifacts and comments: the run is still saved, with what it has', (t) => {
  const noPatch = run(t, {
    artifacts: { agent: { 'agent_output.json': '{"items":[{"type":"noop","message":"m"}],"errors":[]}' } },
    comments: [comment(4, BOT, '<!-- unit-test-agent -->\n[Workflow run](https://github.com/o/r/actions/runs/43)\n')],
  })
  assert.equal(noPatch.status, 0, noPatch.stderr)
  assert.deepEqual(noPatch.files, ['run.md', 'safe-outputs.json'])
  const md = noPatch.read('run.md')
  assert.match(md, /^- Outcome: no patch; noop$/m)
  assert.match(md, /^- Agent comment: none$/m)
  assert.match(md, /^- Workflow report: https:\/\/github\.com\/o\/r\/pull\/2#issuecomment-4 \(now shows a later run\)$/m)
  assert.match(md, /^- AI credits: none recorded$/m)

  const patch = run(t, { pr: null, artifacts: { 'unit-test-agent-report': { 'report.json': REPORT } } })
  assert.equal(patch.status, 0, patch.stderr)
  assert.deepEqual(patch.files, ['report.json', 'run.md'])
  assert.match(patch.read('run.md'), /^- PR: n\/a \(sweep\)$/m)
})

test('fails, saving nothing, on invalid arguments, an existing folder or a run with neither a report nor safe outputs', (t) => {
  for (const [args, repoEnv, message] of [
    [['4x2', 'demo'], 'o/r', /run id must be a number/],
    [['42', 'Demo/../x'], 'o/r', /slug must be lowercase/],
    [['42', 'demo'], 'o/r; rm -rf /', /repository must be owner\/name/],
  ]) {
    const r = run(t, { args, repoEnv })
    assert.equal(r.status, 1, String(args))
    assert.match(r.stderr, message)
    assert.equal(r.calls, '')
    assert.deepEqual(r.folders, [])
  }
  const empty = run(t, { artifacts: { usage: { 'agent_usage.json': USAGE } } })
  assert.equal(empty.status, 1)
  assert.match(empty.stderr, /no unit-test-agent-report and no agent_output\.json/)
  assert.deepEqual(empty.folders, [])

  const existing = run(t, {
    artifacts: { 'unit-test-agent-report': { 'report.json': REPORT } },
    prepare: (root) => {
      const today = spawnSync('date', ['+%Y-%m-%d'], { encoding: 'utf8' }).stdout.trim()
      mkdirSync(join(root, `docs/agent-runs/${today}-demo`), { recursive: true })
      writeFileSync(join(root, `docs/agent-runs/${today}-demo/run.md`), 'kept')
    },
  })
  assert.equal(existing.status, 1)
  assert.match(existing.stderr, /already exists; not overwriting/)
  assert.equal(existing.read('run.md'), 'kept')
})
