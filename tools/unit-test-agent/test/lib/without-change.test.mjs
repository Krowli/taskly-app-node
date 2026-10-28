import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withoutChangePlan } from '../../lib/without-change.mjs'

const file = (path, status, app = 'backend', testable = true) => ({ path, status, app, testable })

test('restores modified testable files', () => {
  assert.deepEqual(withoutChangePlan({ files: [file('backend/src/a.ts', 'M')] }, 'backend'), [{ path: 'backend/src/a.ts', action: 'restore' }])
})

test('hides added testable files and skips other statuses', () => {
  const manifest = { files: [file('backend/src/b.ts', 'A'), file('backend/src/c.ts', 'D'), file('backend/src/d.ts', 'R')] }
  assert.deepEqual(withoutChangePlan(manifest, 'backend'), [{ path: 'backend/src/b.ts', action: 'hide' }])
})

test('ignores files of another app', () => {
  assert.deepEqual(withoutChangePlan({ files: [file('frontend/src/a.ts', 'M', 'frontend')] }, 'backend'), [])
})

test('ignores files that are not testable', () => {
  assert.deepEqual(withoutChangePlan({ files: [file('backend/prisma/schema.prisma', 'M', 'backend', false)] }, 'backend'), [])
})
