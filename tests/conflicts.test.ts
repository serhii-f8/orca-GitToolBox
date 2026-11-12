import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { conflictInfo, readConflict, writeResolved, resolveSide, conflictType, operationInProgress } from '../worker/conflicts.mjs'

const dirs: string[] = []
after(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3 })
    } catch {}
  }
})

/** A repo where `main` and `feature` both changed `file` from `base`. */
function repo(files: { base: Record<string, string | Buffer>; main: Record<string, string | Buffer | null>; feature: Record<string, string | Buffer | null> }) {
  const dir = mkdtempSync(join(tmpdir(), 'gtb-cf-'))
  dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const put = (set: Record<string, string | Buffer | null>) => {
    for (const [p, c] of Object.entries(set)) {
      if (c === null) git('rm', '-q', '--', p)
      else writeFileSync(join(dir, p), c)
    }
    git('add', '--all')
  }
  git('init', '-q', '-b', 'main')
  git('config', 'core.autocrlf', 'false')
  git('config', 'user.name', 'Tester')
  git('config', 'user.email', 't@example.com')
  put(files.base)
  git('commit', '-q', '-m', 'base')
  git('checkout', '-q', '-b', 'feature')
  put(files.feature)
  git('commit', '-q', '--allow-empty', '-m', 'feature change')
  git('checkout', '-q', 'main')
  put(files.main)
  git('commit', '-q', '--allow-empty', '-m', 'main change')
  return { dir, git }
}

const merge = (r) => {
  try {
    r.git('merge', '-q', '--no-edit', 'feature')
  } catch {}
}

test('conflictType names porcelain codes', () => {
  assert.equal(conflictType('UU'), 'both modified')
  assert.equal(conflictType('UD'), 'deleted by them')
  assert.equal(conflictType('DU'), 'deleted by you')
  assert.equal(conflictType('AA'), 'both added')
})

test('conflictInfo for merge', async () => {
  const r = repo({ base: { 'f.txt': 'a\nb\nc\n' }, main: { 'f.txt': 'a\nM\nc\n' }, feature: { 'f.txt': 'a\nF\nc\n' } })
  merge(r)
  const info = await conflictInfo(r.dir)
  assert.equal(info.op, 'merge')
  assert.equal(info.oursLabel, 'main')
  assert.equal(info.theirsLabel, 'feature')
  assert.deepEqual(info.files, [{ path: 'f.txt', code: 'UU', type: 'both modified' }])
})

test('labels for rebase', async () => {
  const r = repo({ base: { 'f.txt': 'a\nb\nc\n' }, main: { 'f.txt': 'a\nM\nc\n' }, feature: { 'f.txt': 'a\nF\nc\n' } })
  r.git('checkout', '-q', 'feature')
  try {
    r.git('rebase', 'main')
  } catch {}
  const info = await conflictInfo(r.dir)
  assert.equal(info.op, 'rebase')
  assert.match(info.oursLabel, /^Upstream: main/)
  assert.match(info.theirsLabel, /^Your commit: [0-9a-f]{7,} feature change$/)
})

test('readConflict stages', async () => {
  const r = repo({ base: { 'f.txt': 'a\nb\nc\n' }, main: { 'f.txt': 'a\nM\nc\n' }, feature: { 'f.txt': 'a\nF\nc\n' } })
  merge(r)
  const c = await readConflict(r.dir, 'f.txt')
  assert.equal(c.base, 'a\nb\nc\n')
  assert.equal(c.ours, 'a\nM\nc\n')
  assert.equal(c.theirs, 'a\nF\nc\n')
  assert.equal(c.whole, false)
  assert.match(c.current ?? '', /^<<<<<<< /m)
})

test('writeResolved stages result', async () => {
  const r = repo({ base: { 'f.txt': 'a\nb\nc\n' }, main: { 'f.txt': 'a\nM\nc\n' }, feature: { 'f.txt': 'a\nF\nc\n' } })
  merge(r)
  await writeResolved(r.dir, 'f.txt', 'a\nM\nF\nc\n')
  assert.equal(readFileSync(join(r.dir, 'f.txt'), 'utf8'), 'a\nM\nF\nc\n')
  assert.equal(r.git('diff', '--name-only', '--diff-filter=U'), '')
  assert.equal(r.git('show', ':f.txt'), 'a\nM\nF\nc\n')
})

test('writeResolved keeps CRLF', async () => {
  const r = repo({
    base: { 'f.txt': 'a\r\nb\r\nc' },
    main: { 'f.txt': 'a\r\nM\r\nc' },
    feature: { 'f.txt': 'a\r\nF\r\nc' }
  })
  merge(r)
  const c = await readConflict(r.dir, 'f.txt')
  assert.equal(c.ours, 'a\r\nM\r\nc')
  await writeResolved(r.dir, 'f.txt', c.ours ?? '')
  assert.equal(readFileSync(join(r.dir, 'f.txt'), 'utf8'), 'a\r\nM\r\nc')
})

