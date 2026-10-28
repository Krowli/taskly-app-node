import { execFileSync } from 'node:child_process'

const REF = /^(HEAD(~\d+)?|[0-9a-f]{7,40})$/

export function assertRef(ref) {
  if (typeof ref !== 'string' || !REF.test(ref)) throw new Error(`Invalid git ref: ${JSON.stringify(ref)}`)
  return ref
}

export function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

export function parseNameStatus(text) {
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [code, first, second] = line.split('\t')
      const status = code[0]
      return status === 'R' ? { status, path: second, oldPath: first } : { status, path: first }
    })
}

// Parses `git diff -U0` output into per-file new-side line ranges plus the text of
// added lines (new line numbers) and removed lines (old line numbers).
export function parseFileDiffs(text) {
  const files = new Map()
  let current = null
  let oldPath = null
  let nextLine = 0
  let nextOldLine = 0
  let inHeader = false
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null
      oldPath = null
      inHeader = true
    } else if (inHeader && line.startsWith('--- ')) {
      oldPath = line === '--- /dev/null' ? null : line.slice('--- a/'.length)
    } else if (inHeader && line.startsWith('+++ ')) {
      const path = line === '+++ /dev/null' ? oldPath : line.slice('+++ b/'.length)
      current = { ranges: [], added: [], removed: [] }
      files.set(path, current)
    } else if (current && line.startsWith('@@')) {
      inHeader = false
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
      const start = Number(match[2])
      const count = match[3] === undefined ? 1 : Number(match[3])
      if (count > 0) current.ranges.push([start, start + count - 1])
      nextLine = start
      nextOldLine = Number(match[1])
    } else if (current && line.startsWith('+')) {
      current.added.push({ line: nextLine++, text: line.slice(1) })
    } else if (current && line.startsWith('-')) {
      current.removed.push({ line: nextOldLine++, text: line.slice(1) })
    }
  }
  return files
}
