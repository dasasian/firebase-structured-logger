/**
 * `enableNavigation()` (#27) — `@dasasian/firebase-structured-logger/client/navigation`.
 *
 * Covers the id rule, the labels it attaches (`route`, `path`, `routeSource`), what
 * never leaves the browser (the query string, non-route fragments), `cleanPath` and
 * `path: false`, the `history.pushState`/`replaceState`/`popstate` wiring (wrap once,
 * leave a foreign wrapper alone whichever side it installs on, return the original's
 * result, run with the original `this`), and that none of this reaches the core
 * `/client` bundle.
 *
 * Tests run in one process and share module state on purpose — `history.pushState`
 * is wrapped once for the file, the way it would be once for a real session — so
 * ordering matters: the "off by default" and "a foreign wrapper installed before
 * ours" checks run before the first `enableNavigation()` call.
 *
 * Run: npx tsx tests/navigation.ts
 */

import '../tests/browserStubs.js'
import * as path from 'path'
import { build } from 'esbuild'
import { assert, reportResults } from './testHelpers.js'
import { routePattern, enableNavigation } from '../src/client/navigation.js'
import { getCurrentRoute, getLastBreadcrumbs } from '../src/client/breadcrumbs.js'
import { initLogger } from '../src/client/logger.js'
import type { LogPayload } from '../src/shared/types.js'

const FSL_WRAPPED = Symbol.for('fsl.wrappedHistoryMethod')

function lastBreadcrumb() {
  const all = getLastBreadcrumbs(1000)
  return all[all.length - 1]
}

function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// --- The id rule ---

function testIdRule() {
  console.log('\nTest: routePattern — the id rule, a table')
  const cases: [string, string][] = [
    ['/orders/1042', '/orders/:id'],
    ['/users/f47ac10b-58cc-4372-a567-0e02b2c3d479', '/users/:id'],
    ['/files/9f86d081884c7d659a2feaa0c55ad015', '/files/:id'],
    ['/runs/01ARZ3NDEKTSV4RRFFQ69G5FAV', '/runs/:id'],
    ['/blog/my-post', '/blog/my-post'],
    ['/api/v2', '/api/v2'],
    ['/promo/ab12', '/promo/ab12'],
    ['/orders/1042/items', '/orders/:id/items'],
  ]
  for (const [input, expected] of cases) {
    const got = routePattern(input)
    assert(`${input} -> ${expected}`, got === expected, `got: ${got}`)
  }
}

// --- Off unless called ---

function testOffByDefault() {
  console.log('\nTest: with initLogger alone, history.pushState is unwrapped')
  initLogger({ appId: 'nav-test', releaseId: 'r1', logFunction: async () => {} })
  assert(
    'pushState carries no fsl wrapper',
    (history.pushState as unknown as Record<symbol, boolean>)[FSL_WRAPPED] === undefined,
  )
}

// --- Wiring: wrap once, foreign wrappers on either side, this/return ---

let foreignBeforeCalls = 0
let foreignBeforeThis: unknown
let foreignAfterCalls = 0

function installForeignWrapperBeforeOurs() {
  const native = history.pushState
  history.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
    foreignBeforeCalls++
    foreignBeforeThis = this
    return native.apply(this, args)
  }
}

function installForeignWrapperAfterOurs() {
  const current = history.pushState
  history.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
    foreignAfterCalls++
    return current.apply(this, args)
  }
}

function testFirstEnableWrapsAndWrapsAroundAForeignWrapper() {
  console.log('\nTest: enableNavigation wraps once, around a wrapper already installed, and records the first page')
  installForeignWrapperBeforeOurs()

  enableNavigation()
  assert('the first page was recorded at once', getCurrentRoute() !== undefined)

  installForeignWrapperAfterOurs()

  const before = getLastBreadcrumbs(1000).length
  const ret = history.pushState({}, '', '/orders/1042')

  assert('the foreign wrapper installed before ours still ran', foreignBeforeCalls === 1, String(foreignBeforeCalls))
  assert('it ran with the original this', foreignBeforeThis === history)
  assert('the foreign wrapper installed after ours still ran', foreignAfterCalls === 1, String(foreignAfterCalls))
  assert('the wrapped pushState returns what the original returns', ret === undefined, String(ret))

  const after = getLastBreadcrumbs(1000).length
  assert('exactly one nav breadcrumb was added', after === before + 1, `got ${after - before}`)

  const nav = getCurrentRoute()
  assert('route is the id-rule pattern', nav?.route === '/orders/:id', JSON.stringify(nav))
  assert('path is the real path', nav?.path === '/orders/1042', JSON.stringify(nav))
  assert('routeSource is pattern', nav?.routeSource === 'pattern', JSON.stringify(nav))
}

