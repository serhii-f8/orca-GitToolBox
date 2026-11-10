import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCommand,
  parseDecoration,
  parseLog,
  parseNameStatus,
  parseRefs,
  parseRepoPath,
  parseStatus,
  parseTrack,
  assertRefName,
  runGit,
  LOG_FORMAT,
  REF_FORMAT
} from '../worker/git.mjs'

test('WSL UNC paths run git inside the distro', () => {
  assert.deepEqual(parseRepoPath('\\\\wsl.localhost\\Ubuntu-22.04\\srv\\app'), {
    kind: 'wsl',
    distro: 'Ubuntu-22.04',
    path: '/srv/app'
  })
  assert.equal(parseRepoPath('\\\\wsl$\\Debian\\home\\me\\').path, '/home/me')
  assert.deepEqual(parseRepoPath('C:\\code\\app'), { kind: 'native', path: 'C:\\code\\app' })
  const cmd = buildCommand('\\\\wsl.localhost\\Ubuntu\\srv\\r', ['status'], 'win32')
  assert.equal(cmd.file, 'wsl.exe')
  assert.deepEqual(cmd.args.slice(0, 6), ['-d', 'Ubuntu', '--cd', '/srv/r', '--exec', 'env'])
  assert.equal(cmd.args.at(-1), 'status')
  const linux = buildCommand('\\\\wsl.localhost\\Ubuntu\\srv\\r', ['status'], 'linux')
  assert.equal(linux.file, 'git')
  assert.equal(linux.cwd, '/srv/r')
})

test('decorations', () => {
  assert.deepEqual(
    parseDecoration('HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1'),
    [
      { type: 'local', name: 'main', current: true },
      { type: 'remote', name: 'origin/main' },
      { type: 'tag', name: 'v1' }
    ]
  )
  assert.deepEqual(parseDecoration('HEAD'), [{ type: 'head', name: 'HEAD' }])
})

test('track and name-status', () => {
  assert.deepEqual(parseTrack('ahead 2, behind 3'), { ahead: 2, behind: 3, gone: false })
  assert.deepEqual(parseTrack('gone'), { ahead: 0, behind: 0, gone: true })
  assert.deepEqual(parseNameStatus('M\0a.txt\0R100\0old.txt\0new.txt\0'), [
    { status: 'M', path: 'a.txt' },
    { status: 'R', path: 'new.txt', oldPath: 'old.txt' }
  ])
})

test('ref names that git would read as options are refused', () => {
  assert.throws(() => assertRefName('--force'))
  assert.throws(() => assertRefName('a b'))
  assert.throws(() => assertRefName('a..b'))
  assert.equal(assertRefName('feature/login-42'), 'feature/login-42')
})

let dir = ''
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } })

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtb-'))
  git('init', '-q', '-b', 'main')
  git('config', 'core.autocrlf', 'false')
  git('config', 'user.name', 'Tester')
  git('config', 'user.email', 't@example.com')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
  git('checkout', '-q', '-b', 'feat/x')
  writeFileSync(join(dir, 'b.txt'), 'two\n')
  git('add', '.')
  git('commit', '-q', '-m', 'feature work')
  git('checkout', '-q', 'main')
  writeFileSync(join(dir, 'a.txt'), 'one\nmore\n')
  git('commit', '-q', '-am', 'main work')
  git('merge', '-q', '--no-edit', 'feat/x')
  git('tag', 'v1')
})
after(() => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    // Windows keeps git's read-only object files; the temp folder is cleaned by the OS.
  }
})

test('log, refs and status from a real repository', async () => {
  const commits = parseLog(await runGit(dir, ['log', '--date-order', '--decorate=full', `--format=${LOG_FORMAT}`, '--all']))
  assert.equal(commits.length, 4)
  assert.equal(commits[0].parents.length, 2)
  assert.ok(commits[0].refs.some((r) => r.type === 'tag' && r.name === 'v1'))
  assert.ok(commits[0].refs.some((r) => r.type === 'local' && r.name === 'main' && r.current))
  assert.equal(commits.at(-1)?.subject, 'first')

  const refs = parseRefs(await runGit(dir, ['for-each-ref', `--format=${REF_FORMAT}`]))
  assert.deepEqual(refs.locals.map((l) => l.name).sort(), ['feat/x', 'main'])
  assert.equal(refs.locals.find((l) => l.name === 'main')?.current, true)
  assert.deepEqual(refs.tags.map((t) => t.name), ['v1'])

  writeFileSync(join(dir, 'a.txt'), 'changed\n')
  writeFileSync(join(dir, 'new file.txt'), 'x\n')
  git('mv', 'b.txt', 'c.txt')
  const st = parseStatus(await runGit(dir, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']))
  assert.equal(st.branch, 'main')
  const byPath = Object.fromEntries(st.files.map((f) => [f.path, f]))
  assert.equal(byPath['a.txt'].worktree, 'M')
  assert.equal(byPath['c.txt'].index, 'R')
  assert.equal(byPath['c.txt'].oldPath, 'b.txt')
  assert.equal(byPath['new file.txt'].kind, 'untracked')
})

test('commit message goes through stdin', async () => {
  await runGit(dir, ['add', '--all'])
  await runGit(dir, ['commit', '-F', '-'], { input: 'Quote "me" & $HOME\n\nbody line' })
  const msg = git('log', '-1', '--format=%B').trim()
  assert.equal(msg, 'Quote "me" & $HOME\n\nbody line')
})

test('git failures reject with stderr', async () => {
  await assert.rejects(runGit(dir, ['checkout', 'no-such-branch']), /no-such-branch/)
})
