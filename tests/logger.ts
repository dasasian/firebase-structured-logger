/**
 * Client logger unit tests
 * Run: npx tsx test-logger.ts
 */

import { sessionStorageStub, localStorageStub, withFrozenTime, setVisibility } from './browserStubs.js'
import { initLogger } from '../src/client/logger.js'
import { configureRateLimiter, resetRateLimiter, flushDueSummaries } from '../src/client/rateLimiter.js'
import { setNavigationEnabled, setCurrentRoute, setCurrentScreen, clearBreadcrumbs } from '../src/client/breadcrumbs.js'
import type { LogPayload } from '../src/shared/types.js'
import type { Logger } from '../src/client/logger.js'
import { assert, reportResults } from './testHelpers.js'

function makeLogger(): {
  logger: Logger
  lastPayload: () => LogPayload | undefined
  allPayloads: () => LogPayload[]
} {
  const captured: LogPayload[] = []
  const logger = initLogger({
    appId: 'test-app',
    releaseId: 'test-release',
    logFunction: async (data) => { captured.push(data) },
  })
  return { logger, lastPayload: () => captured[captured.length - 1], allPayloads: () => captured }
}

// --- Tests ---

async function testErrorPayloadStructure() {
  console.log('\nTest: error() puts error at jsonPayload.error, not inside context')
  const { logger, lastPayload } = makeLogger()

  const err = new Error('something broke')
  err.stack = 'Error: something broke\n    at foo (bar.ts:1:1)'

  await logger.error(err, undefined, { screen: 'HomeScreen', operation: 'fetchData' })

  const payload = lastPayload()!
  const jp = payload.jsonPayload!

  assert('jsonPayload.error is set', !!jp.error)
  assert('jsonPayload.error.message matches', jp.error?.message === 'something broke')
  assert('jsonPayload.error.stack matches', jp.error?.stack === err.stack)
  assert('jsonPayload.context is set', !!jp.context)
  assert('jsonPayload.context.screen is preserved', jp.context?.screen === 'HomeScreen')
  assert('jsonPayload.context.error is NOT present (no duplicate)', (jp.context as any)?.error === undefined)
}

async function testErrorWithNoContext() {
  console.log('\nTest: error() with no caller context')
  const { logger, lastPayload } = makeLogger()

  await logger.error(new Error('bare error'))

  const payload = lastPayload()!
  const jp = payload.jsonPayload!

  assert('jsonPayload.error is set', !!jp.error)
  assert('jsonPayload.context is undefined', jp.context === undefined)
}

async function testErrorNameAndCause() {
  console.log('\nTest: error() serialises name and cause')
  const { logger, lastPayload } = makeLogger()

  class DuplicateProductError extends Error {
    constructor(id: string) {
      super(`DUPLICATE_PRODUCT:${id}`)
      this.name = 'DuplicateProductError'
    }
  }

  const err = new DuplicateProductError('abc123')
  err.cause = new Error('upstream failure') as any

  await logger.error(err)

  const jp = lastPayload()!.jsonPayload!

  assert('error.name is DuplicateProductError', jp.error?.name === 'DuplicateProductError')
  assert('error.cause is serialised to string', jp.error?.cause === 'Error: upstream failure')
  assert('error.message correct', jp.error?.message === 'DUPLICATE_PRODUCT:abc123')
}

async function testNonErrorInput() {
  console.log('\nTest: error() wraps non-Error values')
  const { logger, lastPayload } = makeLogger()

  await logger.error('plain string error')

  const jp = lastPayload()!.jsonPayload!

  assert('jsonPayload.error is set', !!jp.error)
  assert('error.message is the string', jp.error?.message === 'plain string error')
}

async function testInfoHasNoError() {
  console.log('\nTest: info() produces no jsonPayload.error')
  const { logger, lastPayload } = makeLogger()

  await logger.info('just a message', undefined, { screen: 'Home' })

  const jp = lastPayload()!.jsonPayload!

  assert('jsonPayload.error is undefined', jp.error === undefined)
  assert('jsonPayload.context is set', !!jp.context)
}


