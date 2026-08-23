/**
 * Global error handler unit tests.
 *
 * Run: npx tsx tests/errorHandler.ts
 */

// Must come first — errorHandler reads `window`, and the client logger reads
// `navigator` at module load.
import { dispatchErrorEvent, dispatchRejectionEvent, listenerCount } from './browserStubs.js'

import { initLogger } from '../src/client/logger.js'
import { setupGlobalErrorHandler, handleReactError } from '../src/client/errorHandler.js'
import { resetRateLimiter, configureRateLimiter } from '../src/client/rateLimiter.js'
import { clearBreadcrumbs } from '../src/client/breadcrumbs.js'
import type { LogPayload } from '../src/shared/types.js'
import { assert, reportResults } from './testHelpers.js'

let captured: LogPayload[] = []

initLogger({
  appId: 'acme',
  releaseId: 'test-release',
  logFunction: async (data) => {
    captured.push(data)
  },
})

function reset() {
  captured = []
  clearBreadcrumbs()
  configureRateLimiter({ sessionLimit: 50, duplicateLimit: 3 })
  resetRateLimiter()
}

/**
 * `Logger.error` is fire-and-forget, so the send resolves on a later
 * microtask. Yield until the payload lands.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

// --- Registration ---

function testListenersAreRegistered() {
  console.log('\nTest: setupGlobalErrorHandler registers both window listeners')
  const beforeError = listenerCount('error')
  const beforeRejection = listenerCount('unhandledrejection')

  setupGlobalErrorHandler()

  assert('an error listener was added', listenerCount('error') === beforeError + 1)
  assert('an unhandledrejection listener was added', listenerCount('unhandledrejection') === beforeRejection + 1)
}

// --- Uncaught errors ---

async function testUncaughtError() {
  console.log('\nTest: an uncaught window error is logged')
  reset()

  const error = new TypeError('boom from window')
  dispatchErrorEvent({ error })
  await flush()

  assert('exactly one log was sent', captured.length === 1, `got: ${captured.length}`)

  const payload = captured[0]
  assert('it is logged at ERROR', payload?.severity === 'ERROR')
  assert('the message is the error message', payload?.message === 'boom from window')
  assert('errorCategory is crash', payload?.labels.errorCategory === 'crash')
  assert('errorType is UncaughtError', payload?.labels.errorType === 'UncaughtError', `got: ${payload?.labels.errorType}`)
  assert('the error payload carries the stack', !!payload?.jsonPayload?.error?.stack)
  assert('the error name is preserved', payload?.jsonPayload?.error?.name === 'TypeError')
  assert('appId comes from the logger config', payload?.labels.appId === 'acme')
}

async function testUnhandledRejection() {
  console.log('\nTest: an unhandled promise rejection is logged')
  reset()

  dispatchRejectionEvent(new Error('rejected promise'))
  await flush()

  assert('exactly one log was sent', captured.length === 1, `got: ${captured.length}`)

  const payload = captured[0]
  assert('the message is the reason message', payload?.message === 'rejected promise')
  assert('errorCategory is crash', payload?.labels.errorCategory === 'crash')
  assert('errorType is UnhandledRejection', payload?.labels.errorType === 'UnhandledRejection', `got: ${payload?.labels.errorType}`)
}

async function testRejectionWithNonError() {
  console.log('\nTest: a rejection with a non-Error reason still logs')
  reset()

  dispatchRejectionEvent('just a string')
  await flush()

  assert('a log was still sent', captured.length === 1, `got: ${captured.length}`)
  assert('the string became the message', captured[0]?.message === 'just a string')
  assert('errorType is still UnhandledRejection', captured[0]?.labels.errorType === 'UnhandledRejection')
}

// --- React errors ---

async function testHandleReactError() {
  console.log('\nTest: handleReactError logs with the component stack')
  reset()

  handleReactError(new Error('render failed'), {
    componentStack: '\n    at ProductCard\n    at ProductList',
  })
  await flush()

  assert('exactly one log was sent', captured.length === 1, `got: ${captured.length}`)

  const payload = captured[0]
  assert('the message is the error message', payload?.message === 'render failed')
  assert('errorCategory is crash', payload?.labels.errorCategory === 'crash')
  assert('errorType is ReactError', payload?.labels.errorType === 'ReactError', `got: ${payload?.labels.errorType}`)

  const componentStack = (payload?.jsonPayload?.context as { componentStack?: string })?.componentStack
  assert('the component stack is in context', componentStack?.includes('at ProductCard') === true, `got: ${componentStack}`)
  assert('the component stack is not in the error payload', !payload?.jsonPayload?.error?.stack?.includes('at ProductCard'))
}

// --- Interaction with the rate limiter ---

async function testDuplicateCrashesAreSuppressed() {
  console.log('\nTest: a repeating crash is suppressed by the rate limiter')
  reset()
  configureRateLimiter({ duplicateLimit: 2 })

  // The same error, over and over, from the same (absent) screen.
  for (let i = 0; i < 5; i++) {
    dispatchErrorEvent({ error: new Error('same crash') })
    await flush()
  }

  assert('the flood was capped at the duplicate limit', captured.length === 2, `got: ${captured.length}`)
}


// --- Cross-origin errors (#13) ---

async function testCrossOriginScriptError() {
  console.log('\nTest: a cross-origin script error keeps the information the event carried')
  reset()

  // A script loaded cross-origin without CORS: the browser withholds the error
  // object entirely and gives only the event's own fields.
  dispatchErrorEvent({
    error: null,
    message: 'Script error.',
    filename: 'https://cdn.example.com/vendor.js',
    lineno: 1,
    colno: 0,
  })
  await flush()

  assert('a log was sent', captured.length === 1, `got: ${captured.length}`)

  const payload = captured[0]
  assert(
    'the message is the event message, not the string "null"',
    payload?.message.startsWith('Script error.') === true,
    `got: ${payload?.message}`,
  )
  assert(
    'the message carries the locator, so entries stay distinct',
    payload?.message.includes('vendor.js') === true,
    `got: ${payload?.message}`,
  )
  assert(
    'errorType marks it as cross-origin, so it is filterable',
    payload?.labels.errorType === 'CrossOriginError',
    `got: ${payload?.labels.errorType}`,
  )

  const context = payload?.jsonPayload?.context as Record<string, unknown> | undefined
  assert('the filename is kept as context', context?.filename === 'https://cdn.example.com/vendor.js', `got: ${context?.filename}`)
  assert('the line number is kept', context?.lineno === 1, `got: ${context?.lineno}`)
}

async function testCrossOriginErrorsAreNotAllTheSame() {
  console.log('\nTest: two different cross-origin errors are not collapsed into one signature')
  reset()
  configureRateLimiter({ duplicateLimit: 1 })

  dispatchErrorEvent({ error: null, message: 'Script error.', filename: 'https://cdn.example.com/a.js', lineno: 1 })
  await flush()
  dispatchErrorEvent({ error: null, message: 'Script error.', filename: 'https://cdn.example.com/b.js', lineno: 9 })
  await flush()

  // Before the fix every cross-origin error became Error("null"), so they all
  // shared one signature and duplicate suppression swallowed the rest.
  assert('both were logged', captured.length === 2, `got: ${captured.length}`)
}

async function testRejectionWithNoReason() {
  console.log('\nTest: a rejection with no reason still says something useful')
  reset()

  dispatchRejectionEvent(undefined)
  await flush()

  assert('a log was sent', captured.length === 1, `got: ${captured.length}`)
  assert(
    'the message is not the string "undefined"',
    captured[0]?.message !== 'undefined',
    `got: ${captured[0]?.message}`,
  )
}

// --- Runner ---

async function run() {
  testListenersAreRegistered()
  await testUncaughtError()
  await testUnhandledRejection()
  await testRejectionWithNonError()
  await testHandleReactError()
  await testDuplicateCrashesAreSuppressed()
  await testCrossOriginScriptError()
  await testCrossOriginErrorsAreNotAllTheSame()
  await testRejectionWithNoReason()

  reportResults()
}

run().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
