import { test } from 'node:test'
import assert from 'node:assert/strict'
import { intersect, statementLines, summarize, uncoveredBranchLines, uncoveredFunctions, uncoveredLines } from '../../lib/coverage.mjs'
import { parseVitestJson } from '../../lib/vitest-json.mjs'

const FILE = '/repo/backend/src/features/todos/router.ts'
const coverageFinal = {
  [FILE]: {
    path: FILE,
    statementMap: {
      0: { start: { line: 6, column: 17 }, end: { line: 6, column: 24 } },
      1: { start: { line: 8, column: 4 }, end: { line: 10, column: 5 } },
      2: { start: { line: 12, column: 2 }, end: { line: 12, column: 30 } },
      3: { start: { line: 13, column: 2 }, end: { line: 13, column: 30 } },
    },
    s: { 0: 3, 1: 0, 2: 0, 3: 2 },
  },
}

test('lists the lines of statements that never ran', () => {
  assert.deepEqual(uncoveredLines(coverageFinal, FILE), [8, 9, 10, 12])
  assert.deepEqual(uncoveredLines(coverageFinal, '/repo/missing.ts'), [])
})

test('intersects changed ranges with uncovered lines as merged ranges', () => {
  assert.deepEqual(intersect([[7, 9], [12, 14]], [8, 9, 10, 12]), [[8, 9], [12, 12]])
  assert.deepEqual(intersect([[1, 3]], [8]), [])
})

test('reads the total percentages from a coverage summary', () => {
  const summary = {
    total: {
      lines: { pct: 33.02 }, statements: { pct: 30.23 }, functions: { pct: 40.62 }, branches: { pct: 33.33 },
      branchesTrue: { pct: 100 },
    },
  }
  assert.deepEqual(summarize(summary), { lines: 33.02, statements: 30.23, functions: 40.62, branches: 33.33 })
})

test('turns a Vitest JSON report into counts and short failure records', () => {
  const report = {
    numTotalTests: 3, numPassedTests: 2, numFailedTests: 1,
    testResults: [{
      name: '/repo/backend/tests/router.test.ts',
      assertionResults: [
        { fullName: 'lists tasks', status: 'passed', failureMessages: [] },
        { fullName: 'rejects long titles', status: 'failed', failureMessages: ['AssertionError: ' + 'x'.repeat(600)] },
      ],
    }],
  }
  const result = parseVitestJson(report, '/repo')
  assert.equal(result.passed, 2)
  assert.equal(result.failed, 1)
  assert.equal(result.total, 3)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].file, 'backend/tests/router.test.ts')
  assert.equal(result.failures[0].name, 'rejects long titles')
  assert.equal(result.failures[0].message.length, 500)
})

test('counts a test file that failed to load as a failure', () => {
  const report = {
    numTotalTests: 0, numPassedTests: 0, numFailedTests: 0,
    testResults: [{ name: '/repo/backend/tests/broken.test.ts', status: 'failed', message: 'Failed to load url ../src/nope.ts', assertionResults: [] }],
  }
  const result = parseVitestJson(report, '/repo')
  assert.equal(result.failed, 1)
  assert.deepEqual(result.failures, [{ file: 'backend/tests/broken.test.ts', name: '(file failed to load)', message: 'Failed to load url ../src/nope.ts' }])
})

test('lists the lines that hold any statement, covered or not', () => {
  assert.deepEqual(statementLines(coverageFinal, FILE), [6, 8, 9, 10, 12, 13])
})

const branchy = {
  [FILE]: {
    statementMap: {},
    s: {},
    branchMap: {
      0: { loc: { start: { line: 20 } }, locations: [{ start: { line: 21 } }, { start: { line: 23 } }] },
      1: { loc: { start: { line: 30 } }, locations: [{ start: {} }] },
      2: { loc: { start: { line: 40 } }, locations: [{ start: { line: 41 } }] },
    },
    b: { 0: [3, 0], 1: [0], 2: [1] },
    fnMap: {
      0: { name: 'onToggle', decl: { start: { line: 47 } }, loc: { start: { line: 46 } } },
      1: { name: 'used', decl: { start: { line: 5 } }, loc: { start: { line: 5 } } },
      2: { name: '(anonymous_2)', loc: { start: { line: 9 } } },
    },
    f: { 0: 0, 1: 2, 2: 0 },
  },
}

test('lists the lines of branch paths that were never taken', () => {
  assert.deepEqual(uncoveredBranchLines(branchy, FILE), [23, 30])
  assert.deepEqual(uncoveredBranchLines({ [FILE]: { ...branchy[FILE], b: { 0: [1, 1], 1: [1], 2: [1] } } }, FILE), [])
  assert.deepEqual(uncoveredBranchLines(branchy, '/repo/missing.ts'), [])
})

test('lists functions that never ran with their line', () => {
  assert.deepEqual(uncoveredFunctions(branchy, FILE), [{ name: '(anonymous_2)', line: 9 }, { name: 'onToggle', line: 47 }])
  assert.deepEqual(uncoveredFunctions(branchy, '/repo/missing.ts'), [])
})
