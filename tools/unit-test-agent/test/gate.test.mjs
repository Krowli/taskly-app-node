import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const gate = fileURLToPath(new URL('../gate.sh', import.meta.url))
// gate.sh calls judge.sh, which needs bash 4+; macOS ships 3.2, CI runs Linux.
const bashMajor = Number(spawnSync('bash', ['-c', 'echo ${BASH_VERSINFO[0]}'], { encoding: 'utf8' }).stdout)
const skip = bashMajor < 4 && `bash ${bashMajor} is too old for gate.sh`

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

function commitFiles(repo, files, message) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true })
    if (typeof content === 'object') symlinkSync(content.link, join(repo, path))
    else writeFileSync(join(repo, path), content)
  }
  git(repo, 'add', '-A')
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message)
  return git(repo, 'rev-parse', 'HEAD')
}

const Y = { 'backend/tests/y.test.ts': "import { test } from 'vitest'\ntest('y', () => {})\n" }

// Fake docker snippets. $w is the host directory mounted as /w, $m the one mounted as
// /in/measurements, $phase is baseline or measure, $dir the test's temp dir.
const BASELINE_RESULTS = 'if [ "$phase" = baseline ]; then mkdir -p "$w/.unit-test-agent"; for app in backend frontend; do echo \'{"testResults":[]}\' > "$w/.unit-test-agent/results-$app.json"; done; fi'

// agentFiles: file map for one agent commit on top of head, or an array of maps for several.
// bundle: 'ok' | 'foreign' | 'corrupt' | 'none' | 'two' | 'multi-ref' | 'tag'. docker: shell run by the fake docker.
function runGate({ agentFiles = Y, bundle = 'ok', headRef = 'agent', mode, docker = '', headFiles = {}, artifactFiles = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'))
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  const base = commitFiles(repo, { 'backend/src/x.ts': 'export const x = 1\n', 'backend/tests/x.test.ts': "import { test } from 'vitest'\ntest('x', () => {})\n" }, 'base')
  const head = commitFiles(repo, { 'backend/src/x.ts': 'export const x = 2\n', ...headFiles }, 'head')
  const artifacts = join(dir, 'artifacts')
  mkdirSync(artifacts)
  const bundlePath = join(artifacts, 'aw-test-repo-branch.bundle')
  if (bundle === 'none') {
    // gh-aw also leaves a .patch next to the bundle; the gate must not fall back to it.
    writeFileSync(join(artifacts, 'aw-test-repo-branch.patch'), 'diff --git a/backend/tests/y.test.ts b/backend/tests/y.test.ts\n')
  } else {
    if (bundle === 'foreign') {
      git(repo, 'checkout', '-q', '--orphan', 'agent')
      git(repo, 'rm', '-rfq', '.')
    } else {
      git(repo, 'checkout', '-q', '-b', 'agent')
    }
    for (const files of [].concat(agentFiles)) commitFiles(repo, files, 'agent')
    if (bundle === 'tag') git(repo, 'tag', 'agent-tag')
    git(repo, 'bundle', 'create', bundlePath, ...(bundle === 'multi-ref' ? ['agent', 'main'] : bundle === 'tag' ? ['refs/tags/agent-tag'] : ['agent']))
    if (bundle === 'corrupt') writeFileSync(bundlePath, 'not a bundle')
    if (bundle === 'two') copyFileSync(bundlePath, join(artifacts, 'aw-test-repo-other.bundle'))
    git(repo, 'checkout', '-q', head)
  }
  for (const [name, content] of Object.entries(artifactFiles)) {
    if (typeof content === 'object') symlinkSync(content.link, join(artifacts, name))
    else writeFileSync(join(artifacts, name), content)
  }
  const gitConfig = readFileSync(join(repo, '.git/config'), 'utf8')

  // Fake npm and docker: a marker proves they were reached. npm logs the tree it installs in;
  // docker logs its arguments and runs the test's snippet against the mounted directories.
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const fakes = {
    npm: [`{ pwd -P; ls backend/tests; } >> '${dir}/npm.log'`],
    docker: [
      `printf '%s\\n' "$@" -- >> '${dir}/docker.args'`,
      `dir='${dir}'; w=; m=; prev=; phase=measure`,
      'for a in "$@"; do',
      '  if [ "$prev" = -v ]; then case "$a" in *:/w) w=${a%:/w} ;; *:/in/measurements) m=${a%:/in/measurements} ;; esac; fi',
      '  prev=$a',
      'done',
      '[ "$a" = baseline ] && phase=baseline',
      docker,
    ],
  }
  for (const [name, lines] of Object.entries(fakes)) {
    writeFileSync(join(bin, name), ['#!/bin/sh', `touch '${dir}/${name}.marker'`, ...lines, 'exit 0', ''].join('\n'))
    chmodSync(join(bin, name), 0o755)
  }
  const input = join(dir, 'in')
  const workA = join(dir, 'work-a')
  const workB = join(dir, 'work-b')
  const result = spawnSync('bash', [gate], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, BASE_SHA: base, HEAD_SHA: head, HEAD_REF: headRef, MODE: mode, GATE_DIR: repo, IN: input,
      NODE_IMAGE: 'unused', AGENT_ARTIFACTS_DIR: artifacts, AGENT_RESULT: 'success', RUN_URL: 'https://run', PR_NUMBER: '7',
      WORK_A: workA, WORK_B: workB, GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary'),
    },
  })
  const reportPath = join(input, 'out/report.json')
  const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '')
  return {
    dir, repo, input, workA, workB, gitConfig,
    status: result.status,
    report: existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null,
    npm: existsSync(join(dir, 'npm.marker')),
    docker: existsSync(join(dir, 'docker.marker')),
    npmLog: read(join(dir, 'npm.log')),
    // One argument list per docker call.
    dockerRuns: read(join(dir, 'docker.args')).split('\n--\n').filter(Boolean).map((run) => run.split('\n')),
    stderr: result.stderr,
    stdout: result.stdout,
  }
}

