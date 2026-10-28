import { relative } from 'node:path'

// Reads Vitest's Jest-compatible JSON reporter output.
export function parseVitestJson(report, repoRoot) {
  const failures = []
  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status !== 'failed') continue
      failures.push({
        file: relative(repoRoot, file.name),
        name: assertion.fullName,
        message: (assertion.failureMessages ?? []).join('\n').slice(0, 500),
      })
    }
    // A file that fails to load (syntax error, bad import) has a message but no assertions.
    if (file.status === 'failed' && !(file.assertionResults ?? []).length) {
      failures.push({ file: relative(repoRoot, file.name), name: '(file failed to load)', message: String(file.message ?? '').slice(0, 500) })
    }
  }
  return {
    passed: report.numPassedTests ?? 0,
    failed: (report.numFailedTests ?? 0) + failures.filter((failure) => failure.name === '(file failed to load)').length,
    total: report.numTotalTests ?? 0,
    failures,
  }
}
