import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pluginKeyFor, orcaCli } from '../worker/reveal.mjs'

const hash = 'ffc727cf49f2b0a869e1f37c4e603cac049565589278923349ed6572c174c034'

test('pluginKeyFor reads the key of an installed copy from its folder', () => {
  assert.equal(pluginKeyFor(`C:\\Users\\me\\AppData\\Roaming\\orca\\plugins\\serhii-f8.git-toolbox\\${hash}`, 'git-toolbox'), 'serhii-f8.git-toolbox')
  assert.equal(pluginKeyFor(`/home/me/.config/orca/plugins/serhii-f8.git-toolbox/${hash}/`, 'git-toolbox'), 'serhii-f8.git-toolbox')
})

test('pluginKeyFor treats any other folder as a development copy', () => {
  assert.equal(pluginKeyFor('\\\\wsl.localhost\\Ubuntu\\var\\www\\orca-GitToolBox', 'git-toolbox'), 'local.git-toolbox')
  assert.equal(pluginKeyFor(`/tmp/someone.else/${hash}`, 'git-toolbox'), 'local.git-toolbox')
  assert.equal(pluginKeyFor('/srv/plugins/a.git-toolbox/not-a-hash', 'git-toolbox'), 'local.git-toolbox')
})

test('orcaCli finds the CLI next to the app and never falls back to PATH', () => {
  const has = (set: string[]) => (f: string) => set.includes(f)
  assert.equal(orcaCli('C:\\Orca\\resources', 'win32', has(['C:\\Orca\\resources\\bin\\orca.exe'])), 'C:\\Orca\\resources\\bin\\orca.exe')
  assert.equal(orcaCli('/opt/Orca/resources', 'linux', has(['/opt/Orca/resources/bin/orca'])), '/opt/Orca/resources/bin/orca')
  assert.equal(orcaCli('/opt/Orca/resources', 'linux', has([])), null)
  assert.equal(orcaCli(undefined, 'linux', has(['/bin/orca'])), null)
})
