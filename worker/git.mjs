// Git access for the worker: where a repository lives, how to run git there, and parsers for
// git's machine-readable output. Pure functions are exported for tests.
import { spawn } from 'node:child_process'

const FS = '\x1f' // field separator in our --format strings
const RS = '\x1e' // record separator

/**
 * Orca on Windows names WSL workspaces by UNC path (\\wsl.localhost\Distro\var\www\repo).
 * Running Windows git on such a path is slow and trips "dubious ownership", so those repos run
 * git inside the distro through wsl.exe instead.
 * @param {string} p
 */
export function parseRepoPath(p) {
  const m = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/]([^\\/]+)([\\/].*)?$/i.exec(p)
  if (m) {
    const rest = (m[2] || '/').replace(/\\/g, '/')
    return { kind: 'wsl', distro: m[1], path: rest.length > 1 ? rest.replace(/\/+$/, '') : '/' }
  }
  return { kind: 'native', path: p }
}

/**
 * @param {string} repo  workspace path as Orca reports it
 * @param {string[]} args git arguments
 * @param {string} [platform]
 */
export function buildCommand(repo, args, platform = process.platform) {
  const loc = parseRepoPath(repo)
  const gitArgs = ['-c', 'core.quotepath=off', '-c', 'color.ui=never', '-c', 'core.pager=cat', ...args]
  const env = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C.UTF-8' }
  if (loc.kind === 'wsl' && platform === 'win32') {
    // --exec skips the login shell, so arguments arrive exactly as given; `env` sets variables
    // that would not cross the Windows/Linux boundary otherwise.
    const envArgs = Object.entries(env).map(([k, v]) => `${k}=${v}`)
    return {
      file: 'wsl.exe',
      args: ['-d', loc.distro, '--cd', loc.path, '--exec', 'env', ...envArgs, 'git', ...gitArgs],
      cwd: undefined,
      env: {}
    }
  }
  return { file: 'git', args: gitArgs, cwd: loc.path, env }
}

export class GitError extends Error {
  /** @param {string} message @param {{ stderr?: string; exitCode?: number | null; args?: string[] }} [info] */
  constructor(message, info = {}) {
    super(message)
    this.code = 'git_failed'
    this.stderr = info.stderr ?? ''
    this.exitCode = info.exitCode ?? null
  }
}

/**
 * Runs git and resolves with stdout.
 * @param {string} repo
 * @param {string[]} args
 * @param {{ input?: string; timeoutMs?: number; okExitCodes?: number[]; maxBytes?: number }} [opts]
 * @returns {Promise<string>}
 */
