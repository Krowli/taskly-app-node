// Validates the agent's patch before anything is applied or published
// (contract: plans/000 §4 and D12b). Exit code 1 when invalid.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { forbiddenAddedLine, isAllowedTestPath, isRunnableTest } from './lib/patch-rules.mjs'

const MAX_BYTES = 300 * 1024
const MAX_FILES = 30

// A hunk ends when its header's line counts are used up, so anything after it (the next
// commit's mail header, the "-- " signature of git format-patch) is never read as a change.
function openHunk(header) {
  const [, oldStart = '0', oldCount = '1', newCount = '1'] = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(header) ?? []
  return { header, lines: [], added: [], removed: [], oldStart: Number(oldStart), oldCount: Number(oldCount), oldLeft: Number(oldCount), newLeft: Number(newCount) }
}

function parsePatch(text) {
  const files = []
  let file = null
  for (const line of text.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (!header && line.startsWith('diff --git ')) {
      // e.g. git-quoted paths ("a/\303\251.ts"): never let a header we cannot read through.
      file = { unparseable: line, oldPath: '', path: '', flags: [], hunks: [], inHeader: true }
      files.push(file)
      continue
    }
    if (header) {
      file = { oldPath: header[1], path: header[2], flags: [], hunks: [], inHeader: true }
      files.push(file)
      continue
    }
    if (!file) continue
    if (file.inHeader) {
      if (line.startsWith('@@')) {
        file.inHeader = false
        file.hunks.push(openHunk(line))
      } else if (/^(new file|deleted file|old|new) mode /.test(line)) {
        file.flags.push(line)
      } else if (/^(rename|copy) (from|to) /.test(line)) {
        file.flags.push('rename')
      } else if (line === 'GIT binary patch' || line.startsWith('Binary files ')) {
        file.flags.push('binary')
      }
      continue
    }
    if (line.startsWith('@@')) {
      file.hunks.push(openHunk(line))
      continue
    }
    const hunk = file.hunks.at(-1)
    if (hunk.oldLeft <= 0 && hunk.newLeft <= 0) continue
    if (line.startsWith('+')) {
      hunk.added.push(line.slice(1))
      hunk.lines.push({ op: '+', text: line.slice(1) })
      hunk.newLeft--
    } else if (line.startsWith('-')) {
      hunk.removed.push(line.slice(1))
      hunk.lines.push({ op: '-', text: line.slice(1) })
      hunk.oldLeft--
    } else if (line.startsWith(' ') || line === '') {
      hunk.lines.push({ op: ' ', text: line.slice(1) })
      hunk.oldLeft--
      hunk.newLeft--
    }
  }
  return files
}

const COMMIT_HEADER = /^From [0-9a-f]{40} Mon Sep 17 00:00:00 2001$/gm

const NAMED_IMPORT = /^\s*import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/

function namedImport(line) {
  const match = NAMED_IMPORT.exec(line)
  return match ? { names: match[1].split(',').map((name) => name.trim()).filter(Boolean), from: match[2] } : null
}

// Adding names to an existing import (same module, nothing dropped) cannot weaken a test.
function isWidenedImport(removed, added) {
  const before = namedImport(removed)
  return Boolean(before) && added.some((line) => {
    const after = namedImport(line)
    return after?.from === before.from && before.names.every((name) => after.names.includes(name))
  })
}

// What a patch changes inside test files is read with line-based heuristics, not a parser:
// string, template-literal, regular-expression and comment text is blanked, then brackets are matched.
// Multi-line strings, regex literals after a value, and unbalanced code can mislead them.

// The code with string, template-literal, regex and comment text blanked; line breaks and columns stay.
function codeOnly(text) {
  const out = text.split('')
  const blank = (from, to) => { for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ' }
  const templates = [] // per open template literal: null in its text, else the brace depth inside its ${ }
  for (let i = 0; i < text.length;) {
    const c = text[i]
    if (templates.length && templates.at(-1) === null) {
      if (c === '`') {
        templates.pop()
        i++
        continue
      }
      const width = c === '\\' || (c === '$' && text[i + 1] === '{') ? 2 : 1
      if (c === '$' && width === 2) templates[templates.length - 1] = 0
      blank(i, i + width)
      i += width
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      const stop = end < 0 ? text.length : end
      blank(i, stop)
      i = stop
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? text.length : end + 2
      blank(i, stop)
      i = stop
      continue
    }
    if (c === "'" || c === '"' || (c === '/' && regexCanStart(out, i))) {
      let j = i + 1
      let inClass = false
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') { j += 2; continue }
        if (c === '/' && text[j] === '[') inClass = true
        else if (c === '/' && text[j] === ']') inClass = false
        else if (text[j] === c && !inClass) break
        j++
      }
      blank(i + 1, j)
      i = j + 1
      continue
    }
    if (c === '`') templates.push(null)
    else if (templates.length && c === '{') templates[templates.length - 1]++
    else if (templates.length && c === '}') {
      if (templates.at(-1) === 0) {
        blank(i, i + 1)
        templates[templates.length - 1] = null
      } else templates[templates.length - 1]--
    }
    i++
  }
  return out.join('')
}

