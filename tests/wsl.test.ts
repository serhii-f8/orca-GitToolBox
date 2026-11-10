// Runs only when the tests themselves run on Windows from a WSL folder (as `orca plugin test`
// does for a plugin kept in WSL): then git must go through wsl.exe, exactly as the worker does.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { parseRepoPath, runGit } from '../worker/git.mjs'

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const inWsl = process.platform === 'win32' && parseRepoPath(here).kind === 'wsl'

test('git runs inside WSL for a \\\\wsl.localhost path', { skip: !inWsl && 'not Windows + WSL' }, async () => {
  const out = await runGit(here, ['rev-parse', '--show-toplevel'])
  assert.equal(out.trim(), parseRepoPath(here).path)
  const status = await runGit(here, ['status', '--porcelain=v2', '--branch', '-z'])
  assert.match(status, /# branch\.head /)
})
