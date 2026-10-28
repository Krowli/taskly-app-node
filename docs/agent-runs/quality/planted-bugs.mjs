#!/usr/bin/env node
// Puts each bug from bugs.json into a checkout, one at a time, runs that app's full test suite and undoes the bug.
// Caught = at least one test fails while the bug is in place. It edits source files, so run it in a throw-away clone.
// Usage: planted-bugs.mjs <checkout> [--check]   (--check only verifies that every bug still applies, and runs nothing)
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const bugs = JSON.parse(readFileSync(new URL('./bugs.json', import.meta.url), 'utf8'))
const [root, flag] = process.argv.slice(2)
if (!root) {
  console.error('usage: planted-bugs.mjs <checkout> [--check]')
  process.exit(2)
}

// Every original snippet must occur exactly once, or the bug would land in the wrong place or nowhere.
const stale = bugs.filter((bug) => readFileSync(join(root, bug.file), 'utf8').split(bug.original).length !== 2)
if (stale.length) {
  console.error(`bugs that no longer apply: ${stale.map((bug) => bug.id).join(', ')}`)
  process.exit(1)
}
if (flag === '--check') {
  console.log(`${bugs.length} bugs apply`)
  process.exit(0)
}
if (execFileSync('git', ['status', '--porcelain', '--', 'backend/src', 'frontend/src'], { cwd: root, encoding: 'utf8' }).trim()) {
  console.error('source files have local changes; run this in a clean throw-away clone')
  process.exit(1)
}

const suite = (app) => spawnSync(join(root, app, 'node_modules/.bin/vitest'), ['run'], { cwd: join(root, app), encoding: 'utf8' })
for (const app of ['backend', 'frontend']) {
  if (suite(app).status !== 0) {
    console.error(`${app} tests fail before any bug is planted`)
    process.exit(1)
  }
}

let caught = 0
console.log('| Bug | What was broken | Result |\n|---|---|---|')
for (const bug of bugs) {
  const path = join(root, bug.file)
  const source = readFileSync(path, 'utf8')
  writeFileSync(path, source.replace(bug.original, bug.replacement))
  let status
  try {
    status = suite(bug.file.split('/')[0]).status
  } finally {
    writeFileSync(path, source)
  }
  if (status !== 0) caught++
  console.log(`| ${bug.id} | ${bug.what} | ${status !== 0 ? 'caught' : 'missed'} |`)
}
console.log(`\nCaught ${caught} of ${bugs.length} (commit ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()})`)
