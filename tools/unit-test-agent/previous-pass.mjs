// Continuation pass: the earlier pass's per-file reasons (its untrusted agent-output.json) for the files the
// new manifest still lists, as plain-text lines the agent reads as data. Only file and reason are kept.
// Usage: node previous-pass.mjs <agent-output.json> --manifest <manifest.json> --out <previous-pass.md>
// Writes nothing when the claims file is missing or unreadable, or when no listed file has a reason.
import { readFileSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { clean } from './render-comment.mjs'

export function previousPassNotes(agentOutput, { files, max = 4000 }) {
  const left = new Set(files)
  const decisions = Array.isArray(agentOutput?.decisions) ? agentOutput.decisions : []
  let notes = ''
  for (const d of decisions) {
    if (!left.has(d?.file) || !d.reason) continue
    const line = `- ${clean(d.file, 200)}: ${clean(d.reason)}\n`
    if (Buffer.byteLength(notes + line) > max) break
    notes += line
  }
  return notes
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { manifest: { type: 'string' }, out: { type: 'string' } } })
  const files = JSON.parse(readFileSync(values.manifest, 'utf8')).files.map((f) => f.path)
  let claims = null
  try {
    claims = JSON.parse(readFileSync(positionals[0], 'utf8'))
  } catch (error) {
    console.log(`No notes from the earlier pass: ${error.message}`)
  }
  const notes = claims ? previousPassNotes(claims, { files }) : ''
  if (notes) writeFileSync(values.out, notes)
  console.log(`Notes from the earlier pass: ${notes ? `${notes.split('\n').length - 1} files` : 'none'}`)
}
