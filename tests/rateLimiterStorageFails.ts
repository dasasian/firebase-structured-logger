/**
 * Where browser storage fails, the rate limiter keeps its state in memory (#97).
 *
 * Every failing case sends the same error twenty times through `captureEntries()` and expects
 * what a working browser sends: three full copies, seventeen counted, and the count sent as a
 * summary when the tab goes hidden.
 *
 * Run: npx tsx tests/rateLimiterStorageFails.ts
 */

// Must come first — supplies the document the logger listens on, and the storages replaced below.
import { sessionStorageStub, localStorageStub, setVisibility } from './browserStubs.js'

import { initLogger } from '../src/client/logger.js'
import { captureEntries, resetSession } from '../src/testing.js'
import { assert, reportResults } from './testHelpers.js'

const globals = globalThis as Record<string, unknown>
const STATE_KEY = 'fsl_ratelimit'
const SUMMARY_KEY = 'fsl_pending_summaries'

const unavailable = (): never => {
  throw new Error('storage unavailable')
}

const storageThatThrowsEverywhere = { getItem: unavailable, setItem: unavailable, removeItem: unavailable }

const storageWhoseWritesThrow = {
  getItem: () => null,
  setItem: unavailable,
  removeItem: () => undefined,
}

async function sendSameCrashTwentyTimes(): Promise<{ fullCopies: number; summaryCounts: string[] }> {
  resetSession()
  const capture = captureEntries()
  const logger = initLogger({ appId: 'test', releaseId: 'r1', logFunction: capture.logFunction })
  for (let i = 0; i < 20; i++) logger.error(new TypeError('same crash'))
  await capture.settled()
  const fullCopies = capture.entries.filter((e) => e.labels.repeatOf === undefined).length
  setVisibility('hidden')
  await capture.settled()
  setVisibility('visible')
  const summaryCounts = capture.entries.filter((e) => e.labels.repeatOf !== undefined).map((e) => e.labels.repeatCount ?? '')
  return { fullCopies, summaryCounts }
}

function loadRateLimiterAsAFreshPageLoad(): typeof import('../src/client/rateLimiter.js') {
  const modulePath = require.resolve('../src/client/rateLimiter.ts')
  delete require.cache[modulePath]
  return require(modulePath)
}

async function whileSessionStorageIs(replacement: unknown, run: () => Promise<void>) {
  globals.sessionStorage = replacement
  try {
    await run()
  } finally {
    globals.sessionStorage = sessionStorageStub
    resetSession()
  }
}

async function testNoStorageAtAll() {
  console.log('\nTest: with no sessionStorage and no localStorage, twenty of one error send three and count seventeen')
  delete globals.sessionStorage
  delete globals.localStorage
  try {
    const { fullCopies, summaryCounts } = await sendSameCrashTwentyTimes()
    assert('three full copies', fullCopies === 3, `got: ${fullCopies}`)
    assert('one summary counting seventeen', JSON.stringify(summaryCounts) === '["17"]', JSON.stringify(summaryCounts))
  } finally {
    globals.sessionStorage = sessionStorageStub
    globals.localStorage = localStorageStub
    resetSession()
  }
}

async function testSessionStorageThrowsOnEveryCall() {
  console.log('\nTest: sessionStorage that throws on every call gives the same result')
  await whileSessionStorageIs(storageThatThrowsEverywhere, async () => {
    const { fullCopies, summaryCounts } = await sendSameCrashTwentyTimes()
    assert('three full copies', fullCopies === 3, `got: ${fullCopies}`)
    assert('one summary counting seventeen', JSON.stringify(summaryCounts) === '["17"]', JSON.stringify(summaryCounts))
  })
}

async function testReadsWorkAndWritesThrow() {
  console.log('\nTest: a full quota (reads work, writes throw) gives the same result')
  await whileSessionStorageIs(storageWhoseWritesThrow, async () => {
    const { fullCopies, summaryCounts } = await sendSameCrashTwentyTimes()
    assert('three full copies', fullCopies === 3, `got: ${fullCopies}`)
    assert('one summary counting seventeen', JSON.stringify(summaryCounts) === '["17"]', JSON.stringify(summaryCounts))
  })
}

async function testOneStoreFailingDoesNotMoveTheOther() {
  console.log('\nTest: sessionStorage failing leaves the summary queue in localStorage')
  await whileSessionStorageIs(storageThatThrowsEverywhere, async () => {
    resetSession()
    const logger = initLogger({ appId: 'test', releaseId: 'r1', logFunction: () => Promise.reject(new Error('offline')) })
    for (let i = 0; i < 20; i++) logger.error(new TypeError('same crash'))
    setVisibility('hidden')
    setVisibility('visible')
    const queued = JSON.parse(localStorageStub.peek(SUMMARY_KEY) ?? '[]') as { repeatCount: number }[]
    assert('the unsent summary is in localStorage', queued.length === 1 && queued[0].repeatCount === 17, JSON.stringify(queued))
  })
}

async function testWorkingStorageStillHoldsTheState() {
  console.log('\nTest: with working storage the state is in storage, and a fresh module load keeps the count')
  resetSession()
  const capture = captureEntries()
  const logger = initLogger({ appId: 'test', releaseId: 'r1', logFunction: capture.logFunction })
  for (let i = 0; i < 20; i++) logger.error(new TypeError('same crash'))
  await capture.settled()

  const stored = JSON.parse(sessionStorageStub.peek(STATE_KEY) ?? '{}') as { signatures?: Record<string, { count: number; repeatCount?: number }> }
  const signature = Object.values(stored.signatures ?? {})[0]
  assert('sessionStorage holds three copies sent and seventeen counted', signature?.count === 3 && signature?.repeatCount === 17, JSON.stringify(stored))

  const reloaded = loadRateLimiterAsAFreshPageLoad()
  const decision = reloaded.allow({ signature: JSON.stringify(['TypeError', 'same crash', '']), severity: 'ERROR', labels: { releaseId: 'r1' } })
  const after = JSON.parse(sessionStorageStub.peek(STATE_KEY) ?? '{}') as { signatures?: Record<string, { repeatCount?: number }> }
  assert('a module loaded again sees the count and counts the next one', !decision.allowed && Object.values(after.signatures ?? {})[0]?.repeatCount === 18, JSON.stringify(after))
  resetSession()
}

async function testResetSessionStartsCleanAfterAFailure() {
  console.log('\nTest: resetSession() after a failure starts the next run clean')
  await whileSessionStorageIs(storageThatThrowsEverywhere, async () => {
    await sendSameCrashTwentyTimes()
    const second = await sendSameCrashTwentyTimes()
    assert('the second run sends three full copies again', second.fullCopies === 3, `got: ${second.fullCopies}`)
  })
}

async function main() {
  await testNoStorageAtAll()
  await testSessionStorageThrowsOnEveryCall()
  await testReadsWorkAndWritesThrow()
  await testOneStoreFailingDoesNotMoveTheOther()
  await testWorkingStorageStillHoldsTheState()
  await testResetSessionStartsCleanAfterAFailure()
  reportResults()
}

main()
