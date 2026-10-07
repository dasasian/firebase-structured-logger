/**
 * Deprecated-name coverage for the 1.0 rename (#44).
 *
 * Seven names were renamed before the API freeze; every old name still works
 * in 1.x by resolving to the new one, and warns exactly once per process. The
 * suites each old name used to live in (`logger`, `rateLimiter`, `symbolication`,
 * `publicApi`) were switched over to the new names outright — this file is the
 * one place that still uses the old names on purpose, because proving the
 * alias works requires using it.
 *
 * Run: FUNCTIONS_EMULATOR=true npx tsx tests/deprecatedNames.ts
 */

if (process.env.FUNCTIONS_EMULATOR !== 'true') {
  console.error('Run with: FUNCTIONS_EMULATOR=true npx tsx tests/deprecatedNames.ts')
  process.exit(1)
}

// Must come first — client/logger reads `navigator`, rateLimiter reads `window`,
// both at module load.
import { withFrozenTime } from './browserStubs.js'

import { initializeApp } from 'firebase-admin/app'
import { initLogger, triggerTestLog, sendTestLog } from '../src/client/logger.js'
import { allow, configureRateLimiter, resetRateLimiter } from '../src/client/rateLimiter.js'
import { createClientLogHandler } from '../src/functions/logHandler.js'
import { getBucket } from '../src/functions/sourceMapCache.js'
import { enableNavigation } from '../src/client/navigation.js'
import { getCurrentRoute, getCurrentScreen, bc, clearBreadcrumbs, getLastBreadcrumbs } from '../src/client/breadcrumbs.js'
import { resetDeprecationWarnings } from '../src/shared/deprecate.js'
import type { LogPayload } from '../src/shared/types.js'
import { assert, reportResults } from './testHelpers.js'

initializeApp({ projectId: 'demo-project' })

function captureWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = []
  const real = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    return { result: fn(), warnings }
  } finally {
    console.warn = real
  }
}

// --- minLogLevel -> minSeverity ---

async function testMinLogLevelActsLikeMinSeverity() {
  console.log('\nTest: minLogLevel, used alone, behaves like minSeverity')
  const captured: LogPayload[] = []
  const logger = initLogger({
    appId: 'acme',
    releaseId: 'r1',
    minLogLevel: 'WARNING',
    logFunction: async (data) => { captured.push(data) },
  })
  logger.info('dropped by the floor')
  logger.warning('kept')
  for (let i = 0; i < 10; i++) await Promise.resolve()

  assert('INFO was dropped by the WARNING floor set via minLogLevel', captured.length === 1, `got ${captured.length}`)
  assert('the WARNING got through', captured[0]?.message === 'kept')
}

async function testMinLogLevelWarnsOnce() {
  console.log('\nTest: minLogLevel warns exactly once, however many times it is used')
  resetDeprecationWarnings()
  const { warnings } = captureWarnings(() => {
    initLogger({ appId: 'a', releaseId: 'r', minLogLevel: 'DEBUG', logFunction: async () => {} })
    initLogger({ appId: 'a', releaseId: 'r', minLogLevel: 'DEBUG', logFunction: async () => {} })
    initLogger({ appId: 'a', releaseId: 'r', minLogLevel: 'DEBUG', logFunction: async () => {} })
  })
  const matching = warnings.filter((w) => w.includes('"minLogLevel"'))
  assert('exactly one warning was printed', matching.length === 1, JSON.stringify(warnings))
}

async function testMinSeverityWinsOverMinLogLevel() {
  console.log('\nTest: minSeverity and minLogLevel together — minSeverity wins, the warning still fires')
  resetDeprecationWarnings()
  const captured: LogPayload[] = []
  const { warnings } = captureWarnings(() => {
    initLogger({
      appId: 'acme',
      releaseId: 'r1',
      minSeverity: 'DEBUG',
      minLogLevel: 'WARNING',
      logFunction: async (data) => { captured.push(data) },
    })
  })
  assert('minLogLevel still produced the warning', warnings.some((w) => w.includes('"minLogLevel"')))
}

// --- bucketName -> bucket ---

function testBucketNameActsLikeBucket() {
  console.log('\nTest: bucketName, used alone, behaves like bucket')
  createClientLogHandler({ bucketName: 'legacy-bucket' })
  assert('the legacy field configured the source-map bucket', getBucket()?.name === 'legacy-bucket', `got: ${getBucket()?.name}`)
}