function testReplaceStateAddsABreadcrumb() {
  console.log('\nTest: replaceState adds one nav breadcrumb with the real path')
  const before = getLastBreadcrumbs(1000).length
  history.replaceState({}, '', '/orders/2099')
  const after = getLastBreadcrumbs(1000).length
  assert('one breadcrumb was added', after === before + 1, `got ${after - before}`)
  assert('its name is the real path', lastBreadcrumb().name === '/orders/2099', lastBreadcrumb().name)
  assert('route reflects the new page', getCurrentRoute()?.route === '/orders/:id')
}

async function testPopstateAddsABreadcrumb() {
  console.log('\nTest: back/forward (popstate) adds one nav breadcrumb with the real path')
  history.pushState({}, '', '/page-a')
  history.pushState({}, '', '/page-b')
  const before = getLastBreadcrumbs(1000).length

  history.back()
  await tick(50)

  const after = getLastBreadcrumbs(1000).length
  assert('one breadcrumb was added for the back navigation', after === before + 1, `got ${after - before}`)
  assert('the path reflects the previous page', getCurrentRoute()?.path === '/page-a', JSON.stringify(getCurrentRoute()))

  history.forward()
  await tick(50)
  assert('forward is tracked too', getCurrentRoute()?.path === '/page-b', JSON.stringify(getCurrentRoute()))
}

function testSecondEnableReplacesOptionsWithoutRewrapping() {
  console.log('\nTest: calling enableNavigation twice wraps once, and the second call replaces options')
  const before = getLastBreadcrumbs(1000).length
  enableNavigation({ routeFor: (p) => (p === '/special' ? 'Special' : undefined) })
  assert('no breadcrumb is added merely by calling enableNavigation again', getLastBreadcrumbs(1000).length === before)

  history.pushState({}, '', '/special')
  assert('the new options take effect', getCurrentRoute()?.route === 'Special', JSON.stringify(getCurrentRoute()))
  assert('routeSource is router', getCurrentRoute()?.routeSource === 'router')

  const beforeSecondPush = getLastBreadcrumbs(1000).length
  history.pushState({}, '', '/orders/77')
  const afterSecondPush = getLastBreadcrumbs(1000).length
  assert(
    'exactly one breadcrumb per pushState call — not double-wrapped',
    afterSecondPush === beforeSecondPush + 1,
    `got ${afterSecondPush - beforeSecondPush}`,
  )
}

// --- routeFor, the id-rule fallback, and routeSource ---

function testRouteForFallsBackToIdRuleWhenUndefined() {
  console.log('\nTest: routeFor returning undefined falls back to the id rule')
  enableNavigation({ routeFor: (p) => (p === '/orders/1042/items' ? 'OrderItems' : undefined) })

  history.pushState({}, '', '/orders/1042/items')
  assert('routeSource is router when routeFor names it', getCurrentRoute()?.route === 'OrderItems')
  assert('routeSource says so', getCurrentRoute()?.routeSource === 'router')

  history.pushState({}, '', '/unmatched/1042')
  assert('the id rule is used when routeFor returns undefined', getCurrentRoute()?.route === '/unmatched/:id')
  assert('routeSource is pattern', getCurrentRoute()?.routeSource === 'pattern')
}

// --- Query and fragments never leave the browser ---

function testQueryAndFragmentAreStripped() {
  console.log('\nTest: the query string and a non-route fragment are stripped from path, route, and breadcrumbs')
  enableNavigation({})
  history.pushState({}, '', '/orders/1042/items?token=x#frag')

  const nav = getCurrentRoute()
  assert('route has no query or fragment', nav?.route === '/orders/:id/items', JSON.stringify(nav))
  assert('path has no query or fragment', nav?.path === '/orders/1042/items', JSON.stringify(nav))
  assert('routeSource is pattern', nav?.routeSource === 'pattern')

  const crumb = lastBreadcrumb()
  const serialized = JSON.stringify(crumb)
  assert('the breadcrumb carries no query', !serialized.includes('token'), serialized)
  assert('the breadcrumb carries no fragment', !serialized.includes('frag'), serialized)
}

function testHashRouting() {
  console.log('\nTest: #/... is read as the path; other fragments are dropped')
  enableNavigation({})

  history.pushState({}, '', '/base-page')
  history.pushState({}, '', '#/orders/1042')
  assert('a #/ fragment is read as the path', getCurrentRoute()?.path === '/orders/1042', JSON.stringify(getCurrentRoute()))
  assert('and matched against the id rule', getCurrentRoute()?.route === '/orders/:id')

  history.pushState({}, '', '#section-3')
  assert(
    'a non-route fragment is dropped — the pathname is used instead',
    getCurrentRoute()?.path === '/base-page',
    JSON.stringify(getCurrentRoute()),
  )

  history.pushState({}, '', '#access_token=abc')
  const serialized = JSON.stringify(getCurrentRoute())
  assert('an auth-shaped fragment is dropped too', !serialized.includes('access_token'), serialized)
}

