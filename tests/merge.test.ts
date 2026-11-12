import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  splitLines,
  diffLines,
  buildRegions,
  createMerge,
  take,
  ignore,
  setManual,
  applyNonConflicting,
  chunkText,
  isResolved,
  counts,
  resultText,
  hasConflictMarkers
} from '../panel/merge.js'

const chunks = (regions) => regions.filter((r) => r.type === 'chunk')

test('splitLines keeps terminators', () => {
  assert.deepEqual(splitLines('a\r\nb\nc'), ['a\r\n', 'b\n', 'c'])
  assert.deepEqual(splitLines(''), [])
  assert.deepEqual(splitLines('a\n'), ['a\n'])
})

test('diffLines finds a replaced line', () => {
  assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'x', 'c']), [{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }])
  assert.deepEqual(diffLines(['a'], ['a', 'b']), [{ aStart: 1, aEnd: 1, bStart: 1, bEnd: 2 }])
  assert.deepEqual(diffLines([], []), [])
})

test('regions for one-sided, same and conflicting edits', () => {
  const base = '1\n2\n3\n4\n5\n6\n7\n8\n9\n'
  const ours = '1\nA\n3\n4\n5\nS\n7\n8\nO\n'
  const theirs = '1\n2\n3\nT\n5\nS\n7\n8\nX\n'
  const r = buildRegions(base, ours, theirs)
  assert.deepEqual(
    chunks(r).map((c) => c.kind),
    ['ours', 'theirs', 'same', 'conflict']
  )
  const c = chunks(r)
  assert.deepEqual(c[0].ours, ['A\n'])
  assert.deepEqual(c[0].theirs, ['2\n'])
  assert.deepEqual(c[3].base, ['9\n'])
  assert.deepEqual(c[3].ours, ['O\n'])
  assert.deepEqual(c[3].theirs, ['X\n'])
  // Every region together reproduces the base on the base side.
  assert.equal(r.map((x) => (x.type === 'equal' ? x.lines : x.base).join('')).join(''), base)
})

test('edits on adjacent lines conflict, as in git', () => {
  const r = buildRegions('a\nb\nc\n', 'a\nB\nc\n', 'a\nb\nC\n')
  assert.deepEqual(chunks(r).map((c) => c.kind), ['conflict'])
})

test('insertions at the same base point conflict', () => {
  const r = buildRegions('a\nb\n', 'a\nX\nb\n', 'a\nY\nb\n')
  assert.deepEqual(chunks(r).map((c) => c.kind), ['conflict'])
  assert.deepEqual(chunks(r)[0].base, [])
})

test('take then take other side appends', () => {
  const m = createMerge(buildRegions('a\nb\nc\n', 'a\nO\nc\n', 'a\nT\nc\n'))
  const i = m.regions.findIndex((r) => r.type === 'chunk')
  assert.deepEqual(chunkText(m, i), ['b\n'])
  assert.equal(isResolved(m, i), false)
  take(m, i, 'theirs')
  assert.deepEqual(chunkText(m, i), ['T\n'])
  assert.equal(isResolved(m, i), false)
  take(m, i, 'ours')
  assert.deepEqual(chunkText(m, i), ['T\n', 'O\n'])
  assert.equal(isResolved(m, i), true)
  assert.equal(resultText(m), 'a\nT\nO\nc\n')
})

test('ignore resolves without changing text', () => {
  const m = createMerge(buildRegions('a\nb\nc\n', 'a\nO\nc\n', 'a\nT\nc\n'))
  const i = m.regions.findIndex((r) => r.type === 'chunk')
  take(m, i, 'ours')
  ignore(m, i, 'theirs')
  assert.equal(isResolved(m, i), true)
  assert.equal(resultText(m), 'a\nO\nc\n')
  assert.deepEqual(counts(m), { conflicts: 0, changes: 0 })
})

test('applyNonConflicting resolves only one-sided', () => {
  const m = createMerge(buildRegions('1\n2\n3\n4\n5\n', '1\nA\n3\n4\nO\n', '1\n2\n3\nT\nX\n'))
  assert.deepEqual(counts(m), { conflicts: 1, changes: 1 })
  applyNonConflicting(m)
  assert.deepEqual(counts(m), { conflicts: 1, changes: 0 })
  assert.equal(resultText(m), '1\nA\n3\n4\n5\n')
})

test('same change on both sides starts resolved with that text', () => {
  const m = createMerge(buildRegions('a\nb\n', 'a\nS\n', 'a\nS\n'))
  assert.deepEqual(counts(m), { conflicts: 0, changes: 0 })
  assert.equal(resultText(m), 'a\nS\n')
})

test('manual edit resolves the chunk and blocks later takes', () => {
  const m = createMerge(buildRegions('a\nb\nc\n', 'a\nO\nc\n', 'a\nT\nc\n'))
  const i = m.regions.findIndex((r) => r.type === 'chunk')
  setManual(m, i, ['mine\n'])
  assert.equal(isResolved(m, i), true)
  take(m, i, 'ours')
  assert.equal(resultText(m), 'a\nmine\nc\n')
})

test('keeps CRLF and missing final newline', () => {
  const base = 'a\r\nb\r\nm\r\nc'
  const ours = 'a\r\nO\r\nm\r\nc'
  const theirs = 'a\r\nb\r\nm\r\nT'
  const m = createMerge(buildRegions(base, ours, theirs))
  applyNonConflicting(m)
  assert.equal(resultText(m), 'a\r\nO\r\nm\r\nT')
})

test('identical files give one equal region', () => {
  const r = buildRegions('a\nb\n', 'a\nb\n', 'a\nb\n')
  assert.equal(chunks(r).length, 0)
})

test('hasConflictMarkers', () => {
  assert.equal(hasConflictMarkers('a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\n'), true)
  assert.equal(hasConflictMarkers('a\n  <<<<<<< not at start\n'), false)
  assert.equal(hasConflictMarkers('plain\n'), false)
})

test('diffLines hunks rebuild the other side for random inputs', () => {
  let seed = 7
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
  for (let t = 0; t < 300; t++) {
    const a = Array.from({ length: rnd(30) }, () => 'abcde'[rnd(5)])
    const b = Array.from({ length: rnd(30) }, () => 'abcde'[rnd(5)])
    const out = []
    let p = 0
    for (const h of diffLines(a, b)) {
      out.push(...a.slice(p, h.aStart), ...b.slice(h.bStart, h.bEnd))
      p = h.aEnd
    }
    out.push(...a.slice(p))
    assert.deepEqual(out, b)
  }
})
