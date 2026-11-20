// Regression checks in the real panel (log paging, diff rows, commit and push, branch chip, popovers,
// stashes, conflict stops, commands run before the panel loads),
// against the testbed from make-testbed.sh. usage: node e2e-fixes.mjs [plugin-dir]
import { launch, TESTBED } from './browser.mjs'
import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const plugin = process.argv[2] ?? new URL('../..', import.meta.url).pathname
const TB = TESTBED
const git = (...a) => execFileSync('git', a, { cwd: TB, encoding: 'utf8' })
const server = spawn('node', [new URL('./server.mjs', import.meta.url).pathname, plugin, '4791'], { stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise((r) => server.stdout.once('data', r))
const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const ok = (m) => console.log('ok -', m)
try {
  await page.goto('http://localhost:4791/')
  await page.waitForSelector('#rows .row', { timeout: 20000 })

  const from = Number(process.env.FROM ?? 1)
  if (from <= 1) {
  // 1. Paging: pick the 420-commit branch and fire a burst of scroll events.
  await page.evaluate(() => {
    const sel = document.querySelector('#branchSelect')
    if (sel) { sel.value = 'long-history'; sel.dispatchEvent(new Event('change', { bubbles: true })) }
  })
  await page.waitForTimeout(1500)
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      const box = document.querySelector('#rows')
      for (let k = 0; k < 6; k++) { box.scrollTop = box.scrollHeight; box.dispatchEvent(new Event('scroll')) }
    })
    await page.waitForTimeout(1200)
  }
  const rows = await page.$$eval('#rows .row', (r) => r.length)
  assert.ok(rows > 300, `expected more than 300 rows after scrolling, got ${rows}`)
  ok(`log paging loads past the first page under a burst of scroll events (${rows} rows)`)

  }
  if (from <= 2) {
  // 2. Diff: a removed "-- " line and an added "++ " line are shown.
  writeFileSync(`${TB}/q.sql`, 'select 1;\n-- old comment\n')
  git('add', 'q.sql'); git('commit', '-q', '-m', 'Add q.sql', '--', 'q.sql')
  writeFileSync(`${TB}/q.sql`, 'select 1;\n++ counter\n')
  await page.click('[data-tab="changes"]').catch(() => page.evaluate(() => document.querySelector('[data-tab="changes"]')?.click()))
  await page.waitForTimeout(1500)
  await page.evaluate(() => [...document.querySelectorAll('#changesList .file')].find((f) => f.textContent.includes('q.sql'))?.click())
  await page.waitForSelector('#changesDiff .l.del', { timeout: 8000 })
  const diff = await page.$$eval('#changesDiff .l', (ls) => ls.map((l) => l.className.replace('l', '').trim() + ':' + l.querySelector('.code').textContent))
  assert.deepEqual(diff.filter((d) => !d.startsWith('hunk')), [':' + ' select 1;', 'del:--- old comment', 'add:+++ counter'])
  ok('diff shows "-- " and "++ " lines and no phantom trailing row')
  git('checkout', '--', 'q.sql')

  }
  if (from <= 3) {
  // 3. Commit and push with a rejected push.
  git('remote', 'set-url', 'origin', '/nonexistent/remote.git')
  writeFileSync(`${TB}/pushme.txt`, 'x\n')
  git('add', 'pushme.txt')
  await page.evaluate(() => document.querySelector('[data-act="refresh"]').click())
  await page.waitForFunction(() => [...document.querySelectorAll('#changesList .file')].some((f) => f.textContent.includes('pushme.txt')), null, { timeout: 10000 })
  await page.waitForTimeout(500)
  await page.fill('#commitMessage', 'Commit that cannot be pushed')
  await page.evaluate(() => document.querySelector('#commitPushBtn, [data-a="commitPush"], #commitAndPush')?.click())
  await page.waitForSelector('.toast.error', { timeout: 15000 })
  const toastText = await page.$eval('.toast.error', (t) => t.textContent)
  assert.match(toastText, /Committed, but push failed/)
  assert.equal(await page.$eval('#commitMessage', (t) => t.value), '')
  assert.equal(git('log', '-1', '--format=%s').trim(), 'Commit that cannot be pushed')
  ok('commit+push with a rejected push says "Committed, but push failed" and clears the message')
  git('remote', 'set-url', 'origin', `${TB}-remote.git`)

  }
  // 4. A commit made outside the panel shows up in the branch chip after the window gets focus.
  await page.evaluate(() => document.querySelector('[data-act="refresh"]').click())
  await page.waitForTimeout(1500)
  const before = await page.$eval('#branchChip', (c) => c.textContent)
  writeFileSync(`${TB}/outside.txt`, 'x\n')
  git('add', 'outside.txt'); git('commit', '-q', '-m', 'Commit from a terminal', '--', 'outside.txt')
  const ahead = git('rev-list', '--count', '@{upstream}..HEAD').trim()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForFunction((n) => document.querySelector('#branchChip').textContent.includes('↗' + n), ahead, { timeout: 8000 })
  ok(`branch chip follows an outside commit (${before.trim()} -> ↗${ahead})`)

  // 5. The switcher closes when the conflicts dialog opens.
  await fetch('http://localhost:4791/__cmd', { method: 'POST', body: JSON.stringify({ id: 'gittoolbox.switch' }) })
  await page.waitForSelector('#switcherPop:not(.hidden)', { timeout: 5000 })
  git('stash', '-q', '-u')
  try { git('merge', 'conflict/a') } catch {}
  try { git('merge', 'conflict/b') } catch {}
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForSelector('#conflictsModal:not(.hidden)', { timeout: 8000 })
  assert.equal(await page.$eval('#switcherPop', (p) => p.classList.contains('hidden')), true)
  ok('the switcher closes when the conflicts dialog opens')
  git('merge', '--abort')

  // 6. A pull that stops on conflicts is a warning to resolve, not a red error.
  writeFileSync(`${TB}/upstream.txt`, 'mine\n')
  git('add', 'upstream.txt'); git('commit', '-q', '-m', 'Clashes with the teammate', '--', 'upstream.txt')
  await page.evaluate(() => document.querySelector('[data-act="refresh"]').click())
  await page.waitForTimeout(1500)
  await page.evaluate(() => { for (const t of document.querySelectorAll('.toast')) t.remove() })
  await page.evaluate(() => document.querySelector('[data-act="pull"]').click())
  await page.waitForSelector('.toast.warn', { timeout: 15000 })
  const warn = await page.$eval('.toast.warn', (t) => t.textContent)
  assert.match(warn, /Update stopped on 1 conflict|stopped on 1 conflict/)
  assert.equal(await page.$('.toast.error'), null)
  ok(`a pull that stops on conflicts shows a warning (${warn.split('Resolve')[0].trim()})`)
  git('merge', '--abort')
  git('reset', '-q', '--hard', 'HEAD~1')
  await page.evaluate(() => document.querySelector('#conflictsModal [data-cf="close"]')?.click())

  // 7. Stashes: stash from the panel, see it listed with its diff, apply it, drop it.
  writeFileSync(`${TB}/stash-me.txt`, 'set aside\n')
  await page.evaluate(() => document.querySelector('[data-tab="changes"]').click())
  await page.evaluate(() => document.querySelector('[data-act="refresh"]').click())
  await page.waitForSelector('#changesList [data-a="stashPush"]', { timeout: 10000 })
  await page.evaluate(() => document.querySelector('#changesList [data-a="stashPush"]').click())
  await page.waitForSelector('#modal:not(.hidden) input[type=text]')
  await page.fill('#modal input[type=text]', 'from the panel')
  await page.evaluate(() => document.querySelector('#modal button[type=submit]').click())
  await page.waitForFunction(() => [...document.querySelectorAll('#changesList .file.stash')].some((r) => r.textContent.includes('from the panel')), null, { timeout: 10000 })
  assert.ok(!git('status', '--porcelain').includes('stash-me.txt'))
  await page.evaluate(() => [...document.querySelectorAll('#changesList .file.stash')].find((r) => r.textContent.includes('from the panel')).click())
  await page.waitForFunction(() => document.querySelector('#changesDiff .diff')?.textContent.includes('set aside'), null, { timeout: 10000 })
  await page.evaluate(() => [...document.querySelectorAll('#changesList .file.stash')].find((r) => r.textContent.includes('from the panel')).querySelector('[data-a="stashApply"]').click())
  await page.waitForFunction(() => [...document.querySelectorAll('#changesList .file')].some((r) => r.textContent.includes('stash-me.txt')), null, { timeout: 10000 })
  const stashCount = (await page.$$('#changesList .file.stash')).length
  await page.evaluate(() => [...document.querySelectorAll('#changesList .file.stash')].find((r) => r.textContent.includes('from the panel')).querySelector('[data-a="stashDrop"]').click())
  await page.waitForSelector('#modal:not(.hidden) button[type=submit]')
  await page.evaluate(() => document.querySelector('#modal button[type=submit]').click())
  await page.waitForFunction(() => ![...document.querySelectorAll('#changesList .file.stash')].some((r) => r.textContent.includes('from the panel')), null, { timeout: 10000 })
  assert.ok(!git('stash', 'list').includes('from the panel'))
  assert.equal((await page.$$('#changesList .file.stash')).length, stashCount - 1)
  ok('stash from the panel, show its diff, apply it and drop it')

  // 8. A palette command run while the panel is closed shows its view once the panel loads.
  await page.goto('about:blank')
  await fetch('http://localhost:4791/__cmd', { method: 'POST', body: JSON.stringify({ id: 'gittoolbox.switch' }) })
  await page.goto('http://localhost:4791/')
  await page.waitForSelector('#switcherPop:not(.hidden)', { timeout: 15000 })
  ok('a command run before the panel loads opens its view when the panel starts')

  assert.deepEqual(errors, [])
  ok('no page errors')
} catch (err) {
  // Keep the panel as it looked when a check failed.
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/e2e-fixes-failure.png` }).catch(() => {})
  throw err
} finally {
  await browser.close()
  server.kill()
}
