// The status bar tracker of the activated worker, with a stand-in Orca host and real repositories.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import activate from '../worker/main.mjs'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

function repo(branch: string) {
  const dir = mkdtempSync(join(tmpdir(), 'gtb-tr-'))
  dirs.push(dir)
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', branch)
  git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'i')
  return dir
}

test('a focus change during a status refresh ends with the new repository in the status bar', async () => {
  const a = repo('alpha')
  const b = repo('beta')
  const workspaces = [
    { id: 'a', kind: 'worktree', name: 'proj-a', path: a, branch: 'refs/heads/alpha' },
    { id: 'b', kind: 'worktree', name: 'proj-b', path: b, branch: 'refs/heads/beta' }
  ]
  const bar: any[] = []
  const on: Record<string, (e: any) => void> = {}
  await activate({
    panels: { handle: () => {}, post: async () => {} },
    commands: { register: () => {} },
    events: { on: (n: string, f: any) => (on[n] = f) },
    settings: { get: async () => 0, onDidChange: () => {} },
    storage: { get: async () => undefined, set: async () => {} },
    log: () => {},
    host: {
      call: async (m: string, p: any) => {
        if (m === 'workspace.list') return { workspaces }
        if (m === 'statusBar.update') bar.push(p)
        return null
      }
    }
  })
  on['workspace.changed']({ context: { displayName: 'proj-a', branch: 'alpha' } })
  on['workspace.changed']({ context: { displayName: 'proj-b', branch: 'beta' } })
  for (let i = 0; i < 100 && !bar.at(-1)?.text?.startsWith('beta'); i++) await new Promise((r) => setTimeout(r, 50))
  await new Promise((r) => setTimeout(r, 300))
  assert.match(bar.at(-1).text, /^beta/)
  assert.match(bar.at(-1).tooltip, /^proj-b: beta/)
})