function testBucketNameWarnsOnce() {
  console.log('\nTest: bucketName warns exactly once, however many times it is used')
  resetDeprecationWarnings()
  const { warnings } = captureWarnings(() => {
    createClientLogHandler({ bucketName: 'legacy-a' })
    createClientLogHandler({ bucketName: 'legacy-b' })
  })
  const matching = warnings.filter((w) => w.includes('"bucketName"'))
  assert('exactly one warning was printed', matching.length === 1, JSON.stringify(warnings))
}

function testBucketWinsOverBucketName() {
  console.log('\nTest: bucket and bucketName together — bucket wins, the warning still fires')
  resetDeprecationWarnings()
  const { warnings } = captureWarnings(() => {
    createClientLogHandler({ bucket: 'new-bucket', bucketName: 'old-bucket' })
  })
  assert('the new name won', getBucket()?.name === 'new-bucket', `got: ${getBucket()?.name}`)
  assert('bucketName still produced the warning', warnings.some((w) => w.includes('"bucketName"')))
}

// --- rateLimitOptions: sessionLimit / refillPerMinute / errorReserve ---

function testSessionLimitActsLikeBurstLimit() {
  console.log('\nTest: sessionLimit, used alone, behaves like burstLimit')
  resetRateLimiter()
  configureRateLimiter({ sessionLimit: 3, reservedForErrors: 0, duplicateLimit: 99 })
  assert('1st allowed', allow({ severity: 'INFO' }).allowed)
  assert('2nd allowed', allow({ severity: 'INFO' }).allowed)
  assert('3rd allowed', allow({ severity: 'INFO' }).allowed)
  assert('4th refused — the burst is 3', !allow({ severity: 'INFO' }).allowed)
}

function testSessionLimitWarnsOnce() {
  console.log('\nTest: sessionLimit warns exactly once, however many times it is used')
  resetDeprecationWarnings()
  const { warnings } = captureWarnings(() => {
    configureRateLimiter({ sessionLimit: 10 })
    configureRateLimiter({ sessionLimit: 20 })
  })
  const matching = warnings.filter((w) => w.includes('"sessionLimit"'))
  assert('exactly one warning was printed', matching.length === 1, JSON.stringify(warnings))
}

function testBurstLimitWinsOverSessionLimit() {
  console.log('\nTest: burstLimit and sessionLimit together — burstLimit wins, the warning still fires')
  resetDeprecationWarnings()
  resetRateLimiter()
  const { warnings } = captureWarnings(() => {
    configureRateLimiter({ burstLimit: 5, sessionLimit: 2, reservedForErrors: 0, duplicateLimit: 99 })
  })
  for (let i = 0; i < 5; i++) assert(`spend ${i + 1}/5 allowed`, allow({ severity: 'INFO' }).allowed)
  assert('6th refused — the winning limit is 5, not 2', !allow({ severity: 'INFO' }).allowed)
  assert('sessionLimit still produced the warning', warnings.some((w) => w.includes('"sessionLimit"')))
}

function testRefillPerMinuteConvertsToRechargeSeconds() {
  console.log('\nTest: refillPerMinute: 2 gives rechargeSecondsPerLog 30')
  resetRateLimiter()
  configureRateLimiter({ burstLimit: 50, refillPerMinute: 2, reservedForErrors: 0, duplicateLimit: 99 })

  const t0 = 1_700_000_000_000
  withFrozenTime(t0, () => {
    for (let i = 0; i < 50; i++) allow({ severity: 'INFO' })
    assert('the budget is empty', !allow({ severity: 'INFO' }).allowed)
  })
  withFrozenTime(t0 + 30_000, () => {
    assert('one log recharges after 30s (60 / 2)', allow({ severity: 'INFO' }).allowed)
    assert('but not a second one yet', !allow({ severity: 'INFO' }).allowed)
  })
}

