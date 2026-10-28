import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { summarizePins } from '../pins-change.mjs'

test('counts tests and failures on base, including files that fail to load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pins-'))
  writeFileSync(join(dir, 'pins-backend.json'), JSON.stringify({ numTotalTests: 5, numFailedTests: 3, testResults: [] }))
  writeFileSync(join(dir, 'pins-frontend.json'), JSON.stringify({
    numTotalTests: 2, numFailedTests: 0,
    testResults: [{ status: 'failed', assertionResults: [] }, { status: 'passed', assertionResults: [{}] }],
  }))
  assert.deepEqual(summarizePins(dir), { applicable: true, newTests: 7, failingOnBase: 4 })
})

test('is not applicable when no app ran on base', () => {
  assert.deepEqual(summarizePins(mkdtempSync(join(tmpdir(), 'pins-'))), { applicable: false, newTests: 0, failingOnBase: 0 })
})
