// Renders unified diff text from git as HTML rows with old/new line numbers. Pure: shared by the panel
// and the tests.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** @param {number} n bytes */
export function formatSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * One line for git's "Binary files a/x and b/y differ": what kind of file, and how its size changed.
 * @param {string} line
 * @param {{ oldSize: number; newSize: number } | null | undefined} sizes
 */
export function binarySummary(line, sizes) {
  const m = /^Binary files (\S+|".*?") and (\S+|".*?") differ$/.exec(line)
  const added = m?.[1] === '/dev/null'
  const deleted = m?.[2] === '/dev/null'
  const name = (deleted ? m?.[1] : m?.[2]) ?? ''
  const ext = /\.([A-Za-z0-9]{1,8})"?$/.exec(name)?.[1]
  const kind = ext ? `Binary ${ext.toUpperCase()} file` : 'Binary file'
  if (!sizes) return `${kind} ${added ? 'added' : deleted ? 'deleted' : 'changed'}`
  if (added) return `${kind} added · ${formatSize(sizes.newSize)}`
  if (deleted) return `${kind} deleted · ${formatSize(sizes.oldSize)}`
  const delta = sizes.newSize - sizes.oldSize
  const change = delta ? ` (${delta > 0 ? '+' : '−'}${formatSize(Math.abs(delta))})` : ', same size'
  return `${kind} changed · ${formatSize(sizes.oldSize)} → ${formatSize(sizes.newSize)}${change}`
}

/**
 * @param {string} text
 * @param {boolean} [truncated]
 * @param {{ oldSize: number; newSize: number } | null} [binary] sizes from the worker for a binary file
 * @param {{ files?: boolean }} [opts] files: a row naming each file, for a diff that spans several
 * @returns {string}
 */
export function diffHtml(text, truncated, binary, opts = {}) {
  if (!text.trim()) return '<div class="diff"><div class="info">No textual changes (mode change or empty file).</div></div>'
  const out = []
  let oldN = 0
  let newN = 0
  let count = 0
  // Header lines only appear between "diff --git" and the first hunk. Inside a hunk, a removed "-- x" reads
  // as "--- x" and an added "++ x" as "+++ x", so matching headers there would hide real changes.
  let inHeader = true
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  for (const line of lines) {
    if (count++ > 20_000) {
      out.push('<div class="info">Diff too long to show in full.</div>')
      break
    }
    if (line.startsWith('diff --git')) {
      inHeader = true
      if (opts.files) {
        const name = / b\/(.*)$/.exec(line)?.[1] ?? line.slice(11)
        out.push(`<div class="l file"><span class="ln"></span><span class="ln"></span><span class="code">${esc(name)}</span></div>`)
      }
      continue
    }
    if (inHeader && /^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|old mode|new mode)/.test(line)) continue
    if (line.startsWith('Binary files')) {
      out.push(`<div class="info">${esc(binarySummary(line, binary))}</div>`)
      continue
    }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (m) {
      inHeader = false
      oldN = Number(m[1])
      newN = Number(m[2])
      out.push(`<div class="l hunk"><span class="ln"></span><span class="ln"></span><span class="code">${esc(line)}</span></div>`)
      continue
    }
    if (line.startsWith('+')) out.push(`<div class="l add"><span class="ln"></span><span class="ln">${newN++}</span><span class="code">${esc(line)}</span></div>`)
    else if (line.startsWith('-')) out.push(`<div class="l del"><span class="ln">${oldN++}</span><span class="ln"></span><span class="code">${esc(line)}</span></div>`)
    else if (line.startsWith('\\')) out.push(`<div class="l"><span class="ln"></span><span class="ln"></span><span class="code">${esc(line)}</span></div>`)
    else if (!inHeader) out.push(`<div class="l"><span class="ln">${oldN++}</span><span class="ln">${newN++}</span><span class="code">${esc(line)}</span></div>`)
  }
  if (truncated) out.push('<div class="info">Diff truncated.</div>')
  return `<div class="diff">${out.join('')}</div>`
}