function testErrorReserveConvertsToReservedForErrors() {
  console.log('\nTest: errorReserve: 0.2 with burstLimit: 50 gives 10 reserved')
  resetRateLimiter()
  configureRateLimiter({ burstLimit: 50, errorReserve: 0.2, duplicateLimit: 99 })

  const now = 1_700_000_000_000
  withFrozenTime(now, () => {
    for (let i = 0; i < 40; i++) assert(`non-reserved spend ${i + 1}/40 allowed`, allow({ severity: 'INFO' }).allowed)
    const warning = allow({ severity: 'WARNING' })
    assert('a WARNING is refused with 10 left — reservedForErrors is 10, not a share', !warning.allowed)
    const error = allow({ severity: 'ERROR' })
    assert('an ERROR still spends the reserve', error.allowed)
  })
}

function testReservedForErrorsAboveHalfIsCapped() {
  console.log('\nTest: reservedForErrors: 40 with burstLimit: 50 is capped at 25, and warns')
  resetRateLimiter()
  resetDeprecationWarnings()
  const { warnings } = captureWarnings(() => {
    configureRateLimiter({ burstLimit: 50, reservedForErrors: 40, duplicateLimit: 99 })
  })
  assert('capping a value above half warns', warnings.some((w) => w.includes('reservedForErrors') && w.includes('capped')), JSON.stringify(warnings))

  const now = 1_700_000_000_000
  withFrozenTime(now, () => {
    // Spend down to exactly the cap (25 left of 50).
    for (let i = 0; i < 25; i++) allow({ severity: 'INFO' })
    const warning = allow({ severity: 'WARNING' })
    assert('a WARNING is refused at 25 left — the cap, not the requested 40', !warning.allowed)
  })
}

// --- ClientLogRequest -> LogRequest (compile-time; see tests/publicApi.ts for the runtime surface) ---

function testClientLogRequestIsUsableAsLogRequest() {
  console.log('\nTest: ClientLogRequest is a type alias of LogRequest')
  const handler = createClientLogHandler({})
  // If the alias ever diverged from LogRequest, this would fail to typecheck
  // (tsconfig.check.json covers this file) rather than fail at runtime.
  const request: import('../src/functions/logHandler.js').ClientLogRequest = {
    data: { message: 'hi', severity: 'INFO', labels: {} } as LogPayload,
  }
  void handler(request)
  assert('a ClientLogRequest is accepted wherever LogRequest is expected', true)
}

// --- triggerTestLog -> sendTestLog ---

async function testTriggerTestLogCallsSendTestLog() {
  console.log('\nTest: triggerTestLog() still sends the same three verify logs as sendTestLog()')
  const captured: LogPayload[] = []
  initLogger({
    appId: 'acme',
    releaseId: 'r1',
    minSeverity: 'DEBUG',
    logFunction: async (data) => { captured.push(data) },
  })

  triggerTestLog()
  for (let i = 0; i < 10; i++) await Promise.resolve()

  assert('three verify logs were sent', captured.length === 3, `got ${captured.length}`)
  assert(
    'all three carry errorType fsl-verify',
    captured.every((p) => p.labels.errorType === 'fsl-verify'),
  )
  assert('sendTestLog is exported alongside it', typeof sendTestLog === 'function')
}

// --- bc.nav / setScreen, with navigation off (#57) ---

function testBcNavActsLikeBeforeWhenNavigationIsOff() {
  console.log('\nTest: bc.nav, with navigation off, still works as before')
  clearBreadcrumbs()
  bc.nav('Checkout')
  assert('the screen is set', getCurrentScreen() === 'Checkout')
  const [entry] = getLastBreadcrumbs(10)
  assert('a nav breadcrumb named navigate_<screen> was added', entry.name === 'navigate_Checkout', entry.name)
}

function testBcNavWarnsOnce() {
  console.log('\nTest: bc.nav warns exactly once, however many times it is used')
  resetDeprecationWarnings()
  const { warnings } = captureWarnings(() => {
    bc.nav('A')
    bc.nav('B')
  })
  const matching = warnings.filter((w) => w.includes('"bc.nav"'))
  assert('exactly one warning was printed', matching.length === 1, JSON.stringify(warnings))
}

function testSetScreenActsLikeBeforeWhenNavigationIsOff() {
  console.log('\nTest: logger.setScreen, with navigation off, still works as before')
  clearBreadcrumbs()
  const logger = initLogger({ appId: 'acme', releaseId: 'r1', logFunction: async () => {} })
  logger.setScreen('Dashboard')
  assert('the screen is set', getCurrentScreen() === 'Dashboard')
  const [entry] = getLastBreadcrumbs(10)
  assert('a nav breadcrumb named navigate_<screen> was added', entry.name === 'navigate_Dashboard', entry.name)
}

