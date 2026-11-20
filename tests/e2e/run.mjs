// Runs every E2E check: rebuilds the testbed, then the panel checks and each conflict scenario.
// usage: node tests/e2e/run.mjs [plugin-dir]    (npm run test:e2e)
import { spawnSync } from 'node:child_process'
import { TESTBED } from './browser.mjs'

const here = new URL('.', import.meta.url).pathname
const plugin = process.argv[2] ?? new URL('../..', import.meta.url).pathname
const runs = [
  ['bash', [`${here}make-testbed.sh`, TESTBED], 'testbed'],
  ['node', [`${here}e2e-fixes.mjs`, plugin], 'panel checks'],
  ...['merge', 'changes', 'rebase', 'rebase2', 'squash'].map((s) => ['node', [`${here}e2e-conflicts.mjs`, plugin, s], `conflicts: ${s}`])
]
let failed = 0
for (const [cmd, args, label] of runs) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, TESTBED } })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const ok = r.status === 0
  if (!ok) failed++
  console.log(`${ok ? 'ok' : 'not ok'} - ${label}`)
  for (const line of out.split('\n')) if (/^(ok|not ok) - /.test(line) || (!ok && line.trim() && !/^warning: /.test(line))) console.log(`    ${line}`)
  if (label === 'testbed' && !ok) break
}
console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
