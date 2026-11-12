// Git Toolbox panel: branch tree, commit graph log, commit details and local changes.
// Every git call goes to the plugin's worker through orca.plugin.request.
import { createGraph } from './graph.js'
import { createConflictUI } from './mergeview.js'

/* global orca */
const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

// ------------------------------------------------------------------------------------------------
// Icons (inline, stroke-based so they follow currentColor)

const ICONS = {
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>',
  fetch: '<path d="M8 2v8"/><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/><path d="M3 13h10"/>',
  pull: '<path d="M3 3l7 7"/><path d="M10 4.5V10H4.5"/><path d="M3 13.5h10"/>',
  push: '<path d="M4 12l7-7"/><path d="M5.5 5H11v5.5"/><path d="M3 14h10"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  minus: '<path d="M3 8h10"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.5"/><path d="M13 2.5v3h-3"/>',
  branch:
    '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 3-7 2-7 4"/>',
  tag: '<path d="M2.5 2.5h5l6 6-5 5-6-6z"/><circle cx="5.5" cy="5.5" r="1"/>',
  star: '<path d="m8 2 1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5z"/>',
  folder: '<path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>',
  cloud: '<path d="M4.5 12.5h7a3 3 0 0 0 .3-6A4 4 0 0 0 4 7.5a2.5 2.5 0 0 0 .5 5z"/>',
  chevron: '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
  undo: '<path d="M5.5 3 2.5 6l3 3"/><path d="M2.5 6H10a3.5 3.5 0 0 1 0 7H6"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/>',
  back: '<path d="M10 3.5 5.5 8l4.5 4.5"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
  head: '<circle cx="8" cy="8" r="3"/><circle cx="8" cy="8" r="6"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  chevronDown: '<path d="m4 6 4 4 4-4"/>',
  chevronUp: '<path d="m4 10 4-4 4 4"/>',
  merge: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="8" r="1.5"/><path d="M4.5 5v6M4.5 5c0 3 4 3 5.5 3"/>',
  open: '<path d="M9 3h4v4"/><path d="M13 3 7.5 8.5"/><path d="M11 9.5V13H3V5h3.5"/>',
  check: '<path d="m3.5 8.5 3 3 6-7"/>'
}
const icon = (name, cls = '') =>
  `<svg class="${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ''}</svg>`

function applyIcons(root = document) {
  for (const el of $$('[data-icon]', root)) {
    if (!el.firstElementChild) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon))
  }
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// ------------------------------------------------------------------------------------------------
// State

const LANE = 14
const ROW_H = 26
// Lane colours: saturated enough to read on dark and light Orca themes, distinct at a glance.
const COLORS = ['#e0a82e', '#9d6ff0', '#26a69a', '#ef6c4d', '#4f8ff7', '#5fb04a', '#e05fa8', '#c98a3c', '#2fa8d4', '#8a8ae6']

const state = {
  workspaces: [],
  repo: /** @type {string | null} */ (null),
  repoName: '',
  branches: /** @type {any} */ (null),
  status: /** @type {any} */ (null),
  commits: /** @type {any[]} */ ([]),
  rowLayout: /** @type {any[]} */ ([]),
  graph: createGraph(),
  graphLanes: 1,
  hasMore: false,
  loadingLog: false,
  logToken: 0,
  detailsToken: 0,
  filters: { ref: 'all', text: '', author: '', since: '' },
  selected: /** @type {string | null} */ (null),
  details: /** @type {any} */ (null),
  tab: 'log',
  favorites: /** @type {Record<string, string[]>} */ ({}),
  collapsed: new Set(['tags']),
  branchSel: /** @type {string | null} */ (null),
  changeSel: /** @type {string | null} */ (null),
  pageSize: 300,
  busy: 0,
  acting: false,
  workspacesSig: '',
  focusedId: /** @type {string | null | undefined} */ (undefined),
  follow: true,
  lastPickedId: /** @type {string | null} */ (null),
  pickSeq: 0,
  sig: { log: '', branches: '', status: '' },
  // Conflicts seen in the last status (null before the first one for this repository), and the
  // stash bookkeeping: conflicts with no operation come from a stash pop, which keeps the stash.
  conflictCount: /** @type {number | null} */ (null),
  stashConflict: false,
  stashKept: false
}

// ------------------------------------------------------------------------------------------------
// Worker requests

async function req(name, input = {}, timeoutMs = 60_000) {
  state.busy++
  updateBusy()
  try {
    // Orca accepts only plain JSON: drop `undefined` fields (e.g. a missing oldPath), which it refuses.
    const payload = JSON.parse(JSON.stringify({ repo: state.repo, ...input }))
    return await orca.plugin.request(name, payload, { timeoutMs })
  } finally {
    state.busy--
    updateBusy()
  }
}

function updateBusy() {
  $('#busy').classList.toggle('hidden', state.busy === 0)
}

/** Runs a git action, reports the result and refreshes. Resolves to true on success. */
async function act(op, args = {}, { success, quiet = false, timeoutMs = 120_000, refresh = true } = {}) {
  state.acting = true
  try {
    const res = await req('git.action', { op, ...args }, timeoutMs)
    if (!quiet) toast(success ?? `${op} done`, lastLines(res?.output))
    return true
  } catch (err) {
    throw err
  } finally {
    state.acting = false
    if (refresh) void refreshAll()
  }
}

/** Like act, but shows the failure instead of throwing. */
async function tryAct(op, args, opts) {
  try {
    return await act(op, args, opts)
  } catch (err) {
    toastError(`${opLabel(op)} failed`, err)
    return false
  }
}

const opLabel = (op) =>
  ({
    fetch: 'Fetch',
    pull: 'Update',
    push: 'Push',
    checkout: 'Checkout',
    createBranch: 'New branch',
    deleteBranch: 'Delete branch',
    merge: 'Merge',
    rebase: 'Rebase',
    cherryPick: 'Cherry-pick',
    revert: 'Revert',
    reset: 'Reset',
    commit: 'Commit'
  })[op] ?? op

// Wrapped: some of these are consts defined further down.
const conflictsUI = createConflictUI({
  req: (...a) => req(...a),
  tryAct: (...a) => tryAct(...a),
  ask: (o) => ask(o),
  toast: (...a) => toast(...a),
  toastError: (t, e) => toastError(t, e),
  esc: (x) => esc(x),
  icon: (n) => icon(n),
  repo: () => state.repo,
  // A refresh already in flight may have read the status before the change: read it once more.
  afterChange: () => void refreshAll().then(() => loadStatus()).catch(() => undefined)
})

const lastLines = (text, n = 6) =>
  (text ?? '')
    .split('\n')
    .filter((l) => l.trim())
    .slice(-n)
    .join('\n')

// ------------------------------------------------------------------------------------------------
// Toasts, menus and dialogs

function toast(title, detail = '', { error = false, timeout } = {}) {
  const el = document.createElement('div')
  el.className = `toast${error ? ' error' : ''}`
  el.innerHTML = `<div><div>${esc(title)}</div>${detail ? `<pre>${esc(detail)}</pre>` : ''}</div><button class="x" title="Dismiss">✕</button>`
  $('.x', el).onclick = () => el.remove()
  $('#toasts').append(el)
  const ms = timeout ?? (error ? 15_000 : 4000)
  setTimeout(() => el.remove(), ms)
  while ($('#toasts').children.length > 4) $('#toasts').firstElementChild?.remove()
}
const toastError = (title, err) => toast(title, err?.message ?? String(err), { error: true })

let menuCleanup = null
/**
 * @param {MouseEvent} ev
 * @param {({ label: string; run: () => void; danger?: boolean; disabled?: boolean } | '-' | { head: string })[]} items
 */