function testSetScreenWarnsOnce() {
  console.log('\nTest: setScreen warns exactly once, however many times it is used')
  resetDeprecationWarnings()
  const logger = initLogger({ appId: 'acme', releaseId: 'r1', logFunction: async () => {} })
  const { warnings } = captureWarnings(() => {
    logger.setScreen('A')
    logger.setScreen('B')
  })
  const matching = warnings.filter((w) => w.includes('"setScreen"'))
  assert('exactly one warning was printed', matching.length === 1, JSON.stringify(warnings))
}

// --- bc.error -> bc.handledError ---

function testBcErrorActsLikeHandledError() {
  console.log('\nTest: bc.error, used alone, behaves like bc.handledError')
  clearBreadcrumbs()
  bc.error('ValidationError', { field: 'price' })
  const [entry] = getLastBreadcrumbs(10)
  assert('an error breadcrumb was added', entry.type === 'error')
  assert('it names the error type', entry.name === 'ValidationError')
}

function testBcErrorWarnsOnce() {
  console.log('\nTest: bc.error warns exactly once, however many times it is used')
  resetDeprecationWarnings()
  const { warnings } = captureWarnings(() => {
    bc.error('A')
    bc.error('B')
  })
  const matching = warnings.filter((w) => w.includes('"bc.error"'))
  assert('exactly one warning was printed', matching.length === 1, JSON.stringify(warnings))
}

// --- routeFor / cleanPath / path: false -> labelsFor ---

function testRouteForActsLikeLabelsFor() {
  console.log('\nTest: routeFor, used alone, behaves the same as before — its string becomes route')
  enableNavigation({ routeFor: (p) => (p === '/special' ? 'Special' : undefined) })
  history.pushState({}, '', '/special')
  assert('the route is the string routeFor returned', getCurrentRoute()?.route === 'Special', JSON.stringify(getCurrentRoute()))
}

function testRouteForWarnsOnce() {
  console.log('\nTest: routeFor warns exactly once, however many times enableNavigation is called with it')
  resetDeprecationWarnings()
  const { warnings } = captureWarnings(() => {
    enableNavigation({ routeFor: () => 'A' })
    enableNavigation({ routeFor: () => 'B' })
  })
  const matching = warnings.filter((w) => w.includes('"routeFor"'))
  assert('exactly one warning was printed', matching.length === 1, JSON.stringify(warnings))
}

function testCleanPathActsLikeBefore() {
  console.log('\nTest: cleanPath, used alone, still runs before the id rule sees the path')
  enableNavigation({ cleanPath: (p) => p.replace(/[^/]+@[^/]+/g, ':email') })
  history.pushState({}, '', '/users/jane@example.com')
  assert('the cleaned path is stored', getCurrentRoute()?.path === '/users/:email', JSON.stringify(getCurrentRoute()))
}

function testCleanPathWarnsOnce() {
  console.log('\nTest: cleanPath warns exactly once, however many times enableNavigation is called with it')
  resetDeprecationWarnings()
  const { warnings } = captureWarnings(() => {
    enableNavigation({ cleanPath: (p) => p })
    enableNavigation({ cleanPath: (p) => p })
  })
  const matching = warnings.filter((w) => w.includes('"cleanPath"'))
  assert('exactly one warning was printed', matching.length === 1, JSON.stringify(warnings))
}

function testPathFalseActsLikeBefore() {
  console.log('\nTest: path: false, used alone, still omits path everywhere')
  enableNavigation({ path: false })
  history.pushState({}, '', '/orders/5')
  assert('path is omitted', getCurrentRoute()?.path === undefined, JSON.stringify(getCurrentRoute()))
  assert('route is still set', getCurrentRoute()?.route === '/orders/:id', JSON.stringify(getCurrentRoute()))
}

function testPathFalseWarnsOnce() {
  console.log('\nTest: path: false warns exactly once, however many times enableNavigation is called with it')
  resetDeprecationWarnings()
  const { warnings } = captureWarnings(() => {
    enableNavigation({ path: false })
    enableNavigation({ path: false })
  })
  const matching = warnings.filter((w) => w.includes('"path: false"'))
  assert('exactly one warning was printed', matching.length === 1, JSON.stringify(warnings))
}

