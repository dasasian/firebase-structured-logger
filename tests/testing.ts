/**
 * `/testing` — `captureEntries()` and `resetSession()` (#64).
 *
 * The POUR5 routing shape from the README ("Testing what your app logs"): a real data
 * router, the React Router adapter, and a probe log, with `findLast` reading back the
 * entry that actually shipped. Deliberately NO `tests/browserStubs.js` import and no
 * jsdom anywhere in this file — `/testing` and the client modules it rests on
 * (`breadcrumbs`, `rateLimiter`, the React Router adapter) must work in plain Node, so
 * importing this file at all is the first half of that claim; every case below is run
 * with no DOM in place to prove the second half.
 *
 * Run: npx tsx tests/testing.ts
 */

import { createMemoryRouter } from 'react-router-7'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { build } from 'esbuild'
import { assert, reportResults } from './testHelpers.js'
import { captureEntries, resetSession } from '../src/testing.js'
import { initLogger } from '../src/client/logger.js'
import { enableReactRouterNavigation } from '../src/client/navigation/react-router.js'
import type { LogPayload } from '../src/shared/types.js'

const routes = [
  { path: '/', handle: { screen: 'Home' } },
  {
    path: 'settings',
    handle: { screen: 'Settings' },
    children: [{ path: 'team', handle: { screen: 'SettingsTeam' } }],
  },
]

function samplePayload(message: string): LogPayload {
  return { message, severity: 'INFO', labels: { appId: 'test' } }
}

async function testRoutingProbeGivesScreenRouteAndOneNavCrumb() {
  console.log('\nTest: a probe through a real router (no DOM) gives screen, route and one nav crumb')
  resetSession()
  const capture = captureEntries()
  const logger = initLogger({ appId: 'test', releaseId: 'r1', logFunction: capture.logFunction })

  const router = createMemoryRouter(routes, { initialEntries: ['/settings/team'] })
  const stop = enableReactRouterNavigation(router)

  await logger.info('probe')

  const entry = capture.entries.findLast((e) => e.message === 'probe')
  assert('the entry was captured', entry !== undefined, JSON.stringify(capture.entries))
  assert('screen is the matched route\'s handle', entry?.labels.screen === 'SettingsTeam', JSON.stringify(entry?.labels))
  assert('route is the joined path', entry?.labels.route === '/settings/team', JSON.stringify(entry?.labels))
  const navCrumbs = (entry?.jsonPayload?.breadcrumbs ?? []).filter((b) => b.type === 'nav')
  assert('exactly one nav breadcrumb', navCrumbs.length === 1, JSON.stringify(navCrumbs))

  stop()
}

async function testSixtyProbesWithResetBetweenAreAllCaptured() {
  console.log('\nTest: 60 probes, resetSession() before each, are all captured — the trail (50) and budget (50) caps never bite')
  const capture = captureEntries()
  const logger = initLogger({ appId: 'test', releaseId: 'r1', logFunction: capture.logFunction })

  for (let i = 0; i < 60; i++) {
    resetSession()
    await logger.info(`probe-${i}`)
  }

  assert('all 60 probes were captured', capture.entries.length === 60, `got ${capture.entries.length}`)
  const missing = Array.from({ length: 60 }, (_, i) => `probe-${i}`).filter(
    (message) => !capture.entries.some((e) => e.message === message),
  )
  assert('none are missing', missing.length === 0, JSON.stringify(missing))
}

/**
 * A plain in-memory Web Storage implementation — not jsdom, not `window`, just the
 * two methods `rateLimiter` calls. The budget is deliberately storage-backed (CLAUDE.md,
 * "Module-scoped state": it has to survive a reload), and plain Node has no Web Storage
 * global at all to back that with — confirmed directly: without this, `sessionStorage`
 * is undefined, `rateLimiter`'s `readState`/`writeState` catch the `ReferenceError` and
 * fall back to a fresh default state on every call, and the budget silently never
 * depletes (the documented "rate limiting degrades, logging continues" fallback) —
 * nothing throws, but nothing is ever dropped either, so this one case needs real
 * persistence across calls to be exercised at all. Scoped to this test only, so the
 * "no DOM" cases around it still run with no browser global of any kind.
 */
class MemoryStorage {
  private readonly store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
}

