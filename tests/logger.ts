/**
 * Client logger unit tests
 * Run: npx tsx test-logger.ts
 */

import { initLogger } from '../src/client/logger.js'
import type { LogPayload } from '../src/shared/types.js'
import { assert, reportResults } from './testHelpers.js'

function makeLogger(): { logger: Logger; lastPayload: () => LogPayload | undefined } {
  let captured: LogPayload | undefined
  const logger = initLogger({
    appId: 'test-app',
    releaseId: 'test-release',
    logFunction: async (data) => { captured = data },
  })
  return { logger, lastPayload: () => captured }
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

// --- Runner ---

async function run() {
  await testErrorPayloadStructure()
  await testErrorWithNoContext()
  await testErrorNameAndCause()
  await testNonErrorInput()
  await testInfoHasNoError()

  reportResults()
}

run().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