test('rejects a patch that edits source before installing or running anything', { skip }, () => {
  const r = runGate({ agentFiles: { 'backend/src/x.ts': 'export const x = 3\n' } })
  assert.equal(r.status, 1, r.stderr)
  assert.equal(r.report.verdict, 'rejected')
  assert.match(r.report.reason, /not an allowed test path/)
  assert.deepEqual([r.npm, r.docker], [false, false])
})

test('rejects agent commits that do not build on the PR head', { skip }, () => {
  const r = runGate({ bundle: 'foreign' })
  assert.equal(r.status, 1, r.stderr)
  assert.equal(r.report.verdict, 'rejected')
  assert.match(r.report.reason, /do not build on the PR head/)
  assert.deepEqual([r.npm, r.docker], [false, false])
})

test('fails when gh-aw reported a patch but left no bundle, even with a .patch file', { skip }, () => {
  const r = runGate({ bundle: 'none' })
  assert.equal(r.status, 1, r.stderr)
  assert.equal(r.report.verdict, 'failed')
  assert.match(r.report.reason, /no agent bundle found although the agent produced a patch/)
  assert.deepEqual([r.npm, r.docker], [false, false])
})

test('installs on the clean PR head, then measures; an empty measurement is never ready', { skip }, () => {
  const r = runGate()
  assert.equal(r.npm, true, r.stderr)
  assert.equal(r.docker, true)
  // npm ci runs in the checkout before the agent's patch is applied: its new test is not there yet.
  assert.ok(r.npmLog.split('\n').includes(realpathSync(r.repo)), r.npmLog)
  assert.match(r.npmLog, /x\.test\.ts/)
  assert.doesNotMatch(r.npmLog, /y\.test\.ts/)
  assert.equal(r.status, 1, r.stderr)
  assert.equal(r.report.verdict, 'failed')
})

test('fails closed when the bundle does not verify', { skip }, () => {
  const r = runGate({ bundle: 'corrupt' })
  assert.equal(r.status, 1, r.stderr)
  assert.equal(r.report.verdict, 'failed')
  assert.deepEqual([r.npm, r.docker], [false, false])
})

test('rejects more than one agent commit', { skip }, () => {
  const r = runGate({ agentFiles: [Y, { 'backend/tests/z.test.ts': Y['backend/tests/y.test.ts'] }] })
  assert.equal(r.status, 1, r.stderr)
  assert.equal(r.report.verdict, 'rejected')
  assert.match(r.report.reason, /exactly one commit/)
  assert.deepEqual([r.npm, r.docker], [false, false])
})