async function testEverySeverityCostsOneUnitOfBudget() {
  console.log('\nTest: every severity costs exactly one unit of session budget')
  const spent = (burstLimit = 50) =>
    burstLimit - JSON.parse(sessionStorageStub.peek('fsl_ratelimit') ?? `{"available":${burstLimit}}`).available

  for (const severity of ['info', 'warning', 'debug', 'error'] as const) {
    configureRateLimiter({ burstLimit: 50, duplicateLimit: 99, storageKey: 'fsl_ratelimit', reservedForErrors: 10 })
    resetRateLimiter()
    const { logger } = makeLogger()
    if (severity === 'error') logger.error(new Error('boom'))
    else logger[severity]('message')
    await new Promise((r) => setTimeout(r, 10))

    // error() used to spend two: recordError() incremented, then recordLog()
    // incremented again inside send(). A limit of 50 was really 25 for errors.
    assert(`${severity}() spends exactly 1`, spent() === 1, `spent ${spent()}`)
  }
}

async function testReserveIsHonouredBySeverity() {
  console.log('\nTest: the reserve case — a WARNING is refused once only the reserve is left, an ERROR still sends')
  configureRateLimiter({ burstLimit: 10, duplicateLimit: 99, storageKey: 'fsl_ratelimit', reservedForErrors: 2 })
  resetRateLimiter()
  const { logger, allPayloads } = makeLogger()

  // Frozen throughout: real elapsed time between calls would refill a sliver
  // of budget (rechargeSecondsPerLog applies continuously), which is enough to tip
  // `available` back over the reserve threshold at this exact boundary.
  const now = 1_700_000_000_000
  withFrozenTime(now, () => {
    for (let i = 0; i < 8; i++) logger.info(`fill ${i}`)
    logger.warning('at the edge of the reserve')
    logger.error(new Error('still goes through'))
  })
  await new Promise((r) => setTimeout(r, 10))

  assert('8 non-reserved units spent, the WARNING refused, the ERROR sent', allPayloads().length === 9, `got ${allPayloads().length}`)
  assert('the reserve-refused entry is missing, not a WARNING', !allPayloads().some((p) => p.message === 'at the edge of the reserve'))
  assert('the error still went through', allPayloads()[8]?.severity === 'ERROR')
}

/**
 * "Done when": 200 copies of one error send 3 full entries and one summary
 * with repeatCount 197, the right repeatOf, firstSeen and lastSeen — driven
 * through the real Logger, not the rate limiter directly.
 */
async function testTwoHundredErrorsThroughTheLoggerSendThreeCopiesAndASummary() {
  console.log('\nTest: 200 logger.error() calls of the same error send 3 full copies and one summary')
  configureRateLimiter({
    burstLimit: 1000,
    duplicateLimit: 3,
    storageKey: 'fsl_ratelimit',
    summaryIntervalMinutes: 60,
  })
  resetRateLimiter()
  localStorageStub.setItem('fsl_pending_summaries', '[]')
  const { logger, allPayloads } = makeLogger()

  const t0 = Date.now()
  for (let i = 0; i < 200; i++) {
    withFrozenTime(t0 + i * 1000, () => {
      logger.error(new Error('cart sync failed'), undefined, undefined, undefined)
    })
  }
  // send() is async (attachment handling awaits even with none); let every
  // microtask queued so far settle before reading what was sent.
  await new Promise((r) => setTimeout(r, 10))

  const fullCopies = allPayloads().filter((p) => p.jsonPayload?.error?.message === 'cart sync failed')
  assert('exactly 3 full copies were sent', fullCopies.length === 3, `got ${fullCopies.length}`)
  assert('each full copy carries a repeatKey label', fullCopies.every((p) => typeof p.labels.repeatKey === 'string'))
  const repeatKey = fullCopies[0]?.labels.repeatKey
  assert('all three share the same repeatKey', fullCopies.every((p) => p.labels.repeatKey === repeatKey))

  // Nothing is due before the hour is up.
  assert('no summary yet, still within the hour', allPayloads().length === 3, `got ${allPayloads().length}`)

  // Force it due, the way a hidden tab would.
  withFrozenTime(t0 + 200_000 + 61 * 60_000, () => {
    setVisibility('hidden')
  })
  await new Promise((r) => setTimeout(r, 10))
  setVisibility('visible')

  const summaries = allPayloads().filter((p) => p.labels.repeatOf !== undefined)
  assert('exactly one summary was sent', summaries.length === 1, `got ${summaries.length}`)
  const summary = summaries[0]!
  assert('repeatCount is 197', summary.labels.repeatCount === '197', `got: ${summary.labels.repeatCount}`)
  // A body besides the message, so Cloud Logging files it as JSON, not textPayload.
  const repeat = (summary.jsonPayload?.context as { repeat?: { count?: number } } | undefined)?.repeat
  assert('the summary has a JSON body with the count', repeat?.count === 197, JSON.stringify(summary.jsonPayload))
  assert('repeatOf matches the full copies’ repeatKey', summary.labels.repeatOf === repeatKey)
  assert('it is a WARNING', summary.severity === 'WARNING')
  assert('it carries no stack', summary.jsonPayload?.error === undefined)
  assert('firstSeen and lastSeen are present', typeof summary.labels.firstSeen === 'string' && typeof summary.labels.lastSeen === 'string')
  assert('errorType is recovered from the signature', summary.labels.errorType === 'Error', `got: ${summary.labels.errorType}`)
  assert('releaseId is recovered — from the time of the errors', summary.labels.releaseId === 'test-release', `got: ${summary.labels.releaseId}`)
  assert('appId is set', summary.labels.appId === 'test-app', `got: ${summary.labels.appId}`)
  assert('the message names the repeat count', summary.message.includes('197') && summary.message.includes('cart sync failed'))
}

