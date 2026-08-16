/**
 * Rate limiter unit tests.
 *
 * Run: npx tsx tests/rateLimiter.ts
 */

// Must come first — rateLimiter reads `window` at module load.
import { sessionStorageStub, listenerCount } from './browserStubs.js'

import {
  canLogEvent,
  canLogError,
  recordLog,
  recordError,
  configureRateLimiter,
  resetRateLimiter,
} from '../src/client/rateLimiter.js'
import { assert, reportResults } from './testHelpers.js'

const STORAGE_KEY = 'fsl_ratelimit'

/** Back to a clean session and the default limits. */
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

  assert('a fresh session may log', canLogEvent())

  recordLog()
  recordLog()
  assert('under the limit it may still log', canLogEvent())

  recordLog()
  assert('at the limit it may not log', !canLogEvent())

  recordLog()
  assert('past the limit it still may not log', !canLogEvent())
}

function testRecordLogPersists() {
  console.log('\nTest: counts persist to sessionStorage')
  reset()

  assert('nothing stored before the first log', storedState() === null)

  recordLog()
  assert('logCount is 1 after one log', storedState()?.logCount === 1)

  recordLog()
  recordLog()
  assert('logCount is 3 after three logs', storedState()?.logCount === 3)
}

// --- Duplicate suppression ---

function testDuplicateSuppression() {
  console.log('\nTest: duplicate error suppression')
  reset()
  configureRateLimiter({ duplicateLimit: 2 })

  const error = new Error('same failure')

  assert('the first occurrence is allowed', canLogError(error, 'Checkout', 'pay'))
  recordError(error, 'Checkout', 'pay')

  assert('the second occurrence is allowed', canLogError(error, 'Checkout', 'pay'))
  recordError(error, 'Checkout', 'pay')

  assert('the third occurrence is suppressed', !canLogError(error, 'Checkout', 'pay'))
}

function testSignatureIsScopedToContext() {
  console.log('\nTest: the duplicate signature includes screen and activity')
  reset()
  configureRateLimiter({ duplicateLimit: 1 })

  const error = new Error('same failure')

  recordError(error, 'Checkout', 'pay')
  assert('the same error on the same screen is suppressed', !canLogError(error, 'Checkout', 'pay'))
  assert('the same error on another screen is allowed', canLogError(error, 'Settings', 'pay'))
  assert('the same error in another activity is allowed', canLogError(error, 'Checkout', 'refund'))

  // Name and message both feed the signature.
  const differentMessage = new Error('another failure')
  assert('a different message is allowed', canLogError(differentMessage, 'Checkout', 'pay'))

  const differentName = new Error('same failure')
  differentName.name = 'TypeError'
  assert('a different error name is allowed', canLogError(differentName, 'Checkout', 'pay'))
}

function testStringErrorsAreSupported() {
  console.log('\nTest: string errors get a signature too')
  reset()
  configureRateLimiter({ duplicateLimit: 1 })

  assert('a string error is allowed first', canLogError('plain failure', 'Home'))
  recordError('plain failure', 'Home')
  assert('the same string is suppressed', !canLogError('plain failure', 'Home'))
  assert('a different string is allowed', canLogError('other failure', 'Home'))
}

function testErrorsCountTowardTheSessionLimit() {
  console.log('\nTest: errors count toward the session limit')
  reset()
  configureRateLimiter({ sessionLimit: 2, duplicateLimit: 99 })

  recordError(new Error('a'), 'Home')
  recordError(new Error('b'), 'Home')

  assert('the session limit is reached by errors alone', !canLogEvent())
  assert('canLogError also refuses once the session limit is hit', !canLogError(new Error('c'), 'Home'))
}

// --- Config and reset ---

function testConfigureOverrides() {
  console.log('\nTest: configureRateLimiter merges, it does not replace')
  reset()
  configureRateLimiter({ duplicateLimit: 2 })

  // A second call passing only sessionLimit must leave duplicateLimit alone.
  configureRateLimiter({ sessionLimit: 10 })

  const error = new Error('dupe')
  recordError(error, 'Home')
  recordError(error, 'Home')
  assert('the earlier duplicateLimit of 2 survived the merge', !canLogError(error, 'Home'))

  // And the newly set sessionLimit is in force.
  for (let i = 0; i < 8; i++) recordLog()
  assert('the new session limit applies', !canLogEvent())
}

function testCustomStorageKey() {
  console.log('\nTest: a custom storage key is honoured')
  reset()
  configureRateLimiter({ storageKey: 'custom_key' })
  resetRateLimiter()

  recordLog()
  assert('state lands under the custom key', JSON.parse(sessionStorageStub.peek('custom_key')!).logCount === 1)
  assert('the default key is untouched', sessionStorageStub.peek(STORAGE_KEY) === null)

  configureRateLimiter({ storageKey: STORAGE_KEY })
}

function testResetClearsState() {
  console.log('\nTest: resetRateLimiter clears the session')
  reset()
  configureRateLimiter({ sessionLimit: 2 })

  recordLog()
  recordLog()
  assert('the limit is reached', !canLogEvent())

  resetRateLimiter()
  assert('reset clears the stored state', storedState() === null)
  assert('logging is allowed again', canLogEvent())
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
    assert('canLogEvent falls back to allowing the log', canLogEvent())
    recordLog()
    assert('canLogError falls back to allowing the error', canLogError(new Error('x'), 'Home'))
    recordError(new Error('x'), 'Home')
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
  testRecordLogPersists()
  testDuplicateSuppression()
  testSignatureIsScopedToContext()
  testStringErrorsAreSupported()
  testErrorsCountTowardTheSessionLimit()
  testConfigureOverrides()
  testCustomStorageKey()
  testResetClearsState()
  testResetIsWiredToBeforeUnload()
  testStorageFailureIsNonFatal()

  reportResults()
}

run()
