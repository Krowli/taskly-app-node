// Helpers over Istanbul-format coverage written by @vitest/coverage-v8
// (`coverage-final.json`, `coverage-summary.json`).

export function uncoveredLines(coverageFinal, absPath) {
  const entry = coverageFinal[absPath]
  if (!entry) return []
  const lines = new Set()
  for (const [id, hits] of Object.entries(entry.s)) {
    if (hits > 0) continue
    const { start, end } = entry.statementMap[id]
    for (let line = start.line; line <= end.line; line++) lines.add(line)
  }
  return [...lines].sort((a, b) => a - b)
}

// Lines of branch paths (if/else arms, ternaries, `&&`, defaults) that never ran.
export function uncoveredBranchLines(coverageFinal, absPath) {
  const entry = coverageFinal[absPath]
  if (!entry?.branchMap) return []
  const lines = new Set()
  for (const [id, hits] of Object.entries(entry.b ?? {})) {
    const branch = entry.branchMap[id]
    hits.forEach((count, index) => {
      if (count > 0) return
      lines.add(branch.locations?.[index]?.start?.line ?? branch.loc.start.line)
    })
  }
  return [...lines].sort((a, b) => a - b)
}

export function uncoveredFunctions(coverageFinal, absPath) {
  const entry = coverageFinal[absPath]
  if (!entry?.fnMap) return []
  return Object.entries(entry.f ?? {})
    .filter(([, hits]) => hits === 0)
    .map(([id]) => ({ name: entry.fnMap[id].name, line: (entry.fnMap[id].decl ?? entry.fnMap[id].loc).start.line }))
    .sort((a, b) => a.line - b.line)
}

// Lines that hold any statement, covered or not: the lines coverage can speak about.
export function statementLines(coverageFinal, absPath) {
  const entry = coverageFinal[absPath]
  if (!entry) return []
  const lines = new Set()
  for (const { start, end } of Object.values(entry.statementMap)) {
    for (let line = start.line; line <= end.line; line++) lines.add(line)
  }
  return [...lines].sort((a, b) => a - b)
}

export function toRanges(lines) {
  const ranges = []
  for (const line of [...lines].sort((a, b) => a - b)) {
    const last = ranges.at(-1)
    if (last && line <= last[1] + 1) last[1] = Math.max(last[1], line)
    else ranges.push([line, line])
  }
  return ranges
}

export function intersect(ranges, lines) {
  return toRanges(lines.filter((line) => ranges.some(([start, end]) => line >= start && line <= end)))
}

export function countLines(ranges) {
  return ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0)
}

export function summarize(summary) {
  const { lines, statements, functions, branches } = summary.total
  return { lines: lines.pct, statements: statements.pct, functions: functions.pct, branches: branches.pct }
}
