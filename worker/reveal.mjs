// Bringing the Git panel into view from a palette command. Plugins have no host call for this, so the
// worker runs Orca's own CLI (`orca plugin open <key> --panel git`), which ships next to the app.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The plugin key Orca knows this copy by. An installed plugin lives in `plugins/<key>/<content hash>/`;
 * a development folder loads as `local.<id>`.
 * @param {string} root the plugin folder (where orca-plugin.json is)
 * @param {string} id the manifest id
 */
export function pluginKeyFor(root, id) {
  const parts = root.split(/[\\/]+/).filter(Boolean)
  const [hash, key] = [parts.at(-1) ?? '', parts.at(-2) ?? '']
  if (/^[0-9a-f]{64}$/i.test(hash) && /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/i.test(key) && key.endsWith(`.${id}`)) return key
  return `local.${id}`
}

/**
 * Orca's CLI inside the running app, or null when it cannot be found. Never a bare `orca` from PATH:
 * on Linux that is usually the screen reader.
 * @param {string | undefined} resourcesPath Electron's process.resourcesPath
 * @param {NodeJS.Platform} platform
 */
export function orcaCli(resourcesPath, platform = process.platform, exists = existsSync) {
  if (!resourcesPath) return null
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  const names = platform === 'win32' ? ['orca.exe'] : ['orca', 'orca-ide']
  for (const name of names) {
    const file = join(resourcesPath, 'bin', name)
    if (exists(file)) return file
  }
  return null
}

const workerDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(workerDir)
let key = null

/** @returns {string} */
function ownKey() {
  if (key) return key
  let id = 'git-toolbox'
  try {
    id = JSON.parse(readFileSync(path.join(root, 'orca-plugin.json'), 'utf8')).id || id
  } catch {}
  key = pluginKeyFor(root, id)
  return key
}

/**
 * Opens the plugin's panel in Orca's right sidebar. Resolves to true when Orca says it is shown.
 * @param {string} panel
 */
export function revealPanel(panel) {
  const cli = orcaCli(/** @type {any} */ (process).resourcesPath)
  if (!cli) return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile(cli, ['plugin', 'open', ownKey(), '--panel', panel, '--json'], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(false)
      try {
        resolve(JSON.parse(stdout).ok === true)
      } catch {
        resolve(false)
      }
    })
  })
}
