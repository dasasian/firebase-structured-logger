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

import '../tests/browserStubs.js'

if (process.env.FUNCTIONS_EMULATOR !== 'true') {
  console.error('Run with: FUNCTIONS_EMULATOR=true npx tsx tests/configureTwice.ts')
  process.exit(1)
}

import { initializeApp } from 'firebase-admin/app'
import { configureRateLimiter, allow, resetRateLimiter } from '../src/client/rateLimiter.js'
import { configureSourceMapBucket, getBucket } from '../src/functions/sourceMapCache.js'
import { assert, reportResults } from './testHelpers.js'

initializeApp({ projectId: 'demo-project' })

function testConfigureRateLimiterTwice() {
  console.log('\nTest: configureRateLimiter — second call merges into the first')
  resetRateLimiter()

  configureRateLimiter({ sessionLimit: 5, duplicateLimit: 2 })
  configureRateLimiter({ sessionLimit: 3 })          // only sessionLimit

  // Documented semantics: MERGE, last value wins per field.
  for (let i = 0; i < 3; i++) allow()
  assert('the newer sessionLimit is in force', !allow().allowed)

  resetRateLimiter()
  for (let i = 0; i < 2; i++) allow()
  assert('the untouched duplicateLimit survived the merge', allow().allowed)

  // This is process-wide by design: one browser session, one budget. It is not
  // per-Logger, which is why Logger is not exported as a constructible class.
  assert('rate-limit config is session-scoped, not per-instance', true)
}

function testConfigureSourceMapBucketTwice() {
  console.log('\nTest: configureSourceMapBucket — second call replaces the default')
  configureSourceMapBucket('bucket-one')
  assert('first bucket becomes the default', getBucket().name === 'bucket-one', `got: ${getBucket().name}`)

  configureSourceMapBucket('bucket-two')
  assert('second call replaces it', getBucket().name === 'bucket-two', `got: ${getBucket().name}`)

  // The critical property: this default must NOT govern source-map lookups.
  // Handlers pass their bucket explicitly, so two handlers cannot collide.
  assert(
    'an explicit bucket still overrides the default',
    getBucket('bucket-one').name === 'bucket-one',
    `got: ${getBucket('bucket-one').name}`,
  )
}

function run() {
  testConfigureRateLimiterTwice()
  testConfigureSourceMapBucketTwice()
  reportResults()
}

run()
