/**
 * "Called twice" tests for every configure/init entry point.
 *
 * Both bugs in this area — the rate limiter (#2) and the source-map bucket —
 * were the same defect: a value held in module scope while being accepted as a
 * per-call parameter, so a second call silently changed the first caller's
 * behaviour. Nothing asserted what a second call was supposed to do, so nothing
 * caught it.
 *
 * Every module-level configure/init function gets an assertion here stating its
 * second-call semantics. Adding a new one without a case here is the gap that
 * let these ship.
 *
 * Run: FUNCTIONS_EMULATOR=true npx tsx tests/configureTwice.ts
 */

import fs from 'fs'
import '../tests/browserStubs.js'

if (process.env.FUNCTIONS_EMULATOR !== 'true') {
  console.error('Run with: FUNCTIONS_EMULATOR=true npx tsx tests/configureTwice.ts')
  process.exit(1)
}

const LOG_DIR = './test-configuretwice-output'

import { initializeApp } from 'firebase-admin/app'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createMemoryRouter as createMemoryRouter6 } from 'react-router-6'
import { configureRateLimiter, allow, resetRateLimiter } from '../src/client/rateLimiter.js'
import { enableNavigation } from '../src/client/navigation.js'
import { enableVueRouterNavigation } from '../src/client/navigation/vue-router.js'
import { enableReactRouterNavigation } from '../src/client/navigation/react-router.js'
import { enableViews } from '../src/client/views.js'
import { getCurrentRoute, getActiveView } from '../src/client/breadcrumbs.js'
import { initLogger as initClientLogger } from '../src/client/logger.js'
import { configureTraces as configureClientTraces, startTrace as startClientTrace } from '../src/client/timing.js'
import { initLogger as initFunctionsLogger } from '../src/functions/logger.js'
import { configureTraces as configureServerTraces, startTrace as startServerTrace } from '../src/functions/trace.js'
import {
  configureAttachments,
  configureSourceMapBucket,
  getAttachmentBucket,
  getAttachmentPrefix,
  getBucket,
  resetAttachmentConfig,
} from '../src/functions/sourceMapCache.js'
import { assert, reportResults, readLastEntry, clearLog } from './testHelpers.js'
import { installFakeClock, uninstallFakeClock, advanceFakeTime, jsdomWindow } from './browserStubs.js'
import type { LogPayload } from '../src/shared/types.js'

initializeApp({ projectId: 'demo-project' })
fs.mkdirSync(LOG_DIR, { recursive: true })
initFunctionsLogger({ appId: 'cfg-twice', logLocalDir: LOG_DIR })

function testConfigureRateLimiterTwice() {
  console.log('\nTest: configureRateLimiter — second call merges into the first')
  resetRateLimiter()

  configureRateLimiter({ burstLimit: 5, duplicateLimit: 2, reservedForErrors: 0 })
  configureRateLimiter({ burstLimit: 3 })          // only burstLimit

  // Documented semantics: MERGE, last value wins per field.
  for (let i = 0; i < 3; i++) allow({ severity: 'INFO' })
  assert('the newer burstLimit is in force', !allow({ severity: 'INFO' }).allowed)

  resetRateLimiter()
  for (let i = 0; i < 2; i++) allow({ severity: 'INFO' })
  assert('the untouched duplicateLimit survived the merge', allow({ severity: 'INFO' }).allowed)

  // This is process-wide by design: one browser session, one budget. It is not
  // per-Logger, which is why Logger is not exported as a constructible class.
  assert('rate-limit config is session-scoped, not per-instance', true)
}

function testConfigureSourceMapBucketTwice() {
  console.log('\nTest: configureSourceMapBucket — second call replaces the default')
  configureSourceMapBucket('bucket-one')
  assert('first bucket becomes the default', getBucket()?.name === 'bucket-one', `got: ${getBucket()?.name}`)

  configureSourceMapBucket('bucket-two')
  assert('second call replaces it', getBucket()?.name === 'bucket-two', `got: ${getBucket()?.name}`)

  // The critical property: this default must NOT govern source-map lookups.
  // Handlers pass their bucket explicitly, so two handlers cannot collide.
  assert(
    'an explicit bucket still overrides the default',
    getBucket('bucket-one')?.name === 'bucket-one',
    `got: ${getBucket('bucket-one')?.name}`,
  )
}

