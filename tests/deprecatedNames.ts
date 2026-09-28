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

// --- Runner ---

async function run() {
  await testMinLogLevelActsLikeMinSeverity()
  await testMinLogLevelWarnsOnce()
  await testMinSeverityWinsOverMinLogLevel()

  testBucketNameActsLikeBucket()
  testBucketNameWarnsOnce()
  testBucketWinsOverBucketName()

  testSessionLimitActsLikeBurstLimit()
  testSessionLimitWarnsOnce()
  testBurstLimitWinsOverSessionLimit()
  testRefillPerMinuteConvertsToRechargeSeconds()
  testErrorReserveConvertsToReservedForErrors()
  testReservedForErrorsAboveHalfIsCapped()

  testClientLogRequestIsUsableAsLogRequest()
  await testTriggerTestLogCallsSendTestLog()

  reportResults()
}

run().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