function showMenu(ev, items) {
  ev.preventDefault()
  ev.stopPropagation()
  hideMenu()
  const menu = $('#menu')
  menu.innerHTML = items
    .map((it, i) => {
      if (it === '-') return '<div class="sep"></div>'
      if ('head' in it) return `<div class="head">${esc(it.head)}</div>`
      return `<div class="item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}" data-i="${i}" role="menuitem">${esc(it.label)}</div>`
    })
    .join('')
  menu.classList.remove('hidden')
  const { innerWidth: W, innerHeight: H } = window
  const r = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(4, Math.min(ev.clientX, W - r.width - 4))}px`
  menu.style.top = `${Math.max(4, Math.min(ev.clientY, H - r.height - 4))}px`
  menu.onclick = (e) => {
    const el = /** @type {HTMLElement} */ (e.target).closest('.item')
    if (!el) return
    const it = /** @type {any} */ (items[Number(el.dataset.i)])
    hideMenu()
    it.run()
  }
  const away = (e) => {
    if (!menu.contains(e.target)) hideMenu()
  }
  const key = (e) => {
    if (e.key === 'Escape') hideMenu()
  }
  setTimeout(() => {
    document.addEventListener('mousedown', away, true)
    document.addEventListener('keydown', key, true)
    window.addEventListener('blur', hideMenu)
  })
  menuCleanup = () => {
    document.removeEventListener('mousedown', away, true)
    document.removeEventListener('keydown', key, true)
    window.removeEventListener('blur', hideMenu)
  }
}
function hideMenu() {
  $('#menu').classList.add('hidden')
  menuCleanup?.()
  menuCleanup = null
}

/**
 * A small modal. Resolves null when cancelled.
 * @param {{ title: string; message?: string; input?: { value?: string; placeholder?: string; multiline?: boolean };
 *   checkbox?: { label: string; checked?: boolean }; choices?: { value: string; label: string; hint?: string }[];
 *   choice?: string; ok?: string; danger?: boolean; cancel?: string | false }} o
 * @returns {Promise<{ value: string; checked: boolean; choice: string } | null>}
 */
function ask(o) {
  return new Promise((resolve) => {
    const modal = $('#modal')
    const input = o.input
      ? o.input.multiline
        ? `<textarea rows="4" placeholder="${esc(o.input.placeholder)}">${esc(o.input.value)}</textarea>`
        : `<input type="text" spellcheck="false" placeholder="${esc(o.input.placeholder)}" value="${esc(o.input.value)}" />`
      : ''
    const choices = o.choices
      ? `<div class="choices">${o.choices
          .map(
            (c) =>
              `<label><input type="radio" name="choice" value="${esc(c.value)}" ${c.value === (o.choice ?? o.choices?.[0].value) ? 'checked' : ''}/> <span>${esc(c.label)}${c.hint ? `<small>${esc(c.hint)}</small>` : ''}</span></label>`
          )
          .join('')}</div>`
      : ''
    const checkbox = o.checkbox
      ? `<label><input type="checkbox" ${o.checkbox.checked ? 'checked' : ''} class="cb"/> ${esc(o.checkbox.label)}</label>`
      : ''
    modal.innerHTML = `<form class="dialog" role="dialog" aria-modal="true">
      <h3>${esc(o.title)}</h3>${o.message ? `<p>${esc(o.message)}</p>` : ''}${input}${choices}${checkbox}
      <div class="buttons">${o.cancel === false ? '' : `<button type="button" class="cancel">${esc(o.cancel ?? 'Cancel')}</button>`}
      <button type="submit" class="${o.danger ? 'danger' : 'primary'}">${esc(o.ok ?? 'OK')}</button></div></form>`
    modal.classList.remove('hidden')
    const form = /** @type {HTMLFormElement} */ ($('form', modal))
    const field = /** @type {HTMLInputElement | null} */ ($('input[type=text], textarea', form))
    const done = (result) => {
      modal.classList.add('hidden')
      modal.innerHTML = ''
      document.removeEventListener('keydown', onKey, true)
      resolve(result)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        done(null)
      }
    }
    document.addEventListener('keydown', onKey, true)
    form.onsubmit = (e) => {
      e.preventDefault()
      if (field && !o.input?.multiline && !field.value.trim()) {
        field.focus()
        return
      }
      done({
        value: field?.value.trim() ?? '',
        checked: !!(/** @type {HTMLInputElement | null} */ ($('.cb', form))?.checked),
        choice: /** @type {HTMLInputElement | null} */ ($('input[name=choice]:checked', form))?.value ?? ''
      })
    }
    $('.cancel', form)?.addEventListener('click', () => done(null))
    modal.onmousedown = (e) => {
      if (e.target === modal) done(null)
    }
    setTimeout(() => {
      if (field) {
        field.focus()
        field.select?.()
      } else /** @type {HTMLElement} */ ($('button[type=submit]', form)).focus()
    })
  })
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.append(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
  toast('Copied', text.length > 80 ? text.slice(0, 80) + '…' : text, { timeout: 1800 })
}

// ------------------------------------------------------------------------------------------------
// Dates

function formatDate(ms) {
  const d = new Date(ms)
  const now = new Date()
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ms >= startOfToday) return `Today ${time}`
  if (ms >= startOfToday - 86_400_000) return `Yesterday ${time}`
  return `${d.toLocaleDateString()} ${time}`
}
const shortDate = (ms) => {
  const s = formatDate(ms)
  return $('#app').classList.contains('narrow') ? s.replace(/^(Today|Yesterday) /, '').replace(/ \d{1,2}:\d{2}.*$/, '') || s : s
}

// ------------------------------------------------------------------------------------------------
// Workspaces

let wsTimer = null
function scheduleWorkspaces() {
  clearTimeout(wsTimer)
  wsTimer = setTimeout(() => void loadWorkspaces(), 300)
}

/**
 * Which workspace Orca has focused. Orca names it only by display name and branch, which several
 * workspaces can share ("master" in every project), so ties go to what the person last picked or
 * what the panel shows. Returns undefined when Orca reports no focus (Settings is open), null
 * when the match stays ambiguous: neither moves the panel.
 */
function resolveFocus(ctx) {
  if (!ctx.hasContext) return undefined
  const ids = ctx.candidates ?? (ctx.focused ? [ctx.focused] : [])
  if (!ids.length) return null
  if (ids.length === 1) return ids[0]
  for (const prefer of [state.lastPickedId, currentWs()?.id, state.focusedId]) if (prefer && ids.includes(prefer)) return prefer
  return null
}

let wsSeq = 0
/**
 * Reads Orca's workspaces. Follows Orca's focus only when the focused workspace actually changes:
 * `workspace.changed` also fires for every terminal opened, closed or renamed, and those must not
 * move the panel off the repository the person is looking at.
 */
async function loadWorkspaces() {
  const seq = ++wsSeq
  const pickSeq = state.pickSeq
  let ctx
  try {
    ctx = await req('repo.context')
  } catch (err) {
    if (seq === wsSeq && !state.repo) showFatal(err)
    return
  }
  // A newer read started, or the person picked a workspace while this one was in flight:
  // this answer is stale and must not move the panel.
  if (seq !== wsSeq) return
  const listSig = JSON.stringify(ctx.workspaces)
  const listChanged = listSig !== state.workspacesSig
  state.workspaces = ctx.workspaces
  state.workspacesSig = listSig

  const fid = resolveFocus(ctx)
  const firstLoad = state.focusedId === undefined
  let focusMoved = false
  if (fid !== undefined && fid !== null && fid !== state.focusedId) {
    focusMoved = true
    state.focusedId = fid
  } else if (firstLoad && fid === null) state.focusedId = null

  let next = state.repo
  const focused = state.workspaces.find((w) => w.id === state.focusedId && w.git)
  if (focusMoved && focused && state.follow && pickSeq === state.pickSeq && !conflictsUI.mergeOpen) next = focused.path
  if (!next) {
    // First load: the workspace Orca shows, else the one picked last time, else any repository.
    const last = state.workspaces.find((w) => w.id === state.lastPickedId && w.git)
    next = focused?.path ?? last?.path ?? state.workspaces.find((w) => w.git)?.path ?? null
  } else if (!state.workspaces.some((w) => w.path === next)) {
    // The workspace was removed from Orca.
    next = focused?.path ?? state.workspaces.find((w) => w.git)?.path ?? null
  }
  if (next !== state.repo) await setRepo(next)
  else if (listChanged || focusMoved) renderSwitcherButton()
  if (!next) showFatal(new Error('Add a Git repository or worktree to Orca to see it here.'))
  if ((listChanged || focusMoved) && switcherOpen()) renderSwitcherList()
}

function showFatal(err) {
  $('#rows').innerHTML = `<div class="empty"><strong>Nothing to show</strong>${esc(err?.message ?? err)}</div>`
}

async function setRepo(path) {
  state.repo = path
  state.repoName = state.workspaces.find((w) => w.path === path)?.name ?? ''
  state.filters = { ref: 'all', text: '', author: '', since: '' }
  state.sig = { log: '', branches: '', status: '' }
  $('#textFilter').value = ''
  $('#userSelect').value = ''
  $('#dateSelect').value = ''
  state.selected = null
  state.branchSel = null
  state.changeSel = null
  state.branches = null
  state.conflictCount = null
  state.stashConflict = false
  state.stashKept = false
  conflictsUI.closeDialog()
  renderSwitcherButton()
  renderDetailsEmpty()
  $('#changesDiff').innerHTML = '<div class="empty"><strong>No file selected</strong>Pick a file to see its diff.</div>'
  if (!path) return
  $('#rows').innerHTML = '<div class="more"><span class="spinner"></span>Reading history</div>'
  $('#branchTree').innerHTML = ''
  await refreshAll({ background: false })
  void loadAuthors()
}

// ------------------------------------------------------------------------------------------------
// Refresh
//
// A foreground refresh (new repository, new filter) redraws the log. A background refresh (after
// an action, a fetch, the window regaining focus, the refresh button) asks git again and only
// touches what changed, keeping scroll positions, the selected commit and any open diff.

const refreshing = new Map()
async function refreshAll({ background = true } = {}) {
  const repo = state.repo
  if (!repo) return
  const key = `${repo}\n${background}`
  if (refreshing.has(key)) return refreshing.get(key)
  const run = (async () => {
    const results = await Promise.allSettled([
      loadBranches(),
      loadStatus(),
      background ? refreshLog() : loadLog(true, false)
    ])
    const failed = results.find((r) => r.status === 'rejected')
    if (failed && repo === state.repo) toastError('Could not read the repository', /** @type {any} */ (failed).reason)
  })().finally(() => refreshing.delete(key))
  refreshing.set(key, run)
  return run
}

const logSig = (commits) =>
  commits.map((c) => c.hash + ':' + c.refs.map((r) => r.type + r.name + (r.current ? '*' : '')).join(',')).join('|')

/** Re-reads the loaded part of the log; redraws only when commits or refs changed. */
async function refreshLog() {
  const repo = state.repo
  const token = ++state.logToken
  const limit = Math.min(Math.max(state.pageSize, state.commits.length), 5000)
  const res = await req('git.log', { ...state.filters, skip: 0, limit })
  if (token !== state.logToken || repo !== state.repo) return
  const sig = logSig(res.commits) + (res.hasMore ? '+' : '')
  if (sig === state.sig.log) return
  state.sig.log = sig
  const rowsEl = $('#rows')
  const scroll = rowsEl.scrollTop
  state.commits = res.commits
  state.hasMore = res.hasMore
  state.graph = createGraph()
  state.rowLayout = state.graph.add(res.commits)
  rowsEl.innerHTML = ''
  appendRows(0)
  rowsEl.scrollTop = scroll
  const keep = state.selected ? state.commits.findIndex((c) => c.hash === state.selected) : -1
  if (keep >= 0) markSelected(keep, false)
  else if (state.selected) {
    // The selected commit is gone (amended, reset or filtered out): say so instead of a stale view.
    state.selected = null
    renderDetailsEmpty()
  }
  if (!state.commits.length) renderLogEmpty()
}

async function loadAuthors() {
  try {
    const authors = await req('git.authors')
    const sel = /** @type {HTMLSelectElement} */ ($('#userSelect'))
    const cur = sel.value
    sel.innerHTML =
      '<option value="">User</option>' + authors.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('')
    sel.value = cur
  } catch {}
}

// ------------------------------------------------------------------------------------------------
// Branch tree

async function loadBranches() {
  const repo = state.repo
  const branches = await req('git.branches')
  if (repo !== state.repo) return
  const sig = JSON.stringify(branches)
  state.branches = branches
  if (sig === state.sig.branches) return
  state.sig.branches = sig
  renderBranchSelect()
  const tree = $('#branchTree')
  const scroll = tree.scrollTop
  renderTree()
  tree.scrollTop = scroll
  renderBranchChip()
  renderSwitcherButton()
}

/** Current branch with its ahead/behind counts, next to the repository picker. */
function renderBranchChip() {
  const b = state.branches
  const chip = $('#branchChip')
  if (!b) return chip.classList.add('hidden')
  const cur = b.locals.find((l) => l.current)
  const name = b.head.branch ?? `detached ${b.head.sha?.slice(0, 8) ?? ''}`
  const track = cur?.upstream
    ? `${cur.behind ? `<span class="in" title="${cur.behind} incoming">↙${cur.behind}</span>` : ''}${cur.ahead ? `<span class="out" title="${cur.ahead} outgoing">↗${cur.ahead}</span>` : ''}`
    : b.head.branch
      ? '<span class="none" title="No upstream branch; Push sets one">local only</span>'
      : ''
  chip.innerHTML = `${icon('branch')}<span class="bname">${esc(name)}</span>${track}`
  chip.title = cur?.upstream ? `${name} tracks ${cur.upstream}` : name
  chip.classList.remove('hidden')
}

const favKey = () => state.repo ?? ''
function isFavorite(name) {
  const list = state.favorites[favKey()]
  if (!list) return ['main', 'master'].includes(name)
  return list.includes(name)
}
async function toggleFavorite(name) {
  const key = favKey()
  const list = state.favorites[key] ?? ['main', 'master'].filter((n) => state.branches?.locals.some((l) => l.name === n))
  state.favorites[key] = list.includes(name) ? list.filter((n) => n !== name) : [...list, name]
  try {
    await orca.storage.set('favorites', state.favorites)
  } catch {}
  renderTree()
}

/** Groups branch names on "/" into folders. */
function groupByFolder(items, nameOf) {
  const root = { folders: new Map(), leaves: [] }
  for (const item of items) {
    const parts = nameOf(item).split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), leaves: [] })
      node = node.folders.get(part)
    }
    node.leaves.push({ item, label: parts[parts.length - 1] })
  }
  return root
}

/**
 * Flattens the branch tree into visible rows.
 * @returns {{ key: string; depth: number; kind: string; label: string; ref?: string; item?: any; open?: boolean; folder?: boolean }[]}
 */
function treeRows() {
  const b = state.branches
  if (!b) return []
  const q = /** @type {HTMLInputElement} */ ($('#branchFilter')).value.trim().toLowerCase()
  const match = (name) => !q || name.toLowerCase().includes(q)
  const rows = []
  const isOpen = (key) => (q ? true : !state.collapsed.has(key))

  const pushFolder = (tree, prefix, depth, kind) => {
    const folders = [...tree.folders.entries()].sort((a, c) => a[0].localeCompare(c[0]))
    for (const [name, sub] of folders) {
      const key = `${prefix}/${name}`
      const open = isOpen(key)
      rows.push({ key, depth, kind: 'folder', label: name, open, folder: true })
      if (open) pushFolder(sub, key, depth + 1, kind)
    }
    const leaves = [...tree.leaves].sort((a, c) => a.label.localeCompare(c.label, undefined, { numeric: true }))
    for (const { item, label } of leaves) {
      rows.push({ key: `${kind}:${item.name}`, depth, kind, label, ref: item.name, item })
    }
  }

  // HEAD
  const headLabel = b.head.branch ? 'HEAD (Current Branch)' : `HEAD (detached at ${b.head.sha?.slice(0, 8) ?? '?'})`
  if (!q || match('head')) rows.push({ key: 'head', depth: 0, kind: 'head', label: headLabel, ref: 'HEAD' })

  // Local: current and favourites first, then folders, then the rest.
  const locals = b.locals.filter((l) => match(l.name))
  if (locals.length || !q) {
    const open = isOpen('local')
    rows.push({ key: 'local', depth: 0, kind: 'section', label: 'Local', open, folder: true })
    if (open) {
      const pinned = locals
        .filter((l) => l.current || isFavorite(l.name))
        .sort((a, c) => Number(c.current) - Number(a.current) || a.name.localeCompare(c.name))
      for (const l of pinned) rows.push({ key: `local:${l.name}`, depth: 1, kind: 'local', label: l.name, ref: l.name, item: l })
      const rest = locals.filter((l) => !l.current && !isFavorite(l.name))
      pushFolder(groupByFolder(rest, (l) => l.name), 'local', 1, 'local')
    }
  }

  // Remote: one folder per remote.
  const remotes = b.remotes.filter((r) => match(r.name))
  if (remotes.length || (!q && b.remotesList.length)) {
    const open = isOpen('remote')
    rows.push({ key: 'remote', depth: 0, kind: 'section', label: 'Remote', open, folder: true })
    if (open) {
      const names = [...new Set([...b.remotesList, ...remotes.map((r) => r.remote)])]
      for (const remote of names) {
        const key = `remote/${remote}`
        const ropen = isOpen(key)
        rows.push({ key, depth: 1, kind: 'remoteRoot', label: remote, open: ropen, folder: true })
        if (ropen) {
          const mine = remotes.filter((r) => r.remote === remote)
          const fav = mine.filter((r) => isFavorite(r.branch))
          for (const r of fav) rows.push({ key: `remote:${r.name}`, depth: 2, kind: 'remote', label: r.branch, ref: r.name, item: r })
          pushFolder(
            groupByFolder(
              mine.filter((r) => !isFavorite(r.branch)),
              (r) => r.branch
            ),
            key,
            2,
            'remote'
          )
        }
      }
    }
  }

  const tags = b.tags.filter((t) => match(t.name))
  if (tags.length) {
    const open = isOpen('tags')
    rows.push({ key: 'tags', depth: 0, kind: 'section', label: `Tags (${tags.length})`, open, folder: true })
    if (open) {
      const sorted = [...tags].sort((a, c) => c.date - a.date || c.name.localeCompare(a.name, undefined, { numeric: true }))
      for (const t of sorted) rows.push({ key: `tag:${t.name}`, depth: 1, kind: 'tag', label: t.name, ref: t.name, item: t })
    }
  }
  return rows
}

let currentTreeRows = []
function renderTree() {
  const el = $('#branchTree')
  currentTreeRows = treeRows()
  el.innerHTML = currentTreeRows
    .map((r, i) => {
      const pad = 6 + r.depth * 14
      const chev = r.folder ? `<span class="chev">${icon('chevron')}</span>` : '<span class="chev"></span>'
      let ico = ''
      let track = ''
      if (r.kind === 'folder') ico = `<span class="ico">${icon('folder')}</span>`
      else if (r.kind === 'remoteRoot') ico = `<span class="ico">${icon('cloud')}</span>`
      else if (r.kind === 'local' || r.kind === 'remote') {
        const name = r.kind === 'local' ? r.item.name : r.item.branch
        const current = r.kind === 'local' && r.item.current
        ico = current
          ? `<span class="ico current" title="Current branch">${icon('tag')}</span>`
          : isFavorite(name)
            ? `<span class="ico fav" title="Favorite">${icon('star')}</span>`
            : `<span class="ico">${icon('branch')}</span>`
        if (r.kind === 'local') {
          const it = r.item
          if (it.gone) track = '<span class="track"><span class="gone" title="Upstream branch is gone">gone</span></span>'
          else if (it.ahead || it.behind) {
            track = `<span class="track" title="${it.behind} incoming, ${it.ahead} outgoing (${esc(it.upstream ?? '')})">${
              it.behind ? `<span class="in">↙${it.behind}</span>` : ''
            }${it.ahead ? `<span class="out">↗${it.ahead}</span>` : ''}</span>`
          }
        }
      } else if (r.kind === 'tag') ico = `<span class="ico">${icon('tag')}</span>`
      else if (r.kind === 'head') ico = `<span class="ico">${icon('head')}</span>`
      const cls = ['node', r.folder ? 'folder' : '', r.open ? 'open' : '', r.kind === 'section' ? 'section' : '', state.branchSel === r.key ? 'selected' : '']
        .filter(Boolean)
        .join(' ')
      const title = r.item?.subject ? ` title="${esc(r.ref)}\n${esc(r.item.subject)}"` : ''
      return `<div class="${cls}" data-i="${i}" style="padding-left:${pad}px"${title}>${chev}${ico}<span class="label">${esc(r.label)}</span>${track}</div>`
    })
    .join('')
}

function onTreeClick(e) {
  const el = /** @type {HTMLElement} */ (e.target).closest('.node')
  if (!el) return
  const r = currentTreeRows[Number(el.dataset.i)]
  if (r.folder) {
    if (state.collapsed.has(r.key)) state.collapsed.delete(r.key)
    else state.collapsed.add(r.key)
    renderTree()
    return
  }
  state.branchSel = r.key
  renderTree()
  if (r.ref) setRefFilter(r.kind === 'remote' || r.kind === 'tag' ? r.ref : r.ref)
  $('#branchesPane').classList.remove('open')
  $('#toggleBranches').classList.remove('on')
}

function onTreeDblClick(e) {
  const el = /** @type {HTMLElement} */ (e.target).closest('.node')
  if (!el) return
  const r = currentTreeRows[Number(el.dataset.i)]
  if (r.kind === 'local' && !r.item.current) void checkout(r.item.name)
  if (r.kind === 'remote') void checkout(r.item.name, { remote: true })
}

function onTreeContext(e) {
  const el = /** @type {HTMLElement} */ (e.target).closest('.node')
  if (!el) return
  const r = currentTreeRows[Number(el.dataset.i)]
  state.branchSel = r.key
  renderTree()
  const cur = state.branches?.head.branch
  if (r.kind === 'local') {
    const it = r.item
    showMenu(e, [
      { head: it.name },
      { label: 'Checkout', run: () => void checkout(it.name), disabled: it.current },
      { label: `New Branch from '${it.name}'…`, run: () => void newBranch(it.name) },
      { label: 'Show Commits Not in Current Branch', run: () => setRefFilter(`HEAD..${it.name}`), disabled: it.current },
      '-',
      { label: `Merge '${it.name}' into '${cur ?? 'HEAD'}'`, run: () => void merge(it.name), disabled: it.current },
      { label: `Rebase '${cur ?? 'HEAD'}' onto '${it.name}'`, run: () => void rebase(it.name), disabled: it.current },
      '-',
      it.current
        ? { label: 'Update (Pull)', run: () => void pull() }
        : { label: 'Update (Fast-Forward)', run: () => void tryAct('updateBranch', { branch: it.name }, { success: `Updated ${it.name}` }), disabled: !it.upstream },
      { label: 'Push…', run: () => void push(it.name) },
      '-',
      { label: isFavorite(it.name) ? 'Remove from Favorites' : 'Add to Favorites', run: () => void toggleFavorite(it.name) },
      { label: 'Rename…', run: () => void renameBranch(it.name) },
      { label: 'Copy Branch Name', run: () => void copyText(it.name) },
      { label: 'Delete', danger: true, run: () => void deleteBranch(it.name), disabled: it.current }
    ])
  } else if (r.kind === 'remote') {
    const it = r.item
    showMenu(e, [
      { head: it.name },
      { label: 'Checkout', run: () => void checkout(it.name, { remote: true }) },
      { label: `New Branch from '${it.name}'…`, run: () => void newBranch(it.name, it.branch) },
      { label: 'Show Commits Not in Current Branch', run: () => setRefFilter(`HEAD..${it.name}`) },
      '-',
      { label: `Merge '${it.name}' into '${cur ?? 'HEAD'}'`, run: () => void merge(it.name) },
      { label: `Rebase '${cur ?? 'HEAD'}' onto '${it.name}'`, run: () => void rebase(it.name) },
      '-',
      { label: isFavorite(it.branch) ? 'Remove from Favorites' : 'Add to Favorites', run: () => void toggleFavorite(it.branch) },
      { label: 'Copy Branch Name', run: () => void copyText(it.name) },
      { label: 'Delete Remote Branch', danger: true, run: () => void deleteBranch(it.name, { remote: true }) }
    ])
  } else if (r.kind === 'tag') {
    const it = r.item
    showMenu(e, [
      { head: `tag ${it.name}` },
      { label: 'Checkout Tag (Detached)', run: () => void checkout(it.name, { detach: true }) },
      { label: `New Branch from '${it.name}'…`, run: () => void newBranch(it.name) },
      { label: `Merge '${it.name}' into '${cur ?? 'HEAD'}'`, run: () => void merge(it.name) },
      '-',
      { label: 'Copy Tag Name', run: () => void copyText(it.name) },
      { label: 'Delete Tag', danger: true, run: () => void deleteTag(it.name) }
    ])
  } else if (r.kind === 'head') {
    showMenu(e, [
      { label: 'New Branch…', run: () => void newBranch('HEAD') },
      { label: 'Update (Pull)', run: () => void pull() },
      { label: 'Push…', run: () => void push() }
    ])
  }
}

// ------------------------------------------------------------------------------------------------
// Log

function renderBranchSelect() {
  const b = state.branches
  const sel = /** @type {HTMLSelectElement} */ ($('#branchSelect'))
  const ref = state.filters.ref
  const opts = ['<option value="all">All branches</option>', '<option value="HEAD">HEAD</option>']
  if (b) {
    opts.push(`<optgroup label="Local">${b.locals.map((l) => `<option value="${esc(l.name)}">${esc(l.name)}</option>`).join('')}</optgroup>`)
    if (b.remotes.length)
      opts.push(`<optgroup label="Remote">${b.remotes.map((r) => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('')}</optgroup>`)
  }
  const known = ref === 'all' || ref === 'HEAD' || b?.locals.some((l) => l.name === ref) || b?.remotes.some((r) => r.name === ref)
  if (!known) opts.push(`<option value="${esc(ref)}">${esc(ref)}</option>`)
  sel.innerHTML = opts.join('')
  sel.value = ref
}

function setRefFilter(ref) {
  state.filters.ref = ref
  renderBranchSelect()
  void loadLog(true, true)
}

function renderLogEmpty() {
  $('#rows').innerHTML =
    state.filters.text || state.filters.author || state.filters.since || state.filters.ref !== 'all'
      ? '<div class="empty"><strong>No matching commits</strong>Clear the text, user, date or branch filter to see more.</div>'
      : '<div class="empty"><strong>No commits yet</strong>Make the first commit from the Changes tab.</div>'
}

async function loadLog(reset = true, keepSelection = true) {
  const token = ++state.logToken
  const rowsEl = $('#rows')
  if (reset) {
    state.loadingLog = true
    let res
    try {
      res = await req('git.log', { ...state.filters, skip: 0, limit: state.pageSize })
    } catch (err) {
      if (token === state.logToken) {
        state.loadingLog = false
        state.commits = []
        rowsEl.innerHTML = `<div class="empty">${esc(err?.message ?? err)}</div>`
      }
      return
    }
    if (token !== state.logToken) return
    state.commits = res.commits
    state.hasMore = res.hasMore
    state.graph = createGraph()
    state.rowLayout = state.graph.add(res.commits)
    state.graphLanes = 1
    rowsEl.innerHTML = ''
    appendRows(0)
    state.loadingLog = false
    state.sig.log = logSig(res.commits) + (res.hasMore ? '+' : '')
    const keep = keepSelection && state.selected ? state.commits.findIndex((c) => c.hash === state.selected) : -1
    if (keep >= 0) {
      markSelected(keep, false)
      if (state.details?.hash !== state.selected) void loadDetails(/** @type {string} */ (state.selected))
    } else {
      state.selected = null
      renderDetailsEmpty()
    }
    if (!state.commits.length) renderLogEmpty()
    return
  }
  if (state.loadingLog || !state.hasMore) return
  state.loadingLog = true
  try {
    const res = await req('git.log', { ...state.filters, skip: state.commits.length, limit: state.pageSize })
    if (token !== state.logToken) return
    const start = state.commits.length
    state.commits.push(...res.commits)
    state.rowLayout.push(...state.graph.add(res.commits))
    state.hasMore = res.hasMore
    state.sig.log = logSig(state.commits) + (res.hasMore ? '+' : '')
    appendRows(start)
  } catch (err) {
    toastError('Could not load more commits', err)
  } finally {
    if (token === state.logToken) state.loadingLog = false
  }
}

const laneColor = (i) => COLORS[i % COLORS.length]

/** A lane segment from (x1,y1) to (x2,y2): straight when vertical, an S-curve when it changes lane. */
function seg(x1, y1, x2, y2, color) {
  if (x1 === x2) return `<path d="M${x1} ${y1}V${y2}" stroke="${color}"/>`
  const ym = (y1 + y2) / 2
  return `<path d="M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}" stroke="${color}"/>`
}

function graphSvg(row, commit, isHead) {
  const x = (c) => c * LANE + LANE / 2 + 4
  const mid = ROW_H / 2
  const w = Math.max(row.width, 1) * LANE + 8
  // Lines run a pixel past the row so neighbouring rows join without a seam.
  const top = -1
  const bottom = ROW_H + 1
  let s = `<svg width="${w}" height="${ROW_H}" stroke-width="2" fill="none" stroke-linecap="round" aria-hidden="true">`
  for (const p of row.passes) s += seg(x(p.col), top, x(p.col), bottom, laneColor(p.color))
  for (const m of row.merges) s += seg(x(m.from), top, x(row.col), mid, laneColor(m.color))
  if (row.hasTop) s += seg(x(row.col), top, x(row.col), mid, laneColor(row.color))
  for (const p of row.parents) s += seg(x(row.col), mid, x(p.to), bottom, laneColor(p.color))
  const cx = x(row.col)
  const c = laneColor(row.color)
  if (isHead) {
    s += `<circle cx="${cx}" cy="${mid}" r="6.5" fill="${c}" fill-opacity=".22" stroke="none"/><circle cx="${cx}" cy="${mid}" r="4" fill="${c}" stroke="var(--bg)" stroke-width="1.5"/>`
  } else if (commit.parents.length > 1) {
    s += `<circle cx="${cx}" cy="${mid}" r="3.4" fill="var(--bg)" stroke="${c}" stroke-width="2"/>`
  } else {
    s += `<circle cx="${cx}" cy="${mid}" r="3.6" fill="${c}" stroke="var(--bg)" stroke-width="1.2"/>`
  }
  return s + '</svg>'
}

/**
 * Ref labels in the colour of the commit's lane, joining a local branch with its remote twin
 * ("origin & main"). The icon tells the kind: branch, remote, tag.
 */
function refBadges(refs, lane = 0) {
  if (!refs.length) return ''
  const style = `style="--lane:${laneColor(lane)}"`
  const locals = refs.filter((r) => r.type === 'local')
  const remotes = refs.filter((r) => r.type === 'remote')
  const used = new Set()
  const out = []
  for (const r of refs) if (r.type === 'head') out.push(`<span class="ref head" ${style} title="Detached HEAD">${icon('head')}HEAD</span>`)
  for (const l of locals) {
    const twins = remotes.filter((r) => r.name.slice(r.name.indexOf('/') + 1) === l.name)
    twins.forEach((t) => used.add(t.name))
    const label = twins.length ? `${twins.map((t) => t.name.slice(0, t.name.indexOf('/'))).join(' & ')} & ${l.name}` : l.name
    const tip = l.current ? `${label} (current branch)` : label
    out.push(`<span class="ref local${l.current ? ' current' : ''}" ${style} title="${esc(tip)}">${icon('branch')}<span>${esc(label)}</span></span>`)
  }
  for (const r of remotes)
    if (!used.has(r.name)) out.push(`<span class="ref remote" ${style} title="${esc(r.name)}">${icon('cloud')}<span>${esc(r.name)}</span></span>`)
  for (const r of refs) if (r.type === 'tag') out.push(`<span class="ref tag" title="Tag ${esc(r.name)}">${icon('tag')}<span>${esc(r.name)}</span></span>`)
  return `<span class="refs">${out.join('')}</span>`
}

function appendRows(start) {
  const rowsEl = $('#rows')
  $('.more', rowsEl)?.remove()
  const headSha = state.branches?.head.sha
  let maxLanes = state.graphLanes
  const html = []
  for (let i = start; i < state.commits.length; i++) {
    const c = state.commits[i]
    const row = state.rowLayout[i]
    maxLanes = Math.max(maxLanes, row.width)
    const cls = ['row', c.parents.length > 1 ? 'merge' : '', c.hash === state.selected ? 'selected' : ''].filter(Boolean).join(' ')
    html.push(
      `<div class="${cls}" data-i="${i}" style="--lane:${laneColor(row.color)}"><div class="graph">${graphSvg(row, c, c.hash === headSha)}</div><div class="subject">${refBadges(c.refs, row.color)}<span class="text" title="${esc(c.subject)}">${esc(c.subject)}</span></div><div class="author" title="${esc(c.author)} <${esc(c.email)}>">${esc(c.author)}</div><div class="date" title="${esc(new Date(c.time).toLocaleString())}">${esc(shortDate(c.time))}</div></div>`
    )
  }
  rowsEl.insertAdjacentHTML('beforeend', html.join(''))
  if (state.hasMore) rowsEl.insertAdjacentHTML('beforeend', '<div class="more"><span class="spinner"></span>Loading older commits</div>')
  state.graphLanes = Math.min(maxLanes, 24)
  document.documentElement.style.setProperty('--graph-w', `${state.graphLanes * LANE + 12}px`)
}

function markSelected(i, scroll = true) {
  const c = state.commits[i]
  if (!c) return
  state.selected = c.hash
  for (const el of $$('.row.selected')) el.classList.remove('selected')
  const el = $(`.row[data-i="${i}"]`)
  el?.classList.add('selected')
  if (scroll) el?.scrollIntoView({ block: 'nearest' })
  $('#logView').classList.remove('no-details')
}

function selectRow(i) {
  const c = state.commits[i]
  if (!c) return
  markSelected(i)
  void loadDetails(c.hash)
}

function onRowsKey(e) {
  if (!state.commits.length) return
  const cur = state.commits.findIndex((c) => c.hash === state.selected)
  let next = cur
  if (e.key === 'ArrowDown') next = Math.min(cur + 1, state.commits.length - 1)
  else if (e.key === 'ArrowUp') next = Math.max(cur - 1, 0)
  else if (e.key === 'PageDown') next = Math.min(cur + 20, state.commits.length - 1)
  else if (e.key === 'PageUp') next = Math.max(cur - 20, 0)
  else if (e.key === 'Home') next = 0
  else if (e.key === 'End') next = state.commits.length - 1
  else return
  e.preventDefault()
  if (next !== cur) selectRow(next)
}

function onRowContext(e) {
  const el = /** @type {HTMLElement} */ (e.target).closest('.row')
  if (!el) return
  const i = Number(el.dataset.i)
  const c = state.commits[i]
  if (c.hash !== state.selected) selectRow(i)
  const short = c.hash.slice(0, 8)
  const cur = state.branches?.head.branch
  const branchesHere = c.refs.filter((r) => r.type === 'local' && !r.current)
  showMenu(e, [
    { head: `${short} ${c.subject}` },
    { label: 'Copy Revision Number', run: () => void copyText(c.hash) },
    { label: 'Copy Commit Message', run: () => void copySubject(c) },
    '-',
    ...branchesHere.map((r) => ({ label: `Checkout '${r.name}'`, run: () => void checkout(r.name) })),
    { label: 'Checkout Revision (Detached)', run: () => void checkout(c.hash, { detach: true }) },
    { label: 'New Branch…', run: () => void newBranch(c.hash) },
    { label: 'New Tag…', run: () => void newTag(c.hash) },
    '-',
    { label: 'Cherry-Pick', run: () => void cherryPick(c) },
    { label: 'Revert Commit', run: () => void revert(c) },
    { label: `Reset Current Branch to Here…`, run: () => void reset(c), danger: true, disabled: !cur && !state.branches?.head.sha }
  ])
}

async function copySubject(c) {
  try {
    const d = state.details?.hash === c.hash ? state.details : await req('git.details', { hash: c.hash })
    await copyText(d.message)
  } catch {
    await copyText(c.subject)
  }
}

// ------------------------------------------------------------------------------------------------
// Details

function renderDetailsEmpty() {
  state.details = null
  $('#detailsPane').innerHTML = '<div class="empty"><strong>No commit selected</strong>Pick a commit in the log to see its message and changed files.</div>'
  $('#logView').classList.add('no-details')
}

async function loadDetails(hash) {
  const token = ++state.detailsToken
  try {
    const d = await req('git.details', { hash })
    if (token !== state.detailsToken) return
    state.details = d
    renderDetails()
  } catch (err) {
    if (token !== state.detailsToken) return
    $('#detailsPane').innerHTML = `<div class="empty">${esc(err.message)}</div>`
  }
}

function splitPath(p) {
  const i = p.lastIndexOf('/')
  return i < 0 ? { name: p, dir: '' } : { name: p.slice(i + 1), dir: p.slice(0, i) }
}

const STATUS_NAMES = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Conflict', '?': 'Unversioned', T: 'Type changed' }

function fileRow(f, i, extra = '') {
  const { name, dir } = splitPath(f.path)
  const st = f.status
  const title = `${STATUS_NAMES[st] ?? st}: ${f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}`
  return `<div class="file" data-i="${i}" title="${esc(title)}"><span class="st st-${esc(st)}" aria-label="${esc(STATUS_NAMES[st] ?? st)}">${esc(st === '?' ? 'N' : st)}</span><span class="name n-${esc(st)}">${esc(name)}</span><span class="dir">${esc(dir)}</span>${extra}</div>`
}

function initials(name) {
  const parts = String(name ?? '?').trim().split(/[\s._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}
function nameColor(name) {
  let h = 0
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]
}

function relative(ms) {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`
  return new Date(ms).toLocaleDateString()
}