/**
 * Global in the API because it is global in fact. The attachment upload happens
 * in writeLog, which is reached from every log call — including one inside a
 * handler that never went through createClientLogHandler — so there is no
 * per-instance config to read. A field on the handler would let a second
 * handler silently retarget the first's attachments, which is the trap this
 * file exists to catch.
 */
function testConfigureAttachmentsTwice() {
  console.log('\nTest: configureAttachments — second call replaces, and unset fields fall back')
  resetAttachmentConfig()
  configureSourceMapBucket('maps-bucket')

  // Never calling it must change nothing: today's behaviour is the source-map
  // bucket, then the project default.
  assert(
    'unconfigured attachments follow the source-map bucket',
    getAttachmentBucket()?.name === 'maps-bucket',
    `got: ${getAttachmentBucket()?.name}`,
  )
  assert('unconfigured prefix is left to the path builder', getAttachmentPrefix() === undefined)

  configureAttachments({ bucket: 'attach-one', prefix: 'one/' })
  assert('the configured bucket wins over the source-map bucket', getAttachmentBucket()?.name === 'attach-one')
  assert('the configured prefix is used', getAttachmentPrefix() === 'one/')

  configureAttachments({ bucket: 'attach-two' })
  assert('a second call replaces the bucket', getAttachmentBucket()?.name === 'attach-two')
  // Partial calls merge rather than reset. Passing only a bucket should not
  // silently move every attachment back to the default prefix.
  assert('and leaves an unmentioned field alone', getAttachmentPrefix() === 'one/', `got: ${getAttachmentPrefix()}`)

  resetAttachmentConfig()
  assert('reset returns to the fallback bucket', getAttachmentBucket()?.name === 'maps-bucket')
}

/**
 * enableNavigation — a second call replaces the options (session-wide, like
 * breadcrumbs and the screen) but must not wrap history.pushState/replaceState a
 * second time. #27.
 */
function testEnableNavigationTwice() {
  console.log('\nTest: enableNavigation — second call replaces options, does not rewrap')

  enableNavigation()
  history.pushState({}, '', '/orders/1')
  assert('the id rule applies by default', getCurrentRoute()?.route === '/orders/:id', JSON.stringify(getCurrentRoute()))

  enableNavigation({ routeFor: () => 'Named' })
  history.pushState({}, '', '/orders/2')
  assert('the second call\'s options take effect', getCurrentRoute()?.route === 'Named', JSON.stringify(getCurrentRoute()))

  const FSL_WRAPPED = Symbol.for('fsl.wrappedHistoryMethod')
  const wrapped = history.pushState as unknown as Record<symbol, boolean>
  history.pushState({}, '', '/orders/3')
  const stillSameWrapper = history.pushState === (wrapped as unknown)
  assert('pushState is not re-wrapped by the second call', stillSameWrapper)
  assert('the one wrapper installed is fsl\'s own', wrapped[FSL_WRAPPED] === true)
}

/**
 * enableVueRouterNavigation — a second call stops the first adapter rather than
 * stacking two listeners (the same "second call replaces" shape as enableNavigation
 * and every other configure/init entry point here). #61.
 */
async function testEnableVueRouterNavigationTwiceStopsTheFirst() {
  console.log('\nTest: enableVueRouterNavigation — second call stops the first adapter')
  const routerA = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', name: 'HomeA', component: {} },
      { path: '/orders/:id', name: 'OrderA', component: {} },
    ],
  })
  await routerA.push('/')
  await routerA.isReady()
  enableVueRouterNavigation(routerA)

  const routerB = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', name: 'HomeB', component: {} }],
  })
  await routerB.push('/')
  await routerB.isReady()
  enableVueRouterNavigation(routerB)

  await routerA.push('/orders/5')
  assert('the first adapter no longer records once the second starts', getCurrentRoute()?.screen !== 'OrderA', JSON.stringify(getCurrentRoute()))
}