/**
 * "Done when" (#60): navigation on with screen A, then the legacy setScreen('B')
 * (ignored while navigation is on, so it changes nothing) — the repeat signature
 * must still key off the same screen the entries are labelled with, or the two
 * calls below would group under two different signatures instead of one.
 */
async function testRepeatSignatureUsesTheSameScreenAsTheLabelWithNavigationOn() {
  console.log('\nTest: with navigation on, the repeat signature groups under the nav screen, not getCurrentScreen() (#60)')
  configureRateLimiter({
    burstLimit: 500,
    duplicateLimit: 1,
    storageKey: 'fsl_ratelimit',
    summaryIntervalMinutes: 60,
  })
  resetRateLimiter()
  localStorageStub.setItem('fsl_pending_summaries', '[]')
  clearBreadcrumbs()
  setNavigationEnabled(true)
  setCurrentRoute({ screen: 'A' })
  setCurrentScreen('B') // legacy call, ignored while navigation is on
  const { logger, allPayloads } = makeLogger()

  try {
    const t0 = Date.now()
    withFrozenTime(t0, () => logger.error(new Error('nav screen mismatch')))
    withFrozenTime(t0 + 1000, () => logger.error(new Error('nav screen mismatch')))
    await new Promise((r) => setTimeout(r, 10))

    const fullCopy = allPayloads().find((p) => p.jsonPayload?.error?.message === 'nav screen mismatch')
    assert('the full copy is labelled with the nav screen', fullCopy?.labels.screen === 'A', JSON.stringify(fullCopy?.labels))

    withFrozenTime(t0 + 1000 + 61 * 60_000, () => setVisibility('hidden'))
    await new Promise((r) => setTimeout(r, 10))
    setVisibility('visible')

    const summary = allPayloads().find((p) => p.labels.repeatOf !== undefined)
    assert('a summary was sent', summary !== undefined)
    assert('the summary groups under the nav screen, A', summary?.labels.screen === 'A', `got: ${summary?.labels.screen}`)
  } finally {
    setNavigationEnabled(false)
    clearBreadcrumbs()
  }
}

/**
 * A summary is queued in localStorage so it survives the tab closing — the
 * exact case where the send that follows can plausibly fail (offline, or the
 * tab tearing down right after `visibilitychange: hidden`). A summary may
 * only leave the queue once its `logFunction` call has actually resolved;
 * otherwise the "next visit sends them" promise in the README is false.
 */