test('resolveSide ours/theirs', async () => {
  const r = repo({
    base: { 'f.txt': 'a\nb\nc\n', 'g.txt': '1\n' },
    main: { 'f.txt': 'a\nM\nc\n', 'g.txt': 'main\n' },
    feature: { 'f.txt': 'a\nF\nc\n', 'g.txt': 'feature\n' }
  })
  merge(r)
  await resolveSide(r.dir, ['f.txt'], 'ours')
  await resolveSide(r.dir, ['g.txt'], 'theirs')
  assert.equal(readFileSync(join(r.dir, 'f.txt'), 'utf8'), 'a\nM\nc\n')
  assert.equal(readFileSync(join(r.dir, 'g.txt'), 'utf8'), 'feature\n')
  assert.equal(r.git('diff', '--name-only', '--diff-filter=U'), '')
})

test('resolveSide on deleted-by-them', async () => {
  const mk = () =>
    repo({ base: { 'f.txt': 'a\n', 'k.txt': 'k\n' }, main: { 'f.txt': 'mine\n' }, feature: { 'f.txt': null } })
  const a = mk()
  merge(a)
  assert.deepEqual((await conflictInfo(a.dir)).files.map((f) => f.type), ['deleted by them'])
  assert.equal((await readConflict(a.dir, 'f.txt')).whole, 'structural')
  await resolveSide(a.dir, ['f.txt'], 'theirs')
  assert.equal(existsSync(join(a.dir, 'f.txt')), false)
  assert.equal(a.git('status', '--porcelain'), 'D  f.txt\n')

  const b = mk()
  merge(b)
  await resolveSide(b.dir, ['f.txt'], 'ours')
  assert.equal(readFileSync(join(b.dir, 'f.txt'), 'utf8'), 'mine\n')
  assert.equal(b.git('diff', '--name-only', '--diff-filter=U'), '')
})

test('binary and non-utf8 files are whole-file only', async () => {
  const r = repo({
    base: { 'b.bin': Buffer.from([0, 1, 2]), 'l.txt': Buffer.from('caf\xe9\n', 'latin1') },
    main: { 'b.bin': Buffer.from([0, 1, 3]), 'l.txt': Buffer.from('caf\xe9 main\n', 'latin1') },
    feature: { 'b.bin': Buffer.from([0, 1, 4]), 'l.txt': Buffer.from('caf\xe9 feat\n', 'latin1') }
  })
  merge(r)
  assert.equal((await readConflict(r.dir, 'b.bin')).whole, 'binary')
  assert.equal((await readConflict(r.dir, 'l.txt')).whole, 'binary')
})

test('current is null when the file was removed from disk', async () => {
  const r = repo({ base: { 'f.txt': 'a\nb\nc\n' }, main: { 'f.txt': 'a\nM\nc\n' }, feature: { 'f.txt': 'a\nF\nc\n' } })
  merge(r)
  unlinkSync(join(r.dir, 'f.txt'))
  assert.equal((await readConflict(r.dir, 'f.txt')).current, null)
})

test('conflictInfo with no operation uses neutral side names', async () => {
  const r = repo({ base: { 'f.txt': 'a\nb\nc\n' }, main: { 'f.txt': 'a\nM\nc\n' }, feature: {} })
  writeFileSync(join(r.dir, 'f.txt'), 'a\nS\nc\n')
  r.git('stash', '-q')
  writeFileSync(join(r.dir, 'f.txt'), 'a\nX\nc\n')
  r.git('commit', '-qam', 'x')
  try {
    r.git('stash', 'pop')
  } catch {}
  const info = await conflictInfo(r.dir)
  assert.equal(info.op, null)
  assert.equal(info.oursLabel, 'Your files')
  assert.equal(info.theirsLabel, 'Incoming changes')
  assert.equal(info.files.length, 1)
})

test('rebase state ends when the rebase finishes, though git keeps REBASE_HEAD', async () => {
  const r = repo({ base: { 'f.txt': 'a\nb\nc\n' }, main: { 'f.txt': 'a\nM\nc\n' }, feature: { 'f.txt': 'a\nF\nc\n' } })
  r.git('checkout', '-q', 'feature')
  try {
    r.git('rebase', 'main')
  } catch {}
  assert.equal(await operationInProgress(r.dir), 'rebase')
  await resolveSide(r.dir, ['f.txt'], 'theirs')
  r.git('-c', 'core.editor=true', 'rebase', '--continue')
  assert.equal(await operationInProgress(r.dir), null)
})