// A "/" starts a regular expression where a value is expected, not after one (division),
// and not in JSX: `/>` and `</tag>`.
function regexCanStart(out, i) {
  if (out[i + 1] === '>' || out[i - 1] === '<') return false
  let k = i - 1
  while (k >= 0 && /\s/.test(out[k])) k--
  if (k < 0 || /[(,=:[!&|?{};+\-*%<>~^]/.test(out[k])) return true
  return /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await)$/.test(out.slice(Math.max(0, k - 10), k + 1).join(''))
}

const lastNonSpace = (code, i) => {
  let k = i - 1
  while (k >= 0 && /\s/.test(code[k])) k--
  return k
}

const CALLS = [
  ['test', /(?:^|[^\w$.])(?:it|test)(?:\s*\.\s*(?:only|skip|todo|concurrent|sequential|fails))*\s*$/],
  ['each-test', /(?:^|[^\w$.])(?:it|test)(?:\s*\.\s*\w+)*\s*\.\s*(?:each|for)\s*$/],
  ['describe', /(?:^|[^\w$.])describe(?:\s*\.\s*(?:only|skip|todo|concurrent|sequential|shuffle))*\s*$/],
  ['each-describe', /(?:^|[^\w$.])describe(?:\s*\.\s*\w+)*\s*\.\s*(?:each|for)\s*$/],
  ['hook', /(?:^|[^\w$.])(?:beforeEach|afterEach|beforeAll|afterAll)\s*$/],
  ['mock', /(?:^|[^\w$.])vi\s*\.\s*(?:mock|hoisted)\s*$/], // Vitest hoists these to the top of the file
  ['setup', /(?:^|[^\w$.])vi\s*\.\s*(?:doMock|stubGlobal|stubEnv|spyOn|useFakeTimers|setSystemTime)\s*$/],
]
const BLOCK_KINDS = ['test', 'describe', 'hook', 'mock', 'setup']

// "{" opens a function body, a conditional branch (if/else/switch/catch) or a plain block (object, loop, try).
function braceKind(code, i, lastParen) {
  const k = lastNonSpace(code, i)
  if (k < 0) return 'block'
  if (code[k] === '>' && code[k - 1] === '=') return 'function'
  // `) {` or a return type in between: `): Todo {`
  if (lastParen && lastParen.at <= k && /^\s*(?::[^;={}()]*)?$/.test(code.slice(lastParen.at + 1, i))) {
    const before = lastParen.entry.before
    if (/(?:^|[^\w$.])(?:if|switch|catch)\s*$/.test(before)) return 'cond'
    if (/(?:^|[^\w$.])(?:for|while|with)\s*$/.test(before)) return 'block'
    return /[\w$]\s*$/.test(before) ? 'function' : 'block' // function f(...) {, method(...) {
  }
  const word = /([\w$]+)$/.exec(code.slice(Math.max(0, k - 20), k + 1))?.[1]
  return word === 'else' || word === 'catch' ? 'cond' : 'block'
}

// Test, describe, hook and mock calls with their line ranges, each test's assertions and returns,
// and the file-scope statements. `broken` when the brackets did not match.
function readStructure(text) {
  const code = codeOnly(text)
  const blocks = []
  const tests = []
  const depthAt = [0] // bracket depth at the start of each line
  const conditionalLines = new Set() // the statement after a braceless if/else
  const stack = []
  let line = 1
  let lastParen = null
  let broken = false
  for (let i = 0; i < code.length; i++) {
    const c = code[i]
    if (c === '\n') {
      line++
      depthAt.push(stack.length)
    } else if (c === '(') {
      const before = code.slice(Math.max(0, i - 200), i)
      let [call] = CALLS.find(([, pattern]) => pattern.test(before)) ?? [null]
      let start = line
      // it.each(table)(name, fn): the second call is the test
      if (!call && lastParen?.at === lastNonSpace(code, i) && lastParen.entry.call?.startsWith('each-')) {
        call = lastParen.entry.call.slice('each-'.length)
        start = lastParen.entry.start
      }
      stack.push({ ch: '(', call, start, before })
    } else if (c === '{') {
      const parent = stack.at(-1)
      const entry = { ch: '{', kind: braceKind(code, i, lastParen), start: line }
      if (entry.kind === 'function' && parent?.ch === '(' && parent.call === 'test') {
        entry.test = { start: parent.start, end: line, assertions: [], returns: [] }
        tests.push(entry.test)
      }
      stack.push(entry)
    } else if (c === '[') {
      stack.push({ ch: '[' })
    } else if (c === ')' || c === '}' || c === ']') {
      const open = { ')': '(', '}': '{', ']': '[' }[c]
      while (stack.length && stack.at(-1).ch !== open) {
        stack.pop()
        broken = true
      }
      const entry = stack.pop()
      if (!entry) {
        broken = true
        continue
      }
      if (entry.ch === '(') {
        lastParen = { entry, at: i }
        if (BLOCK_KINDS.includes(entry.call)) blocks.push({ kind: entry.call, start: entry.start, end: line })
        if (/(?:^|[^\w$.])if\s*$/.test(entry.before)) markBraceless(i + 1)
      } else if (entry.ch === '{') {
        if (entry.kind === 'function') blocks.push({ kind: 'function', start: entry.start, end: line })
        if (entry.test) entry.test.end = line
      }
    } else if (/[A-Za-z_$]/.test(c) && !/[\w$.]/.test(code[i - 1] ?? '')) {
      const rest = code.slice(i, i + 40)
      if (/^(?:expect|assert)\w*\s*[.(]/.test(rest)) {
        let conditional = conditionalLines.has(line)
        for (const entry of [...stack].reverse()) {
          if (entry.kind === 'cond') conditional = true
          if (entry.test) {
            entry.test.assertions.push({ line, conditional })
            break
          }
        }
      } else if (/^return\b/.test(rest)) {
        const fn = [...stack].reverse().find((entry) => entry.kind === 'function')
        fn?.test?.returns.push(line)
      } else if (/^else\b/.test(rest)) {
        markBraceless(i + 4)
      }
    }
  }
  if (stack.length) broken = true

  // `if (x) expect(y)` or `else expect(y)`: the rest of the line, or the next line, is conditional.
  function markBraceless(from) {
    let k = from
    while (k < code.length && (code[k] === ' ' || code[k] === '\t')) k++
    if (code[k] === '{' || code.startsWith('if', k)) return
    conditionalLines.add(code[k] === '\n' || k >= code.length ? line + 1 : line)
  }

  // File-scope statements: from a line at depth 0 to the next one that does not continue it.
  const lines = code.split('\n')
  const statements = []
  let current = null
  lines.forEach((content, index) => {
    if (!content.trim()) return
    const continues = current && (depthAt[index] > 0 || /^\s*[.?)\]}]/.test(content) || /(?:[=,([{+\-*/?:&|]|=>)\s*$/.test(lines[current.end - 1]))
    if (continues) current.end = index + 1
    else statements.push((current = { start: index + 1, end: index + 1 }))
  })
  return { lines, blocks, tests, statements, broken }
}

// The new text of a file and which of its lines (1-based) the patch added; null when the hunks do not
// fit the original (then the original is not the file the patch was made from).
function applyHunks(original, hunks) {
  const old = original.split('\n')
  const lines = []
  const added = new Set()
  let pos = 0
  for (const hunk of hunks) {
    const start = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1
    if (start < pos || start > old.length) return null
    while (pos < start) lines.push(old[pos++])
    for (const { op, text } of hunk.lines) {
      if (op === '+') {
        lines.push(text)
        added.add(lines.length)
        continue
      }
      if (old[pos] !== text) return null
      if (op === ' ') lines.push(text)
      pos++
    }
  }
  while (pos < old.length) lines.push(old[pos++])
  return { text: lines.join('\n'), added }
}

const TRIVIAL = /^[\s)\]};,]*$/ // blank, comment-only or only closing brackets
const DECLARATION = /^\s*(?:export\s+)?(?:declare\s+)?(?:import\b|(?:async\s+)?function\b|class\b|type\b|interface\b|enum\b|const\b|let\b|var\b)/
const VALUE_DECLARATION = /^\s*(?:export\s+)?(?:const|let|var)\b/
const FUNCTION_VALUE = /^\s*(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\b|(?:<[^>]*>\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]*)?=>)/
const IMPORT_SPECIFIER = /^\s*(?:type\s+)?[\w$]+(?:\s+as\s+[\w$]+)?\s*,?\s*$/