export function runGit(repo, args, opts = {}) {
  const { input, timeoutMs = 60_000, okExitCodes = [0], maxBytes = 64 * 1024 * 1024 } = opts
  const cmd = buildCommand(repo, args)
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(cmd.file, cmd.args, {
        cwd: cmd.cwd,
        env: { ...process.env, ...cmd.env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      reject(new GitError(`Could not start git: ${err?.message ?? err}`))
      return
    }
    /** @type {Buffer[]} */
    const out = []
    /** @type {Buffer[]} */
    const errOut = []
    let size = 0
    let truncated = false
    const timer = setTimeout(() => {
      child.kill()
      reject(new GitError(`git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)} s`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      if (truncated) return
      size += chunk.length
      if (size > maxBytes) {
        truncated = true
        out.push(chunk.subarray(0, chunk.length - (size - maxBytes)))
        child.kill()
        return
      }
      out.push(chunk)
    })
    child.stderr.on('data', (chunk) => errOut.push(chunk))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new GitError(`Could not run git: ${err.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(out).toString('utf8')
      const stderr = Buffer.concat(errOut).toString('utf8').trim()
      if (truncated || okExitCodes.includes(code ?? -1)) {
        resolve(stdout)
      } else {
        const msg = stderr || stdout.trim() || `git ${args[0]} exited with code ${code}`
        reject(new GitError(msg, { stderr, exitCode: code }))
      }
    })
    if (input !== undefined) child.stdin.end(input, 'utf8')
    else child.stdin.end()
  })
}

// ---------------------------------------------------------------------------------------------
// Refs

/**
 * Parses `%D` with --decorate=full: "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1".
 * @param {string} decoration
 */
export function parseDecoration(decoration) {
  /** @type {{ type: 'head' | 'local' | 'remote' | 'tag' | 'other'; name: string; current?: boolean }[]} */
  const refs = []
  if (!decoration) return refs
  for (let part of decoration.split(', ')) {
    part = part.trim()
    if (!part) continue
    let current = false
    if (part.startsWith('HEAD -> ')) {
      current = true
      part = part.slice('HEAD -> '.length)
    } else if (part === 'HEAD') {
      refs.push({ type: 'head', name: 'HEAD' })
      continue
    }
    if (part.startsWith('tag: ')) part = part.slice(5)
    if (part.startsWith('refs/heads/')) refs.push({ type: 'local', name: part.slice(11), current })
    else if (part.startsWith('refs/remotes/')) {
      const name = part.slice(13)
      if (!name.endsWith('/HEAD')) refs.push({ type: 'remote', name })
    } else if (part.startsWith('refs/tags/')) refs.push({ type: 'tag', name: part.slice(10) })
    else refs.push({ type: 'other', name: part })
  }
  return refs
}

export const REF_FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(HEAD)',
  '%(committerdate:unix)',
  '%(contents:subject)'
].join('%1f')

/** @param {string} track "ahead 2, behind 3" | "gone" | "" */
export function parseTrack(track) {
  const ahead = /ahead (\d+)/.exec(track)
  const behind = /behind (\d+)/.exec(track)
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: track.trim() === 'gone'
  }
}

/** @param {string} out output of `git for-each-ref --format=REF_FORMAT` */
export function parseRefs(out) {
  const locals = []
  const remotes = []
  const tags = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const [ref, sha, upstream, track, head, date, subject] = line.split(FS)
    if (ref.startsWith('refs/heads/')) {
      locals.push({
        name: ref.slice(11),
        sha,
        upstream: upstream || null,
        ...parseTrack(track || ''),
        current: head === '*',
        date: Number(date) || 0,
        subject: subject ?? ''
      })
    } else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice(13)
      if (name.endsWith('/HEAD')) continue
      const slash = name.indexOf('/')
      remotes.push({
        name,
        remote: slash > 0 ? name.slice(0, slash) : name,
        branch: slash > 0 ? name.slice(slash + 1) : name,
        sha,
        date: Number(date) || 0,
        subject: subject ?? ''
      })
    } else if (ref.startsWith('refs/tags/')) {
      tags.push({ name: ref.slice(10), sha, date: Number(date) || 0 })
    }
  }
  return { locals, remotes, tags }
}

// ---------------------------------------------------------------------------------------------
// Log

export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s'].join('%x1f') + '%x1e'

/** @param {string} out */
export function parseLog(out) {
  const commits = []
  for (let rec of out.split(RS)) {
    rec = rec.replace(/^\n+/, '')
    if (!rec) continue
    const [hash, parents, author, email, time, deco, subject] = rec.split(FS)
    if (!hash || hash.length < 7) continue
    commits.push({
      hash,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      author,
      email,
      time: Number(time) * 1000,
      refs: parseDecoration(deco ?? ''),
      subject: subject ?? ''
    })
  }
  return commits
}

export const DETAILS_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%D', '%B'].join('%x1f')

/** @param {string} out */
export function parseDetails(out) {
  const [hash, parents, author, email, time, committer, committerEmail, ctime, deco, ...body] =
    out.split(FS)
  return {
    hash: hash.trim(),
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    author,
    email,
    time: Number(time) * 1000,
    committer,
    committerEmail,
    commitTime: Number(ctime) * 1000,
    refs: parseDecoration(deco ?? ''),
    message: body.join(FS).replace(/\s+$/, '')
  }
}

/**
 * Parses `--name-status -z` output: "M\0path\0R100\0old\0new\0".
 * @param {string} out
 */
export function parseNameStatus(out) {
  const parts = out.split('\0')
  const files = []
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++]
    if (!status) continue
    const letter = status[0]
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[i++]
      const path = parts[i++]
      files.push({ status: letter, path, oldPath })
    } else {
      files.push({ status: letter, path: parts[i++] })
    }
  }
  return files
}

// ---------------------------------------------------------------------------------------------
// Working tree status

/**
 * Parses `git status --porcelain=v2 --branch -z`.
 * @param {string} out
 */
export function parseStatus(out) {
  const parts = out.split('\0')
  const status = {
    branch: /** @type {string | null} */ (null),
    oid: /** @type {string | null} */ (null),
    upstream: /** @type {string | null} */ (null),
    ahead: 0,
    behind: 0,
    /** @type {{ path: string; oldPath?: string; index: string; worktree: string; kind: 'changed' | 'untracked' | 'conflict' }[]} */
    files: []
  }
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]
    if (!line) continue
    if (line.startsWith('# ')) {
      const [key, ...rest] = line.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.head') status.branch = value === '(detached)' ? null : value
      else if (key === 'branch.oid') status.oid = value === '(initial)' ? null : value
      else if (key === 'branch.upstream') status.upstream = value
      else if (key === 'branch.ab') {
        const m = /\+(\d+) -(\d+)/.exec(value)
        if (m) {
          status.ahead = Number(m[1])
          status.behind = Number(m[2])
        }
      }
    } else if (line.startsWith('1 ')) {
      // 1 XY sub mH mI mW hH hI path
      const fields = line.split(' ')
      const xy = fields[1]
      status.files.push({
        path: fields.slice(8).join(' '),
        index: xy[0],
        worktree: xy[1],
        kind: 'changed'
      })
    } else if (line.startsWith('2 ')) {
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const fields = line.split(' ')
      const xy = fields[1]
      status.files.push({
        path: fields.slice(9).join(' '),
        oldPath: parts[++i],
        index: xy[0],
        worktree: xy[1],
        kind: 'changed'
      })
    } else if (line.startsWith('u ')) {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const fields = line.split(' ')
      status.files.push({
        path: fields.slice(10).join(' '),
        index: fields[1][0],
        worktree: fields[1][1],
        kind: 'conflict'
      })
    } else if (line.startsWith('? ')) {
      status.files.push({ path: line.slice(2), index: '?', worktree: '?', kind: 'untracked' })
    }
  }
  return status
}

/** Branch and ref names a person typed: refuse what git would read as an option. */
export function assertRefName(name, what = 'name') {
  if (typeof name !== 'string' || !name.trim()) throw new GitError(`Missing ${what}`)
  if (name.startsWith('-')) throw new GitError(`Invalid ${what}: ${name}`)
  if (/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(name) || name.includes('..') || name.endsWith('.lock')) {
    throw new GitError(`Invalid ${what}: ${name}`)
  }
  return name
}

/** A commit hash or a ref name. */
export function assertRev(rev) {
  if (typeof rev !== 'string' || !rev || rev.startsWith('-') || /[\s\x00-\x1f]/.test(rev)) {
    throw new GitError(`Invalid revision: ${rev}`)
  }
  return rev
}

/** Paths are passed after `--`; still refuse non-strings. */
export function assertPaths(paths) {
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || !p)) {
    throw new GitError('Invalid path list')
  }
  return paths
}
