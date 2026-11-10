// Commit graph layout: assigns each commit a lane and works out the line segments for its row.
// Incremental: rows already laid out never change when more commits are appended, so the panel
// renders new pages without redrawing old ones.

/**
 * @typedef {{ hash: string; parents: string[] }} GraphCommit
 * @typedef {{ col: number; color: number }} Seg
 * @typedef {{
 *   col: number,             // lane of the commit's dot
 *   color: number,           // colour index of the dot
 *   hasTop: boolean,         // a line comes into the dot from above in the same lane
 *   passes: Seg[],           // lanes that run straight through this row
 *   merges: { from: number; color: number }[],  // lanes that end in this dot (top → dot)
 *   parents: { to: number; color: number }[],   // lines leaving the dot downward (dot → bottom)
 *   width: number            // lanes used in this row
 * }} GraphRow
 */

export function createGraph() {
  /** @type {({ hash: string; color: number } | null)[]} */
  const lanes = []
  let nextColor = 0

  const firstFree = () => {
    const i = lanes.indexOf(null)
    return i === -1 ? lanes.length : i
  }

  /**
   * @param {GraphCommit[]} commits
   * @returns {GraphRow[]}
   */
  function add(commits) {
    const rows = []
    for (const commit of commits) {
      let col = lanes.findIndex((l) => l !== null && l.hash === commit.hash)
      const hasTop = col !== -1
      let color
      if (col === -1) {
        col = firstFree()
        color = nextColor++
      } else {
        color = /** @type {any} */ (lanes[col]).color
      }

      /** @type {Seg[]} */
      const passes = []
      const merges = []
      for (let j = 0; j < lanes.length; j++) {
        const lane = lanes[j]
        if (!lane || j === col) continue
        if (lane.hash === commit.hash) {
          merges.push({ from: j, color: lane.color })
          lanes[j] = null
        } else {
          passes.push({ col: j, color: lane.color })
        }
      }

      const parents = []
      if (commit.parents.length === 0) {
        lanes[col] = null
      } else {
        const [first, ...rest] = commit.parents
        const existing = lanes.findIndex((l, j) => l !== null && j !== col && l.hash === first)
        if (existing !== -1) {
          // Another lane already waits for this parent: join it instead of running in parallel.
          lanes[col] = null
          parents.push({ to: existing, color })
        } else {
          lanes[col] = { hash: first, color }
          parents.push({ to: col, color })
        }
        for (const p of rest) {
          let k = lanes.findIndex((l) => l !== null && l.hash === p)
          if (k === -1) {
            k = firstFree()
            lanes[k] = { hash: p, color: nextColor++ }
          }
          parents.push({ to: k, color: /** @type {any} */ (lanes[k]).color })
        }
      }

      const width =
        Math.max(
          col,
          ...passes.map((s) => s.col),
          ...merges.map((m) => m.from),
          ...parents.map((p) => p.to)
        ) + 1

      while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()

      rows.push({ col, color, hasTop, passes, merges, parents, width })
    }
    return rows
  }

  return { add }
}

/** @param {GraphCommit[]} commits */
export function layoutGraph(commits) {
  return createGraph().add(commits)
}