// --- cleanPath and path: false ---

function testCleanPath() {
  console.log('\nTest: cleanPath runs before the path is stored and before routeFor/the id rule sees it')
  enableNavigation({ cleanPath: (p) => p.replace(/[^/]+@[^/]+/g, ':email') })

  history.pushState({}, '', '/users/jane@example.com/profile')
  const nav = getCurrentRoute()
  assert('the cleaned path is stored', nav?.path === '/users/:email/profile', JSON.stringify(nav))
  assert('the id rule runs on the cleaned path', nav?.route === '/users/:email/profile', JSON.stringify(nav))

  const serialized = JSON.stringify(lastBreadcrumb())
  assert('the raw email never reaches the breadcrumb', !serialized.includes('jane@example.com'), serialized)
}

function testPathFalse() {
  console.log('\nTest: path: false omits path everywhere, including breadcrumbs')
  enableNavigation({ path: false })

  const before = getLastBreadcrumbs(1000).length
  history.pushState({}, '', '/orders/99')
  const nav = getCurrentRoute()
  assert('path is omitted from the labels', nav?.path === undefined, JSON.stringify(nav))
  assert('route is still set', nav?.route === '/orders/:id', JSON.stringify(nav))

  const after = getLastBreadcrumbs(1000).length
  assert('a breadcrumb was still added', after === before + 1)
  const crumb = lastBreadcrumb()
  assert('the breadcrumb falls back to the route, not the path', crumb.name === '/orders/:id', crumb.name)
  const serialized = JSON.stringify(crumb)
  assert('the real path is not in the breadcrumb', !serialized.includes('/orders/99'), serialized)
}

// --- Entry labels end to end, and screen's fallback ---

async function testEntryLabelsAndScreenFallback() {
  console.log('\nTest: an entry carries route/path/routeSource, and screen falls back to route when unset')
  enableNavigation({})

  let sent: LogPayload | undefined
  const logger = initLogger({
    appId: 'nav-test',
    releaseId: 'r1',
    logFunction: async (data) => {
      sent = data
    },
  })

  history.pushState({}, '', '/orders/1042/items?token=x#frag')
  logger.info('navigated')
  await tick()

  assert('route is on the entry', sent?.labels.route === '/orders/:id/items', JSON.stringify(sent?.labels))
  assert('path is on the entry', sent?.labels.path === '/orders/1042/items', JSON.stringify(sent?.labels))
  assert('routeSource is on the entry', sent?.labels.routeSource === 'pattern', JSON.stringify(sent?.labels))
  assert('screen falls back to route when never set', sent?.labels.screen === '/orders/:id/items', JSON.stringify(sent?.labels))
  const serialized = JSON.stringify(sent)
  assert('no query reaches the entry', !serialized.includes('token'), serialized)
  assert('no fragment reaches the entry', !serialized.includes('frag'), serialized)

  logger.setScreen('Checkout')
  history.pushState({}, '', '/dashboard')
  logger.info('navigated again')
  await tick()

  assert("the app's own screen is kept, not overridden by route", sent?.labels.screen === 'Checkout', JSON.stringify(sent?.labels))
  assert('route still updates', sent?.labels.route === '/dashboard', JSON.stringify(sent?.labels))
}

// --- Not in the core bundle ---

async function testNavigationCodeIsNotInTheCoreBundle() {
  console.log('\nTest: an esbuild bundle of src/client/index.ts contains none of the navigation code')
  const result = await build({
    stdin: {
      contents: "export * from './src/client/index'",
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
  assert('the id rule is absent', !code.includes('routePattern'), 'found routePattern in the core bundle')
  assert('the pushState wrapper is absent', !code.includes('pushState'), 'found pushState in the core bundle')
  assert('the history wrapper marker is absent', !code.includes('fsl.wrappedHistoryMethod'), 'found the wrapper symbol in the core bundle')
}

async function run() {
  testIdRule()
  testOffByDefault()
  testFirstEnableWrapsAndWrapsAroundAForeignWrapper()
  testReplaceStateAddsABreadcrumb()
  await testPopstateAddsABreadcrumb()
  testSecondEnableReplacesOptionsWithoutRewrapping()
  testRouteForFallsBackToIdRuleWhenUndefined()
  testQueryAndFragmentAreStripped()
  testHashRouting()
  testCleanPath()
  testPathFalse()
  await testEntryLabelsAndScreenFallback()
  await testNavigationCodeIsNotInTheCoreBundle()
  reportResults()
}

run()