async function testRateLimiterDroppedEntryIsAbsentNotUndefined() {
  console.log('\nTest: an entry the rate limiter drops is absent from entries — findLast gives undefined, not a stale match')
  const globals = globalThis as Record<string, unknown>
  globals.sessionStorage = new MemoryStorage()
  globals.localStorage = new MemoryStorage()

  try {
    resetSession()
    const capture = captureEntries()
    const logger = initLogger({ appId: 'test', releaseId: 'r1', logFunction: capture.logFunction })

    const realWarn = console.warn
    console.warn = () => {}
    try {
      // Default burstLimit 50, reservedForErrors 10 — INFO (below ERROR) can spend
      // only the 40 logs outside the reserve before every further one is refused.
      for (let i = 0; i < 40; i++) await logger.info(`fill-${i}`)
      await logger.info('over-budget')
    } finally {
      console.warn = realWarn
    }

    assert('only the 40 non-reserved probes were captured', capture.entries.length === 40, `got ${capture.entries.length}`)
    assert(
      'the dropped entry is absent, not present with empty data',
      capture.entries.find((e) => e.message === 'over-budget') === undefined,
    )
    assert(
      'findLast on the dropped message gives undefined',
      capture.entries.findLast((e) => e.message === 'over-budget') === undefined,
    )
  } finally {
    delete globals.sessionStorage
    delete globals.localStorage
  }
}

async function testTwoCapturesAreIndependent() {
  console.log('\nTest: two captureEntries() calls give two independent captures')
  const a = captureEntries()
  const b = captureEntries()

  await a.logFunction(samplePayload('from-a'))
  await b.logFunction(samplePayload('from-b'))

  assert('a holds only its own entry', a.entries.length === 1 && a.entries[0]?.message === 'from-a', JSON.stringify(a.entries))
  assert('b holds only its own entry', b.entries.length === 1 && b.entries[0]?.message === 'from-b', JSON.stringify(b.entries))

  a.clear()
  assert('clearing a empties a', a.entries.length === 0, JSON.stringify(a.entries))
  assert('clearing a does not touch b', b.entries.length === 1, JSON.stringify(b.entries))
}

// --- Not in the core bundle ---

async function testTestingCodeIsNotInAnyClientBundle() {
  console.log('\nTest: /client, /client/navigation* and /client/views contain none of /testing, in source and in the built CJS dist')
  const entries = [
    './src/client/index',
    './src/client/navigation',
    './src/client/navigation/vue-router',
    './src/client/navigation/react-router',
    './src/client/views',
  ]

  for (const entry of entries) {
    const result = await build({
      stdin: {
        contents: `export * from '${entry}'`,
        resolveDir: path.join(process.cwd()),
        loader: 'ts',
      },
      bundle: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      logLevel: 'silent',
    })
    const code = result.outputFiles[0].text
    assert(`${entry}: captureEntries is absent`, !code.includes('captureEntries'), `found captureEntries in ${entry}`)
    assert(`${entry}: resetSession is absent`, !code.includes('resetSession'), `found resetSession in ${entry}`)
  }

  execFileSync('npx', ['tsc'], { cwd: process.cwd(), stdio: 'pipe' })
  const builtEntries: [string, string][] = [
    ['dist/client/index.js', path.join(process.cwd(), 'dist', 'client', 'index.js')],
    ['dist/client/navigation.js', path.join(process.cwd(), 'dist', 'client', 'navigation.js')],
    ['dist/client/navigation/vue-router.js', path.join(process.cwd(), 'dist', 'client', 'navigation', 'vue-router.js')],
    ['dist/client/navigation/react-router.js', path.join(process.cwd(), 'dist', 'client', 'navigation', 'react-router.js')],
    ['dist/client/views.js', path.join(process.cwd(), 'dist', 'client', 'views.js')],
  ]

  for (const [name, entry] of builtEntries) {
    assert(`the build produced ${name}`, fs.existsSync(entry), entry)
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      write: false,
      minify: true,
      logLevel: 'silent',
    })
    const code = result.outputFiles[0].text
    assert(`${name}: captureEntries is absent`, !code.includes('captureEntries'), `found captureEntries in ${name}`)
    assert(`${name}: resetSession is absent`, !code.includes('resetSession'), `found resetSession in ${name}`)
  }
}

/**
 * The core must not import `/testing` — a source check, same shape as
 * `tests/loadsWithoutOptionalPeers.ts`, since the bundle check above only proves
 * there is no import edge reaching the built output, not that no source file in
 * `src/client` ever names the module.
 */
function testNoClientSourceImportsTesting() {
  console.log('\nTest: no file under src/client imports ../testing or ./testing')
  const dir = path.join(process.cwd(), 'src', 'client')
  const files = fs
    .readdirSync(dir, { recursive: true, encoding: 'utf-8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(dir, f))
  assert('there are client source files to check', files.length > 0)

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf-8')
    const hit = src.match(/from\s+['"].*\/testing(\.js)?['"]/)
    assert(`${path.relative(process.cwd(), file)} does not import /testing`, !hit, hit?.[0])
  }
}

async function run() {
  await testRoutingProbeGivesScreenRouteAndOneNavCrumb()
  await testSixtyProbesWithResetBetweenAreAllCaptured()
  await testRateLimiterDroppedEntryIsAbsentNotUndefined()
  await testTwoCapturesAreIndependent()
  await testTestingCodeIsNotInAnyClientBundle()
  testNoClientSourceImportsTesting()
  reportResults()
}

run()
