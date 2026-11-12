// Three-way merge model for the merge view: aligns base, yours and theirs into regions and tracks
// how each conflicting or one-sided chunk is resolved. Pure: shared by the panel and the tests.

/**
 * Splits text into lines that keep their terminators, so joining them gives the exact bytes back
 * (CRLF, and a last line without a newline, survive).
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/**
 * Myers O(ND) line diff. Returns the changed ranges as half-open hunks.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {{ aStart: number; aEnd: number; bStart: number; bEnd: number }[]}
 */
export function diffLines(a, b) {
  // Trim the common prefix and suffix: cheap, and most merges touch a small part of a file.
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const A = a.slice(pre, a.length - suf)
  const B = b.slice(pre, b.length - suf)
  const matches = myersMatches(A, B)
  /** @type {{ aStart: number; aEnd: number; bStart: number; bEnd: number }[]} */
  const hunks = []
  let x = 0
  let y = 0
  for (const [mx, my] of [...matches, [A.length, B.length]]) {
    if (mx > x || my > y) hunks.push({ aStart: x + pre, aEnd: mx + pre, bStart: y + pre, bEnd: my + pre })
    x = mx + 1
    y = my + 1
  }
  return hunks
}

/** @param {string[]} a @param {string[]} b @returns {[number, number][]} matched index pairs, in order */
function myersMatches(a, b) {
  const n = a.length
  const m = b.length
  if (!n || !m) return []
  const max = n + m
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  /** @type {Int32Array[]} */
  const trace = []
  let end = -1
  for (let d = 0; d <= max && end < 0; d++) {
    trace.push(v.slice(off - d, off + d + 1))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) {
        end = d
        break
      }
    }
  }
  /** @type {[number, number][]} */
  const out = []
  let x = n
  let y = m
  for (let d = end; d > 0; d--) {
    const V = trace[d]
    const at = (k) => V[k + d]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) out.push([--x, --y])
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) out.push([--x, --y])
  return out.reverse()
}

/**
 * @typedef {{ type: 'equal'; lines: string[] }} EqualRegion
 * @typedef {{ type: 'chunk'; kind: 'ours' | 'theirs' | 'same' | 'conflict'; base: string[]; ours: string[]; theirs: string[] }} ChunkRegion
 * @typedef {EqualRegion | ChunkRegion} Region
 */

/**
 * @param {string} base
 * @param {string} ours
 * @param {string} theirs
 * @returns {Region[]}
 */
export function buildRegions(base, ours, theirs) {
  const B = splitLines(base)
  const sides = { ours: splitLines(ours), theirs: splitLines(theirs) }
  const hunks = [
    ...diffLines(B, sides.ours).map((h) => ({ ...h, side: /** @type {const} */ ('ours') })),
    ...diffLines(B, sides.theirs).map((h) => ({ ...h, side: /** @type {const} */ ('theirs') }))
  ].sort((p, q) => p.aStart - q.aStart || p.aEnd - q.aEnd)

  /** @type {Region[]} */
  const regions = []
  let pos = 0
  for (let i = 0; i < hunks.length; ) {
    const gs = hunks[i].aStart
    let ge = hunks[i].aEnd
    const group = [hunks[i++]]
    // Hunks that overlap or touch (from the other side) belong to the same chunk.
    while (i < hunks.length && hunks[i].aStart <= ge) {
      ge = Math.max(ge, hunks[i].aEnd)
      group.push(hunks[i++])
    }
    if (gs > pos) regions.push({ type: 'equal', lines: B.slice(pos, gs) })
    const sideLines = (side) => {
      const out = []
      let p = gs
      for (const h of group) {
        if (h.side !== side) continue
        out.push(...B.slice(p, h.aStart), ...sides[side].slice(h.bStart, h.bEnd))
        p = h.aEnd
      }
      out.push(...B.slice(p, ge))
      return out
    }
    const o = sideLines('ours')
    const t = sideLines('theirs')
    const hasO = group.some((h) => h.side === 'ours')
    const hasT = group.some((h) => h.side === 'theirs')
    const kind = hasO && hasT ? (o.join('') === t.join('') ? 'same' : 'conflict') : hasO ? 'ours' : 'theirs'
    regions.push({ type: 'chunk', kind, base: B.slice(gs, ge), ours: o, theirs: t })
    pos = ge
  }
  if (pos < B.length) regions.push({ type: 'equal', lines: B.slice(pos) })
  return regions
}

/**
 * @typedef {'pending' | 'taken' | 'ignored' | 'none'} SideState
 * @typedef {{ ours: SideState; theirs: SideState; order: ('ours' | 'theirs')[]; manual: string[] | null }} RegionState
 * @typedef {{ regions: Region[]; state: RegionState[] }} Merge
 */

/** @param {Region[]} regions @returns {Merge} */
export function createMerge(regions) {
  return {
    regions,
    state: regions.map((r) => {
      if (r.type === 'equal') return { ours: 'none', theirs: 'none', order: [], manual: null }
      if (r.kind === 'same') return { ours: 'taken', theirs: 'ignored', order: ['ours'], manual: null }
      return {
        ours: r.kind === 'theirs' ? 'none' : 'pending',
        theirs: r.kind === 'ours' ? 'none' : 'pending',
        order: [],
        manual: null
      }
    })
  }
}

/** @param {Merge} m @param {number} i @param {'ours' | 'theirs'} side */
export function take(m, i, side) {
  const s = m.state[i]
  if (!s || s.manual || s[side] !== 'pending') return
  s[side] = 'taken'
  s.order.push(side)
}

/** @param {Merge} m @param {number} i @param {'ours' | 'theirs'} side */
export function ignore(m, i, side) {
  const s = m.state[i]
  if (!s || s.manual || s[side] !== 'pending') return
  s[side] = 'ignored'
}

/** Text the user typed over a region; resolves a chunk. @param {Merge} m @param {number} i @param {string[]} lines */
export function setManual(m, i, lines) {
  m.state[i].manual = lines
}

/** @param {Merge} m */
export function applyNonConflicting(m) {
  m.regions.forEach((r, i) => {
    if (r.type !== 'chunk' || r.kind === 'conflict' || r.kind === 'same') return
    take(m, i, r.kind)
  })
}

/** Current Result lines of a region. @param {Merge} m @param {number} i @returns {string[]} */
export function chunkText(m, i) {
  const r = m.regions[i]
  const s = m.state[i]
  if (s.manual) return s.manual
  if (r.type === 'equal') return r.lines
  return s.order.length ? s.order.flatMap((side) => r[side]) : r.base
}

/** @param {Merge} m @param {number} i */
export function isResolved(m, i) {
  const s = m.state[i]
  return !!s.manual || (s.ours !== 'pending' && s.theirs !== 'pending')
}

/** Unresolved conflicts and unresolved one-sided changes. @param {Merge} m */
export function counts(m) {
  let conflicts = 0
  let changes = 0
  m.regions.forEach((r, i) => {
    if (r.type !== 'chunk' || isResolved(m, i)) return
    if (r.kind === 'conflict') conflicts++
    else changes++
  })
  return { conflicts, changes }
}

/** @param {Merge} m */
export function resultText(m) {
  return m.regions.map((_, i) => chunkText(m, i).join('')).join('')
}

/** True when text still has a git conflict marker at the start of a line. @param {string} text */
export function hasConflictMarkers(text) {
  return /^(?:<{7}|>{7})(?: |\r?$)|^={7}\r?$/m.test(text)
}
