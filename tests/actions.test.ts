// Worker handlers against real temporary repositories: the activated plugin with a stand-in Orca host.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import activate from '../worker/main.mjs'

const dirs: string[] = []
const handlers: Record<string, (input: any, ctx?: any) => Promise<any>> = {}
before(async () => {
  await activate({
    panels: { handle: (n: string, f: any) => (handlers[n] = f), post: async () => {} },
    commands: { register: () => {} },
    events: { on: () => {} },
    settings: { get: async () => 0, onDidChange: () => {} },
    storage: { get: async () => undefined, set: async () => {} },
    log: () => {},
    host: { call: async (m: string) => (m === 'workspace.list' ? { workspaces: [] } : null) }
  })
})
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'gtb-act-'))
  dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q', '-b', 'main')
  git('config', 'core.autocrlf', 'false')
  git('config', 'user.name', 'Tester')
  git('config', 'user.email', 't@example.com')
  const put = (p: string, c: string) => writeFileSync(join(dir, p), c)
  const read = (p: string) => readFileSync(join(dir, p), 'utf8')
  const act = (input: any) => handlers['git.action']({ repo: dir, ...input })
  return { dir, git, put, read, act }
}

test('rollback of ":foo.txt" touches that file, not "foo.txt"', async () => {
  const r = repo()
  r.put('foo.txt', 'foo\n')
  r.put(':foo.txt', 'colon\n')
  r.git('add', '--all')
  r.git('commit', '-q', '-m', 'base')
  r.put('foo.txt', 'foo edited\n')
  r.put(':foo.txt', 'colon edited\n')
  await r.act({ op: 'discard', paths: [':foo.txt'] })
  assert.equal(r.read(':foo.txt'), 'colon\n')
  assert.equal(r.read('foo.txt'), 'foo edited\n')
})

test('checkout of a missing ref that matches a folder fails and keeps the edits', async () => {
  const r = repo()
  mkdirSync(join(r.dir, 'docs'))
  r.put('docs/x.txt', 'x\n')
  r.git('add', '--all')
  r.git('commit', '-q', '-m', 'base')
  r.put('docs/x.txt', 'edited\n')
  await assert.rejects(r.act({ op: 'checkout', ref: 'docs' }))
  assert.equal(r.read('docs/x.txt'), 'edited\n')
})

test('rollback of a mixed set handles a file that is staged as new and then edited', async () => {
  const r = repo()
  mkdirSync(join(r.dir, 'src'))
  r.put('src/a.txt', 'a\n')
  r.git('add', '--all')
  r.git('commit', '-q', '-m', 'base')
  r.put('src/a.txt', 'a edited\n')
  r.put('new.txt', 'new\n')
  r.git('add', 'new.txt')
  r.put('new.txt', 'new edited\n')
  await r.act({ op: 'discard', paths: ['src/a.txt', 'new.txt'] })
  assert.equal(r.read('src/a.txt'), 'a\n')
  assert.equal(r.read('new.txt'), 'new\n')
  assert.match(r.git('status', '--porcelain'), /^A  new\.txt$/m)
})

test('rollback works on a branch with no commits yet', async () => {
  const r = repo()
  r.put('first.txt', 'one\n')
  r.git('add', 'first.txt')
  r.put('first.txt', 'two\n')
  await r.act({ op: 'discard', paths: ['first.txt'] })
  assert.equal(r.read('first.txt'), 'one\n')
})

test('commit and push: a rejected push is reported as such, and the commit exists', async () => {
  const r = repo()
  r.put('a.txt', 'a\n')
  r.git('add', '--all')
  r.git('commit', '-q', '-m', 'base')
  r.git('remote', 'add', 'origin', join(r.dir, 'no-such-remote.git'))
  r.put('a.txt', 'b\n')
  r.git('add', '--all')
  await assert.rejects(r.act({ op: 'commit', message: 'second', push: true }), (err: any) => {
    assert.match(err.message, /^Committed, but the push failed/)
    assert.equal(err.code, 'push_failed')
    return true
  })
  assert.equal(r.git('log', '-1', '--format=%s').trim(), 'second')
})