for (const [bundle, headRef, reason] of [
  ['two', 'agent', /more than one agent bundle/],
  ['ok', 'other-branch', /agent bundle ref does not match the PR branch/],
  ['multi-ref', 'agent', /agent bundle must carry exactly one ref/],
]) {
  test(`rejects an agent bundle that is not the PR branch's one bundle (${bundle}, HEAD_REF=${headRef})`, { skip }, () => {
    const r = runGate({ bundle, headRef })
    assert.equal(r.status, 1, r.stderr)
    assert.equal(r.report.verdict, 'rejected')
    assert.match(r.report.reason, reason)
    assert.deepEqual([r.npm, r.docker], [false, false])
  })
}

test('runs both containers sandboxed on throwaway copies, never on the checkout', { skip }, () => {
  const r = runGate({ docker: BASELINE_RESULTS })
  assert.equal(r.dockerRuns.length, 2, r.stderr)
  const repo = realpathSync(r.repo)
  for (const [i, args] of r.dockerRuns.entries()) {
    assert.equal(args[0], 'run')
    for (const flag of ['--network=none', '--pids-limit', '--memory']) assert.ok(args.includes(flag), `${flag} in ${args}`)
    const mounts = args.filter((_, j) => args[j - 1] === '-v')
    assert.ok(mounts.some((mount) => mount.endsWith(':/t:ro')), mounts.join(' '))
    assert.ok(mounts.some((mount) => mount.endsWith('/analysis:/in/analysis:ro')), mounts.join(' '))
    for (const source of mounts.map((mount) => mount.split(':')[0])) {
      assert.ok(source !== r.repo && source !== repo && !source.startsWith(`${r.repo}/`) && !source.startsWith(`${repo}/`), source)
    }
    assert.ok(mounts.includes(`${i === 0 ? r.workA : r.workB}:/w`), mounts.join(' '))
    assert.equal(args.at(-1) === 'baseline', i === 0)
  }
  assert.deepEqual([existsSync(r.workA), existsSync(r.workB)], [false, false])
  assert.equal(r.status, 1, r.stderr)
  assert.equal(r.report.verdict, 'failed')
})

test('a test that plants git config in its tree cannot reach the checkout the runner runs git in', { skip }, () => {
  const plant = 'printf \'[core]\\n\\tfsmonitor = touch PWNED\\n\' >> "$w/.git/config"; cp "$w/.git/config" "$dir/planted-$phase"'
  const r = runGate({ docker: `${BASELINE_RESULTS}\n${plant}` })
  assert.match(readFileSync(join(r.dir, 'planted-baseline'), 'utf8'), /fsmonitor = touch PWNED/, r.stderr)
  assert.match(readFileSync(join(r.dir, 'planted-measure'), 'utf8'), /fsmonitor = touch PWNED/)
  assert.equal(readFileSync(join(r.repo, '.git/config'), 'utf8'), r.gitConfig)
  git(r.repo, 'status') // what actions/checkout's post step does in the checkout
  assert.equal(existsSync(join(r.repo, 'PWNED')), false)
})

for (const phase of ['baseline', 'measure']) {
  test(`fails without reading measurements that contain a link (${phase})`, { skip }, () => {
    const link = `[ "$phase" = ${phase} ] && ln -s /etc/hostname "$m/typecheck-backend"`
    const r = runGate({ docker: `${BASELINE_RESULTS}\n${link}` })
    assert.equal(r.status, 1, r.stderr)
    assert.equal(r.report.verdict, 'failed')
    assert.match(r.report.reason, /measurements contain links or special files/)
    assert.equal(existsSync(join(r.input, 'measurements')), false)
  })
}

test('fails on measurements larger than 200 MB', { skip }, () => {
  const r = runGate({ docker: `${BASELINE_RESULTS}\n[ "$phase" = measure ] && truncate -s 201M "$m/big"` })
  assert.equal(r.status, 1, r.stderr)
  assert.equal(r.report.verdict, 'failed')
  assert.match(r.report.reason, /measurements are larger than 200 MB/)
})

