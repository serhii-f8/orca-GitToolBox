import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffHtml } from '../panel/diff.js'

const rows = (html: string) => [...html.matchAll(/<div class="l( add| del| hunk)?">(.*?)<\/div>/g)].map((m) => ({
  kind: (m[1] ?? '').trim() || 'ctx',
  nums: [...m[2].matchAll(/<span class="ln">(\d*)<\/span>/g)].map((n) => n[1]),
  code: /<span class="code">(.*)<\/span>/.exec(m[2])?.[1] ?? ''
}))

test('removed "-- " and added "++ " lines inside a hunk are shown, not taken for headers', () => {
  const diff = [
    'diff --git a/q.sql b/q.sql',
    'index 1111111..2222222 100644',
    '--- a/q.sql',
    '+++ b/q.sql',
    '@@ -1,2 +1,2 @@',
    ' select 1;',
    '--- old comment',
    '+++ new counter',
    ''
  ].join('\n')
  const r = rows(diffHtml(diff, false))
  assert.deepEqual(r.map((x) => x.kind), ['hunk', 'ctx', 'del', 'add'])
  assert.equal(r[2].code, '--- old comment')
  assert.equal(r[3].code, '+++ new counter')
})

test('no phantom empty context row from the trailing newline', () => {
  const diff = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n x\n-y\n+z\n'
  const r = rows(diffHtml(diff, false))
  assert.deepEqual(r.map((x) => x.kind), ['hunk', 'ctx', 'del', 'add'])
  assert.deepEqual(r[1].nums, ['1', '1'])
})

test('headers of a second file are skipped again', () => {
  const diff = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/b b/b\nindex 1..2\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-c\n+d\n'
  assert.deepEqual(rows(diffHtml(diff, false)).map((x) => x.kind), ['hunk', 'del', 'add', 'hunk', 'del', 'add'])
})

test('HTML in diff lines is escaped', () => {
  const html = diffHtml('@@ -1 +1 @@\n-<b>\n+<img src=x onerror=alert(1)>\n', false)
  assert.ok(!html.includes('<img'))
  assert.ok(html.includes('&lt;img'))
})

test('binary files get a kind and size summary', async () => {
  const { binarySummary } = await import('../panel/diff.js')
  assert.equal(binarySummary('Binary files a/img/logo.png and b/img/logo.png differ', { oldSize: 2048, newSize: 3072 }), 'Binary PNG file changed · 2.0 KB → 3.0 KB (+1.0 KB)')
  assert.equal(binarySummary('Binary files /dev/null and b/blob.bin differ', { oldSize: 0, newSize: 500 }), 'Binary BIN file added · 500 B')
  assert.equal(binarySummary('Binary files a/x and /dev/null differ', { oldSize: 10, newSize: 0 }), 'Binary file deleted · 10 B')
  assert.equal(binarySummary('Binary files a/x.dat and b/x.dat differ', null), 'Binary DAT file changed')
})
