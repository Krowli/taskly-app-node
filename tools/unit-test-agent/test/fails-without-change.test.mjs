import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { summarizeFailsWithoutChange } from '../fails-without-change.mjs'

test('counts tests and failures on base, including files that fail to load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fails-without-change-'))
  writeFileSync(join(dir, 'fails-without-change-backend.json'), JSON.stringify({ numTotalTests: 5, numFailedTests: 3, testResults: [] }))
  writeFileSync(join(dir, 'fails-without-change-frontend.json'), JSON.stringify({
    numTotalTests: 2, numFailedTests: 0,
    testResults: [{ status: 'failed', assertionResults: [] }, { status: 'passed', assertionResults: [{}] }],
  }))
  assert.deepEqual(summarizeFailsWithoutChange(dir), { applicable: true, newTests: 7, failingOnBase: 4 })
})

test('is not applicable when no app ran on base', () => {
  assert.deepEqual(summarizeFailsWithoutChange(mkdtempSync(join(tmpdir(), 'fails-without-change-'))), { applicable: false, newTests: 0, failingOnBase: 0 })
})
