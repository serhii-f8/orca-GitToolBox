// Git Toolbox worker: answers the panel's git requests, keeps the status bar branch indicator
// current and fetches in the background.
import {
  DETAILS_FORMAT,
  GitError,
  LOG_FORMAT,
  REF_FORMAT,
  assertPaths,
  assertRefName,
  assertRev,
  parseDetails,
  parseLog,
  parseNameStatus,
  parseRefs,
  parseStatus,
  runGit
} from './git.mjs'

const MAX_DIFF_BYTES = 768 * 1024
const NETWORK_TIMEOUT = 180_000

/** @param {unknown} input */
function repoOf(input) {
  const repo = /** @type {any} */ (input)?.repo
  if (typeof repo !== 'string' || !repo) throw new GitError('No repository selected')
  return repo
}

/** Wraps a handler so failures reach the panel with a readable message and a stable code. */
function safe(fn) {
  return async (input, ctx) => {
    try {
      return await fn(input ?? {}, ctx)
    } catch (err) {
      const e = new Error(err?.message ?? String(err))
      // @ts-ignore code is read by the panel
      e.code = err?.code ?? 'action_failed'
      throw e
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Workspaces

/**
 * Which repository each workspace belongs to, so the panel can group worktrees under their project.
 * Asked once per path and cached: it never changes for a worktree.
 * @type {Map<string, Promise<{ git: boolean; project: string | null; root: string | null; main: boolean }>>}
 */
const projectCache = new Map()

/** @param {string} path */
function projectOf(path) {
  let hit = projectCache.get(path)
  if (!hit) {
    hit = runGit(path, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], {
      timeoutMs: 15_000
    }).then(
      (out) => {
        const [common, top] = out.trim().split('\n')
        const root = common.replace(/\/\.git\/?$/, '')
        const name = root.split('/').filter(Boolean).pop() ?? root
        return { git: true, project: name.replace(/\.git$/, ''), root, main: top === root }
      },
      () => ({ git: false, project: null, root: null, main: false })
    )
    projectCache.set(path, hit)
    // A path that failed (offline distro, folder not yet a repo) is asked again next time.
    void hit.then((r) => (r.git ? undefined : projectCache.delete(path)))
  }
  return hit
}

/** Runs fn over items with at most `limit` in flight: each git call starts a wsl.exe process. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Resolved project info by path, so answers never wait on paths already asked. */
const projectKnown = new Map()

/** A first guess from the path while git is asked: Orca keeps worktrees in .../workspaces/<project>/<name>. */
function guessProject(path) {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  const i = parts.lastIndexOf('workspaces')
  return i >= 0 && parts[i + 1] && i + 2 < parts.length ? parts[i + 1] : (parts.at(-1) ?? path)
}

let resolving = null

/**
 * Answers at once from what is known; the focused workspace is resolved before answering, the
 * rest in the background, after which the panel hears `workspaces.updated` and asks again.
 * @param {any} orca
 */
async function listWorkspaces(orca) {
  const [{ workspaces }, context] = await Promise.all([
    orca.host.call('workspace.list'),
    orca.host.call('workspace.readContext').catch(() => null)
  ])
  const usable = workspaces.filter((w) => !w.hostId || w.hostId === 'local')
  const candidates = focusCandidates(usable, context)
  const focused = candidates.length === 1 ? candidates[0] : null
  const remember = (w) => projectOf(w.path).then((info) => projectKnown.set(w.path, info))
  for (const id of candidates.slice(0, 4)) {
    const w = usable.find((x) => x.id === id)
    if (w && !projectKnown.has(w.path)) await remember(w)
  }

  const unknown = usable.filter((w) => !projectKnown.has(w.path))
  if (unknown.length && !resolving) {
    resolving = mapLimit(unknown, 6, remember)
      .then(() => orca.panels.post('workspaces.updated', {}))
      .catch(() => undefined)
      .finally(() => (resolving = null))
  }

  const enriched = usable.map((w) => {
    const info = projectKnown.get(w.path) ?? { git: true, project: guessProject(w.path), root: null, main: false, pending: true }
    return {
      id: w.id,
      kind: w.kind,
      name: w.name,
      path: w.path,
      branch: (w.branch ?? '').replace(/^refs\/heads\//, '') || null,
      ...info
    }
  })
  // `context` lets the panel tell "nothing focused" (Settings is open) from "focus unknown".
  return { workspaces: enriched, focused, candidates, hasContext: !!context }
}

/**
 * readContext has no id or path, only the display name and branch, and several workspaces can
 * share both (every "master"). Returns every workspace that fits, best evidence first; callers
 * break ties with what they already show instead of guessing.
 * @returns {string[]}
 */
export function focusCandidates(workspaces, context) {
  if (!context) return []
  const branch = (b) => (b ?? '').replace(/^refs\/heads\//, '')
  const byBoth = workspaces.filter(
    (w) => w.name === context.displayName && branch(w.branch) === branch(context.branch)
  )
  if (byBoth.length) return byBoth.map((w) => w.id)
  const byName = workspaces.filter((w) => w.name === context.displayName)
  if (byName.length) return byName.map((w) => w.id)
  const byBranch = workspaces.filter((w) => context.branch && branch(w.branch) === branch(context.branch))
  return byBranch.map((w) => w.id)
}

/** The one focused workspace, or null when there is none or the match is ambiguous. */
export function matchFocused(workspaces, context, prefer = null) {
  const ids = focusCandidates(workspaces, context)
  if (ids.length === 1) return ids[0]
  if (prefer && ids.includes(prefer)) return prefer
  return null
}

// ---------------------------------------------------------------------------------------------
// Read operations

async function branches(repo) {
  const [refsOut, headOut] = await Promise.all([
    runGit(repo, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
    runGit(repo, ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], { okExitCodes: [0, 128] })
  ])
  const refs = parseRefs(refsOut)
  const [sha, abbrev] = headOut.trim().split('\n')
  const remoteNames = [...new Set(refs.remotes.map((r) => r.remote))]
  let remotesList = remoteNames
  try {
    remotesList = (await runGit(repo, ['remote'])).split('\n').filter(Boolean)
  } catch {}
  return {
    head: {
      branch: abbrev && abbrev !== 'HEAD' ? abbrev : null,
      sha: sha && /^[0-9a-f]{7,}$/.test(sha) ? sha : null
    },
    ...refs,
    remotesList
  }
}

/**
 * @param {string} repo
 * @param {{ ref?: string; text?: string; author?: string; since?: string; path?: string; skip?: number; limit?: number }} q
 */
async function log(repo, q) {
  const limit = Math.min(Math.max(Number(q.limit) || 300, 1), 5000)
  const skip = Math.max(Number(q.skip) || 0, 0)
  const args = ['log', '--date-order', '--decorate=full', `--format=${LOG_FORMAT}`, `-n`, String(limit + 1)]
  if (skip) args.push(`--skip=${skip}`)
  const text = (q.text ?? '').trim()
  if (q.author) args.push(`--author=${q.author}`)
  if (q.since) args.push(`--since=${q.since}`)
  const hashLike = /^[0-9a-f]{4,40}$/i.test(text)
  if (text && !hashLike) args.push('-i', '--fixed-strings', `--grep=${text}`)
  if (!q.ref || q.ref === 'all') args.push('--branches', '--remotes', '--tags', 'HEAD')
  else args.push(assertRev(q.ref))
  args.push('--')
  if (q.path) args.push(q.path)

  if (text && hashLike && skip === 0) {
    // A hash: show that commit if it exists, else fall back to a message search.
    try {
      const one = parseLog(
        await runGit(repo, ['log', '--decorate=full', `--format=${LOG_FORMAT}`, '-n', '1', `${text}^{commit}`, '--'])
      )
      if (one.length) return { commits: one, hasMore: false }
    } catch {}
    args.splice(args.indexOf('--'), 0, '-i', '--fixed-strings', `--grep=${text}`)
  }
  const out = await runGit(repo, args, { okExitCodes: [0, 128] })
  const commits = parseLog(out)
  const hasMore = commits.length > limit
  return { commits: commits.slice(0, limit), hasMore }
}

async function authors(repo) {
  const out = await runGit(repo, ['log', '--branches', '--remotes', '--format=%an', '-n', '3000'], {
    okExitCodes: [0, 128]
  })
  const counts = new Map()
  for (const name of out.split('\n')) if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
}

async function commitDetails(repo, hash) {
  assertRev(hash)
  const details = parseDetails(
    await runGit(repo, ['show', '-s', '--decorate=full', `--format=${DETAILS_FORMAT}`, hash, '--'])
  )
  const first = details.parents[0]
  const filesOut = first
    ? await runGit(repo, ['diff', '--name-status', '-z', '-M', first, details.hash, '--'])
    : await runGit(repo, ['diff-tree', '--root', '--no-commit-id', '-r', '-M', '--name-status', '-z', details.hash])
  let containedIn = []
  try {
    const out = await runGit(
      repo,
      ['branch', '-a', '--contains', details.hash, '--format=%(refname:short)'],
      { timeoutMs: 8000 }
    )
    containedIn = out.split('\n').filter((b) => b && !b.endsWith('/HEAD'))
  } catch {}
  return { ...details, files: parseNameStatus(filesOut), containedIn }
}

/**
 * @param {string} repo
 * @param {{ hash?: string; parent?: string | null; path: string; oldPath?: string; staged?: boolean; untracked?: boolean }} q
 */
async function diff(repo, q) {
  const paths = assertPaths(q.oldPath && q.oldPath !== q.path ? [q.oldPath, q.path] : [q.path])
  let args
  let ok = [0]
  if (q.hash) {
    assertRev(q.hash)
    args = q.parent
      ? ['diff', '-M', '--no-ext-diff', assertRev(q.parent), q.hash, '--', ...paths]
      : ['show', '--format=', '--no-ext-diff', q.hash, '--', ...paths]
  } else if (q.untracked) {
    args = ['diff', '--no-index', '--no-ext-diff', '--', '/dev/null', q.path]
    ok = [0, 1]
  } else {
    args = ['diff', '-M', '--no-ext-diff', ...(q.staged ? ['--cached'] : []), '--', ...paths]
  }
  const out = await runGit(repo, args, { okExitCodes: ok, maxBytes: MAX_DIFF_BYTES })
  return { diff: out, truncated: out.length >= MAX_DIFF_BYTES - 1 }
}

async function status(repo) {
  const verify = (ref) =>
    runGit(repo, ['rev-parse', '-q', '--verify', ref], { okExitCodes: [0, 1, 128] }).then(
      (o) => o.trim().length > 0,
      () => false
    )
  const [out, merge, rebase, cherryPick, revert] = await Promise.all([
    runGit(repo, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
    verify('MERGE_HEAD'),
    verify('REBASE_HEAD'),
    verify('CHERRY_PICK_HEAD'),
    verify('REVERT_HEAD')
  ])
  const inProgress = merge ? 'merge' : rebase ? 'rebase' : cherryPick ? 'cherry-pick' : revert ? 'revert' : null
  return { ...parseStatus(out), inProgress }
}

// ---------------------------------------------------------------------------------------------
// Write operations

/** @param {any} orca */
async function pullArgs(orca) {
  const mode = (await orca.settings.get('pullMode').catch(() => 'merge')) ?? 'merge'
  if (mode === 'rebase') return ['pull', '--rebase', '--autostash']
  if (mode === 'ff-only') return ['pull', '--ff-only']
  return ['pull', '--no-rebase']
}

async function defaultRemote(repo) {
  const remotes = (await runGit(repo, ['remote'])).split('\n').filter(Boolean)
  if (!remotes.length) throw new GitError('This repository has no remotes')
  return remotes.includes('origin') ? 'origin' : remotes[0]
}

/**
 * Every mutating action the panel can ask for, by name. Arguments are validated here; nothing
 * the panel sends is passed to git as an option.
 * @param {any} orca
 * @param {string} repo
 * @param {any} a
 */
async function action(orca, repo, a) {
  const op = a.op
  const net = { timeoutMs: NETWORK_TIMEOUT }
  switch (op) {
    case 'fetch':
      return runGit(repo, ['fetch', '--all', '--prune', '--tags'], net)
    case 'pull':
      return runGit(repo, await pullArgs(orca), net)
    case 'push': {
      const st = await status(repo)
      const args = ['push']
      if (a.force) args.push('--force-with-lease')
      if (a.branch && a.branch !== st.branch) {
        // Push a branch that is not checked out, to its upstream or the same name.
        const remote = await defaultRemote(repo)
        args.push(remote, `${assertRefName(a.branch, 'branch')}`)
      } else if (!st.upstream) {
        if (!st.branch) throw new GitError('HEAD is detached; check out a branch to push')
        args.push('-u', await defaultRemote(repo), 'HEAD')
      }
      return runGit(repo, args, net)
    }
    case 'updateBranch': {
      // Fast-forward a branch that is not checked out from its upstream ("Update").
      const name = assertRefName(a.branch, 'branch')
      const up = (await runGit(repo, ['rev-parse', '--abbrev-ref', `${name}@{upstream}`])).trim()
      const slash = up.indexOf('/')
      if (slash < 0) throw new GitError(`${name} has no upstream branch`)
      return runGit(repo, ['fetch', up.slice(0, slash), `${up.slice(slash + 1)}:${name}`], net)
    }
    case 'checkout': {
      const ref = assertRev(a.ref)
      if (a.remote) {
        // Remote branch: check out the local branch of the same name, creating a tracking one.
        const local = ref.slice(ref.indexOf('/') + 1)
        const has = await runGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${local}`], {
          okExitCodes: [0, 1]
        })
        if (has.trim()) return runGit(repo, ['checkout', local])
        return runGit(repo, ['checkout', '--track', ref])
      }
      if (a.detach) return runGit(repo, ['checkout', '--detach', ref])
      return runGit(repo, ['checkout', ref])
    }
    case 'createBranch': {
      const name = assertRefName(a.name, 'branch name')
      const start = a.start ? assertRev(a.start) : 'HEAD'
      if (a.checkout) return runGit(repo, ['checkout', '-b', name, start])
      return runGit(repo, ['branch', name, start])
    }
    case 'renameBranch':
      return runGit(repo, ['branch', '-m', assertRefName(a.from, 'branch'), assertRefName(a.to, 'new name')])
    case 'deleteBranch': {
      const name = assertRefName(a.name, 'branch')
      if (a.remote) {
        const slash = name.indexOf('/')
        return runGit(repo, ['push', name.slice(0, slash), '--delete', name.slice(slash + 1)], net)
      }
      return runGit(repo, ['branch', a.force ? '-D' : '-d', name])
    }
    case 'merge':
      return runGit(repo, ['merge', '--no-edit', assertRev(a.ref)])
    case 'rebase':
      return runGit(repo, ['rebase', assertRev(a.ref)])
    case 'abort': {
      const what = a.what
      if (!['merge', 'rebase', 'cherry-pick', 'revert'].includes(what)) throw new GitError('Nothing to abort')
      return runGit(repo, [what, '--abort'])
    }
    case 'cherryPick':
      return runGit(repo, ['cherry-pick', assertRev(a.hash)])
    case 'revert':
      return runGit(repo, ['revert', '--no-edit', assertRev(a.hash)])
    case 'reset': {
      const mode = a.mode
      if (!['soft', 'mixed', 'hard', 'keep'].includes(mode)) throw new GitError('Invalid reset mode')
      return runGit(repo, ['reset', `--${mode}`, assertRev(a.hash)])
    }
    case 'createTag': {
      const name = assertRefName(a.name, 'tag name')
      const args = ['tag']
      if (a.message) args.push('-a', '-F', '-')
      args.push(name, assertRev(a.hash))
      return runGit(repo, args, a.message ? { input: String(a.message) } : {})
    }
    case 'deleteTag':
      return runGit(repo, ['tag', '-d', assertRefName(a.name, 'tag')])
    case 'stage':
      return runGit(repo, ['add', '--', ...assertPaths(a.paths)])
    case 'stageAll':
      return runGit(repo, ['add', '--all'])
    case 'unstage':
      return runGit(repo, ['reset', '-q', 'HEAD', '--', ...assertPaths(a.paths)], { okExitCodes: [0, 1] })
    case 'unstageAll':
      return runGit(repo, ['reset', '-q'], { okExitCodes: [0, 1] })
    case 'discard': {
      const tracked = assertPaths(a.paths ?? [])
      const untracked = assertPaths(a.untracked ?? [])
      if (tracked.length) await runGit(repo, ['checkout', 'HEAD', '--', ...tracked])
      if (untracked.length) await runGit(repo, ['clean', '-f', '-q', '--', ...untracked])
      return ''
    }
    case 'commit': {
      const message = String(a.message ?? '').trim()
      if (!message && !a.amend) throw new GitError('Enter a commit message')
      const args = ['commit']
      if (a.all) args.push('-a')
      if (a.amend) args.push('--amend')
      if (message) args.push('-F', '-')
      else args.push('--no-edit')
      const out = await runGit(repo, args, message ? { input: message } : {})
      if (a.push) await action(orca, repo, { op: 'push' })
      return out
    }
    case 'stash':
      return runGit(repo, ['stash', 'push', '--include-untracked', ...(a.message ? ['-m', String(a.message)] : [])])
    case 'stashPop':
      return runGit(repo, ['stash', 'pop'])
    default:
      throw new GitError(`Unknown action: ${op}`)
  }
}

// ---------------------------------------------------------------------------------------------
// Status bar and auto-fetch

/** @param {any} orca */
function createStatusTracker(orca) {
  /** @type {string | null} */
  let repo = null
  let name = ''
  let busy = false
  let lastBehind = new Map()
  let statusTimer = null
  let fetchTimer = null

  async function setting(key, fallback) {
    try {
      const v = await orca.settings.get(key)
      return v ?? fallback
    } catch {
      return fallback
    }
  }

  async function show(fields) {
    try {
      await orca.host.call('statusBar.update', { id: 'branch', ...fields })
    } catch (err) {
      orca.log(`statusBar.update failed: ${err?.message ?? err}`)
    }
  }

  async function refresh() {
    if (!repo) {
      await show({ visible: false })
      return
    }
    if (busy) return
    busy = true
    try {
      const st = parseStatus(
        await runGit(repo, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no'], {
          timeoutMs: 20_000
        })
      )
      const label = st.branch ?? (st.oid ? `detached ${st.oid.slice(0, 8)}` : 'no commits')
      const parts = [label]
      if (st.ahead) parts.push(`↑${st.ahead}`)
      if (st.behind) parts.push(`↓${st.behind}`)
      const changed = st.files.length
      const tooltip = [
        `${name}: ${label}`,
        st.upstream ? `Tracking ${st.upstream}` : 'No upstream branch',
        st.upstream ? `${st.ahead} outgoing, ${st.behind} incoming` : null,
        changed ? `${changed} changed file${changed === 1 ? '' : 's'}` : 'Working tree clean',
        'Click to fetch'
      ]
        .filter(Boolean)
        .join('\n')
      await show({
        visible: true,
        text: parts.join(' ') + (changed ? ' *' : ''),
        tone: st.behind ? 'warning' : st.ahead ? 'accent' : 'neutral',
        tooltip
      })
      return st
    } catch (err) {
      await show({ visible: true, text: 'Git: unavailable', tone: 'neutral', tooltip: String(err?.message ?? err) })
    } finally {
      busy = false
    }
  }

  async function fetchNow({ quiet }) {
    if (!repo) return
    const target = repo
    try {
      await runGit(target, ['fetch', '--all', '--prune', '--quiet'], { timeoutMs: NETWORK_TIMEOUT })
    } catch (err) {
      if (!quiet) throw err
      orca.log(`auto-fetch failed: ${err?.message ?? err}`)
      return
    }
    const st = await refresh()
    orca.panels.post('repo.changed', { repo: target, reason: 'fetch' })
    if (quiet && st && st.branch && (await setting('notifyBehind', true))) {
      const key = `${target}\n${st.branch}`
      const prev = lastBehind.get(key) ?? 0
      if (st.behind > prev) {
        void orca.host
          .call('notifications.show', {
            title: `${st.branch} is ${st.behind} commit${st.behind === 1 ? '' : 's'} behind`,
            body: `${name}: new commits on ${st.upstream ?? 'its upstream'}`
          })
          .catch(() => undefined)
      }
      lastBehind.set(key, st.behind)
    }
  }

  async function reschedule() {
    if (statusTimer) clearInterval(statusTimer)
    if (fetchTimer) clearInterval(fetchTimer)
    statusTimer = fetchTimer = null
    const statusSec = Number(await setting('statusRefreshSeconds', 30))
    const fetchMin = Number(await setting('autoFetchMinutes', 15))
    if (statusSec > 0) statusTimer = setInterval(() => void refresh(), statusSec * 1000)
    if (fetchMin > 0) fetchTimer = setInterval(() => void fetchNow({ quiet: true }), fetchMin * 60_000)
  }

  async function focus(context) {
    try {
      const { workspaces } = await orca.host.call('workspace.list')
      const usable = workspaces.filter((w) => !w.hostId || w.hostId === 'local')
      if (!context) return // Settings or another full page: keep showing the last repository
      const current = usable.find((w) => w.path === repo)
      const id = matchFocused(usable, context, current?.id ?? null)
      const ws = usable.find((w) => w.id === id)
      // Ambiguous (two workspaces with the same name and branch): keep the current one.
      if (ws) {
        repo = ws.path
        name = ws.name
      }
    } catch (err) {
      orca.log(`workspace.list failed: ${err?.message ?? err}`)
    }
    await refresh()
  }

  return {
    focus,
    refresh,
    fetchNow,
    reschedule,
    get repo() {
      return repo
    }
  }
}

// ---------------------------------------------------------------------------------------------

/** @type {import('orca/worker').Activate} */
export default async function activate(orca) {
  const tracker = createStatusTracker(orca)

  orca.panels.handle('repo.context', safe(() => listWorkspaces(orca)))
  orca.panels.handle(
    'workspace.focus',
    safe(async (i) => {
      if (typeof i.workspaceId !== 'string' || !i.workspaceId) throw new GitError('Missing workspace')
      await orca.host.call('workspace.open', { workspaceId: i.workspaceId })
      return { opened: true }
    })
  )
  orca.panels.handle('git.branches', safe((i) => branches(repoOf(i))))
  orca.panels.handle('git.log', safe((i) => log(repoOf(i), i)))
  orca.panels.handle('git.authors', safe((i) => authors(repoOf(i))))
  orca.panels.handle('git.details', safe((i) => commitDetails(repoOf(i), i.hash)))
  orca.panels.handle('git.diff', safe((i) => diff(repoOf(i), i)))
  orca.panels.handle('git.status', safe((i) => status(repoOf(i))))
  orca.panels.handle(
    'git.action',
    safe(async (i, ctx) => {
      const repo = repoOf(i)
      const output = await action(orca, repo, i)
      if (repo === tracker.repo) void tracker.refresh()
      orca.panels.post('repo.changed', { repo, reason: i.op, from: ctx?.panel?.id ?? null })
      return { output: typeof output === 'string' ? output.trim().slice(0, 4000) : '' }
    })
  )

  const runOnFocused = (op) => async () => {
    if (!tracker.repo) return 'No Git workspace is focused'
    try {
      if (op === 'fetch') {
        await tracker.fetchNow({ quiet: false })
        return 'Fetched all remotes'
      }
      const out = await action(orca, tracker.repo, { op })
      void tracker.refresh()
      orca.panels.post('repo.changed', { repo: tracker.repo, reason: op })
      return (typeof out === 'string' && out.trim().split('\n').slice(-3).join('\n')) || `${op} done`
    } catch (err) {
      return `${op} failed: ${err?.message ?? err}`
    }
  }
  // Views of the open Git panel, for the palette and shortcuts. `select: 'first'` also selects the
  // newest commit or changed file, so the view opens with something in it.
  const show = (view) => {
    orca.panels.post('ui.show', view)
    return 'Shown in the Git panel (open it from the right sidebar if it is hidden)'
  }
  orca.panels.handle('ui.show', safe((i) => ({ shown: show(i) })))
  orca.commands.register('gittoolbox.showLog', () => show({ tab: 'log' }))
  orca.commands.register('gittoolbox.showChanges', () => show({ tab: 'changes' }))
  orca.commands.register('gittoolbox.switch', () => show({ switcher: true }))
  orca.commands.register('gittoolbox.fetch', runOnFocused('fetch'))
  orca.commands.register('gittoolbox.pull', runOnFocused('pull'))
  orca.commands.register('gittoolbox.push', runOnFocused('push'))

  orca.events.on('workspace.changed', ({ context }) => tracker.focus(context))
  orca.settings.onDidChange?.(() => void tracker.reschedule())

  await tracker.reschedule()
  const context = await orca.host.call('workspace.readContext').catch(() => null)
  await tracker.focus(context)
}