test('copies back only plain baseline files, never through a link', { skip }, () => {
  const failing = '{"testResults":[{"name":"/w/backend/tests/x.test.ts","assertionResults":[{"fullName":"x","status":"failed","failureMessages":["boom"]}]}]}'
  const summary = '{"total":{"lines":{"pct":50},"statements":{"pct":50},"functions":{"pct":50},"branches":{"pct":50}}}'
  const r = runGate({
    docker: [
      BASELINE_RESULTS,
      'if [ "$phase" = baseline ]; then',
      `  echo '${failing}' > "$w/.unit-test-agent/results-backend.json"`,
      `  mkdir -p "$w/backend/coverage" "$dir/outside" && echo '${summary}' > "$w/backend/coverage/coverage-summary.json"`,
      `  echo '${summary}' > "$dir/outside/coverage-summary.json" && mkdir -p "$w/frontend" && ln -s "$dir/outside" "$w/frontend/coverage"`,
      'fi',
    ].join('\n'),
  })
  const manifest = JSON.parse(readFileSync(join(r.input, 'analysis/.unit-test-agent/manifest.json'), 'utf8'))
  assert.deepEqual(manifest.failingTests.map((f) => f.name), ['x'], r.stderr)
  assert.equal(manifest.coverageBefore.backend.lines, 50)
  assert.equal(manifest.coverageBefore.frontend, null)
})

for (const [label, plant] of [
  ['a link', 'ln -sf /etc/hostname "$w/.unit-test-agent/results-backend.json"'],
  ['over 20 MB', 'truncate -s 21M "$w/.unit-test-agent/results-backend.json"'],
]) {
  test(`fails when the baseline results are ${label}`, { skip }, () => {
    const r = runGate({ docker: `${BASELINE_RESULTS}\n[ "$phase" = baseline ] && ${plant}` })
    assert.equal(r.status, 1, r.stderr)
    assert.equal(r.report.verdict, 'failed')
    assert.match(r.report.reason, /baseline results for backend are missing, a link or over 20 MB/)
    assert.equal(r.dockerRuns.length, 1)
  })
}

test('gives each container run 4 minutes, so the gate report is written inside the 10-minute job', { skip }, () => {
  const text = readFileSync(gate, 'utf8')
  assert.match(text, /timeout 4m docker run/)
  assert.doesNotMatch(text, /timeout 12m/)
})

test('restores permissions the container removed before inspecting measurements', { skip }, () => {
  const r = runGate({ docker: `${BASELINE_RESULTS}\n[ "$phase" = measure ] && { mkdir -p "$m/d" && ln -s /dev/zero "$m/d/link" && chmod 555 "$m/d" "$m"; }` })
  assert.equal(r.status, 1, r.stderr)
  assert.match(r.report.reason, /measurements contain links or special files/)
  assert.equal(existsSync(join(r.input, 'measurements')), false)
})

test('copy-back never writes through a destination link committed in the PR head', { skip }, () => {
  const summary = '{"total":{"lines":{"pct":50},"statements":{"pct":50},"functions":{"pct":50},"branches":{"pct":50}}}'
  const r = runGate({
    headFiles: { 'backend/coverage/coverage-final.json': { link: '../../.git/config' } },
    docker: `${BASELINE_RESULTS}\n[ "$phase" = baseline ] && rm -f "$w/backend/coverage/coverage-final.json" && echo '${summary}' > "$w/backend/coverage/coverage-final.json"`,
  })
  assert.equal(readFileSync(join(r.repo, '.git/config'), 'utf8'), r.gitConfig, r.stderr)
})

test('copies the agent session log and usage only when they are regular files under the size cap', { skip }, () => {
  const copied = (r, name) => existsSync(join(r.input, 'agent', name))
  const ok = runGate({ artifactFiles: { 'agent-session.jsonl': '{}\n', 'agent_usage.json': '{"ai_credits":1}' } })
  assert.deepEqual([copied(ok, 'execution.jsonl'), copied(ok, 'usage.json')], [true, true])

  const secret = join(mkdtempSync(join(tmpdir(), 'secret-')), 'secret')
  writeFileSync(secret, '{"ai_credits":1}')
  const linked = runGate({ artifactFiles: { 'agent-session.jsonl': { link: secret }, 'agent_usage.json': { link: secret } } })
  assert.deepEqual([copied(linked, 'execution.jsonl'), copied(linked, 'usage.json')], [false, false])

  const big = runGate({ artifactFiles: { 'agent-session.jsonl': 'x'.repeat(5 * 1024 * 1024 + 1), 'agent_usage.json': 'x'.repeat(64 * 1024 + 1) } })
  assert.deepEqual([copied(big, 'execution.jsonl'), copied(big, 'usage.json')], [false, false])

  const none = runGate()
  assert.deepEqual([copied(none, 'execution.jsonl'), copied(none, 'usage.json')], [false, false])
  assert.equal(none.report.verdict, 'failed')  // missing facts never change how the gate decides
})

