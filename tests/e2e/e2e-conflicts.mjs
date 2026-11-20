// End-to-end check of the conflict UI: the real panel in headless Chromium, the real worker in
// this Node process (with a stand-in Orca host), and a real repository in conflict.
// usage: node e2e-conflicts.mjs [plugin-dir] <scenario>   scenarios: merge changes rebase rebase2 squash
import { launch } from './browser.mjs'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import assert from 'node:assert/strict'

const pluginDir = process.argv[2] ?? new URL('../..', import.meta.url).pathname
const { default: activate } = await import(join(pluginDir, 'worker/main.mjs'))

// ------------------------------------------------------------------ a repository in conflict
const dir = mkdtempSync(join(tmpdir(), 'gtb-e2e-'))
const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
git('init', '-q', '-b', 'main')
git('config', 'user.name', 'T')
git('config', 'user.email', 't@e.x')
git('config', 'core.autocrlf', 'false')
mkdirSync(join(dir, 'src'))
const base = ['// cart', 'const A = 1', '', 'function d(code) {', "  if (code === 'W') return 0.1", '  return 0', '}', '', 'function n(items) {', '  return items.length', '}', ''].join('\n')
writeFileSync(join(dir, 'src/cart.js'), base)
writeFileSync(join(dir, 'notes.txt'), 'base\n')
git('add', '-A')
git('commit', '-qm', 'base')
git('checkout', '-qb', 'feature')
writeFileSync(join(dir, 'src/cart.js'), base.replace('const A = 1', 'const A = 1\nconst FREE = 50').replace("  if (code === 'W') return 0.1\n  return 0", "  if (code === 'W') return 0.1\n  if (code === 'S') return 0.15\n  return 0"))
writeFileSync(join(dir, 'notes.txt'), 'feature\n')
git('commit', '-qam', 'feature')
if (process.argv[3] === 'changes') {
  writeFileSync(join(dir, 'src/cart.js'), readFileSync(join(dir, 'src/cart.js'), 'utf8').replace('function n(items) {', 'function n(list) {').replace('items.length', 'list.length'))
  git('commit', '-qam', 'rename')
}
if (process.argv[3] === 'rebase2') {
  writeFileSync(join(dir, 'src/cart.js'), readFileSync(join(dir, 'src/cart.js'), 'utf8').replace('// cart', '// cart v2'))
  git('commit', '-qam', 'feature two')
}
git('checkout', '-q', 'main')
writeFileSync(join(dir, 'src/cart.js'), base.replace('// cart', '// cart, main').replace("  if (code === 'W') return 0.1\n  return 0", '  return { W: 0.1 }[code] ?? 0'))
writeFileSync(join(dir, 'notes.txt'), 'main\n')
git('commit', '-qam', 'main')
const scenario = process.argv[3] ?? 'merge'
try {
  if (scenario === 'rebase' || scenario === 'rebase2') {
    git('checkout', '-q', 'feature')
    git('rebase', 'main')
  } else if (scenario === 'squash') git('merge', '--squash', 'feature')
  else git('merge', '--no-edit', 'feature')
} catch {}

// ------------------------------------------------------------------ worker with a stand-in host
const handlers = {}
await activate({
  panels: { handle: (n, f) => (handlers[n] = f), post: (n, p) => page?.evaluate(([n, p]) => window.__emit(n, p), [n, p]).catch(() => {}) },
  commands: { register() {} },
  events: { on() {} },
  settings: { get: async () => undefined, onDidChange() {} },
  log() {},
  host: {
    call: async (m) => {
      if (m === 'workspace.list') return { workspaces: [{ id: 'w1', kind: 'worktree', name: 'demo', path: dir, branch: 'main' }] }
      if (m === 'workspace.readContext') return null
      return {}
    }
  }
})

// ------------------------------------------------------------------ static server for the panel
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const stub = `<script>
  window.__on = {}
  window.__emit = (n, p) => (window.__on[n] ?? []).forEach((f) => f(p))
  window.orca = {
    plugin: {
      request: (n, p) => window.__req(n, p).then((r) => { if (r && r.__error) throw Object.assign(new Error(r.__error), { code: 'x' }); return r }),
      on: (n, f) => (window.__on[n] ??= []).push(f)
    },
    on() {},
    storage: { get: async () => null, set: async () => {} },
    settings: { get: async () => undefined }
  }
</script>`
const server = http.createServer((req, res) => {
  const p = req.url === '/' ? '/index.html' : req.url.split('?')[0]
  try {
    let body = readFileSync(join(pluginDir, 'panel', p))
    if (p === '/index.html') body = body.toString().replace('<script type="module"', stub + '<script type="module"')
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end()
  }
})
await new Promise((r) => server.listen(0, r))
const url = `http://127.0.0.1:${server.address().port}/`

// ------------------------------------------------------------------ drive it
const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && errors.push(m.text()))
await page.exposeFunction('__req', async (n, p) => {
  if (process.env.TRACE) console.log('req', n, JSON.stringify(p).slice(0, 120))
  try {
    return await handlers[n](p, { panel: { id: 'git' } })
  } catch (e) {
    return { __error: e.message }
  }
})
const shot = (name) => page.screenshot({ path: join(process.env.SHOTS ?? tmpdir(), `${name}.png`) })
const step = (s) => console.log('ok -', s)