function renderDetails() {
  const d = state.details
  const pane = $('#detailsPane')
  const [subject, ...bodyLines] = d.message.split('\n')
  const body = bodyLines.join('\n').trim()
  const rowIndex = state.commits.findIndex((c) => c.hash === d.hash)
  const lane = rowIndex >= 0 ? state.rowLayout[rowIndex].color : 0
  const refs = refBadges(d.refs, lane)
  const committer = d.committer && (d.committer !== d.author || Math.abs(d.commitTime - d.time) > 60_000)
  const branches = d.containedIn.length
    ? `<div class="meta-row"><span class="k">Branches</span><span class="v">${d.containedIn
        .slice(0, 8)
        .map((b) => esc(b))
        .join(', ')}${d.containedIn.length > 8 ? ` and ${d.containedIn.length - 8} more` : ''}</span></div>`
    : ''
  const n = d.files.length
  pane.innerHTML = `
    <div class="d-commit" style="--lane:${laneColor(lane)}">
      <div class="d-author">
        <span class="avatar" style="--av:${nameColor(d.author)}" aria-hidden="true">${esc(initials(d.author))}</span>
        <div class="who">
          <div class="name" title="${esc(d.email)}">${esc(d.author)}</div>
          <div class="when" title="${esc(new Date(d.time).toLocaleString())}">${esc(relative(d.time))}</div>
        </div>
        <button class="hash-chip" data-copy="${esc(d.hash)}" title="Copy full hash">${icon('copy')}${esc(d.hash.slice(0, 8))}</button>
      </div>
      <h2 class="d-subject">${esc(subject)}</h2>
      ${body ? `<p class="d-body">${esc(body)}</p>` : ''}
      ${refs ? `<div class="refs-line">${refs}</div>` : ''}
      <div class="meta">
        ${committer ? `<div class="meta-row"><span class="k">Committed</span><span class="v">${esc(d.committer)}, ${esc(new Date(d.commitTime).toLocaleString())}</span></div>` : ''}
        ${d.parents.length ? `<div class="meta-row"><span class="k">${d.parents.length > 1 ? 'Parents' : 'Parent'}</span><span class="v">${d.parents.map((p) => `<a class="hash" data-goto="${esc(p)}" title="Go to commit">${esc(p.slice(0, 8))}</a>`).join(' ')}</span></div>` : ''}
        ${branches}
      </div>
    </div>
    <div class="d-head"><span class="title">${n ? `${n} changed file${n === 1 ? '' : 's'}` : 'No file changes'}</span>${d.parents.length > 1 ? '<span class="hint">compared with first parent</span>' : ''}</div>
    <div class="d-files">${d.files.map((f, i) => fileRow(f, i)).join('')}</div>`
  $('.d-files', pane).onclick = (e) => {
    const el = /** @type {HTMLElement} */ (e.target).closest('.file')
    if (el) void showCommitDiff(d.files[Number(el.dataset.i)])
  }
  $('.d-commit', pane).onclick = (e) => {
    const a = /** @type {HTMLElement} */ (e.target).closest('[data-copy],[data-goto]')
    if (!(a instanceof HTMLElement)) return
    if (a.dataset.copy) void copyText(a.dataset.copy)
    if (a.dataset.goto) gotoCommit(a.dataset.goto)
  }
}