// Coverage mode: a sweep opens a new PR, so there is no PR branch name to match and no PR diff.
test('coverage mode rejects a commit that changes a line of an existing test', { skip }, () => {
  const r = runGate({ mode: 'coverage', headRef: undefined, agentFiles: { 'backend/tests/x.test.ts': "import { test } from 'vitest'\ntest('x changed', () => {})\n" } })
  assert.equal(r.status, 1, r.stderr)
  assert.equal(r.report.verdict, 'rejected')
  assert.match(r.report.reason, /existing test file backend\/tests\/x\.test\.ts must not change/)
  assert.deepEqual([r.npm, r.docker], [false, false])
})

test('coverage mode accepts a new test case in an existing test file, in the gate and in the judge', { skip }, () => {
  const r = runGate({ mode: 'coverage', headRef: undefined, agentFiles: { 'backend/tests/x.test.ts': "import { test } from 'vitest'\ntest('x', () => {})\ntest('x2', () => {})\n" } })
  assert.equal(r.npm, true, r.stderr)
  const validation = JSON.parse(readFileSync(join(r.input, 'patch-validation.json'), 'utf8'))  // the judge's own re-validation
  assert.equal(validation.valid, true, validation.violations.join('\n'))
  assert.equal(validation.assertionAudit.changedExisting, 0)
})

test('coverage mode accepts any branch name and a new test file reaches the install step', { skip }, () => {
  const r = runGate({ mode: 'coverage', headRef: undefined })
  assert.equal(r.npm, true, r.stderr)
  assert.doesNotMatch(r.npmLog, /y\.test\.ts/)
})

test('coverage mode still needs exactly one ref', { skip }, () => {
  const r = runGate({ mode: 'coverage', headRef: undefined, bundle: 'multi-ref' })
  assert.equal(r.report.verdict, 'rejected')
  assert.match(r.report.reason, /exactly one ref/)
  assert.deepEqual([r.npm, r.docker], [false, false])
})

test('coverage mode rejects a bundle whose ref is not a branch', { skip }, () => {
  const r = runGate({ mode: 'coverage', headRef: undefined, bundle: 'tag' })
  assert.equal(r.report.verdict, 'rejected')
  assert.match(r.report.reason, /ref is not a branch/)
  assert.deepEqual([r.npm, r.docker], [false, false])
})

test('coverage mode passes MODE=coverage to the containers', { skip }, () => {
  const r = runGate({ mode: 'coverage', headRef: undefined, docker: BASELINE_RESULTS })
  assert.equal(r.dockerRuns.length, 2, r.stderr)
  for (const args of r.dockerRuns) assert.ok(args.includes('MODE=coverage'), args.join(' '))
})

test('an unknown MODE fails', { skip }, () => {
  const r = runGate({ mode: 'sweep' })
  assert.equal(r.status, 1, r.stderr)
  assert.equal(r.report.verdict, 'failed')
  assert.match(r.report.reason, /unknown MODE sweep/)
})

test('logs which agent facts were copied and why not', { skip }, () => {
  const r = runGate({ artifactFiles: { 'agent-session.jsonl': '{}\n' } })
  assert.match(r.stdout, /gate: agent facts — agent-session\.jsonl: copied; agent_usage\.json: missing/)
})

test('coverage mode keeps its manifest mode but takes failing tests and coverage from the baseline', { skip }, () => {
  const failing = '{"testResults":[{"name":"/w/backend/tests/x.test.ts","assertionResults":[{"fullName":"x","status":"failed","failureMessages":["boom"]}]}]}'
  const summary = '{"total":{"lines":{"pct":50},"statements":{"pct":50},"functions":{"pct":50},"branches":{"pct":50}}}'
  const r = runGate({
    mode: 'coverage', headRef: undefined,
    docker: [
      BASELINE_RESULTS,
      'if [ "$phase" = baseline ]; then',
      `  echo '${failing}' > "$w/.unit-test-agent/results-backend.json"`,
      `  mkdir -p "$w/backend/coverage" && echo '${summary}' > "$w/backend/coverage/coverage-summary.json"`,
      'fi',
    ].join('\n'),
  })
  const manifest = JSON.parse(readFileSync(join(r.input, 'analysis/.unit-test-agent/manifest.json'), 'utf8'))
  assert.equal(manifest.mode, 'coverage', r.stderr)
  assert.deepEqual(manifest.failingTests.map((f) => f.name), ['x'])
  assert.equal(manifest.coverageBefore.backend.lines, 50)
})
