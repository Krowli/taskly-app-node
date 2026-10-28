import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertRef, parseFileDiffs, parseNameStatus } from '../../lib/diff.mjs'

test('parses name-status output including renames', () => {
  const text = 'M\tbackend/src/factory.ts\nA\tfrontend/src/x.ts\nD\tREADME.md\nR087\told/a.ts\tnew/a.ts\n'
  assert.deepEqual(parseNameStatus(text), [
    { status: 'M', path: 'backend/src/factory.ts' },
    { status: 'A', path: 'frontend/src/x.ts' },
    { status: 'D', path: 'README.md' },
    { status: 'R', path: 'new/a.ts', oldPath: 'old/a.ts' },
  ])
})

const ZERO_CONTEXT_DIFF = `diff --git a/backend/src/features/todos/validators.ts b/backend/src/features/todos/validators.ts
index 1111111..2222222 100644
--- a/backend/src/features/todos/validators.ts
+++ b/backend/src/features/todos/validators.ts
@@ -4 +4 @@ const fields = {
-  title: z.string().trim().min(1).max(120),
+  title: z.string().trim().min(1).max(200),
@@ -10,2 +9,0 @@ export const x = 1
-const a = 1
-const b = 2
@@ -20,0 +20,3 @@ export const y = 2
+const c = 3
+const d = 4
+const e = 5
diff --git a/README.md b/README.md
deleted file mode 100644
--- a/README.md
+++ /dev/null
@@ -1,2 +0,0 @@
-# Title
-text
`

test('parses changed line ranges and the text of added and removed lines', () => {
  const files = parseFileDiffs(ZERO_CONTEXT_DIFF)
  assert.deepEqual(files.get('backend/src/features/todos/validators.ts'), {
    ranges: [[4, 4], [20, 22]],
    added: [
      { line: 4, text: '  title: z.string().trim().min(1).max(200),' },
      { line: 20, text: 'const c = 3' },
      { line: 21, text: 'const d = 4' },
      { line: 22, text: 'const e = 5' },
    ],
    removed: [
      { line: 4, text: '  title: z.string().trim().min(1).max(120),' },
      { line: 10, text: 'const a = 1' },
      { line: 11, text: 'const b = 2' },
    ],
  })
  assert.deepEqual(files.get('README.md'), {
    ranges: [],
    added: [],
    removed: [{ line: 1, text: '# Title' }, { line: 2, text: 'text' }],
  })
})

test('accepts only commit-like refs before passing them to git', () => {
  for (const ref of ['HEAD', 'HEAD~1', '22be6e3', '3d3c42e5aac5ba805825da76410c181273ba90b1']) {
    assert.doesNotThrow(() => assertRef(ref), ref)
  }
  for (const ref of ['--output=/tmp/x', 'main; rm -rf /', '', 'a b']) {
    assert.throws(() => assertRef(ref), /Invalid git ref/, ref)
  }
})

test('does not mistake removed or added lines that look like file headers for headers', () => {
  const text = `diff --git a/backend/src/core/database.ts b/backend/src/core/database.ts
--- a/backend/src/core/database.ts
+++ b/backend/src/core/database.ts
@@ -5 +5 @@
--- old SQL comment
+++ new SQL comment
`
  assert.deepEqual(parseFileDiffs(text).get('backend/src/core/database.ts'), {
    ranges: [[5, 5]],
    added: [{ line: 5, text: '++ new SQL comment' }],
    removed: [{ line: 5, text: '-- old SQL comment' }],
  })
})