// Whether the added lines of an existing test file do more than add new test cases: new `it`/`test`/`describe`
// blocks (anywhere but inside an existing test or hook), new file-scope imports and declarations, and names
// added to an existing import are additions; any other added line changes how existing tests run.
function changesExistingTests({ lines, blocks, statements }, added) {
  const isAdded = (n) => added.has(n)
  const trivial = (n) => TRIVIAL.test(lines[n - 1] ?? '')
  const contains = (outer, n) => outer.start <= n && n <= outer.end
  // Wholly new code; git may count an old closing line as part of it.
  const isNewCode = (range) => {
    if (!isAdded(range.start)) return false
    for (let n = range.start; n <= range.end; n++) if (!isAdded(n) && !trivial(n)) return false
    return true
  }
  if (blocks.some((block) => block.kind === 'mock' && isAdded(block.start))) return true
  const existing = blocks.filter((block) => ['test', 'hook', 'mock', 'setup'].includes(block.kind) && !isAdded(block.start))
  const newCases = blocks.filter((block) => ['test', 'describe'].includes(block.kind) && isNewCode(block) && !existing.some((old) => contains(old, block.start)))
  const runsAtLoad = (statement) => blocks.some((block) => ['hook', 'mock', 'setup'].includes(block.kind) && contains(statement, block.start)
    && !blocks.some((fn) => fn.kind === 'function' && contains(statement, fn.start) && fn.start <= block.start && block.end <= fn.end))
  const isNewDeclaration = (statement) => {
    const first = lines[statement.start - 1]
    if (!isNewCode(statement) || !DECLARATION.test(first)) return false
    return !VALUE_DECLARATION.test(first) || FUNCTION_VALUE.test(first) || !runsAtLoad(statement)
  }
  for (const n of added) {
    if (trivial(n) || newCases.some((block) => contains(block, n))) continue
    const statement = statements.find((s) => contains(s, n))
    if (statement && isNewDeclaration(statement)) continue
    if (statement && !isAdded(statement.start) && /^\s*import\b/.test(lines[statement.start - 1]) && IMPORT_SPECIFIER.test(lines[n - 1])) continue
    return true
  }
  return false
}

