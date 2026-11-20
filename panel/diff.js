// Renders unified diff text from git as HTML rows with old/new line numbers. Pure: shared by the panel
// and the tests.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/**
 * @param {string} text
 * @param {boolean} [truncated]
 * @returns {string}
 */
export function diffHtml(text, truncated) {
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
      continue
    }
    if (inHeader && /^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to|old mode|new mode)/.test(line)) continue
    if (line.startsWith('Binary files')) {
      out.push(`<div class="info">${esc(line)}</div>`)
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
