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
 * Myers O(ND) line diff in linear space. Returns the changed ranges as half-open hunks.
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

/** Diagonal steps the diff may take before it gives up on finer matches and reports a range as changed. */
export const DIFF_BUDGET = 30_000_000

/**
 * Matched index pairs, in order. Bisects on the middle of the edit path (as diff-match-patch does), so
 * memory is O(N+M) rather than the O(D²) of keeping a trace: a file whose every line changed (CRLF against
 * LF) no longer needs gigabytes.
 * @param {string[]} a @param {string[]} b @param {number} [budget]
 * @returns {[number, number][]}
 */
export function myersMatches(a, b, budget = DIFF_BUDGET) {
  if (!a.length || !b.length) return []
  // Lines as small integers: comparisons get cheap, and no common line at all is spotted up front.
  /** @type {Map<string, number>} */
  const ids = new Map()
  const A = Int32Array.from(a, (l) => ids.get(l) ?? (ids.set(l, ids.size), ids.size - 1))
  const known = ids.size
  const B = Int32Array.from(b, (l) => ids.get(l) ?? (ids.set(l, ids.size), ids.size - 1))
  if (!B.some((id) => id < known)) return []
  /** @type {[number, number][]} */
  const out = []
  let steps = 0

  /** @param {number} aLo @param {number} aHi @param {number} bLo @param {number} bHi */
  const solve = (aLo, aHi, bLo, bHi) => {
    while (aLo < aHi && bLo < bHi && A[aLo] === B[bLo]) out.push([aLo++, bLo++])
    let tail = 0
    while (aLo < aHi - tail && bLo < bHi - tail && A[aHi - 1 - tail] === B[bHi - 1 - tail]) tail++
    const split = aLo < aHi - tail && bLo < bHi - tail && steps < budget ? bisect(aLo, aHi - tail, bLo, bHi - tail) : null
    if (split) {
      solve(aLo, split[0], bLo, split[1])
      solve(split[0], aHi - tail, split[1], bHi - tail)
    }
    for (let i = tail; i > 0; i--) out.push([aHi - i, bHi - i])
  }

  /**
   * The point where the forward and backward searches meet, or null when nothing in the range matches.
   * @param {number} aLo @param {number} aHi @param {number} bLo @param {number} bHi
   * @returns {[number, number] | null}
   */
  const bisect = (aLo, aHi, bLo, bHi) => {
    const n = aHi - aLo
    const m = bHi - bLo
    const maxD = Math.ceil((n + m) / 2)
    const off = maxD
    const len = 2 * maxD + 2
    const v1 = new Int32Array(len).fill(-1)
    const v2 = new Int32Array(len).fill(-1)
    v1[off + 1] = 0
    v2[off + 1] = 0
    const delta = n - m
    const front = delta % 2 !== 0
    let k1start = 0
    let k1end = 0
    let k2start = 0
    let k2end = 0
    for (let d = 0; d < maxD; d++) {
      if (steps > budget) return null
      for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
        steps++
        const i = off + k1
        let x1 = k1 === -d || (k1 !== d && v1[i - 1] < v1[i + 1]) ? v1[i + 1] : v1[i - 1] + 1
        let y1 = x1 - k1
        while (x1 < n && y1 < m && A[aLo + x1] === B[bLo + y1]) {
          x1++
          y1++
        }
        v1[i] = x1
        if (x1 > n) k1end += 2
        else if (y1 > m) k1start += 2
        else if (front) {
          const j = off + delta - k1
          if (j >= 0 && j < len && v2[j] !== -1 && x1 >= n - v2[j]) return [aLo + x1, bLo + y1]
        }
      }
      for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
        steps++
        const i = off + k2
        let x2 = k2 === -d || (k2 !== d && v2[i - 1] < v2[i + 1]) ? v2[i + 1] : v2[i - 1] + 1
        let y2 = x2 - k2
        while (x2 < n && y2 < m && A[aHi - 1 - x2] === B[bHi - 1 - y2]) {
          x2++
          y2++
        }
        v2[i] = x2
        if (x2 > n) k2end += 2
        else if (y2 > m) k2start += 2
        else if (!front) {
          const j = off + delta - k2
          if (j >= 0 && j < len && v1[j] !== -1) {
            const x1 = v1[j]
            const y1 = off + x1 - j
            if (x1 >= n - x2) return [aLo + x1, bLo + y1]
          }
        }
      }
    }
    return null
  }

  solve(0, A.length, 0, B.length)
  return out
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
  if (!s.order.length) return r.base
  // Taking both sides: a side that ends without a newline (the file's last line) would run into the next.
  return s.order.flatMap((side, k) => {
    const lines = r[side]
    const last = lines.at(-1)
    if (k === s.order.length - 1 || last === undefined || last.endsWith('\n')) return lines
    const eol = [lines, ...m.regions.map((x) => (x.type === 'equal' ? x.lines : x.base))].some((ls) => ls.some((l) => l.endsWith('\r\n'))) ? '\r\n' : '\n'
    return [...lines.slice(0, -1), last + eol]
  })
}

/** @param {Merge} m @param {number} i */
export function isResolved(m, i) {
  const s = m.state[i]
  return !!s.manual || (s.ours !== 'pending' && s.theirs !== 'pending')
}

/**
 * Conflicts nobody has decided yet, and unresolved one-sided changes. A conflict where one side was taken
 * counts as decided: the other side can still be appended, but the Result already has an answer there.
 * @param {Merge} m
 */
export function counts(m) {
  let conflicts = 0
  let changes = 0
  m.regions.forEach((r, i) => {
    if (r.type !== 'chunk' || isResolved(m, i)) return
    if (r.kind !== 'conflict') changes++
    else if (m.state[i].ours !== 'taken' && m.state[i].theirs !== 'taken') conflicts++
  })
  return { conflicts, changes }
}

/** @param {Merge} m */
export function resultText(m) {
  return m.regions.map((_, i) => chunkText(m, i).join('')).join('')
}

/** True when text still has a git conflict marker at the start of a line. @param {string} text */
export function hasConflictMarkers(text) {
  // "=======" alone is a Markdown heading underline, so only the opening and closing markers count. Either
  // one is enough: a conflict whose other half was deleted by hand is still unfinished.
  return /^(?:<{7}|>{7})(?: |\r?$)/m.test(text)
}
