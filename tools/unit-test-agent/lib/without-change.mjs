// Which files to put back to the merge base so tests can run without the PR's change:
// modified testable files are restored to the base revision, added ones are hidden.
export function withoutChangePlan(manifest, app) {
  const plan = []
  for (const file of manifest.files ?? []) {
    if (file.app !== app || !file.testable) continue
    if (file.status === 'M') plan.push({ path: file.path, action: 'restore' })
    else if (file.status === 'A') plan.push({ path: file.path, action: 'hide' })
  }
  return plan
}
