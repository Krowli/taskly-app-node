import { isAllowedTestPath } from './test-paths.mjs'

// Allowed test paths live in one place, shared with the agent's hooks.
export { ALLOWED_TEST_PATTERNS, EXCLUDED_TEST_PATHS, isAllowedTestPath, isRunnableTest } from './test-paths.mjs'

// Contract files: no code imports them, but they encode the same rules as the code.
export const CONTRACT_FILES = ['backend/openapi.json', 'backend/prisma/schema.prisma']

// A whole-statement type-only import is erased at compile time, so it cannot open a connection.
const TYPE_ONLY_IMPORT = /\bimport\s+type\s+[^;'"]*?\bfrom\s*['"][^'"]*['"]/g
const NETWORK_MODULE = /['"]node:(net|https?)['"]/

export const FORBIDDEN_ADDED_LINE_PATTERNS = [
  [/\b(it|test|describe)\.(only|skip|todo)\s*\(/, 'focused, skipped or todo test'],
  [/\b(it|test|describe)\.fails\s*\(/, 'expected-to-fail test'],
  [/\b(toMatchSnapshot|toMatchInlineSnapshot|toMatchFileSnapshot|toThrowErrorMatchingSnapshot|toThrowErrorMatchingInlineSnapshot)\s*\(/, 'snapshot assertion'],
  [/\bx(it|describe)\s*\(/, 'skipped test'],
  [/vi\.setConfig\s*\(|requireAssertions/, 'changes test runner checks'],
  [/expect\.extend\s*\(/, 'overrides matchers'],
  [/\.catch\s*\(\s*(?:async\s*)?(?:\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*(?:\{\s*\}|undefined|null|void\s+0)\s*\)|\.catch\s*\(\s*(?:async\s+)?function\s*[\w$]*\s*\([^)]*\)\s*\{\s*\}\s*\)|\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/, 'swallows a failure (empty catch)'],
  [/\bexpect\s*\.\s*assertions\s*\(\s*0\s*\)/, 'expects zero assertions'],
  [/child_process/, 'spawns processes'],
  [{ test: (line) => NETWORK_MODULE.test(line.replace(TYPE_ONLY_IMPORT, '')) }, 'opens network connections'],
  [/\beval\s*\(/, 'evaluates code'],
  [/new Function\s*\(/, 'evaluates code'],
  [/\bimport\(\s*[^'"\s)]/, 'imports a computed module path'],
  [/\bprocess\s*(\.\s*env\b|\[)/, 'reads the environment (use vi.stubEnv)'],
  [/https?:\/\/(?!(?:localhost|127\.0\.0\.1|example\.com)(?![\w.-]))/, 'references an external URL'],
]

export function forbiddenAddedLine(line) {
  const match = FORBIDDEN_ADDED_LINE_PATTERNS.find(([pattern]) => pattern.test(line))
  return match ? match[1] : null
}

// Mirrors coverage include/exclude in backend/vitest.config.ts and frontend/vite.config.ts.
// Update both sides together.
const BACKEND_EXCLUDED = [/^backend\/src\/(.+\/)?types\.ts$/, /^backend\/src\/generated\//]
const FRONTEND_EXCLUDED = [
  /^frontend\/src\/main\.tsx$/,
  /^frontend\/src\/design-system\//,
  /^frontend\/src\/(.+\/)?types\.ts$/,
  /\.types\.ts$/,
  /^frontend\/src\/(.+\/)?index\.ts$/,
  /^frontend\/src\/(.+\/)?constants\.tsx?$/,
  /\.constants\.ts$/,
  /^frontend\/src\/features\/todos\/api\/queryKeys\.ts$/,
  /^frontend\/src\/lib\/queryClient\.ts$/,
]
const CONFIG = [
  /(^|\/)package(-lock)?\.json$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /\.config\.[cm]?[jt]s$/,
  /(^|\/)(Dockerfile|\.dockerignore|\.npmrc|\.gitignore|nginx\.conf|compose\.yaml|\.prettierrc\.json|\.prettierignore)$/,
  /(^|\/)\.env/,
  /^\.(github|storybook)\//,
  /^frontend\/\.storybook\//,
]

function appOf(path) {
  if (path.startsWith('backend/')) return 'backend'
  if (path.startsWith('frontend/')) return 'frontend'
  return 'other'
}

function kindOf(path) {
  if (isAllowedTestPath(path)) return 'test'
  if (CONTRACT_FILES.includes(path)) return 'contract'
  if (/\.md$/i.test(path) || /(^|\/)LICENSE$/.test(path)) return 'docs'
  if (CONFIG.some((pattern) => pattern.test(path))) return 'config'
  if (/^backend\/src\/.+\.ts$/.test(path)) {
    return BACKEND_EXCLUDED.some((pattern) => pattern.test(path)) ? 'excluded-source' : 'source'
  }
  if (/^frontend\/src\/.+\.tsx?$/.test(path)) {
    return FRONTEND_EXCLUDED.some((pattern) => pattern.test(path)) ? 'excluded-source' : 'source'
  }
  return 'other'
}

export function classify(path) {
  const kind = kindOf(path)
  return { app: appOf(path), kind, testable: kind === 'source' }
}
