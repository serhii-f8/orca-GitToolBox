// Interactive harness: the real Git Toolbox panel served over HTTP, the real worker running in this
// Node process with a stand-in Orca host, pointed at real repositories. Open it in any browser.
// usage: node server.mjs <plugin-dir> <port>
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { TESTBED } from './browser.mjs'

const pluginDir = process.argv[2]
const port = Number(process.argv[3] ?? 4777)
const { default: activate } = await import(join(pluginDir, 'worker/main.mjs'))

const name = basename(TESTBED)
const workspaces = [
  { id: 'w-main', kind: 'worktree', name, path: TESTBED, branch: 'refs/heads/main' },
  { id: 'w-wt', kind: 'worktree', name: `${name}-wt`, path: `${TESTBED}-wt`, branch: 'refs/heads/wt-branch' },
  { id: 'w-nogit', kind: 'folder', name: 'not-a-repo', path: '/', branch: null }
]
let context = { displayName: name, branch: 'main' }
const settings = { autoFetchMinutes: 15, statusRefreshSeconds: 30, notifyBehind: true, pullMode: 'merge', logPageSize: 300 }
const log = []
const note = (kind, data) => { log.push({ t: Date.now(), kind, data }); if (log.length > 500) log.shift() }

const handlers = {}
const commands = {}
const workerEvents = {}
const settingsListeners = []
const sse = new Set()
const send = (type, name, payload) => { for (const res of sse) res.write(`data: ${JSON.stringify({ type, name, payload })}\n\n`) }

await activate({
  panels: {
    handle: (n, f) => (handlers[n] = f),
    post: async (n, p) => { note('post', { n, p }); send('plugin', n, p) }
  },
  commands: { register: (id, f) => (commands[id] = f) },
  events: { on: (n, f) => ((workerEvents[n] ??= []).push(f)) },
  settings: {
    get: async (k) => settings[k],
    onDidChange: (f) => settingsListeners.push(f)
  },
  storage: { get: async () => undefined, set: async () => {} },
  log: (m) => note('log', m),
  host: {
    call: async (m, p) => {
      note('host', { m, p })
      if (m === 'workspace.list') return { workspaces }
      if (m === 'workspace.readContext') return context
      if (m === 'workspace.open') {
        const w = workspaces.find((x) => x.id === p?.id || x.path === p?.path)
        if (w) { context = { displayName: w.name, branch: (w.branch ?? '').replace('refs/heads/', '') }; fireChanged() }
        return {}
      }
      return {}
    }
  }
})

function fireChanged() {
  for (const f of workerEvents['workspace.changed'] ?? []) f({ context })
  send('orca', 'workspace.changed', { context })
}

const storage = {}
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }
const stub = `<script>
  window.__on = {}; window.__orcaOn = {}
  const es = new EventSource('/__events')
  es.onmessage = (e) => { const m = JSON.parse(e.data); const bag = m.type === 'orca' ? window.__orcaOn : window.__on; (bag[m.name] ?? []).forEach((f) => f(m.payload)) }
  const post = (u, b) => fetch(u, { method: 'POST', body: JSON.stringify(b) }).then((r) => r.json())
  window.orca = {
    plugin: {
      request: (n, p) => post('/__req', { n, p }).then((r) => { if (r.error) throw Object.assign(new Error(r.error), { code: r.code ?? 'x' }); return r.result }),
      on: (n, f) => (window.__on[n] ??= []).push(f)
    },
    on: (n, f) => (window.__orcaOn[n] ??= []).push(f),
    storage: { get: (k) => post('/__storage', { k }).then((r) => r.v), set: (k, v) => post('/__storage', { k, v, set: true }) },
    settings: { get: (k) => post('/__setting', { k }).then((r) => r.v) }
  }
</script>`

const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : {})) })
const json = (res, o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }

http.createServer(async (req, res) => {
  const url = req.url.split('?')[0]
  try {
    if (url === '/__events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(':ok\n\n'); sse.add(res); req.on('close', () => sse.delete(res)); return
    }
    if (url === '/__req') {
      const { n, p } = await body(req)
      note('req', { n, p })
      if (!handlers[n]) return json(res, { error: `no handler ${n}` })
      try { return json(res, { result: (await handlers[n](p, { panel: { id: 'git' } })) ?? null }) } catch (e) { note('reqerr', { n, e: e.message }); return json(res, { error: e.message, code: e.code }) }
    }
    if (url === '/__storage') { const b = await body(req); if (b.set) storage[b.k] = b.v; return json(res, { v: storage[b.k] ?? null }) }
    if (url === '/__setting') { const b = await body(req); return json(res, { v: settings[b.k] }) }
    // ---- test controls
    if (url === '/__cmd') { const { id } = await body(req); note('cmd', id); try { await commands[id]?.(); return json(res, { ok: !!commands[id], commands: Object.keys(commands) }) } catch (e) { return json(res, { error: e.message }) } }
    if (url === '/__ctx') { const b = await body(req); context = b.context; fireChanged(); return json(res, { ok: true }) }
    if (url === '/__set') { const b = await body(req); Object.assign(settings, b); for (const f of settingsListeners) f(b); return json(res, { ok: true }) }
    if (url === '/__log') { const since = Number(new URL(req.url, 'http://x').searchParams.get('since') ?? 0); return json(res, log.filter((l) => l.t > since)) }
    const p = url === '/' ? '/index.html' : url
    let b = readFileSync(join(pluginDir, 'panel', p))
    if (p === '/index.html') b = b.toString().replace('<script type="module"', stub + '<script type="module"')
    res.writeHead(200, { 'content-type': types[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(b)
  } catch (e) {
    res.writeHead(404); res.end(String(e.message))
  }
}).listen(port, '0.0.0.0', () => console.log(`harness on http://localhost:${port}/`))
