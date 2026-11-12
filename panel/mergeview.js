// Conflict resolution UI: the conflicts dialog (whole-file Yours/Theirs, or Merge…) and the
// three-pane merge view (Yours · Result · Theirs) built on merge.js.
import {
  applyNonConflicting,
  buildRegions,
  chunkText,
  counts,
  createMerge,
  hasConflictMarkers,
  ignore,
  isResolved,
  resultText,
  setManual,
  splitLines,
  take
} from './merge.js'

const $ = (sel, root = document) => root.querySelector(sel)
const stripEol = (l) => l.replace(/\r?\n$/, '')

/**
 * @param {{
 *   req: (name: string, input?: any, timeoutMs?: number) => Promise<any>;
 *   tryAct: (op: string, args?: any, opts?: any) => Promise<boolean>;
 *   ask: (o: any) => Promise<any>;
 *   toast: (title: string, detail?: string, o?: any) => void;
 *   toastError: (title: string, err: any) => void;
 *   esc: (s: any) => string;
 *   icon: (name: string) => string;
 *   repo: () => string | null;
 * }} d
 */
export function createConflictUI(d) {
  const { esc, icon } = d
  /** @type {{ op: string | null; oursLabel: string; theirsLabel: string; files: { path: string; code: string; type: string }[] } | null} */
  let info = null
  let dialogOpen = false
  /** @type {Set<string>} */
  let selected = new Set()
  let anchor = null
  /** @type {any} */
  let view = null // the open merge view

  // ---------------------------------------------------------------------------------------------
  // Conflicts dialog

  async function loadInfo() {
    info = await d.req('git.conflicts')
    return info
  }

  const opTitle = (op) =>
    ({ merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert' })[op] ?? 'Conflicts'

  async function openDialog() {
    dialogOpen = true
    selected = new Set()
    try {
      await loadInfo()
    } catch (err) {
      dialogOpen = false
      d.toastError('Could not read the conflicts', err)
      return
    }
    if (info?.files[0]) selected.add(info.files[0].path)
    renderDialog()
  }

  function closeDialog() {
    dialogOpen = false
    const el = $('#conflictsModal')
    el.classList.add('hidden')
    el.innerHTML = ''
  }

  /** Called on every status change while the dialog is open. */
  async function refreshDialog() {
    if (!dialogOpen || view) return
    try {
      await loadInfo()
    } catch {
      return
    }
    for (const p of [...selected]) if (!info?.files.some((f) => f.path === p)) selected.delete(p)
    if (!selected.size && info?.files[0]) selected.add(info.files[0].path)
    renderDialog()
  }

  function renderDialog() {
    const el = $('#conflictsModal')
    if (!info) return
    const files = info.files
    const rows = files
      .map((f, i) => {
        const slash = f.path.lastIndexOf('/')
        const name = f.path.slice(slash + 1)
        const dir = slash < 0 ? '' : f.path.slice(0, slash)
        return `<div class="cf-row${selected.has(f.path) ? ' selected' : ''}" data-i="${i}" role="option" aria-selected="${selected.has(f.path)}">
          <span class="name">${esc(name)}</span><span class="dir">${esc(dir)}</span><span class="type">${esc(f.type)}</span></div>`
      })
      .join('')
    const body = files.length
      ? `<div class="cf-sides"><span><b>Yours</b> ${esc(info.oursLabel)}</span><span><b>Theirs</b> ${esc(info.theirsLabel)}</span></div>
         <div class="cf-main"><div class="cf-list" role="listbox" aria-multiselectable="true" tabindex="0">${rows}</div>
         <div class="cf-acts">
           <button type="button" data-cf="ours">Accept Yours</button>
           <button type="button" data-cf="theirs">Accept Theirs</button>
           <button type="button" class="primary" data-cf="merge">Merge…</button>
         </div></div>`
      : `<p class="cf-done">${icon('check')} All conflicts are resolved.</p>${finishHtml()}`
    el.innerHTML = `<div class="dialog conflicts" role="dialog" aria-modal="true" aria-label="Conflicts">
      <h3>${esc(opTitle(info.op))}${files.length ? ` · ${files.length} conflicted file${files.length === 1 ? '' : 's'}` : ''}</h3>
      ${body}
      <div class="buttons"><button type="button" data-cf="close">Close</button></div></div>`
    el.classList.remove('hidden')
    const list = $('.cf-list', el)
    list?.focus()
    el.onmousedown = (e) => {
      if (e.target === el) closeDialog()
    }
    el.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeDialog()
      } else if (e.key === 'Enter' && e.target === list) {
        e.preventDefault()
        void mergeSelected()
      }
    }
    el.onclick = (e) => {
      const t = /** @type {HTMLElement} */ (e.target)
      const b = t.closest('[data-cf]')
      if (b instanceof HTMLElement) {
        const a = b.dataset.cf
        if (a === 'close') closeDialog()
        else if (a === 'ours' || a === 'theirs') void acceptSelected(a)
        else if (a === 'merge') void mergeSelected()
        else if (a.startsWith('finish:')) void finish(a.slice(7))
        return
      }
      const row = t.closest('.cf-row')
      if (row instanceof HTMLElement) selectRow(Number(row.dataset.i), e)
    }
    el.ondblclick = (e) => {
      const row = /** @type {HTMLElement} */ (e.target).closest('.cf-row')
      if (row instanceof HTMLElement) {
        selected = new Set([files[Number(row.dataset.i)].path])
        void mergeSelected()
      }
    }
  }

  function selectRow(i, e) {
    const files = info?.files ?? []
    const path = files[i].path
    if (e.shiftKey && anchor !== null) {
      const a = files.findIndex((f) => f.path === anchor)
      const [lo, hi] = a < i ? [a, i] : [i, a]
      selected = new Set(files.slice(lo, hi + 1).map((f) => f.path))
    } else if (e.ctrlKey || e.metaKey) {
      if (selected.has(path)) selected.delete(path)
      else selected.add(path)
      anchor = path
    } else {
      selected = new Set([path])
      anchor = path
    }
    renderDialog()
  }

  async function acceptSelected(side) {
    const paths = [...selected]
    if (!paths.length) return
    const ok = await d.tryAct('resolveSide', { paths, side }, { quiet: true })
    if (ok) d.toast(`Accepted ${side === 'ours' ? 'yours' : 'theirs'}`, paths.join('\n'))
  }

  async function mergeSelected() {
    const path = [...selected][0]
    if (path) await openMerge(path, { fromDialog: true })
  }

  // ---------------------------------------------------------------------------------------------
  // Finishing the operation

  /** Buttons that finish the operation once nothing is in conflict. */
  function finishHtml() {
    const op = info?.op
    if (op === 'merge') return `<div class="cf-finish"><button type="button" class="primary" data-cf="finish:commitMerge">Commit merge</button></div>`
    if (op === 'rebase' || op === 'cherry-pick' || op === 'revert')
      return `<div class="cf-finish"><button type="button" class="primary" data-cf="finish:continue">Continue ${esc(op)}</button><button type="button" data-cf="finish:skip">Skip this commit</button></div>`
    return ''
  }

  /** @param {string} what commitMerge | continue | skip */
  async function finish(what, op = info?.op) {
    if (what === 'commitMerge') {
      const ok = await d.tryAct('commitMerge', {}, { success: 'Merge committed' })
      if (ok) closeDialog()
      return
    }
    try {
      await d.req('git.action', { op: what, what: op }, 120_000)
      d.toast(what === 'skip' ? 'Commit skipped' : `${opTitle(op)} continued`)
    } catch (err) {
      const msg = String(err?.message ?? err)
      if (/nothing to commit|now empty|is empty|allow-empty/i.test(msg))
        d.toast('Nothing left to commit', 'The resolved commit has no changes. Use "Skip this commit" to drop it.', { error: true })
      else d.toastError(`${opTitle(op)} could not continue`, err)
    }
    // Whatever happened, the status changed: the next step may conflict again, which reopens the dialog.
    closeDialog()
    d.afterChange?.()
  }

  // ---------------------------------------------------------------------------------------------
  // Merge view

  /**
   * @param {string} path
   * @param {{ fromDialog?: boolean }} [o]
   */
  async function openMerge(path, o = {}) {
    if (view && !(await closeMerge())) return
    let data
    try {
      if (!info || !info.files.some((f) => f.path === path)) await loadInfo()
      data = await d.req('git.conflict', { path })
    } catch (err) {
      d.toastError('Could not open the merge view', err)
      return
    }
    if (data.whole) {
      const why = { binary: 'is binary or not UTF-8 text', large: 'is too large to merge here', structural: 'was deleted on one side' }[data.whole]
      const res = await d.ask({
        title: `Resolve ${path}`,
        message: `This file ${why}. Keep one side for the whole file.`,
        choices: [
          { value: 'ours', label: 'Accept Yours', hint: info?.oursLabel },
          { value: 'theirs', label: 'Accept Theirs', hint: info?.theirsLabel }
        ],
        ok: 'Accept'
      })
      if (res) await d.tryAct('resolveSide', { paths: [path], side: res.choice }, { quiet: true })
      return
    }
    // The merge view takes the dialog's place; closing the view brings the dialog back.
    if (dialogOpen) o = { ...o, fromDialog: true }
    if (o.fromDialog) $('#conflictsModal').classList.add('hidden')
    const m = createMerge(buildRegions(data.base ?? '', data.ours ?? '', data.theirs ?? ''))
    const eol = /\r\n/.test(data.ours ?? '') ? '\r\n' : '\n'
    view = { path, data, m, eol, initial: resultText(m), touched: false, fromDialog: !!o.fromDialog, cursor: -1 }
    renderMerge()
  }

  function renderMerge() {
    const el = $('#mergeView')
    const { path, data } = view
    const edited = data.current !== null && !hasConflictMarkers(data.current) && data.current !== view.initial
    el.innerHTML = `
      <div class="m-bar">
        <button class="icon" data-m="prev" title="Previous conflict (Shift+F7)">${icon('chevronUp')}</button>
        <button class="icon" data-m="next" title="Next conflict (F7)">${icon('chevronDown')}</button>
        <span class="m-count"></span>
        <button type="button" class="secondary" data-m="nonConflicting" title="Take every change made on only one side">Apply non-conflicting</button>
        <span class="spacer"></span>
        <span class="m-path" title="${esc(path)}">${esc(path)}</span>
        <span class="spacer"></span>
        <button type="button" class="secondary" data-m="ours">Accept Yours</button>
        <button type="button" class="secondary" data-m="theirs">Accept Theirs</button>
        <button type="button" class="secondary" data-m="cancel">Cancel</button>
        <button type="button" class="primary" data-m="apply">Apply</button>
      </div>
      ${
        edited
          ? `<div class="m-warn"><span>This file was changed after the conflict. Apply will replace it.</span><button type="button" class="secondary" data-m="useCurrent">Use current file as Result</button></div>`
          : ''
      }
      <div class="m-heads"><div title="${esc(info?.oursLabel)}"><b>Yours</b> ${esc(info?.oursLabel)}</div><div></div><div><b>Result</b></div><div></div><div title="${esc(info?.theirsLabel)}"><b>Theirs</b> ${esc(info?.theirsLabel)}</div></div>
      <div class="m-body" tabindex="-1">${view.m.regions.map((_, i) => rowHtml(i)).join('')}</div>`
    el.classList.remove('hidden')
    el.onclick = onMergeClick
    el.oninput = onMergeInput
    updateCount()
    // Start at the first real conflict (one-sided changes can wait for "Apply non-conflicting").
    const first = view.m.regions.findIndex((r) => r.type === 'chunk' && r.kind === 'conflict')
    view.cursor = first > 0 ? first - 1 : -1
    setTimeout(() => go(1), 0)
  }

  function sideLines(lines, startNo) {
    return lines.map((l, k) => `<div class="ml"><span class="no">${startNo + k}</span><span class="tx">${esc(stripEol(l)) || ' '}</span></div>`).join('')
  }

  /** Line number where region i starts on a side. */
  function startLine(i, side) {
    let n = 1
    for (let k = 0; k < i; k++) {
      const r = view.m.regions[k]
      n += r.type === 'equal' ? r.lines.length : r[side].length
    }
    return n
  }

  function rowHtml(i) {
    const m = view.m
    const r = m.regions[i]
    const s = m.state[i]
    const res = chunkText(m, i).map(stripEol).join('\n')
    if (r.type === 'equal') {
      return `<div class="m-row eq" data-i="${i}">
        <div class="m-side">${sideLines(r.lines, startLine(i, 'ours'))}</div><div class="m-gut"></div>
        <div class="m-res" contenteditable="plaintext-only" spellcheck="false" data-i="${i}">${esc(res)}</div>
        <div class="m-gut"></div><div class="m-side">${sideLines(r.lines, startLine(i, 'theirs'))}</div></div>`
    }
    const resolved = isResolved(m, i)
    const gut = (side) => {
      if (s[side] !== 'pending' || s.manual) return ''
      const arrow = side === 'ours' ? '»' : '«'
      return `<button class="m-take" data-take="${side}" data-i="${i}" title="Take ${side === 'ours' ? 'yours' : 'theirs'}">${arrow}</button><button class="m-ign" data-ign="${side}" data-i="${i}" title="Ignore this change">×</button>`
    }
    const sideState = (side) => (s[side] === 'none' ? 'none' : s.manual ? 'done' : s[side])
    return `<div class="m-row ch k-${r.kind}${resolved ? ' resolved' : ''}" data-i="${i}">
      <div class="m-side s-${sideState('ours')}${r.kind === 'theirs' ? ' plain' : ''}">${sideLines(r.ours, startLine(i, 'ours'))}</div>
      <div class="m-gut">${gut('ours')}</div>
      <div class="m-res" contenteditable="plaintext-only" spellcheck="false" data-i="${i}">${esc(res)}</div>
      <div class="m-gut">${gut('theirs')}</div>
      <div class="m-side s-${sideState('theirs')}${r.kind === 'ours' ? ' plain' : ''}">${sideLines(r.theirs, startLine(i, 'theirs'))}</div></div>`
  }

  function rerenderRow(i) {
    const old = $(`#mergeView .m-row[data-i="${i}"]`)
    if (old) old.outerHTML = rowHtml(i)
    updateCount()
  }

  function updateCount() {
    const c = counts(view.m)
    const parts = []
    parts.push(c.conflicts ? `${c.conflicts} conflict${c.conflicts === 1 ? '' : 's'} left` : 'No conflicts left')
    if (c.changes) parts.push(`${c.changes} change${c.changes === 1 ? '' : 's'}`)
    const el = $('#mergeView .m-count')
    el.textContent = parts.join(' · ')
    el.classList.toggle('ok', !c.conflicts && !c.changes)
    $('#mergeView [data-m="nonConflicting"]').disabled = !c.changes
  }

  function onMergeClick(e) {
    const t = /** @type {HTMLElement} */ (e.target)
    const b = t.closest('button')
    if (!(b instanceof HTMLElement)) return
    const m = view.m
    if (b.dataset.take || b.dataset.ign) {
      const i = Number(b.dataset.i)
      if (b.dataset.take) take(m, i, b.dataset.take)
      else ignore(m, i, b.dataset.ign)
      view.touched = true
      rerenderRow(i)
      return
    }
    const a = b.dataset.m
    if (a === 'prev') go(-1)
    else if (a === 'next') go(1)
    else if (a === 'nonConflicting') {
      applyNonConflicting(m)
      view.touched = true
      $('#mergeView .m-body').innerHTML = m.regions.map((_, i) => rowHtml(i)).join('')
      updateCount()
    } else if (a === 'useCurrent') {
      view.m = createMerge([{ type: 'equal', lines: splitLines(view.data.current ?? '') }])
      view.touched = true
      $('#mergeView .m-warn')?.remove()
      $('#mergeView .m-body').innerHTML = rowHtml(0)
      updateCount()
    } else if (a === 'ours' || a === 'theirs') void acceptWhole(a)
    else if (a === 'cancel') void closeMerge()
    else if (a === 'apply') void apply()
  }

  function onMergeInput(e) {
    const cell = /** @type {HTMLElement} */ (e.target).closest('.m-res')
    if (!(cell instanceof HTMLElement)) return
    const i = Number(cell.dataset.i)
    const m = view.m
    const text = cell.innerText.replace(/\n$/, '')
    const last = i === m.regions.length - 1
    const prev = chunkText(m, i)
    const endsWithEol = !last || !prev.length || /\n$/.test(prev[prev.length - 1])
    const parts = text === '' ? [] : text.split('\n')
    const lines = parts.map((p, k) => (k < parts.length - 1 || endsWithEol ? p + view.eol : p))
    const wasResolved = isResolved(m, i)
    setManual(m, i, lines)
    view.touched = true
    // Leave the edited cell alone (it holds the caret); only the row's chrome changes.
    const row = cell.closest('.m-row')
    if (row && !wasResolved) {
      row.classList.add('resolved')
      for (const b of row.querySelectorAll('.m-gut button')) b.remove()
      for (const s of row.querySelectorAll('.m-side')) if (!s.classList.contains('s-none')) s.className = s.className.replace(/s-\w+/, 's-done')
    }
    updateCount()
  }

  /** Scroll to the next (dir 1) or previous (-1) unresolved chunk. */
  function go(dir) {
    if (!view) return
    const m = view.m
    const open = m.regions.map((r, i) => (r.type === 'chunk' && !isResolved(m, i) ? i : -1)).filter((i) => i >= 0)
    if (!open.length) return
    let next
    if (dir > 0) next = open.find((i) => i > view.cursor) ?? open[0]
    else next = [...open].reverse().find((i) => i < view.cursor) ?? open[open.length - 1]
    view.cursor = next
    const row = $(`#mergeView .m-row[data-i="${next}"]`)
    row?.scrollIntoView({ block: 'center' })
    for (const r of document.querySelectorAll('#mergeView .m-row.current')) r.classList.remove('current')
    row?.classList.add('current')
  }

  async function acceptWhole(side) {
    const ok = await d.tryAct('resolveSide', { paths: [view.path], side }, { quiet: true })
    if (ok) {
      d.toast(`Accepted ${side === 'ours' ? 'yours' : 'theirs'}`, view.path)
      hideMerge()
    }
  }

  async function apply() {
    const c = counts(view.m)
    const content = resultText(view.m)
    if (c.conflicts) {
      const ok = await d.ask({
        title: `${c.conflicts} conflict${c.conflicts === 1 ? ' is' : 's are'} not resolved`,
        message: 'Save anyway? Unresolved parts keep the base text.',
        ok: 'Save anyway'
      })
      if (!ok) return
    } else if (hasConflictMarkers(content)) {
      const ok = await d.ask({ title: 'The result still has conflict markers', message: 'Save it anyway?', ok: 'Save anyway' })
      if (!ok) return
    }
    const ok = await d.tryAct('writeResolved', { path: view.path, content }, { quiet: true })
    if (ok) {
      d.toast('Resolved', view.path)
      hideMerge()
    }
  }

  function dirty() {
    return !!view && (view.touched || resultText(view.m) !== view.initial)
  }

  /** Closes the merge view, asking first when it holds work. Resolves false if the person keeps it. */
  async function closeMerge() {
    if (!view) return true
    if (dirty()) {
      const ok = await d.ask({ title: 'Discard this merge?', message: `Your choices for ${view.path} will be lost.`, ok: 'Discard', danger: true })
      if (!ok) return false
    }
    hideMerge()
    return true
  }

  function hideMerge() {
    const back = view?.fromDialog
    view = null
    const el = $('#mergeView')
    el.classList.add('hidden')
    el.innerHTML = ''
    if (back && dialogOpen) void refreshDialog()
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (!view || $('#modal:not(.hidden)')) return
      if (e.key === 'F7') {
        e.preventDefault()
        go(e.shiftKey ? -1 : 1)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        void closeMerge()
      }
    },
    true
  )

  return {
    openDialog,
    closeDialog,
    refreshDialog,
    openMerge,
    closeMerge,
    finish,
    get mergeOpen() {
      return !!view
    },
    get dialogOpen() {
      return dialogOpen
    }
  }
}
