import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGraph, layoutGraph } from '../panel/graph.js'

test('linear history stays in one lane', () => {
  const rows = layoutGraph([
    { hash: 'c', parents: ['b'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] }
  ])
  assert.deepEqual(rows.map((r) => r.col), [0, 0, 0])
  assert.equal(rows[0].hasTop, false)
  assert.equal(rows[1].hasTop, true)
  assert.deepEqual(rows[2].parents, [])
})

test('a merge opens a second lane that closes at the fork point', () => {
  // m merges f into d; both come from a.
  const rows = layoutGraph([
    { hash: 'm', parents: ['d', 'f'] },
    { hash: 'd', parents: ['a'] },
    { hash: 'f', parents: ['a'] },
    { hash: 'a', parents: [] }
  ])
  assert.deepEqual(rows.map((r) => r.col), [0, 0, 1, 0])
  assert.deepEqual(rows[0].parents.map((p) => p.to), [0, 1])
  // d runs in lane 0 while f's lane passes by
  assert.deepEqual(rows[1].passes.map((p) => p.col), [1])
  // f joins lane 0, which already waits for a
  assert.deepEqual(rows[2].parents.map((p) => p.to), [0])
  assert.equal(rows[3].width, 1)
})

test('two branch tips converge into their shared parent', () => {
  const rows = layoutGraph([
    { hash: 'x', parents: ['a'] },
    { hash: 'y', parents: ['a'] },
    { hash: 'a', parents: [] }
  ])
  assert.deepEqual(rows.map((r) => r.col), [0, 1, 0])
  assert.deepEqual(rows[1].parents, [{ to: 0, color: rows[1].color }])
})

test('appending a page keeps earlier rows unchanged', () => {
  const commits = [
    { hash: 'm', parents: ['d', 'f'] },
    { hash: 'd', parents: ['a'] },
    { hash: 'f', parents: ['a'] },
    { hash: 'a', parents: [] }
  ]
  const whole = layoutGraph(commits)
  const g = createGraph()
  const paged = [...g.add(commits.slice(0, 2)), ...g.add(commits.slice(2))]
  assert.deepEqual(paged, whole)
})
