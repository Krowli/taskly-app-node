// "Fails without the change": the agent's tests were re-run with the PR's modified source
// files reverted to the merge base (fails-without-change-<app>.json, Vitest JSON). Tests that now
// fail are the ones that check the new behaviour.
// Usage: node fails-without-change.mjs <dir>  → writes <dir>/fails-without-change.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function summarizeFailsWithoutChange(dir) {
  let applicable = false
  let newTests = 0
  let failingOnBase = 0
  for (const app of ['backend', 'frontend']) {
    const path = join(dir, `fails-without-change-${app}.json`)
    if (!existsSync(path)) continue
    const report = JSON.parse(readFileSync(path, 'utf8'))
    applicable = true
    newTests += report.numTotalTests ?? 0
    // A test file that cannot even load on base (new import) fails as a whole.
    failingOnBase += (report.numFailedTests ?? 0) + (report.testResults ?? []).filter((file) => file.status === 'failed' && !file.assertionResults?.length).length
  }
  return { applicable, newTests, failingOnBase }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(join(process.argv[2], 'fails-without-change.json'), JSON.stringify(summarizeFailsWithoutChange(process.argv[2])))
}