async function testFailedSummarySendKeepsItQueued() {
  console.log('\nTest: a summary stays queued until its send succeeds, and is not sent twice')
  configureRateLimiter({ burstLimit: 500, duplicateLimit: 1, storageKey: 'fsl_ratelimit', summaryIntervalMinutes: 60 })
  resetRateLimiter()
  localStorageStub.setItem('fsl_pending_summaries', '[]')

  let failNextSummary = true
  const summariesSent: LogPayload[] = []
  const logger = initLogger({
    appId: 'test-app',
    releaseId: 'test-release',
    logFunction: async (data) => {
      if (data.labels.repeatOf !== undefined) {
        if (failNextSummary) {
          failNextSummary = false
          throw new Error('offline')
        }
        summariesSent.push(data)
      }
    },
  })

  // Only microtask waits below, on purpose: `initLogger` also schedules a
  // one-shot flush (a real macrotask, for a previous visit's queue) that
  // would otherwise race an arbitrary retry in here. Waiting on resolved
  // promises settles this test's own async chain without ever handing
  // control to the macrotask queue, so that timer plays no part.
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

  const t0 = Date.now()
  withFrozenTime(t0, () => {
    logger.error(new Error('queued-boom')) // full copy
    logger.error(new Error('queued-boom')) // repeat — same message, same (unset) screen
  })

  // First attempt: force the summary due, and let the (failing) send run.
  withFrozenTime(t0 + 61 * 60_000, () => {
    flushDueSummaries(true)
    logger.sendPendingSummaries()
  })
  await settle()

  const afterFailure = JSON.parse(localStorageStub.peek('fsl_pending_summaries') ?? '[]') as unknown[]
  assert('the summary is still queued after a failed send', afterFailure.length === 1, `got: ${afterFailure.length}`)
  assert('nothing was recorded as sent yet', summariesSent.length === 0, `got: ${summariesSent.length}`)

  // Retry: the next flush must pick up the SAME queued summary, not create a
  // second one, and this time the send succeeds.
  logger.sendPendingSummaries()
  await settle()

  const afterRetry = JSON.parse(localStorageStub.peek('fsl_pending_summaries') ?? '[]') as unknown[]
  assert('the queue is empty once the retry succeeds', afterRetry.length === 0, `got: ${afterRetry.length}`)
  assert('the summary was sent exactly once', summariesSent.length === 1, `got: ${summariesSent.length}`)
}

async function testConcurrentFlushesSendAQueuedSummaryOnce() {
  console.log('\nTest: a flush triggered while a summary send is still pending does not send it again')
  configureRateLimiter({ burstLimit: 500, duplicateLimit: 1, storageKey: 'fsl_ratelimit', summaryIntervalMinutes: 60 })
  resetRateLimiter()
  localStorageStub.setItem('fsl_pending_summaries', '[]')

  const summariesSent: LogPayload[] = []
  let finishSummarySend: () => void = () => {}
  const logger = initLogger({
    appId: 'test-app',
    releaseId: 'test-release',
    logFunction: async (data) => {
      if (data.labels.repeatOf === undefined) return
      summariesSent.push(data)
      await new Promise<void>((resolve) => { finishSummarySend = resolve })
    },
  })

  const t0 = Date.now()
  withFrozenTime(t0, () => {
    logger.error(new Error('slow-boom'))
    logger.error(new Error('slow-boom'))
  })
  withFrozenTime(t0 + 61 * 60_000, () => {
    flushDueSummaries(true)
    logger.sendPendingSummaries()
    logger.sendPendingSummaries()
  })
  await new Promise((r) => setTimeout(r, 0))

  assert('the summary reached logFunction once although two flushes ran', summariesSent.length === 1, `got: ${summariesSent.length}`)
  finishSummarySend()
  await new Promise((r) => setTimeout(r, 0))
}

async function testInitSendsAPreviousVisitsQueuedSummary() {
  console.log('\nTest: initLogger sends a previous visit’s queued summary without waiting for a flush trigger')
  configureRateLimiter({ burstLimit: 500, duplicateLimit: 1, storageKey: 'fsl_ratelimit', summaryIntervalMinutes: 60 })
  resetRateLimiter()
  localStorageStub.setItem('fsl_pending_summaries', '[]')
  const t0 = Date.now()
  withFrozenTime(t0, () => {
    const earlier = makeLogger().logger
    earlier.error(new Error('left-over-boom'))
    earlier.error(new Error('left-over-boom'))
  })
  withFrozenTime(t0 + 61 * 60_000, () => flushDueSummaries(true))

  const { allPayloads } = makeLogger()
  await new Promise((r) => setTimeout(r, 10))

  assert('the left-over summary was sent after init', allPayloads().some((p) => p.labels.repeatOf !== undefined))
}