function gotoCommit(hash) {
  const i = state.commits.findIndex((c) => c.hash === hash)
  if (i >= 0) selectRow(i)
  else {
    $('#textFilter').value = hash
    state.filters.text = hash
    void loadLog(true, false).then(() => state.commits.length && selectRow(0))
  }
}

async function showCommitDiff(f) {
  const d = state.details
  const pane = $('#detailsPane')
  pane.innerHTML = `<div class="d-head"><button class="icon" title="Back to commit" data-back>${icon('back')}</button><span class="st st-${esc(f.status)}">${esc(f.status)}</span><span class="title" title="${esc(f.path)}">${esc(f.path)}</span></div><div class="diff"><div class="info">Loading…</div></div>`
  $('[data-back]', pane).onclick = () => renderDetails()
  try {
    const res = await req('git.diff', { hash: d.hash, parent: d.parents[0] ?? null, path: f.path, oldPath: f.oldPath })
    if (state.details !== d) return
    $('.diff', pane).outerHTML = diffHtml(res.diff, res.truncated)
  } catch (err) {
    $('.diff', pane).innerHTML = `<div class="info">${esc(err.message)}</div>`
  }
}

function diffHtml(text, truncated) {
  if (!text.trim()) return '<div class="diff"><div class="info">No textual changes (mode change or empty file).</div></div>'
  const out = []
  let oldN = 0
  let newN = 0
  let count = 0
  for (const line of text.split('\n')) {
    if (count++ > 20_000) {
      out.push('<div class="info">Diff too long to show in full.</div>')
      break
    }
    if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename from|rename to|old mode|new mode)/.test(line)) continue
    if (line.startsWith('Binary files')) {
      out.push(`<div class="info">${esc(line)}</div>`)
      continue
    }
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (m) {
      oldN = Number(m[1])
      newN = Number(m[2])
      out.push(`<div class="l hunk"><span class="ln"></span><span class="ln"></span><span class="code">${esc(line)}</span></div>`)
      continue
    }
    if (line.startsWith('+')) out.push(`<div class="l add"><span class="ln"></span><span class="ln">${newN++}</span><span class="code">${esc(line)}</span></div>`)
    else if (line.startsWith('-')) out.push(`<div class="l del"><span class="ln">${oldN++}</span><span class="ln"></span><span class="code">${esc(line)}</span></div>`)
    else if (line.startsWith('\\')) out.push(`<div class="l"><span class="ln"></span><span class="ln"></span><span class="code">${esc(line)}</span></div>`)
    else if (line.length || oldN) out.push(`<div class="l"><span class="ln">${oldN++}</span><span class="ln">${newN++}</span><span class="code">${esc(line)}</span></div>`)
  }
  if (truncated) out.push('<div class="info">Diff truncated.</div>')
  return `<div class="diff">${out.join('')}</div>`
}

