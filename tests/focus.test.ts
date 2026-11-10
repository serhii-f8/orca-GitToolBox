import { test } from 'node:test'
import assert from 'node:assert/strict'
import { focusCandidates, matchFocused } from '../worker/main.mjs'

const ws = [
  { id: 'a', name: 'master', branch: 'refs/heads/master', path: '/p1' },
  { id: 'b', name: 'master', branch: 'master', path: '/p2' },
  { id: 'c', name: 'feature', branch: 'feature', path: '/p3' }
]

test('every workspace with the focused name and branch is a candidate', () => {
  assert.deepEqual(focusCandidates(ws, { displayName: 'master', branch: 'master' }), ['a', 'b'])
  assert.deepEqual(focusCandidates(ws, { displayName: 'feature', branch: 'feature' }), ['c'])
  assert.deepEqual(focusCandidates(ws, null), [])
})

test('an ambiguous focus is not guessed; a preferred candidate breaks the tie', () => {
  const ctx = { displayName: 'master', branch: 'master' }
  assert.equal(matchFocused(ws, ctx), null)
  assert.equal(matchFocused(ws, ctx, 'b'), 'b')
  assert.equal(matchFocused(ws, ctx, 'c'), null)
  assert.equal(matchFocused(ws, { displayName: 'feature', branch: 'feature' }), 'c')
})