// Weakening patterns in added test code: an early exit, or assertions that only run on one branch.
function weakenedTests({ tests }, added) {
  const findings = []
  for (const test of tests) {
    const last = Math.max(0, ...test.assertions.map((assertion) => assertion.line))
    for (const line of test.returns) if (added.has(line) && line < last) findings.push([line, "returns before the test's assertions (heuristic)"])
    const touched = [test.start, ...test.assertions.map((assertion) => assertion.line)].some((line) => added.has(line))
    if (touched && test.assertions.length && test.assertions.every((assertion) => assertion.conditional)) {
      findings.push([test.start, 'asserts only inside a conditional or catch (heuristic)'])
    }
  }
  return findings
}

function isChangedSourceLine(manifest, sourceRef) {
  const match = /^(.+):(\d+)$/.exec(sourceRef ?? '')
  if (!match) return false
  const [, path, line] = match
  const file = manifest.files.find((entry) => entry.path === path)
  if (!file || !['source', 'excluded-source'].includes(file.kind) || file.status === 'D') return false
  return file.changedLines.some(([start, end]) => Number(line) >= start && Number(line) <= end)
}

// `original(path)` returns an existing file's text before the patch; without it, any edit of an
// existing test file counts as a change to its tests (fails closed).
export function validatePatch(text, { manifest, agentOutput, original } = {}) {
  const violations = []
  const files = parsePatch(text)
  if (Buffer.byteLength(text) > MAX_BYTES) violations.push(`patch is larger than ${MAX_BYTES} bytes`)
  if (files.length > MAX_FILES) violations.push(`patch touches more than ${MAX_FILES} files`)
  const commits = text.match(COMMIT_HEADER)?.length ?? 0
  if (commits > 1) violations.push(`patch has ${commits} commits; the agent must make exactly one`)

  let addedLines = 0
  const changedExisting = []
  for (const file of files) {
    if (file.unparseable) {
      violations.push(`unparseable diff header: ${file.unparseable.slice(0, 200)}`)
      continue
    }
    for (const path of new Set([file.oldPath, file.path])) {
      if (!isAllowedTestPath(path)) violations.push(`not an allowed test path: ${path}`)
    }
    for (const flag of file.flags) {
      if (flag.startsWith('deleted file')) violations.push(`${file.path}: deletes a file`)
      else if (flag === 'rename') violations.push(`${file.path}: renames or copies a file`)
      else if (flag === 'binary') violations.push(`${file.path}: binary content`)
      else if (!/^new file mode 100644$/.test(flag)) violations.push(`${file.path}: changes file mode (${flag})`)
    }
    const isNew = file.flags.some((flag) => flag.startsWith('new file'))
    const before = isNew ? '' : original?.(file.path)
    const rebuilt = typeof before === 'string' ? applyHunks(before, file.hunks) : null
    const structure = rebuilt && readStructure(rebuilt.text)
    let newLine = 0
    for (const hunk of file.hunks) {
      newLine = Number(/\+(\d+)/.exec(hunk.header)?.[1] ?? 0)
      for (const added of hunk.added) {
        addedLines++
        const reason = forbiddenAddedLine(added)
        if (reason) violations.push(`${file.path}:${newLine} ${reason}`)
        newLine++
      }
    }
    if (structure) for (const [line, reason] of weakenedTests(structure, rebuilt.added)) violations.push(`${file.path}:${line} ${reason}`)
    if (isNew || !file.hunks.length || !isAllowedTestPath(file.path)) continue
    // Shared helpers and setup files run under existing tests, so any edit of one changes them. In a test file,
    // a modified or removed line can weaken a test (assertion or input); added lines only when they are not new test cases.
    const changesOldTests = !isRunnableTest(file.path) || !structure || structure.broken
      || file.hunks.some((hunk) => hunk.removed.some((line) => !isWidenedImport(line, hunk.added)))
      || changesExistingTests(structure, rebuilt.added)
    if (changesOldTests) changedExisting.push(file.path)
  }

  const assertionAudit = { changedExisting: changedExisting.length, justified: 0, unjustified: [] }
  if (manifest?.mode === 'coverage') {
    for (const path of changedExisting) {
      assertionAudit.unjustified.push(path)
      violations.push(`coverage mode: existing test file ${path} must not change (only new test cases may be added)`)
    }
  } else if (manifest) {
    for (const path of changedExisting) {
      const justified = (agentOutput?.assertionChanges ?? []).some(
        (change) => change.testFile === path && isChangedSourceLine(manifest, change.sourceRef),
      )
      if (justified) assertionAudit.justified++
      else {
        assertionAudit.unjustified.push(path)
        violations.push(`unjustified assertion change in ${path}: no assertionChanges entry citing a changed source line`)
      }
    }
  }

  return { valid: violations.length === 0, files: files.map((file) => file.path), addedLines, violations, assertionAudit }
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { manifest: { type: 'string' }, 'agent-output': { type: 'string' }, 'original-rev': { type: 'string' }, out: { type: 'string' } },
  })
  const readJson = (path) => (path ? JSON.parse(readFileSync(path, 'utf8')) : undefined)
  // --original-rev <commit id>: existing files are read from that commit of the repository in the working directory.
  // Anything but a commit id reads nothing, so every edit of an existing test file counts as a change.
  const rev = values['original-rev']
  const original = /^[0-9a-f]{7,64}$/i.test(rev ?? '') && ((path) => {
    const shown = spawnSync('git', ['show', `${rev}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return shown.status === 0 ? shown.stdout : undefined
  })
  const result = validatePatch(readFileSync(positionals[0], 'utf8'), {
    manifest: readJson(values.manifest),
    agentOutput: readJson(values['agent-output']),
    original: original || undefined,
  })
  const json = `${JSON.stringify(result, null, 2)}\n`
  if (values.out) writeFileSync(values.out, json)
  else process.stdout.write(json)
  if (!result.valid) {
    console.error(result.violations.join('\n'))
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main()