// ------------------------------------------------------------------------------------------------
// Local changes

async function loadStatus() {
  const repo = state.repo
  const status = await req('git.status')
  if (repo !== state.repo) return
  const sig = JSON.stringify(status)
  state.status = status
  if (sig === state.sig.status) return
  state.sig.status = sig
  const n = status.files.length
  $('#changesCount').textContent = n ? String(n) : ''
  const conflicts = status.files.filter((f) => f.kind === 'conflict').length
  const before = state.conflictCount
  state.conflictCount = conflicts
  if (conflicts && !status.inProgress) state.stashConflict = true
  else if (!conflicts && state.stashConflict) {
    state.stashConflict = false
    state.stashKept = !status.inProgress
  }
  renderBanner()
  // An operation just stopped on conflicts: show them, like the other dialogs that follow an action.
  if (before === 0 && conflicts > 0 && !conflictsUI.dialogOpen && !conflictsUI.mergeOpen) void conflictsUI.openDialog()
  else void conflictsUI.refreshDialog()
  const list = $('#changesList')
  const scroll = list.scrollTop
  renderChanges()
  list.scrollTop = scroll
  // Keep the open diff: refresh it in place if the file is still changed, else say it is gone.
  if (state.changeSel) {
    const f = changeRows.find((r) => `${r.group}:${r.path}` === state.changeSel)
    if (f) void showWorkingDiff(f, { quiet: true })
    else {
      state.changeSel = null
      $('#changesDiff').innerHTML = '<div class="empty"><strong>No changes left in this file</strong>It was committed, staged elsewhere or rolled back.</div>'
    }
  }
}