process.on('unhandledRejection', async (e) => {
  console.log('FAIL', e.message.split('\n')[0], '\nerrors:', errors)
  await shot('e2e-fail').catch(() => {})
  process.exit(1)
})
try { await page.goto(url) } catch (e) { console.log(e) }
await page.waitForSelector('#banner:not(.hidden)', { timeout: 8000 })

if (scenario === 'changes') {
  // C1 + I1: resolve only the conflict, edit an unchanged block that ends in a blank line, Apply.
  await page.click('[data-banner="resolve"]')
  await page.click('.cf-row:has-text("cart.js")')
  await page.click('[data-cf="merge"]')
  await page.waitForSelector('#mergeView:not(.hidden) .m-row')
  await page.locator('.m-row.k-conflict [data-take="ours"]').click()
  await page.locator('.m-row.k-conflict [data-ign="theirs"]').click()
  // The unchanged block "}\n\n" before "function n": edit its closing brace.
  await page.$$eval('.m-row.eq .m-res', (els) => els.find((e) => /^\}\n\n?$/.test(e.textContent))?.setAttribute('data-target', '1'))
  const eq = page.locator('[data-target="1"]')
  await eq.click({ position: { x: 4, y: 4 } })
  await page.keyboard.press('End')
  await page.keyboard.type(' // end')
  await page.click('[data-m="apply"]')
  await page.waitForSelector('#modal:not(.hidden)', { timeout: 3000 }).catch(() => {})
  const asked = await page.isVisible('#modal:not(.hidden)')
  assert.equal(asked, true, 'Apply must ask about the one-sided changes that were not taken')
  assert.match(await page.textContent('#modal'), /change/)
  await page.click('#modal button[type=submit]')
  await page.waitForSelector('#mergeView.hidden', { state: 'attached' })
  const merged = readFileSync(join(dir, 'src/cart.js'), 'utf8')
  assert.match(merged, /const FREE = 50/, 'the default keeps changes made on one side')
  assert.match(merged, /^\/\/ cart, main$/m)
  assert.match(merged, /\} \/\/ end\n\nfunction n\(list\)/, 'the blank line after the edited brace survives')
  step('Apply asked about untaken changes, kept them, and kept the blank line after an edit')
  assert.deepEqual(errors, [])
  step('no page errors')
  process.exit(0)
}
if (scenario === 'rebase2') {
  // I3: continuing into the next conflict is not an error.
  await page.click('[data-banner="resolve"]')
  await page.waitForSelector('.dialog.conflicts')
  await page.click('.cf-row:has-text("cart.js")')
  await page.click('[data-cf="ours"]')
  await page.click('.cf-row:has-text("notes.txt")')
  await page.click('[data-cf="theirs"]')
  await page.waitForSelector('[data-cf="finish:continue"]')
  await page.click('[data-cf="finish:continue"]')
  await page.waitForFunction(() => /Rebase in progress with 1 conflict/.test(document.querySelector('#banner').textContent), null, { timeout: 8000 })
  const toasts = await page.$$eval('#toasts .toast', (t) => t.map((x) => x.className + ' ' + x.textContent))
  assert.ok(!toasts.some((t) => /error/.test(t)), 'no error toast: ' + toasts.join(' | '))
  assert.ok(toasts.some((t) => /next conflict/i.test(t)), 'says it stopped at the next conflict: ' + toasts.join(' | '))
  await page.waitForSelector('.dialog.conflicts .cf-row')
  step('Continue into the next conflict reports it plainly and reopens the dialog')
  process.exit(0)
}
if (scenario === 'squash') {
  // I2: conflicts with no operation are not assumed to be a stash.
  await page.click('[data-banner="resolve"]')
  await page.waitForSelector('.dialog.conflicts')
  assert.doesNotMatch(await page.textContent('.cf-sides'), /Stash/)
  await page.click('.cf-row >> nth=0')
  await page.click('.cf-row >> nth=1', { modifiers: ['Shift'] })
  await page.click('[data-cf="ours"]')
  await page.waitForTimeout(1500)
  assert.equal(await page.isVisible('[data-banner="dropStash"]'), false, 'no Drop stash after a squash merge')
  step('squash conflicts are not labelled or treated as a stash')
  process.exit(0)
}
if (scenario === 'rebase') {
  assert.match(await page.textContent('#banner'), /Rebase in progress with 2 conflicts/)
  await page.click('[data-banner="resolve"]')
  await page.waitForSelector('.dialog.conflicts')
  const sides = await page.textContent('.cf-sides')
  assert.match(sides, /Upstream: main/)
  assert.match(sides, /Your commit: [0-9a-f]+ feature/)
  step('rebase labels name upstream and your commit')
  await page.click('.cf-row >> nth=0')
  await page.click('.cf-row >> nth=1', { modifiers: ['Shift'] })
  await page.click('[data-cf="theirs"]')
  await page.waitForSelector('[data-cf="finish:continue"]')
  await shot('e2e-rebase-done')
  await page.click('[data-cf="finish:continue"]')
  await page.waitForFunction(() => document.querySelector('#banner').classList.contains('hidden'), null, { timeout: 8000 }).catch(async () => {
    console.log('status now:', JSON.stringify(await page.evaluate(() => window.__req('git.status', { repo: document.querySelector('.switcher-btn .proj') && null }))))
    console.log('FAIL continue; toasts:', await page.textContent('#toasts'), '\nbanner:', await page.textContent('#banner'), '\n', git('status'))
    await shot('e2e-fail')
    process.exit(1)
  })
  assert.equal(git('status', '--porcelain'), '')
  assert.equal(git('log', '-1', '--format=%s').trim(), 'feature')
  assert.match(git('log', '--format=%s'), /feature\nmain\nbase/)
  step('shift-select + Accept Theirs, then Continue finished the rebase')
  assert.deepEqual(errors, [])
  step('no page errors')
  await browser.close()
  server.close()
  process.exit(0)
}
step('banner shows the merge')
assert.match(await page.textContent('#banner'), /Merge in progress with 2 conflicts/)

