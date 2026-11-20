// Headless Chrome for the E2E scripts, through playwright-core.
//   PLAYWRIGHT_CORE  path to playwright-core's index.mjs when it is not installed here
//                    (or: npm i --no-save playwright-core)
//   CHROME_PATH      the browser; default /usr/bin/google-chrome when present, else Playwright's own
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export async function launch() {
  const spec = process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : 'playwright-core'
  let mod
  try {
    mod = await import(spec)
  } catch {
    throw new Error('playwright-core not found: run "npm i --no-save playwright-core" or set PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs')
  }
  const { chromium } = mod.default ?? mod
  const executablePath = process.env.CHROME_PATH ?? (existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined)
  return chromium.launch({ executablePath, headless: true })
}

/** Where make-testbed.sh builds the test repository (and its -remote.git and -wt siblings). */
export const TESTBED = process.env.TESTBED ?? `${process.env.TMPDIR ?? '/tmp'}/gtb-testbed`