function renderBanner() {
  const st = state.status
  const banner = $('#banner')
  const op = st?.inProgress ?? null
  const conflicts = st?.files.filter((f) => f.kind === 'conflict').length ?? 0
  const label = op ? { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert' }[op] : ''
  /** @type {[string, string, string][]} action, text, class */
  const buttons = []
  let text = ''
  if (conflicts) {
    const n = `${conflicts} conflict${conflicts === 1 ? '' : 's'}`
    text = op ? `${label} in progress with ${n}.` : `${n} to resolve.`
    buttons.push(['resolve', 'Resolve conflicts…', 'primary'])
  } else if (op === 'merge') {
    text = 'Merge in progress: all conflicts are resolved.'
    buttons.push(['commitMerge', 'Commit merge', 'primary'])
  } else if (op) {
    text = `${label} paused: nothing is in conflict.`
    buttons.push(['continue', `Continue ${op}`, 'primary'], ['skip', 'Skip this commit', 'secondary'])
  } else if (state.stashKept) {
    text = 'Conflicts resolved. The stash was kept.'
    buttons.push(['dropStash', 'Drop stash', 'secondary'], ['dismiss', 'Dismiss', 'secondary'])
  }
  if (op) buttons.push(['abort', `Abort ${label.toLowerCase()}`, 'secondary'])
  if (!text) {
    banner.classList.add('hidden')
    banner.innerHTML = ''
    return
  }
  banner.innerHTML = `<span>${esc(text)}</span><span class="acts">${buttons
    .map(([a, t, c]) => `<button class="${c}" data-banner="${a}">${esc(t)}</button>`)
    .join('')}</span>`
  banner.classList.remove('hidden')
  banner.onclick = async (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('[data-banner]')
    if (!(b instanceof HTMLElement)) return
    const a = b.dataset.banner
    if (a === 'resolve') void conflictsUI.openDialog()
    else if (a === 'commitMerge' || a === 'continue' || a === 'skip') void conflictsUI.finish(a, op)
    else if (a === 'dismiss') {
      state.stashKept = false
      renderBanner()
    } else if (a === 'dropStash') {
      const ok = await ask({ title: 'Drop the stash?', message: 'The newest stash entry will be deleted. Its changes are already in your files.', ok: 'Drop', danger: true })
      if (ok && (await tryAct('stashDrop', {}, { success: 'Stash dropped' }))) {
        state.stashKept = false
        renderBanner()
      }
    } else if (a === 'abort') {
      const ok = await ask({ title: `Abort ${label.toLowerCase()}?`, message: 'Changes made by this operation will be discarded.', ok: 'Abort', danger: true })
      if (ok) await tryAct('abort', { what: op }, { success: `${label} aborted` })
    }
  }
}

function changeGroups() {
  const files = state.status?.files ?? []
  return {
    conflicts: files.filter((f) => f.kind === 'conflict').map((f) => ({ ...f, status: 'U', group: 'conflicts' })),
    staged: files
      .filter((f) => f.kind === 'changed' && f.index !== '.')
      .map((f) => ({ ...f, status: f.index, group: 'staged' })),
    unstaged: files
      .filter((f) => f.kind === 'changed' && f.worktree !== '.')
      .map((f) => ({ ...f, status: f.worktree, group: 'unstaged' })),
    untracked: files.filter((f) => f.kind === 'untracked').map((f) => ({ ...f, status: '?', group: 'untracked' }))
  }
}

let changeRows = []
function renderChanges() {
  const g = changeGroups()
  changeRows = []
  const btn = (name, title, attr) => `<button class="icon" title="${esc(title)}" ${attr}>${icon(name)}</button>`
  const section = (key, title, files, headActs, rowActs) => {
    if (!files.length) return ''
    const rows = files
      .map((f) => {
        const i = changeRows.push(f) - 1
        const sel = state.changeSel === `${f.group}:${f.path}` ? ' selected' : ''
        return fileRow(f, i, `<span class="acts">${rowActs(i)}</span>`).replace('class="file"', `class="file${sel}"`)
      })
      .join('')
    return `<div class="group">${esc(title)} <span class="n">${files.length}</span><span class="spacer"></span>${headActs}</div>${rows}`
  }
  const html =
    section(
      'conflicts',
      'Merge Conflicts',
      g.conflicts,
      '',
      (i) => btn('merge', 'Merge…', `data-a="merge" data-i="${i}"`) + btn('plus', 'Mark as resolved (stage)', `data-a="stage" data-i="${i}"`)
    ) +
    section(
      'staged',
      'Staged',
      g.staged,
      btn('minus', 'Unstage all', 'data-a="unstageAll"'),
      (i) => btn('minus', 'Unstage', `data-a="unstage" data-i="${i}"`)
    ) +
    section(
      'unstaged',
      'Changes',
      g.unstaged,
      btn('plus', 'Stage all changes', 'data-a="stageGroup" data-g="unstaged"') + btn('undo', 'Rollback all changes…', 'data-a="discardGroup" data-g="unstaged"'),
      (i) => btn('plus', 'Stage', `data-a="stage" data-i="${i}"`) + btn('undo', 'Rollback…', `data-a="discard" data-i="${i}"`)
    ) +
    section(
      'untracked',
      'Unversioned Files',
      g.untracked,
      btn('plus', 'Add all to Git', 'data-a="stageGroup" data-g="untracked"'),
      (i) => btn('plus', 'Add to Git', `data-a="stage" data-i="${i}"`) + btn('trash', 'Delete…', `data-a="discard" data-i="${i}"`)
    )
  $('#changesList').innerHTML = html || '<div class="empty"><strong>Working tree clean</strong>Edits to tracked files and new files show up here.</div>'
  updateCommitButtons()
}

function updateSubjectHint() {
  const msg = $('#commitMessage').value
  const len = msg.split('\n')[0].length
  const hint = $('#subjectHint')
  hint.textContent = len ? `${len}/72` : ''
  hint.classList.toggle('over', len > 72)
  hint.title = len > 72 ? 'Subject lines read best at 72 characters or fewer' : 'Subject line length'
}

function updateCommitButtons() {
  const g = changeGroups()
  const any = g.staged.length + g.unstaged.length > 0
  const amend = /** @type {HTMLInputElement} */ ($('#amend')).checked
  for (const b of [$('#commitBtn'), $('#commitPushBtn')]) /** @type {HTMLButtonElement} */ (b).disabled = !any && !amend
  $('#commitBtn').textContent = amend ? 'Amend commit' : g.staged.length ? `Commit ${g.staged.length} staged` : 'Commit'
  $('#commitPushBtn').textContent = amend ? 'Amend and push' : 'Commit and push'
}

async function onChangesClick(e) {
  const t = /** @type {HTMLElement} */ (e.target)
  const b = t.closest('button[data-a]')
  if (b instanceof HTMLElement) {
    e.stopPropagation()
    const a = b.dataset.a
    const f = b.dataset.i !== undefined ? changeRows[Number(b.dataset.i)] : null
    const g = changeGroups()
    if (a === 'merge' && f) await conflictsUI.openMerge(f.path)
    else if (a === 'stage' && f) await tryAct('stage', { paths: [f.path] }, { quiet: true })
    else if (a === 'unstage' && f) await tryAct('unstage', { paths: f.oldPath ? [f.path, f.oldPath] : [f.path] }, { quiet: true })
    else if (a === 'unstageAll') await tryAct('unstageAll', {}, { quiet: true })
    else if (a === 'stageGroup') {
      const files = b.dataset.g === 'untracked' ? g.untracked : g.unstaged
      await tryAct('stage', { paths: files.map((x) => x.path) }, { quiet: true })
    } else if (a === 'discard' && f) {
      const untracked = f.group === 'untracked'
      const ok = await ask({
        title: untracked ? 'Delete file?' : 'Rollback changes?',
        message: untracked ? `${f.path} will be deleted from disk.` : `Local changes to ${f.path} will be lost.`,
        ok: untracked ? 'Delete' : 'Rollback',
        danger: true
      })
      if (ok) await tryAct('discard', untracked ? { untracked: [f.path] } : { paths: [f.path] }, { quiet: true })
    } else if (a === 'discardGroup') {
      const ok = await ask({
        title: 'Rollback all changes?',
        message: `Unstaged and staged changes to ${g.unstaged.length} tracked file${g.unstaged.length === 1 ? '' : 's'} will be lost. Unversioned files are kept.`,
        ok: 'Rollback',
        danger: true
      })
      if (ok) await tryAct('discard', { paths: g.unstaged.map((x) => x.path) }, { quiet: true })
    }
    return
  }
  const row = t.closest('.file')
  if (row instanceof HTMLElement) {
    const f = changeRows[Number(row.dataset.i)]
    state.changeSel = `${f.group}:${f.path}`
    for (const el of $$('#changesList .file.selected')) el.classList.remove('selected')
    row.classList.add('selected')
    void showWorkingDiff(f)
  }
}

async function showWorkingDiff(f, { quiet = false } = {}) {
  const pane = $('#changesDiff')
  const key = `${f.group}:${f.path}`
  if (quiet && pane.dataset.key === key && $('.diff', pane)) {
    // Background refresh: swap the diff body only when it changed, keeping its scroll position.
    try {
      const res = await req('git.diff', {
        path: f.path,
        oldPath: f.group === 'staged' ? f.oldPath : undefined,
        staged: f.group === 'staged',
        untracked: f.group === 'untracked'
      })
      const old = $('.diff', pane)
      if (!old || pane.dataset.key !== key || old.dataset.sig === res.diff) return
      const scroll = old.scrollTop
      old.outerHTML = diffHtml(res.diff, res.truncated)
      const fresh = $('.diff', pane)
      fresh.dataset.sig = res.diff
      fresh.scrollTop = scroll
    } catch {}
    return
  }
  pane.dataset.key = key
  pane.innerHTML = `<div class="d-head"><span class="st st-${esc(f.status)}">${esc(f.status === "?" ? "N" : f.status)}</span><span class="title" title="${esc(f.path)}">${esc(f.path)}</span><span class="spacer"></span><span>${f.group === 'staged' ? 'Staged' : f.group === 'untracked' ? 'New file' : 'Working tree'}</span></div><div class="diff"><div class="info">Loading…</div></div>`
  try {
    const res = await req('git.diff', {
      path: f.path,
      oldPath: f.group === 'staged' ? f.oldPath : undefined,
      staged: f.group === 'staged',
      untracked: f.group === 'untracked'
    })
    if (pane.dataset.key !== key) return
    $('.diff', pane).outerHTML = diffHtml(res.diff, res.truncated)
    $('.diff', pane).dataset.sig = res.diff
  } catch (err) {
    $('.diff', pane).innerHTML = `<div class="info">${esc(err.message)}</div>`
  }
}

async function commit(push) {
  const msgEl = /** @type {HTMLTextAreaElement} */ ($('#commitMessage'))
  const amend = /** @type {HTMLInputElement} */ ($('#amend')).checked
  const message = msgEl.value.trim()
  const g = changeGroups()
  if (!message && !amend) {
    msgEl.focus()
    toast('Enter a commit message', '', { error: true, timeout: 3000 })
    return
  }
  let all = false
  if (!g.staged.length && !amend) {
    if (!g.unstaged.length) return
    const ok = await ask({
      title: 'Nothing is staged',
      message: `Commit all ${g.unstaged.length} changed tracked file${g.unstaged.length === 1 ? '' : 's'}? Unversioned files are not included.`,
      ok: 'Commit All'
    })
    if (!ok) return
    all = true
  }
  const done = await tryAct('commit', { message, amend, all, push }, { success: push ? 'Committed and pushed' : amend ? 'Commit amended' : 'Committed', timeoutMs: 120_000 })
  if (done) {
    msgEl.value = ''
    updateSubjectHint()
    $('#amend').checked = false
    $('#changesDiff').innerHTML = '<div class="empty"><strong>No file selected</strong>Pick a file to see its diff.</div>'
    updateCommitButtons()
  }
}

async function onAmendToggle() {
  const amend = /** @type {HTMLInputElement} */ ($('#amend')).checked
  const msgEl = /** @type {HTMLTextAreaElement} */ ($('#commitMessage'))
  if (amend && !msgEl.value.trim() && state.branches?.head.sha) {
    try {
      const d = await req('git.details', { hash: 'HEAD' })
      if (!msgEl.value.trim()) msgEl.value = d.message
      updateSubjectHint()
    } catch {}
  }
  updateCommitButtons()
}

// ------------------------------------------------------------------------------------------------
// Git operations with confirmation

async function checkout(ref, opts = {}) {
  try {
    await act('checkout', { ref, ...opts }, { success: `Checked out ${opts.remote ? ref.slice(ref.indexOf('/') + 1) : ref.length === 40 ? ref.slice(0, 8) : ref}` })
  } catch (err) {
    if (/would be overwritten|commit your changes or stash/i.test(err.message)) {
      const ok = await ask({
        title: 'Local changes would be overwritten',
        message: `${err.message}\n\nStash your changes, check out ${ref}, and keep the stash to restore later?`,
        ok: 'Stash and Checkout'
      })
      if (!ok) return
      if (await tryAct('stash', { message: `Git Toolbox: before checkout ${ref}` }, { quiet: true, refresh: false })) {
        await tryAct('checkout', { ref, ...opts }, { success: `Checked out ${ref}. Your changes are in the stash.` })
      }
    } else toastError('Checkout failed', err)
  }
}

async function newBranch(start = 'HEAD', suggested = '') {
  const label = start === 'HEAD' ? state.branches?.head.branch ?? 'HEAD' : /^[0-9a-f]{40}$/.test(start) ? start.slice(0, 8) : start
  const r = await ask({
    title: `New branch from ${label}`,
    input: { value: suggested, placeholder: 'feature/my-branch' },
    checkbox: { label: 'Checkout branch', checked: true },
    ok: 'Create'
  })
  if (!r) return
  await tryAct('createBranch', { name: r.value, start, checkout: r.checked }, { success: `Created ${r.value}` })
}

async function newTag(hash) {
  const r = await ask({ title: `New tag on ${hash.slice(0, 8)}`, input: { placeholder: 'v1.2.3' }, ok: 'Create' })
  if (!r) return
  await tryAct('createTag', { name: r.value, hash }, { success: `Tagged ${r.value}` })
}

async function renameBranch(from) {
  const r = await ask({ title: `Rename ${from}`, input: { value: from }, ok: 'Rename' })
  if (!r || r.value === from) return
  await tryAct('renameBranch', { from, to: r.value }, { success: `Renamed to ${r.value}` })
}

async function deleteBranch(name, { remote = false } = {}) {
  const ok = await ask({
    title: remote ? `Delete remote branch ${name}?` : `Delete branch ${name}?`,
    message: remote ? 'The branch is deleted on the remote server for everyone.' : undefined,
    ok: 'Delete',
    danger: true
  })
  if (!ok) return
  try {
    await act('deleteBranch', { name, remote }, { success: `Deleted ${name}` })
  } catch (err) {
    if (!remote && /not fully merged/i.test(err.message)) {
      const force = await ask({
        title: `${name} is not fully merged`,
        message: 'Its commits are not in the current branch or its upstream. Delete it anyway?',
        ok: 'Force Delete',
        danger: true
      })
      if (force) await tryAct('deleteBranch', { name, force: true }, { success: `Deleted ${name}` })
    } else toastError('Delete failed', err)
  }
}

async function deleteTag(name) {
  const ok = await ask({ title: `Delete tag ${name}?`, message: 'Only the local tag is deleted.', ok: 'Delete', danger: true })
  if (ok) await tryAct('deleteTag', { name }, { success: `Deleted tag ${name}` })
}

async function merge(ref) {
  const cur = state.branches?.head.branch ?? 'HEAD'
  const ok = await ask({ title: `Merge ${ref} into ${cur}?`, ok: 'Merge' })
  if (ok) await tryAct('merge', { ref }, { success: `Merged ${ref} into ${cur}` })
}

async function rebase(ref) {
  const cur = state.branches?.head.branch ?? 'HEAD'
  const ok = await ask({ title: `Rebase ${cur} onto ${ref}?`, message: 'Commits of the current branch are replayed on top of the target.', ok: 'Rebase' })
  if (ok) await tryAct('rebase', { ref }, { success: `Rebased ${cur} onto ${ref}` })
}

async function cherryPick(c) {
  await tryAct('cherryPick', { hash: c.hash }, { success: `Cherry-picked ${c.hash.slice(0, 8)}` })
}

async function revert(c) {
  const ok = await ask({ title: `Revert ${c.hash.slice(0, 8)}?`, message: `A new commit undoing "${c.subject}" is created.`, ok: 'Revert' })
  if (ok) await tryAct('revert', { hash: c.hash }, { success: `Reverted ${c.hash.slice(0, 8)}` })
}

async function reset(c) {
  const cur = state.branches?.head.branch ?? 'HEAD'
  const r = await ask({
    title: `Reset ${cur} to ${c.hash.slice(0, 8)}`,
    message: c.subject,
    choices: [
      { value: 'soft', label: 'Soft', hint: 'Keep changes staged' },
      { value: 'mixed', label: 'Mixed', hint: 'Keep changes in the working tree, unstaged' },
      { value: 'keep', label: 'Keep', hint: 'Keep local changes; refuse if they would be lost' },
      { value: 'hard', label: 'Hard', hint: 'Discard all local changes' }
    ],
    choice: 'mixed',
    ok: 'Reset',
    danger: true
  })
  if (!r) return
  if (r.choice === 'hard') {
    const sure = await ask({ title: 'Discard all local changes?', message: 'A hard reset cannot be undone for uncommitted work.', ok: 'Hard Reset', danger: true })
    if (!sure) return
  }
  await tryAct('reset', { hash: c.hash, mode: r.choice }, { success: `Reset ${cur} to ${c.hash.slice(0, 8)} (${r.choice})` })
}

async function fetchAll() {
  await tryAct('fetch', {}, { success: 'Fetched all remotes' })
}

async function pull() {
  await tryAct('pull', {}, { success: 'Project updated' })
}

async function push(branch) {
  const b = state.branches
  const name = branch ?? b?.head.branch
  if (!name) {
    toast('HEAD is detached', 'Check out a branch to push.', { error: true })
    return
  }
  const local = b?.locals.find((l) => l.name === name)
  const target = local?.upstream ?? `${b?.remotesList.includes('origin') ? 'origin' : b?.remotesList[0] ?? 'origin'}/${name} (new)`
  const r = await ask({
    title: `Push ${name}`,
    message: local?.upstream
      ? `${local.ahead} commit${local.ahead === 1 ? '' : 's'} to ${target}${local.behind ? `\nThe remote has ${local.behind} commit${local.behind === 1 ? '' : 's'} you have not pulled.` : ''}`
      : `To ${target}; the upstream branch is set.`,
    checkbox: { label: 'Force push (with lease)', checked: false },
    ok: 'Push'
  })
  if (!r) return
  await tryAct('push', { branch: name, force: r.checked }, { success: `Pushed ${name}` })
}

// ------------------------------------------------------------------------------------------------
// Project and worktree switcher

const currentWs = () => state.workspaces.find((w) => w.path === state.repo)
const switcherOpen = () => !$('#switcherPop').classList.contains('hidden')

function renderSwitcherButton() {
  const w = currentWs()
  const btn = $('#switcher')
  $('.proj', btn).textContent = w?.project ?? (w ? '' : 'Choose a repository')
  $('.wt', btn).textContent = w ? w.name : ''
  $('.wt', btn).classList.toggle('hidden', !w || w.name === w.project)
  btn.title = w ? `${w.project ?? ''} / ${w.name}\n${w.path}\nSwitch project or worktree (Ctrl/Cmd+K)` : 'Switch project or worktree (Ctrl/Cmd+K)'
}

/** Workspaces grouped by project, filtered by the search text. */
function switcherGroups() {
  const q = $('#switcherFilter').value.trim().toLowerCase()
  const groups = new Map()
  for (const w of state.workspaces) {
    const project = w.project ?? 'Not a Git repository'
    const hay = `${project} ${w.name} ${w.branch ?? ''}`.toLowerCase()
    if (q && !q.split(/\s+/).every((t) => hay.includes(t))) continue
    if (!groups.has(project)) groups.set(project, [])
    groups.get(project).push(w)
  }
  const cur = currentWs()?.project
  return [...groups.entries()]
    .map(([project, list]) => [
      project,
      list.sort((a, b) => Number(b.main) - Number(a.main) || a.name.localeCompare(b.name, undefined, { numeric: true }))
    ])
    .sort((a, b) => {
      const rank = (p, l) => (p === cur ? 0 : l.some((w) => w.git) ? 1 : 2)
      return rank(a[0], a[1]) - rank(b[0], b[1]) || a[0].localeCompare(b[0])
    })
}

let switcherItems = []
let switcherActive = 0
function renderSwitcherList() {
  const list = $('#switcherList')
  switcherItems = []
  const html = []
  for (const [project, items] of switcherGroups()) {
    html.push(`<div class="sw-group"><span class="pname">${esc(project)}</span><span class="n">${items.length}</span></div>`)
    for (const w of items) {
      const i = switcherItems.push(w) - 1
      const current = w.path === state.repo
      const focused = w.id === state.focusedId
      const branch = w.branch && w.branch !== w.name ? `<span class="b">${icon('branch')}${esc(w.branch)}</span>` : ''
      html.push(
        `<div class="sw-item${current ? ' current' : ''}${w.git ? '' : ' disabled'}" role="option" aria-selected="${current}" data-i="${i}" title="${esc(w.path)}">` +
          `<span class="ico">${icon(w.main ? 'folder' : 'branch')}</span>` +
          `<span class="nm">${esc(w.name)}</span>${branch}` +
          `${focused ? '<span class="here" title="Open in Orca now">in Orca</span>' : ''}` +
          `<span class="spacer"></span>${current ? `<span class="tick">${icon('check')}</span>` : ''}` +
          (w.git && !focused ? `<button class="icon go" data-open="${i}" title="Open this workspace in Orca" aria-label="Open in Orca">${icon('open')}</button>` : '') +
          '</div>'
      )
    }
  }
  list.innerHTML = html.join('') || '<div class="empty"><strong>No match</strong>Try a project, worktree or branch name.</div>'
  const cur = switcherItems.findIndex((w) => w.path === state.repo)
  switcherActive = Math.max(0, $('#switcherFilter').value ? switcherItems.findIndex((w) => w.git) : cur)
  markSwitcherActive()
}

function markSwitcherActive() {
  for (const el of $$('#switcherList .sw-item.active')) el.classList.remove('active')
  const el = $(`#switcherList .sw-item[data-i="${switcherActive}"]`)
  el?.classList.add('active')
  el?.scrollIntoView({ block: 'nearest' })
}

function openSwitcher() {
  const pop = $('#switcherPop')
  const btn = $('#switcher')
  const r = btn.getBoundingClientRect()
  pop.style.left = `${Math.max(6, r.left)}px`
  pop.style.top = `${r.bottom + 4}px`
  pop.classList.remove('hidden')
  btn.setAttribute('aria-expanded', 'true')
  $('#switcherFilter').value = ''
  renderSwitcherList()
  $('#switcherFilter').focus()
  // Refresh the list behind the scenes: new worktrees may exist since the panel loaded.
  scheduleWorkspaces()
}

function closeSwitcher() {
  $('#switcherPop').classList.add('hidden')
  $('#switcher').setAttribute('aria-expanded', 'false')
}

async function pickWorkspace(w, { openInOrca = false } = {}) {
  if (!w?.git) return
  closeSwitcher()
  if (w.path !== state.repo && !(await conflictsUI.closeMerge())) return
  // A pick wins over any workspace read already in flight, and breaks later ties toward it.
  state.pickSeq++
  wsSeq++
  state.lastPickedId = w.id
  try {
    localStorage.setItem('gtb.lastPicked', w.id)
  } catch {}
  if (openInOrca) {
    // Orca will report this focus by name only; record it so it is not read as a move elsewhere.
    state.focusedId = w.id
    req('workspace.focus', { workspaceId: w.id }).catch((err) => toastError('Could not open the workspace in Orca', err))
  }
  if (w.path !== state.repo) await setRepo(w.path)
}

function wireSwitcher() {
  try {
    state.follow = localStorage.getItem('gtb.follow') !== '0'
    state.lastPickedId = localStorage.getItem('gtb.lastPicked')
  } catch {}
  $('#followFocus').checked = state.follow
  $('#followFocus').addEventListener('change', (e) => {
    state.follow = /** @type {HTMLInputElement} */ (e.target).checked
    try {
      localStorage.setItem('gtb.follow', state.follow ? '1' : '0')
    } catch {}
    if (state.follow) {
      const f = state.workspaces.find((w) => w.id === state.focusedId && w.git)
      if (f && f.path !== state.repo) void pickWorkspace(f)
    }
  })
  $('#switcher').addEventListener('click', () => (switcherOpen() ? closeSwitcher() : openSwitcher()))
  $('#switcherFilter').addEventListener('input', renderSwitcherList)
  $('#switcherFilter').addEventListener('keydown', (e) => {
    const n = switcherItems.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      for (let k = 1; k <= n; k++) {
        const i = (switcherActive + step * k + n) % n
        if (switcherItems[i].git) {
          switcherActive = i
          break
        }
      }
      markSwitcherActive()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void pickWorkspace(switcherItems[switcherActive], { openInOrca: e.shiftKey })
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeSwitcher()
      $('#switcher').focus()
    }
  })
  $('#switcherList').addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target)
    const go = t.closest('[data-open]')
    if (go instanceof HTMLElement) {
      e.stopPropagation()
      void pickWorkspace(switcherItems[Number(go.dataset.open)], { openInOrca: true })
      return
    }
    const item = t.closest('.sw-item')
    if (item instanceof HTMLElement) void pickWorkspace(switcherItems[Number(item.dataset.i)])
  })
  $('#switcherList').addEventListener('mousemove', (e) => {
    const item = /** @type {HTMLElement} */ (e.target).closest('.sw-item')
    if (item instanceof HTMLElement && Number(item.dataset.i) !== switcherActive && !item.classList.contains('disabled')) {
      switcherActive = Number(item.dataset.i)
      markSwitcherActive()
    }
  })
  document.addEventListener(
    'mousedown',
    (e) => {
      if (switcherOpen() && !$('#switcherPop').contains(/** @type {Node} */ (e.target)) && !$('#switcher').contains(/** @type {Node} */ (e.target))) closeSwitcher()
    },
    true
  )
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      switcherOpen() ? closeSwitcher() : openSwitcher()
    }
  })
}