// Resolve conflicts… opens the dialog with both files and the side names.
await page.click('[data-banner="resolve"]')
await page.waitForSelector('.dialog.conflicts')
assert.match(await page.textContent('.cf-sides'), /Yours\s*main.*Theirs\s*feature/s)
assert.equal(await page.locator('.cf-row').count(), 2)
step('dialog lists conflicted files and side names')
await shot('e2e-dialog')

// Accept Theirs for notes.txt (select it, click Accept Theirs).
await page.click('.cf-row:has-text("notes.txt")')
await page.click('[data-cf="theirs"]')
await page.waitForFunction(() => document.querySelectorAll('.cf-row').length === 1)
assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'feature\n')
step('Accept Theirs resolved notes.txt and the dialog updated')

// Merge… the remaining file.
await page.click('[data-cf="merge"]')
await page.waitForSelector('#mergeView:not(.hidden) .m-row')
assert.equal(await page.isVisible('#conflictsModal'), false)
assert.match(await page.textContent('.m-count'), /1 conflict left · 2 changes/)
step('merge view opened with 1 conflict and 2 one-sided changes')
await shot('e2e-merge')

// Escape on a touched view asks first; keep it.
await page.click('[data-m="nonConflicting"]')
assert.match(await page.textContent('.m-count'), /1 conflict left$/)
await page.keyboard.press('Escape')
await page.waitForSelector('#modal:not(.hidden)')
await page.click('#modal .cancel')
assert.equal(await page.isVisible('#mergeView'), true)
step('Apply non-conflicting took both one-sided changes; Escape asked before discarding')

// Conflict: take yours, then theirs (both, in that order).
const conflict = page.locator('.m-row.k-conflict')
await conflict.locator('[data-take="ours"]').click()
await page.locator('.m-row.k-conflict [data-take="theirs"]').click()
assert.match(await page.textContent('.m-count'), /No conflicts left/)
const res = (await page.locator('.m-row.k-conflict .m-res').innerText()).replace(/\n$/, '')
assert.equal(res, "  return { W: 0.1 }[code] ?? 0\n  if (code === 'W') return 0.1\n  if (code === 'S') return 0.15\n  return 0")
step('taking both sides appends theirs after yours')

// Edit the result by hand: replace the combined chunk.
const cell = page.locator('.m-row.k-conflict .m-res')
await cell.click()
await page.keyboard.press('Control+A')
await page.keyboard.type("  return { W: 0.1, S: 0.15 }[code] ?? 0")
await shot('e2e-edited')

// A background refresh must not touch the open view.
await page.evaluate(() => { document.querySelector('[data-act="refresh"]').click(); window.dispatchEvent(new Event('focus')) })
await page.waitForTimeout(500)
assert.match(await cell.innerText(), /S: 0.15/)
step('refresh left the merge view alone')

await page.click('[data-m="apply"]')
await page.waitForSelector('#mergeView.hidden', { state: 'attached' })
const merged = readFileSync(join(dir, 'src/cart.js'), 'utf8')
assert.equal(
  merged,
  ['// cart, main', 'const A = 1', 'const FREE = 50', '', 'function d(code) {', '  return { W: 0.1, S: 0.15 }[code] ?? 0', '}', '', 'function n(items) {', '  return items.length', '}', ''].join('\n')
)
assert.equal(git('diff', '--name-only', '--diff-filter=U'), '')
step('Apply wrote and staged the result')

// Dialog came back with the finish step; commit the merge.
await page.waitForSelector('[data-cf="finish:commitMerge"]')
await shot('e2e-done')
await page.click('[data-cf="finish:commitMerge"]')
await page.waitForFunction(() => document.querySelector('#banner').classList.contains('hidden'), null, { timeout: 5000 })
assert.match(git('log', '-1', '--format=%P'), / /)
step('Commit merge created a merge commit and the banner went away')

assert.deepEqual(errors, [])
step('no page errors')
await browser.close()
server.close()
process.exit(0)
