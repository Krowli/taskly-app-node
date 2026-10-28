import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { KEYWORDS, TYPES, checkOutput } from '../../lib/check-output.mjs'

const schema = JSON.parse(readFileSync(new URL('../../../../.github/agents/unit-test-agent.schema.json', import.meta.url), 'utf8'))

// One entry in every list, so every part of the schema is checked.
const valid = {
  summary: 'Covered the new due-date rule.',
  decisions: [{ file: 'backend/src/a.ts', action: 'updated', testFiles: ['backend/tests/a.test.ts'], reason: 'r', noFailingTest: { reason: 'no-behaviour-change', detail: 'd' } }],
  impact: [{ changedFile: 'backend/src/a.ts', relatedFile: 'frontend/src/b.ts', relatedLines: '3-4', kind: 'importer', risk: 'r', action: 'tested' }],
  assertionChanges: [{ testFile: 'backend/tests/a.test.ts', testName: 'x', sourceRef: 'backend/src/a.ts:4', why: 'w' }],
  suspectedBugs: [{ file: 'backend/src/a.ts', line: 4, question: 'q', evidence: 'e', snippet: 's' }],
  discardedTests: [{ testFile: 'backend/tests/b.test.ts', reason: 'r' }],
}
const withDecision = (fields) => ({ ...valid, decisions: [{ ...valid.decisions[0], ...fields }] })

test('accepts output that matches the schema', () => {
  assert.deepEqual(checkOutput(valid, schema), [])
})

test('names each missing required property with its JSON path', () => {
  const { summary, ...noSummary } = valid
  assert.deepEqual(checkOutput(noSummary, schema), ['(root): missing required "summary"'])
  const { testName, ...noName } = valid.assertionChanges[0]
  assert.deepEqual(checkOutput({ ...valid, assertionChanges: [valid.assertionChanges[0], noName] }, schema), ['assertionChanges[1]: missing required "testName"'])
})

test('names a value of the wrong type', () => {
  assert.deepEqual(checkOutput(null, schema), ['(root): expected object, got null'])
  assert.deepEqual(checkOutput({ ...valid, summary: 5, decisions: {} }, schema), ['summary: expected string, got number', 'decisions: expected array, got object'])
  assert.deepEqual(checkOutput({ ...valid, suspectedBugs: [{ ...valid.suspectedBugs[0], line: 1.5 }] }, schema), ['suspectedBugs[0].line: expected integer, got number'])
})

test('names a value outside the allowed list', () => {
  assert.deepEqual(checkOutput(withDecision({ action: 'made' }), schema), ['decisions[0].action: "made" is not one of "created", "updated", "skipped"'])
})

test('names an unexpected property where the schema allows no others', () => {
  assert.deepEqual(checkOutput({ ...valid, extra: 1 }, schema), ['(root): unexpected property "extra"'])
})

test('the shape a real run wrote for assertionChanges names every wrong field', () => {
  const output = { summary: 'x', decisions: [], impact: [], assertionChanges: [{ file: 'backend/tests/a.test.ts', sourceRef: 'backend/src/a.ts:4', reason: 'r' }], suspectedBugs: [], discardedTests: [] }
  assert.deepEqual(checkOutput(output, schema), [
    'assertionChanges[0]: missing required "testFile"',
    'assertionChanges[0]: missing required "testName"',
    'assertionChanges[0]: missing required "why"',
    'assertionChanges[0]: unexpected property "file"',
    'assertionChanges[0]: unexpected property "reason"',
  ])
})

test('checks the nested no-failing-test exception of a decision', () => {
  assert.deepEqual(checkOutput(withDecision({ noFailingTest: { reason: 'looks fine', detail: '', note: 'x' } }), schema), [
    'decisions[0].noFailingTest.reason: "looks fine" is not one of "no-behaviour-change", "suspected-bug", "not-unit-testable"',
    'decisions[0].noFailingTest.detail: has 0 characters, at least 1 required',
    'decisions[0].noFailingTest: unexpected property "note"',
  ])
  assert.deepEqual(checkOutput(withDecision({ noFailingTest: 'no-behaviour-change' }), schema), ['decisions[0].noFailingTest: expected object, got string'])
  assert.deepEqual(checkOutput(withDecision({ noFailingTest: { reason: 'suspected-bug' } }), schema), ['decisions[0].noFailingTest: missing required "detail"'])
})

test('checks lengths, item counts, patterns and minimums', () => {
  const bug = valid.suspectedBugs[0]
  assert.deepEqual(checkOutput({
    ...valid,
    summary: 'x'.repeat(601),
    assertionChanges: [{ ...valid.assertionChanges[0], sourceRef: 'backend/src/a.ts' }],
    suspectedBugs: [{ ...bug, line: -1 }, bug, bug, bug],
  }, schema), [
    'summary: has 601 characters, at most 600 allowed',
    'assertionChanges[0].sourceRef: "backend/src/a.ts" does not match ^[A-Za-z0-9_./-]+:[0-9]+$',
    'suspectedBugs: has 4 items, at most 3 allowed',
    'suspectedBugs[0].line: -1 is below the minimum 0',
  ])
})

test('implements every keyword and type the schema uses', () => {
  const visit = (node, path) => {
    for (const key of Object.keys(node)) assert.ok(KEYWORDS.includes(key), `${path}: keyword ${key}`)
    if (node.type) assert.ok(Object.hasOwn(TYPES, node.type), `${path}: type ${node.type}`)
    for (const [key, child] of Object.entries(node.properties ?? {})) visit(child, `${path}.${key}`)
    if (node.items) visit(node.items, `${path}[]`)
  }
  visit(schema, '(root)')
})