// ------------------------------------------------------------------------------------------------
// Layout: narrow mode and splitters

function loadSizes() {
  try {
    const s = JSON.parse(localStorage.getItem('gtb.sizes') ?? '{}')
    for (const [k, v] of Object.entries(s)) document.documentElement.style.setProperty(`--${k}`, v)
  } catch {}
}
function saveSize(name, value) {
  try {
    const s = JSON.parse(localStorage.getItem('gtb.sizes') ?? '{}')
    s[name] = value
    localStorage.setItem('gtb.sizes', JSON.stringify(s))
  } catch {}
}

function setupSplitters() {
  for (const sp of $$('.splitter')) {
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      const which = sp.dataset.split
      const narrow = $('#app').classList.contains('narrow')
      const view = /** @type {HTMLElement} */ (sp.parentElement)
      const rect = view.getBoundingClientRect()
      sp.classList.add('dragging')
      sp.setPointerCapture(e.pointerId)
      const move = (ev) => {
        let name
        let value
        if (narrow) {
          name = which === 'changes' ? 'changes-h' : 'details-h'
          value = `${Math.round(Math.min(Math.max(rect.bottom - ev.clientY, 80), rect.height - 120))}px`
        } else if (which === 'branches') {
          name = 'branches-w'
          value = `${Math.round(Math.min(Math.max(ev.clientX - rect.left, 120), rect.width * 0.5))}px`
        } else if (which === 'details') {
          name = 'details-w'
          value = `${Math.round(Math.min(Math.max(rect.right - ev.clientX, 180), rect.width * 0.6))}px`
        } else {
          name = 'changes-w'
          value = `${Math.round(Math.min(Math.max(ev.clientX - rect.left, 200), rect.width * 0.7))}px`
        }
        document.documentElement.style.setProperty(`--${name}`, value)
        sp.dataset.last = `${name}=${value}`
      }
      const up = () => {
        sp.classList.remove('dragging')
        sp.removeEventListener('pointermove', move)
        sp.removeEventListener('pointerup', up)
        const [name, value] = (sp.dataset.last ?? '').split('=')
        if (name) saveSize(name, value)
      }
      sp.addEventListener('pointermove', move)
      sp.addEventListener('pointerup', up)
    })
  }
}

