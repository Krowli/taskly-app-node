import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EXCLUDED_TEST_PATHS } from '../lib/test-paths.mjs'
import { NO_FAILING_TEST_REASONS } from '../build-report.mjs'

// The model reads the allowed paths as prose; the workflow enforces them as code.
// This keeps the two from drifting apart.
const agent = readFileSync(new URL('../../../.github/agents/unit-test-agent.agent.md', import.meta.url), 'utf8')

test('the agent prompt names every allowed test location', () => {
  for (const location of ['backend/tests/**/*.ts', 'frontend/src/**/*.test.ts(x)', 'frontend/src/test/**']) {
    assert.ok(agent.includes(location), location)
  }
})

test('the agent prompt names the excluded setup file', () => {
  for (const path of EXCLUDED_TEST_PATHS) assert.ok(agent.includes(path), path)
})

// gh-aw imports a workflow's markdown body at runtime, where `${{ … }}` and `{{#if}}` stay literal text
// (a sweep's first pass was once told it was a continuation pass). Run facts reach the agent as files instead.
const workflowBody = (name) => readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf8').split(/^---$/m).slice(2).join('---')

test('workflow prompt bodies contain no expressions or template blocks', () => {
  for (const name of ['unit-test-agent.md', 'unit-test-agent-sweep.md']) {
    const body = workflowBody(name)
    assert.ok(body.trim(), name)
    assert.doesNotMatch(body, /\$\{\{|\{\{#/, name)
  }
})

test('the sweep prompt and the agent tell a continuation pass by its file and name both publish tools', () => {
  for (const text of [workflowBody('unit-test-agent-sweep.md'), agent.slice(agent.indexOf('## Coverage mode'))]) {
    for (const word of ['.unit-test-agent/continuation.json', 'push_to_pull_request_branch', 'create_pull_request']) assert.ok(text.includes(word), word)
  }
})

test('the output schema offers exactly the no-failing-test reasons the gate accepts, and the agent names them', () => {
  const schema = JSON.parse(readFileSync(new URL('../../../.github/agents/unit-test-agent.schema.json', import.meta.url), 'utf8'))
  assert.deepEqual(schema.properties.decisions.items.properties.noFailingTest.properties.reason.enum, NO_FAILING_TEST_REASONS)
  for (const reason of NO_FAILING_TEST_REASONS) assert.ok(agent.includes(reason), reason)
})

test('the agent and the test-running skill name the output check', () => {
  const skill = readFileSync(new URL('../../../.github/skills/running-unit-tests/SKILL.md', import.meta.url), 'utf8')
  for (const text of [agent.slice(agent.indexOf('## Report')), skill]) assert.ok(text.includes('./.unit-test-agent/bin/run-tests.mjs --check-output'))
})
