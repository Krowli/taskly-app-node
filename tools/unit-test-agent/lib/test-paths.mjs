// The only files the unit-test agent may create or edit. Single source for the
// agent's run-tests script and the workflow tooling (manifest, patch validation).
import { posix } from 'node:path'

export const ALLOWED_TEST_PATTERNS = [
  /^backend\/tests\/.+\.ts$/,
  /^frontend\/src\/.+\.test\.tsx?$/,
  /^frontend\/src\/test\/.+\.tsx?$/,
]

// Inside the allowed patterns but global: Vitest loads it before every frontend test.
export const EXCLUDED_TEST_PATHS = ['frontend/src/test/setup.ts']

export function isAllowedTestPath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\')) return false
  if (path.startsWith('/') || posix.normalize(path) !== path) return false
  if (path.split('/').includes('..') || EXCLUDED_TEST_PATHS.includes(path)) return false
  return ALLOWED_TEST_PATTERNS.some((pattern) => pattern.test(path))
}

// Helpers such as backend/tests/fixture.ts are allowed but cannot be run on their own.
export function isRunnableTest(path) {
  return isAllowedTestPath(path) && /\.test\.tsx?$/.test(path)
}
