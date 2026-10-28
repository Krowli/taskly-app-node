import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const hook = fileURLToPath(new URL('../commit-msg', import.meta.url))

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GITHUB_RUN_ID: '' } })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

function commitWithHook(message) {
  const repo = mkdtempSync(join(tmpdir(), 'commit-msg-'))
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.name', 'Test')
  git(repo, 'config', 'user.email', 'test@example.com')
  copyFileSync(hook, join(repo, '.git/hooks/commit-msg'))
  writeFileSync(join(repo, 'a.test.ts'), 'x\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', message)
  return git(repo, 'log', '-1', '--format=%B')
}

test('drops an attribution line the agent CLI appends', () => {
  const message = commitWithHook('test: cover TodoEmptyState\n\nAssisted-by: Agent <agent@example.com>')
  assert.equal(message.trim(), 'test: cover TodoEmptyState\n\nUnit-Test-Agent-Run: local')
})

test('drops every attribution line, whatever its case', () => {
  const message = commitWithHook('test: x\n\nbody line\n\nsigned-off-by: Some Bot <bot@example.com>\nReviewed-By: Other <o@example.com>')
  assert.equal(message.trim(), 'test: x\n\nbody line\n\nUnit-Test-Agent-Run: local')
})

test('keeps a message without trailers unchanged', () => {
  assert.equal(
    commitWithHook('test: x\n\nWhy: covers the empty state.').trim(),
    'test: x\n\nWhy: covers the empty state.\n\nUnit-Test-Agent-Run: local',
  )
})

test('keeps exactly one Unit-Test-Agent-Run trailer when the message already has it', () => {
  const message = commitWithHook('test: x\n\nUnit-Test-Agent-Run: 123')
  assert.equal(message.trim(), 'test: x\n\nUnit-Test-Agent-Run: 123')
})