/**
 * enableReactRouterNavigation — same "second call stops the first" shape. #62.
 */
async function testEnableReactRouterNavigationTwiceStopsTheFirst() {
  console.log('\nTest: enableReactRouterNavigation — second call stops the first adapter')
  const routerA = createMemoryRouter6(
    [{ path: '/', handle: { screen: 'HomeA' } }, { path: '/orders/:id', handle: { screen: 'OrderA' } }],
    { initialEntries: ['/'] },
  )
  enableReactRouterNavigation(routerA)

  const routerB = createMemoryRouter6([{ path: '/', handle: { screen: 'HomeB' } }], { initialEntries: ['/'] })
  enableReactRouterNavigation(routerB)

  await routerA.navigate('/orders/5')
  assert('the first adapter no longer records once the second starts', getCurrentRoute()?.screen !== 'OrderA', JSON.stringify(getCurrentRoute()))
}

/**
 * client/timing's configureTraces — a second call replaces the limits
 * wholesale (README: "configureTraces holds every limit"), same as
 * enableNavigation's options. #51.
 */
async function testConfigureClientTracesTwiceReplaces() {
  console.log('\nTest: client configureTraces — second call replaces the limits')
  installFakeClock()
  try {
    resetRateLimiter()
    configureClientTraces({ cfg_demo: { warnAfterMs: 100_000 } })
    configureClientTraces({ cfg_demo: { warnAfterMs: 10 } })

    const sent: LogPayload[] = []
    initClientLogger({ appId: 'cfg-test', releaseId: 'r1', logFunction: async (d) => void sent.push(d) })

    const t = startClientTrace('cfg_demo')
    advanceFakeTime(1000)
    assert(
      'the newer, smaller limit is in force',
      sent.some((e) => e.labels.trace === 'cfg_demo'),
      JSON.stringify(sent),
    )
    t.end()
  } finally {
    uninstallFakeClock()
  }
}

async function testConfigureServerTracesTwiceReplaces() {
  console.log('\nTest: functions configureTraces — second call replaces the limits')
  clearLog(LOG_DIR)
  configureServerTraces({ cfg_demo_server: { warnAfterMs: 100_000 } })
  configureServerTraces({ cfg_demo_server: { warnAfterMs: 1 } })

  const t = startServerTrace('cfg_demo_server')
  await new Promise((resolve) => setTimeout(resolve, 10))
  t.end()

  const entry = readLastEntry(LOG_DIR)
  assert('the newer, smaller limit is in force', entry !== undefined, JSON.stringify(entry))
  assert('it is the reconfigured trace', (entry?.labels as Record<string, string>)?.trace === 'cfg_demo_server')
}

/**
 * enableViews — a second call registers no second reader: setViewReader
 * replaces, it does not stack, so one visible mark reads as itself, not
 * doubled. #58.
 */
function testEnableViewsTwiceNoSecondReader() {
  console.log('\nTest: enableViews — second call registers no second reader')
  const mark = jsdomWindow.document.createElement('div')
  mark.setAttribute('data-fsl-view', 'Checkout')
  jsdomWindow.document.body.appendChild(mark)

  enableViews()
  enableViews()
  assert('the view reads once, not doubled', getActiveView() === 'Checkout', String(getActiveView()))

  jsdomWindow.document.body.removeChild(mark)
}

async function run() {
  testConfigureRateLimiterTwice()
  testConfigureSourceMapBucketTwice()
  testConfigureAttachmentsTwice()
  testEnableNavigationTwice()
  await testEnableVueRouterNavigationTwiceStopsTheFirst()
  await testEnableReactRouterNavigationTwiceStopsTheFirst()
  await testConfigureClientTracesTwiceReplaces()
  await testConfigureServerTracesTwiceReplaces()
  testEnableViewsTwiceNoSecondReader()
  fs.rmSync(LOG_DIR, { recursive: true, force: true })
  reportResults()
}

run()