function setupNarrow() {
  const app = $('#app')
  let wasNarrow = null
  const check = () => {
    const narrow = app.clientWidth < 760
    if (narrow === wasNarrow) return
    wasNarrow = narrow
    app.classList.toggle('narrow', narrow)
    // Dates switch between short and long forms.
    for (const el of $$('.row')) {
      const c = state.commits[Number(el.dataset.i)]
      const d = $('.date', el)
      if (c && d) d.textContent = shortDate(c.time)
    }
  }
  new ResizeObserver(check).observe(app)
  check()
}

function setTab(tab) {
  state.tab = tab
  for (const t of $$('.tab')) t.classList.toggle('active', t.dataset.tab === tab)
  $('#logView').classList.toggle('hidden', tab !== 'log')
  $('#changesView').classList.toggle('hidden', tab !== 'changes')
  if (tab === 'changes') void loadStatus().catch((err) => toastError('Could not read changes', err))
}

// ------------------------------------------------------------------------------------------------
// Wiring

let textTimer = null
function wire() {
  wireSwitcher()
  for (const t of $$('.tab')) t.addEventListener('click', () => setTab(t.dataset.tab))
  for (const b of $$('[data-act]')) {
    b.addEventListener('click', () => {
      const a = b.dataset.act
      if (a === 'fetch') void fetchAll()
      else if (a === 'pull') void pull()
      else if (a === 'push') void push()
      else if (a === 'newBranch') void newBranch('HEAD')
      else if (a === 'refresh') {
        void refreshAll()
        void loadAuthors()
      }
    })
  }

  const tree = $('#branchTree')
  tree.addEventListener('click', onTreeClick)
  tree.addEventListener('dblclick', onTreeDblClick)
  tree.addEventListener('contextmenu', onTreeContext)
  $('#branchFilter').addEventListener('input', () => renderTree())
  $('#toggleBranches').addEventListener('click', () => {
    const open = $('#branchesPane').classList.toggle('open')
    $('#toggleBranches').classList.toggle('on', open)
    if (open) /** @type {HTMLInputElement} */ ($('#branchFilter')).focus()
  })

  const rows = $('#rows')
  rows.addEventListener('click', (e) => {
    const el = /** @type {HTMLElement} */ (e.target).closest('.row')
    if (el) selectRow(Number(el.dataset.i))
  })
  rows.addEventListener('contextmenu', onRowContext)
  rows.addEventListener('keydown', onRowsKey)
  rows.addEventListener('scroll', () => {
    if (rows.scrollTop + rows.clientHeight > rows.scrollHeight - 300) void loadLog(false)
  })

  const text = /** @type {HTMLInputElement} */ ($('#textFilter'))
  text.addEventListener('input', () => {
    clearTimeout(textTimer)
    textTimer = setTimeout(() => {
      if (state.filters.text === text.value.trim()) return
      state.filters.text = text.value.trim()
      void loadLog(true, true)
    }, 400)
  })
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(textTimer)
      state.filters.text = text.value.trim()
      void loadLog(true, true)
    } else if (e.key === 'Escape' && text.value) {
      text.value = ''
      state.filters.text = ''
      void loadLog(true, true)
    }
  })
  $('#branchSelect').addEventListener('change', (e) => {
    state.branchSel = null
    renderTree()
    setRefFilter(/** @type {HTMLSelectElement} */ (e.target).value)
  })
  $('#userSelect').addEventListener('change', (e) => {
    state.filters.author = /** @type {HTMLSelectElement} */ (e.target).value
    void loadLog(true, true)
  })
  $('#dateSelect').addEventListener('change', (e) => {
    state.filters.since = /** @type {HTMLSelectElement} */ (e.target).value
    void loadLog(true, true)
  })

  $('#changesList').addEventListener('click', (e) => void onChangesClick(e))
  $('#changesList').addEventListener('dblclick', (e) => {
    const row = /** @type {HTMLElement} */ (e.target).closest('.file')
    const f = row instanceof HTMLElement ? changeRows[Number(row.dataset.i)] : null
    if (f?.group === 'conflicts') void conflictsUI.openMerge(f.path)
  })
  $('#changesList').addEventListener('contextmenu', (e) => {
    const row = /** @type {HTMLElement} */ (e.target).closest('.file')
    const f = row instanceof HTMLElement ? changeRows[Number(row.dataset.i)] : null
    if (f?.group !== 'conflicts') return
    showMenu(e, [
      { label: 'Merge…', run: () => void conflictsUI.openMerge(f.path) },
      { label: 'Accept Yours', run: () => void tryAct('resolveSide', { paths: [f.path], side: 'ours' }, { quiet: true }) },
      { label: 'Accept Theirs', run: () => void tryAct('resolveSide', { paths: [f.path], side: 'theirs' }, { quiet: true }) },
      '-',
      { label: 'Show all conflicts…', run: () => void conflictsUI.openDialog() }
    ])
  })
  $('#commitBtn').addEventListener('click', () => void commit(false))
  $('#commitPushBtn').addEventListener('click', () => void commit(true))
  $('#amend').addEventListener('change', () => void onAmendToggle())
  $('#commitMessage').addEventListener('input', updateSubjectHint)
  $('#commitMessage').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void commit(false)
    }
  })
}

/** Palette commands: switch tab, open the switcher, optionally select the first item. */
async function showView({ tab, switcher, select, merge, conflicts, repo }) {
  // `repo` shows that workspace's Git without moving Orca (used for screenshots and scripts).
  if (typeof repo === 'string' && repo !== state.repo) {
    if (!state.workspaces.length) await loadWorkspaces()
    const w = state.workspaces.find((x) => x.path === repo)
    if (w) await pickWorkspace(w)
  }
  if (tab === 'log' || tab === 'changes') setTab(tab)
  if (typeof merge === 'string' && merge) {
    await conflictsUI.openMerge(merge)
    return
  }
  if (conflicts) {
    await conflictsUI.openDialog()
    return
  }
  if (switcher) {
    if (!switcherOpen()) openSwitcher()
    return
  }
  if (select !== 'first') return
  if (tab === 'changes') {
    await loadStatus().catch(() => undefined)
    const first = changeRows[0]
    if (first) {
      state.changeSel = `${first.group}:${first.path}`
      renderChanges()
      void showWorkingDiff(first)
    }
  } else if (state.commits.length) selectRow(0)
}

let changedTimer = null
async function init() {
  applyIcons()
  loadSizes()
  setupSplitters()
  setupNarrow()
  wire()
  renderDetailsEmpty()

  try {
    const fav = await orca.storage.get('favorites')
    if (fav && typeof fav === 'object') state.favorites = /** @type {any} */ (fav)
  } catch {}
  try {
    const size = Number(await orca.settings.get('logPageSize'))
    if (size >= 50) state.pageSize = Math.min(size, 5000)
  } catch {}

  orca.plugin.on('repo.changed', (payload) => {
    if (!payload || payload.repo !== state.repo || state.acting) return
    clearTimeout(changedTimer)
    changedTimer = setTimeout(() => void refreshAll(), 300)
  })
  orca.on('workspace.changed', () => scheduleWorkspaces())
  orca.plugin.on('workspaces.updated', () => scheduleWorkspaces())
  orca.plugin.on('ui.show', (view) => void showView(view ?? {}))
  window.addEventListener('focus', () => {
    if (state.repo && !state.acting) void loadStatus().catch(() => undefined)
  })

  await loadWorkspaces()
}

void init()
