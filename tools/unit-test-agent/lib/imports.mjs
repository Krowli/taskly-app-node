import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { git } from './diff.mjs'

const SPECIFIERS = [
  /\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bimport\s+['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
]
const TEST_FILE = /(^backend\/tests\/|\.test\.tsx?$)/

function resolve(fromFile, specifier, files) {
  const base = posix.join(posix.dirname(fromFile), specifier)
  const candidates = [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
  return candidates.find((candidate) => files.has(candidate))
}

// Map of repo-relative file → repo-relative files it imports (relative imports only).
export function buildImportGraph(repoRoot) {
  const files = new Set(
    git(['ls-files', '--', 'backend/src', 'backend/tests', 'frontend/src'], repoRoot)
      .split('\n')
      .filter((path) => /\.tsx?$/.test(path)),
  )
  const graph = new Map()
  for (const file of files) {
    const source = readFileSync(posix.join(repoRoot, file), 'utf8')
    const imports = new Set()
    for (const pattern of SPECIFIERS) {
      for (const [, specifier] of source.matchAll(pattern)) {
        const target = resolve(file, specifier, files)
        if (target) imports.add(target)
      }
    }
    graph.set(file, [...imports])
  }
  return graph
}

// 1-based line where the first import in `importer` that resolves to `target` starts, or null.
// `files` is anything with `.has(path)` over tracked files (a Set, or the import graph).
export function importLineOf(repoRoot, importer, target, files) {
  const source = readFileSync(posix.join(repoRoot, importer), 'utf8')
  let first = null
  for (const pattern of SPECIFIERS) {
    // matchAll works on a copy of the regex, so the shared /g patterns keep no lastIndex state
    for (const match of source.matchAll(pattern)) {
      if (resolve(importer, match[1], files) !== target) continue
      if (first === null || match.index < first) first = match.index
      break
    }
  }
  if (first === null) return null
  // a multi-line import matches at its `from` clause; walk back to where the statement starts
  const starts = [...source.slice(0, first).matchAll(/^(?:import|export)\b/gm)]
  // (only when nothing but the import clause lies between: no quotes, i.e. no earlier specifier)
  const last = starts.at(-1)?.index
  const start = last !== undefined && !/['";]/.test(source.slice(last, first)) ? last : first
  return source.slice(0, start).split('\n').length
}

function directImporters(graph, path) {
  return [...graph].filter(([file, imports]) => !TEST_FILE.test(file) && imports.includes(path)).map(([file]) => file)
}

// Non-test files that import `path` directly, and those reached through them (depth ≤ maxDepth).
export function importersOf(graph, path, maxDepth = 3) {
  const direct = directImporters(graph, path)
  const seen = new Set([path, ...direct])
  const transitive = []
  let frontier = direct
  for (let depth = 2; depth <= maxDepth && frontier.length; depth++) {
    const next = []
    for (const file of frontier) {
      for (const importer of directImporters(graph, file)) {
        if (seen.has(importer)) continue
        seen.add(importer)
        transitive.push(importer)
        next.push(importer)
      }
    }
    frontier = next
  }
  return { direct: direct.sort(), transitive: transitive.sort() }
}

export function testsImporting(graph, path) {
  return [...graph].filter(([file, imports]) => TEST_FILE.test(file) && imports.includes(path)).map(([file]) => file).sort()
}
