/**
 * Rate limiter unit tests.
 *
 * `allow()` is deliberately one operation: it decides AND consumes. The two
 * used to be separate exports (`canLogEvent`/`canLogError` + `recordLog`/
 * `recordError`) called from two different layers, which meant an error was
 * checked against the session limit twice and counted against it twice — a
 * configured limit of 50 was really 25 for errors.
 *
 * Run: npx tsx tests/rateLimiter.ts
 */

// Must come first — rateLimiter reads `window` at module load.
import { sessionStorageStub, listenerCount } from './browserStubs.js'

import {
  allow,
  signatureFor,
  configureRateLimiter,
  resetRateLimiter,
} from '../src/client/rateLimiter.js'
import { assert, reportResults } from './testHelpers.js'

const STORAGE_KEY = 'fsl_ratelimit'

function reset() {
  configureRateLimiter({ sessionLimit: 50, duplicateLimit: 3, storageKey: STORAGE_KEY })
  sessionStorageStub.failing = false
  resetRateLimiter()
}

function storedState(): { logCount: number; errorSignatures: Record<string, number> } | null {
  const raw = sessionStorageStub.peek(STORAGE_KEY)
  return raw ? JSON.parse(raw) : null
}

// --- Session limit ---

function testSessionLimit() {
  console.log('\nTest: session limit')
  reset()
  configureRateLimiter({ sessionLimit: 3 })

  assert('1st is allowed', allow().allowed)
  assert('2nd is allowed', allow().allowed)
  assert('3rd is allowed', allow().allowed)

  const fourth = allow()
  assert('4th is refused', !fourth.allowed)
  assert('and the reason is the session limit', !fourth.allowed && fourth.reason === 'session-limit')
  assert('5th is still refused', !allow().allowed)
}

function testEachAllowCostsExactlyOne() {
  console.log('\nTest: one allowed log costs exactly one unit of budget')
  reset()

  allow()
  assert('a plain log increments once', storedState()?.logCount === 1, `got: ${storedState()?.logCount}`)

  // The regression this file exists for. An error used to be counted twice:
  // once by recordError() and again by recordLog() inside send().
  reset()
  allow(signatureFor(new Error('boom'), 'Home'))
  assert('a signed log also increments once', storedState()?.logCount === 1, `got: ${storedState()?.logCount}`)
}

function testRefusedLogsCostNothing() {
  console.log('\nTest: a refused log does not consume budget')
  reset()
  configureRateLimiter({ sessionLimit: 2, duplicateLimit: 1 })

  const sig = signatureFor(new Error('dupe'), 'Home')
  allow(sig)                                   // 1st: allowed, count = 1
  const refused = allow(sig)                   // 2nd: duplicate, refused
  assert('the duplicate was refused', !refused.allowed)
  assert('a refused duplicate did not spend budget', storedState()?.logCount === 1, `got: ${storedState()?.logCount}`)

  assert('the remaining budget is still usable', allow().allowed)
}

// --- Duplicate suppression ---

function testDuplicateSuppression() {
  console.log('\nTest: duplicate suppression')
  reset()
  configureRateLimiter({ duplicateLimit: 2 })

  const sig = signatureFor(new Error('same failure'), 'Checkout')
  assert('1st occurrence allowed', allow(sig).allowed)
  assert('2nd occurrence allowed', allow(sig).allowed)

  const third = allow(sig)
  assert('3rd is suppressed', !third.allowed)
  assert('reason is duplicate', !third.allowed && third.reason === 'duplicate')
  assert('the signature is reported back', !third.allowed && third.signature === sig)
}

function testUnsignedLogsAreNeverSuppressedAsDuplicates() {
  console.log('\nTest: a log with no signature opts out of duplicate suppression')
  reset()
  configureRateLimiter({ sessionLimit: 50, duplicateLimit: 1 })

  for (let i = 0; i < 10; i++) {
    assert(`unsigned log ${i + 1} allowed`, allow().allowed)
  }
}

function testSuppressionIsAvailableToAnySeverity() {
  console.log('\nTest: suppression is keyed on the signature, not on being an error')
  reset()
  configureRateLimiter({ duplicateLimit: 1 })

  // A warning can opt in with a plain string — nothing here is error-specific.
  const warnSig = signatureFor('deprecated_api_used', 'Settings')
  assert('1st warning allowed', allow(warnSig).allowed)
  assert('repeat warning suppressed', !allow(warnSig).allowed)
}