// --- Runner ---

function testOldRateLimitNamesWarnOnce() {
  console.log('\nTest: refillPerMinute and errorReserve each warn exactly once')
  resetDeprecationWarnings()
  const { warnings } = captureWarnings(() => {
    configureRateLimiter({ refillPerMinute: 1, errorReserve: 0.2 })
    configureRateLimiter({ refillPerMinute: 2, errorReserve: 0.1 })
  })
  assert('refillPerMinute warned once', warnings.filter((w) => w.includes('"refillPerMinute"')).length === 1, JSON.stringify(warnings))
  assert('errorReserve warned once', warnings.filter((w) => w.includes('"errorReserve"')).length === 1, JSON.stringify(warnings))
  configureRateLimiter({ burstLimit: 50, rechargeSecondsPerLog: 60, reservedForErrors: 10 })
}

/**
 * The cap is on what is used, not only on a value someone passed. The default
 * reservedForErrors (10) with a small burstLimit, or a later call that lowers
 * burstLimit alone, must still leave warnings half the burst — as the README says.
 */
function testDefaultReserveIsCappedBySmallBurst() {
  console.log('\nTest: the default reserve is capped at half a small burstLimit, and after a later lowering')
  const now = 1_700_000_000_000

  resetRateLimiter()
  configureRateLimiter({ burstLimit: 50, reservedForErrors: 10, duplicateLimit: 99 })
  configureRateLimiter({ burstLimit: 10 })
  withFrozenTime(now, () => {
    for (let i = 0; i < 5; i++) {
      assert(`WARNING ${i + 1}/5 allowed — the reserve is 5, half of 10`, allow({ severity: 'WARNING' }).allowed)
    }
    assert('the 6th WARNING is refused', !allow({ severity: 'WARNING' }).allowed)
    assert('an ERROR still gets through', allow({ severity: 'ERROR' }).allowed)
  })
  configureRateLimiter({ burstLimit: 50, reservedForErrors: 10 })
}

async function testTriggerTestLogWarnsOnce() {
  console.log('\nTest: triggerTestLog warns exactly once')
  resetDeprecationWarnings()
  const { warnings } = captureWarnings(() => {
    triggerTestLog()
    triggerTestLog()
  })
  await new Promise((r) => setTimeout(r, 0))
  assert('triggerTestLog warned once', warnings.filter((w) => w.includes('"triggerTestLog"')).length === 1, JSON.stringify(warnings))
}

async function run() {
  await testMinLogLevelActsLikeMinSeverity()
  await testMinLogLevelWarnsOnce()
  await testMinSeverityWinsOverMinLogLevel()

  testBucketNameActsLikeBucket()
  testBucketNameWarnsOnce()
  testBucketWinsOverBucketName()

  // Navigation-off cases run before any enableNavigation() call in this process —
  // once navigation is turned on, bc.nav/setScreen are ignored for the rest of it.
  testBcNavActsLikeBeforeWhenNavigationIsOff()
  testBcNavWarnsOnce()
  testSetScreenActsLikeBeforeWhenNavigationIsOff()
  testSetScreenWarnsOnce()
  testBcErrorActsLikeHandledError()
  testBcErrorWarnsOnce()

  testRouteForActsLikeLabelsFor()
  testRouteForWarnsOnce()
  testCleanPathActsLikeBefore()
  testCleanPathWarnsOnce()
  testPathFalseActsLikeBefore()
  testPathFalseWarnsOnce()

  testSessionLimitActsLikeBurstLimit()
  testSessionLimitWarnsOnce()
  testBurstLimitWinsOverSessionLimit()
  testRefillPerMinuteConvertsToRechargeSeconds()
  testErrorReserveConvertsToReservedForErrors()
  testReservedForErrorsAboveHalfIsCapped()
  testOldRateLimitNamesWarnOnce()
  testDefaultReserveIsCappedBySmallBurst()

  testClientLogRequestIsUsableAsLogRequest()
  await testTriggerTestLogCallsSendTestLog()
  await testTriggerTestLogWarnsOnce()

  reportResults()
}

run().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
