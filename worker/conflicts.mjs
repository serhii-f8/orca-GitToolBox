// Conflict access for the merge view: what is in conflict, the three versions of a file, and
// writing a resolution. Everything goes through git (no host file I/O), so it also works for
// repositories that git reaches inside WSL.
import { GitError, assertPaths, parseStatus, runGit } from './git.mjs'

/** Larger stages are offered as whole-file Yours/Theirs only. */
export const MAX_MERGE_BYTES = 1024 * 1024

const TYPES = {
  UU: 'both modified',
  AA: 'both added',
  AU: 'added by you',
  UA: 'added by them',
  DU: 'deleted by you',
  UD: 'deleted by them',
  DD: 'both deleted'
}

/** @param {string} code porcelain v2 XY of an unmerged entry */
export function conflictType(code) {
  return TYPES[code] ?? 'conflict'
}

/** @param {string} repo */
export async function operationInProgress(repo) {
  const verify = (ref) =>
    runGit(repo, ['rev-parse', '-q', '--verify', ref], { okExitCodes: [0, 1, 128] }).then(
      (o) => o.trim().length > 0,
      () => false
    )
  const [merge, rebase, cherryPick, revert] = await Promise.all(
    ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].map(verify)
  )
  return merge ? 'merge' : rebase ? 'rebase' : cherryPick ? 'cherry-pick' : revert ? 'revert' : null
}

/** @param {string} repo @param {string} rev */
async function refName(repo, rev) {
  const name = (
    await runGit(repo, ['name-rev', '--name-only', '--exclude=refs/tags/*', rev], { okExitCodes: [0, 128] }).catch(
      () => ''
    )
  ).trim()
  if (name && name !== 'undefined' && !/[~^]/.test(name)) return name.replace(/^remotes\//, '')
  return (await runGit(repo, ['rev-parse', '--short', rev]).catch(() => rev)).trim()
}

/** @param {string} repo @param {string} rev */
const oneLine = async (repo, rev) => (await runGit(repo, ['log', '-1', '--format=%h %s', rev, '--'])).trim()

/** @param {string} repo */
async function currentBranch(repo) {
  const b = (await runGit(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { okExitCodes: [0, 1] })).trim()
  return b || (await runGit(repo, ['rev-parse', '--short', 'HEAD'])).trim()
}

/**
 * What is in conflict and what to call the two sides. In a rebase git's "ours" is the upstream
 * being rebased onto and "theirs" is the user's commit, so the labels say that.
 * @param {string} repo
 */
export async function conflictInfo(repo) {
  const [op, out] = await Promise.all([
    operationInProgress(repo),
    runGit(repo, ['status', '--porcelain=v2', '-z', '--untracked-files=no'])
  ])
  const files = parseStatus(out)
    .files.filter((f) => f.kind === 'conflict')
    .map((f) => {
      const code = f.index + f.worktree
      return { path: f.path, code, type: conflictType(code) }
    })
  let oursLabel = 'Current branch'
  let theirsLabel = 'Stash'
  if (op === 'merge') {
    oursLabel = await currentBranch(repo)
    theirsLabel = await refName(repo, 'MERGE_HEAD')
  } else if (op === 'rebase') {
    oursLabel = `Upstream: ${await refName(repo, 'HEAD')}`
    theirsLabel = `Your commit: ${await oneLine(repo, 'REBASE_HEAD')}`
  } else if (op === 'cherry-pick') {
    oursLabel = await currentBranch(repo)
    theirsLabel = `Cherry-pick: ${await oneLine(repo, 'CHERRY_PICK_HEAD')}`
  } else if (op === 'revert') {
    oursLabel = await currentBranch(repo)
    theirsLabel = `Revert of ${await oneLine(repo, 'REVERT_HEAD')}`
  }
  return { op, oursLabel, theirsLabel, files }
}

/** Index stages of an unmerged path: { 1?: {mode, sha}, 2?: …, 3?: … }. @param {string} repo @param {string} path */
async function stages(repo, path) {
  const out = await runGit(repo, ['ls-files', '-u', '-z', '--', path])
  /** @type {Record<number, { mode: string; sha: string }>} */
  const st = {}
  for (const rec of out.split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) ([123])\t/.exec(rec)
    if (m) st[Number(m[3])] = { mode: m[1], sha: m[2] }
  }
  return st
}