function testSignatureIsScopedToContext() {
  console.log('\nTest: the signature includes the screen')
  reset()
  configureRateLimiter({ duplicateLimit: 1 })

  const error = new Error('same failure')
  allow(signatureFor(error, 'Checkout'))

  assert('same error, same place → suppressed', !allow(signatureFor(error, 'Checkout')).allowed)
  assert('same error, other screen → allowed', allow(signatureFor(error, 'Settings')).allowed)
  assert('different message → allowed', allow(signatureFor(new Error('other'), 'Checkout')).allowed)

  const named = new Error('same failure')
  named.name = 'TypeError'
  assert('different error name → allowed', allow(signatureFor(named, 'Checkout')).allowed)
}

function testStringErrorsAreSupported() {
  console.log('\nTest: string errors get a signature too')
  reset()
  configureRateLimiter({ duplicateLimit: 1 })

  assert('1st string allowed', allow(signatureFor('plain failure', 'Home')).allowed)
  assert('repeat string suppressed', !allow(signatureFor('plain failure', 'Home')).allowed)
  assert('different string allowed', allow(signatureFor('other failure', 'Home')).allowed)
}

function testSessionLimitOutranksDuplicate() {
  console.log('\nTest: the session limit is checked before the duplicate rule')
  reset()
  configureRateLimiter({ sessionLimit: 2, duplicateLimit: 99 })

  allow(); allow()
  const refused = allow(signatureFor(new Error('fresh'), 'Home'))
  assert('a brand-new error is still refused at the cap', !refused.allowed)
  assert('reported as the session limit, not a duplicate', !refused.allowed && refused.reason === 'session-limit')
}

// --- Config and reset ---

function testConfigureMerges() {
  console.log('\nTest: configureRateLimiter merges, it does not replace')
  reset()
  configureRateLimiter({ duplicateLimit: 2 })
  configureRateLimiter({ sessionLimit: 10 })    // only sessionLimit

  const sig = signatureFor(new Error('dupe'), 'Home')
  allow(sig); allow(sig)
  assert('the earlier duplicateLimit of 2 survived', !allow(sig).allowed)

  for (let i = 0; i < 8; i++) allow()
  assert('the new session limit applies', !allow().allowed)
}

function testCustomStorageKey() {
  console.log('\nTest: a custom storage key is honoured')
  reset()
  configureRateLimiter({ storageKey: 'custom_key' })
  resetRateLimiter()

  allow()
  assert('state lands under the custom key', JSON.parse(sessionStorageStub.peek('custom_key')!).logCount === 1)
  assert('the default key is untouched', sessionStorageStub.peek(STORAGE_KEY) === null)

  configureRateLimiter({ storageKey: STORAGE_KEY })
}

function testResetClearsState() {
  console.log('\nTest: resetRateLimiter clears the session')
  reset()
  configureRateLimiter({ sessionLimit: 2 })

  allow(); allow()
  assert('the limit is reached', !allow().allowed)

  resetRateLimiter()
  assert('reset clears the stored state', storedState() === null)
  assert('logging is allowed again', allow().allowed)
}

function testResetIsWiredToBeforeUnload() {
  console.log('\nTest: the session resets on page unload')
  assert('a beforeunload listener is registered', listenerCount('beforeunload') >= 1)
}

// --- Storage failure ---

function testStorageFailureIsNonFatal() {
  console.log('\nTest: a broken sessionStorage does not break logging')
  reset()
  sessionStorageStub.failing = true

  let threw = false
  try {
    assert('allow() falls back to permitting the log', allow().allowed)
    assert('a signed log is permitted too', allow(signatureFor(new Error('x'), 'Home')).allowed)
    resetRateLimiter()
  } catch {
    threw = true
  }
  assert('no error escapes to the caller', !threw)

  sessionStorageStub.failing = false
}

// --- Runner ---

function run() {
  testSessionLimit()
  testEachAllowCostsExactlyOne()
  testRefusedLogsCostNothing()
  testDuplicateSuppression()
  testUnsignedLogsAreNeverSuppressedAsDuplicates()
  testSuppressionIsAvailableToAnySeverity()
  testSignatureIsScopedToContext()
  testStringErrorsAreSupported()
  testSessionLimitOutranksDuplicate()
  testConfigureMerges()
  testCustomStorageKey()
  testResetClearsState()
  testResetIsWiredToBeforeUnload()
  testStorageFailureIsNonFatal()

  reportResults()
}

run()