test('pushing a branch that is not checked out goes to its upstream', async () => {
  const r = repo()
  const remote = mkdtempSync(join(tmpdir(), 'gtb-remote-'))
  dirs.push(remote)
  execFileSync('git', ['init', '-q', '--bare', remote])
  r.put('a.txt', 'a\n')
  r.git('add', '--all')
  r.git('commit', '-q', '-m', 'base')
  r.git('remote', 'add', 'origin', remote)
  r.git('push', '-q', '-u', 'origin', 'main', 'main:other-name')
  r.git('branch', 'side')
  r.git('branch', '--set-upstream-to=origin/other-name', 'side')
  r.git('checkout', '-q', 'side')
  r.put('a.txt', 'side\n')
  r.git('commit', '-q', '-am', 'side work')
  r.git('checkout', '-q', 'main')
  await r.act({ op: 'push', branch: 'side' })
  const remoteGit = (...a: string[]) => execFileSync('git', a, { cwd: remote, encoding: 'utf8' })
  assert.equal(remoteGit('log', '-1', '--format=%s', 'other-name').trim(), 'side work')
  assert.ok(!remoteGit('branch', '--list', 'side').trim())
})

test('log: author filter is literal and a hex-like search keeps filtering on later pages', async () => {
  const r = repo()
  for (let i = 0; i < 6; i++) {
    r.put('f.txt', String(i))
    r.git('add', '--all')
    const who = i % 2 ? 'dependabot[bot]' : 'Tester'
    execFileSync('git', ['-c', `user.name=${who}`, 'commit', '-q', '-m', i % 2 ? `added ${i}` : `other ${i}`], { cwd: r.dir })
  }
  const byBot = await handlers['git.log']({ repo: r.dir, author: 'dependabot[bot]', ref: 'all' })
  assert.equal(byBot.commits.length, 3)
  const page1 = await handlers['git.log']({ repo: r.dir, text: 'added', ref: 'all', limit: 2, skip: 0 })
  const page2 = await handlers['git.log']({ repo: r.dir, text: 'added', ref: 'all', limit: 2, skip: 2 })
  const subjects = [...page1.commits, ...page2.commits].map((c: any) => c.subject)
  assert.deepEqual(subjects.sort(), ['added 1', 'added 3', 'added 5'])
})

test('a remote whose name contains "/" works for branches, checkout, update and delete', async () => {
  const r = repo()
  const remote = mkdtempSync(join(tmpdir(), 'gtb-remote-'))
  dirs.push(remote)
  execFileSync('git', ['init', '-q', '--bare', remote])
  r.put('a.txt', 'a\n')
  r.git('add', '--all')
  r.git('commit', '-q', '-m', 'base')
  r.git('remote', 'add', 'team/a', remote)
  r.git('push', '-q', 'team/a', 'main', 'main:feature/x')
  r.git('fetch', '-q', 'team/a')
  const b = await handlers['git.branches']({ repo: r.dir })
  const x = b.remotes.find((x: any) => x.name === 'team/a/feature/x')
  assert.deepEqual([x.remote, x.branch], ['team/a', 'feature/x'])
  await r.act({ op: 'checkout', ref: 'team/a/feature/x', remote: true })
  assert.equal(r.git('branch', '--show-current').trim(), 'feature/x')
  r.git('checkout', '-q', 'main')
  r.git('branch', '-q', '--set-upstream-to=team/a/main', 'main')
  await r.act({ op: 'updateBranch', branch: 'feature/x' })
  await r.act({ op: 'deleteBranch', name: 'team/a/feature/x', remote: true })
  assert.equal(execFileSync('git', ['branch', '--list', 'feature/x'], { cwd: remote, encoding: 'utf8' }).trim(), '')
})