/** @param {Buffer} buf */
const isText = (buf) => !buf.subarray(0, 8000).includes(0) && Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)

/**
 * The three versions of a conflicted file, in the form git stores them (line endings as in the
 * blobs). `whole` says why only whole-file Yours/Theirs is offered.
 * @param {string} repo
 * @param {string} path
 */
export async function readConflict(repo, path) {
  assertPaths([path])
  const st = await stages(repo, path)
  if (!st[2] && !st[3]) throw new GitError(`${path} is not in conflict`)
  const blob = (s) =>
    s ? runGit(repo, ['cat-file', 'blob', s.sha], { buffer: true, maxBytes: MAX_MERGE_BYTES + 1 }) : Promise.resolve(null)
  const [base, ours, theirs] = await Promise.all([blob(st[1]), blob(st[2]), blob(st[3])])
  /** @type {false | 'binary' | 'large' | 'structural'} */
  let whole = false
  const present = [base, ours, theirs].filter(Boolean)
  if (!ours || !theirs) whole = 'structural'
  else if (present.some((b) => b.length > MAX_MERGE_BYTES)) whole = 'large'
  else if (!present.every(isText)) whole = 'binary'

  let current = null
  if (!whole) {
    // The working-tree file in index form (clean filters applied), to spot edits made after the
    // conflict and to offer it as the starting Result.
    try {
      const sha = (await runGit(repo, ['hash-object', '-w', '--', path])).trim()
      const buf = await runGit(repo, ['cat-file', 'blob', sha], { buffer: true, maxBytes: MAX_MERGE_BYTES + 1 })
      current = isText(buf) ? buf.toString('utf8') : null
    } catch {
      current = null
    }
  }
  const text = (b) => (whole ? null : (b?.toString('utf8') ?? ''))
  return {
    path,
    base: text(base),
    ours: text(ours),
    theirs: text(theirs),
    current,
    whole,
    mode: (st[2] ?? st[3]).mode
  }
}

/**
 * Stores `content` as the resolved file: a blob with no filters (it is already in index form),
 * staged at stage 0, then checked out so git's own line-ending conversion writes the working file.
 * @param {string} repo
 * @param {string} path
 * @param {string} content
 */
export async function writeResolved(repo, path, content) {
  assertPaths([path])
  if (typeof content !== 'string') throw new GitError('Missing content')
  const st = await stages(repo, path)
  const mode = (st[2] ?? st[3])?.mode ?? '100644'
  const sha = (await runGit(repo, ['hash-object', '-w', '--stdin', '--no-filters'], { input: content })).trim()
  await runGit(repo, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${path}`])
  await runGit(repo, ['checkout-index', '-f', '--', path])
  return ''
}

/**
 * Resolves whole files with one side. When that side deleted the file, the file is removed.
 * @param {string} repo
 * @param {string[]} paths
 * @param {'ours' | 'theirs'} side
 */
export async function resolveSide(repo, paths, side) {
  if (side !== 'ours' && side !== 'theirs') throw new GitError('Invalid side')
  for (const path of assertPaths(paths)) {
    const st = await stages(repo, path)
    if (!st[side === 'ours' ? 2 : 3]) {
      await runGit(repo, ['rm', '-q', '-f', '--ignore-unmatch', '--', path])
    } else {
      await runGit(repo, ['checkout', `--${side}`, '--', path])
      await runGit(repo, ['add', '--', path])
    }
  }
  return ''
}
