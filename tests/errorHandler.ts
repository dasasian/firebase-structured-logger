/**
 * Global error handler unit tests.
 *
 * Run: npx tsx tests/errorHandler.ts
 */

// Must come first — errorHandler reads `window`, and the client logger reads
// `navigator` at module load.
import { dispatchWindowEvent, listenerCount } from './browserStubs.js'

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
  dispatchWindowEvent('error', { error })
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

  dispatchWindowEvent('unhandledrejection', { reason: new Error('rejected promise') })
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

  dispatchWindowEvent('unhandledrejection', { reason: 'just a string' })
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
    dispatchWindowEvent('error', { error: new Error('same crash') })
    await flush()
  }

  assert('the flood was capped at the duplicate limit', captured.length === 2, `got: ${captured.length}`)
}

// --- Runner ---

async function run() {
  testListenersAreRegistered()
  await testUncaughtError()
  await testUnhandledRejection()
  await testRejectionWithNonError()
  await testHandleReactError()
  await testDuplicateCrashesAreSuppressed()

  reportResults()
}

run().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