async function testDroppedLogConsoleMessages() {
  console.log('\nTest: the three console messages a dropped log produces')
  // burstLimit 3, reserve 1/3 -> the last 1 unit is ERROR-only.
  configureRateLimiter({ burstLimit: 3, duplicateLimit: 1, storageKey: 'fsl_ratelimit', reservedForErrors: 1 })
  resetRateLimiter()
  const { logger } = makeLogger()

  const warnings: string[] = []
  const realWarn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    logger.info('fill 1')                       // available 3 -> 2
    logger.warning('fill 2')                     // available 2 -> 1 (now at the reserve line)
    logger.warning('refused at the reserve')     // reserve message; available stays 1
    const sig = new Error('cannot read id')
    logger.error(sig, { screen: 'checkout' } as never) // full copy, spends the reserve -> 0
    logger.error(sig, { screen: 'checkout' } as never) // duplicate message
    logger.info('refused, budget empty')         // session-limit message
    await new Promise((r) => setTimeout(r, 10))
  } finally {
    console.warn = realWarn
  }

  assert(
    'the reserve message appears',
    warnings.some((w) => w.includes('Log limit: only errors can use the reserved logs now')),
    JSON.stringify(warnings),
  )
  assert(
    'the duplicate-counted message appears',
    warnings.some((w) => w.includes('Duplicate counted for the next summary')),
    JSON.stringify(warnings),
  )
  assert(
    'the budget-empty message appears',
    warnings.some((w) => w.includes('Log limit reached — recharging')),
    JSON.stringify(warnings),
  )
}

/**
 * The default floor, read from NODE_ENV. Only the Node half is testable here — the
 * browser half is a bundler fold, and the bug was the `typeof process` guard in front of
 * it (see defaultMinLevel). What this pins: with NODE_ENV=production and no minSeverity,
 * INFO is dropped and WARNING is sent; with it unset, INFO is sent.
 */
async function testDefaultFloorFollowsNodeEnv() {
  console.log('\nTest: the default floor is WARNING under NODE_ENV=production, DEBUG otherwise')
  const previous = process.env.NODE_ENV
  try {
    process.env.NODE_ENV = 'production'
    resetRateLimiter()
    let prod = makeLogger()
    prod.logger.info('routine')
    await new Promise((r) => setTimeout(r, 0))
    assert('production: INFO is dropped by default', prod.lastPayload() === undefined)
    prod.logger.warning('worth hearing')
    await new Promise((r) => setTimeout(r, 0))
    assert('production: WARNING is sent by default', prod.lastPayload()?.severity === 'WARNING')

    delete process.env.NODE_ENV
    resetRateLimiter()
    const dev = makeLogger()
    dev.logger.info('routine')
    await new Promise((r) => setTimeout(r, 0))
    assert('development: INFO is sent by default', dev.lastPayload()?.severity === 'INFO')
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }
}

// --- Runner ---

async function run() {
  await testErrorPayloadStructure()
  await testErrorWithNoContext()
  await testErrorNameAndCause()
  await testNonErrorInput()
  await testInfoHasNoError()
  await testEverySeverityCostsOneUnitOfBudget()
  await testReserveIsHonouredBySeverity()
  await testTwoHundredErrorsThroughTheLoggerSendThreeCopiesAndASummary()
  await testRepeatSignatureUsesTheSameScreenAsTheLabelWithNavigationOn()
  await testFailedSummarySendKeepsItQueued()
  await testConcurrentFlushesSendAQueuedSummaryOnce()
  await testInitSendsAPreviousVisitsQueuedSummary()
  await testDroppedLogConsoleMessages()
  await testDefaultFloorFollowsNodeEnv()

  reportResults()
}

run().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
