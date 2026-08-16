/**
 * Error payload tests.
 *
 * The client logger and the functions logger both put an `ErrorPayload` on the
 * wire. They used to build it independently and had silently drifted apart
 * (`cause: null` serialised as the string "null" on the functions side, and was
 * dropped on the client side). Both now go through `toErrorPayload`, so these
 * tests cover the shared helper plus a parity check that the two loggers still
 * agree end to end.
 *
 * Run: FUNCTIONS_EMULATOR=true npx tsx tests/errorPayload.ts
 *
 * NOTE: FUNCTIONS_EMULATOR must be set in the shell — ESM hoists imports before
 * any code runs, so setting process.env inside this file is too late.
 */

import fs from 'fs'

if (process.env.FUNCTIONS_EMULATOR !== 'true') {
  console.error('Run with: FUNCTIONS_EMULATOR=true npx tsx tests/errorPayload.ts')
  process.exit(1)
}

const LOG_DIR = './test-errorpayload-output'

import { toError, toErrorPayload } from '../src/shared/error.js'
import { Logger } from '../src/client/logger.js'
import { initLogger, createLogWriter } from '../src/functions/logger.js'
import type { LogPayload, ErrorPayload } from '../src/shared/types.js'
import { assert, reportResults, readLastEntry, clearLog } from './testHelpers.js'

fs.mkdirSync(LOG_DIR, { recursive: true })
initLogger({ appId: 'acme', logLocalDir: LOG_DIR })

// --- toError ---

function testToError() {
  console.log('\nTest: toError — coerces unknown values to Error')

  const original = new Error('boom')
  assert('an Error is passed through unchanged', toError(original) === original)

  const fromString = toError('plain string')
  assert('a string becomes an Error', fromString instanceof Error)
  assert('the string becomes the message', fromString.message === 'plain string')

  const fromObject = toError({ code: 42 })
  assert('an object becomes an Error', fromObject instanceof Error)
  assert('the object is stringified', fromObject.message === '[object Object]')

  assert('undefined becomes an Error', toError(undefined) instanceof Error)
  assert('undefined message is "undefined"', toError(undefined).message === 'undefined')

  // A subclass must keep its own name — that is what becomes the errorType label.
  class DuplicateProductError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'DuplicateProductError'
    }
  }
  assert(
    'a subclass keeps its name',
    toError(new DuplicateProductError('dupe')).name === 'DuplicateProductError',
  )
}

// --- toErrorPayload ---

function testToErrorPayloadFields() {
  console.log('\nTest: toErrorPayload — copies message, stack and name')

  const error = new TypeError('bad type')
  const payload = toErrorPayload(error)

  assert('message is copied', payload.message === 'bad type')
  assert('name is copied', payload.name === 'TypeError')
  assert('stack is copied', payload.stack === error.stack)
  assert('stack is present', typeof payload.stack === 'string' && payload.stack.length > 0)
}

function testToErrorPayloadCause() {
  console.log('\nTest: toErrorPayload — cause normalisation')

  const noCause = toErrorPayload(new Error('no cause'))
  assert('absent cause is undefined', noCause.cause === undefined)

  const undefinedCause = toErrorPayload(new Error('x', { cause: undefined }))
  assert('undefined cause is undefined', undefinedCause.cause === undefined)

  // The regression this file exists for: null must be dropped, not stringified.
  const nullCause = toErrorPayload(new Error('x', { cause: null }))
  assert('null cause is dropped, not "null"', nullCause.cause === undefined, `got: ${nullCause.cause}`)

  // Falsy but meaningful values must survive.
  const zeroCause = toErrorPayload(new Error('x', { cause: 0 }))
  assert('cause 0 is kept as "0"', zeroCause.cause === '0', `got: ${zeroCause.cause}`)

  const emptyStringCause = toErrorPayload(new Error('x', { cause: '' }))
  assert('empty string cause is kept', emptyStringCause.cause === '', `got: ${emptyStringCause.cause}`)

  const falseCause = toErrorPayload(new Error('x', { cause: false }))
  assert('cause false is kept as "false"', falseCause.cause === 'false', `got: ${falseCause.cause}`)

  const stringCause = toErrorPayload(new Error('x', { cause: 'upstream failed' }))
  assert('string cause is kept', stringCause.cause === 'upstream failed')

  const errorCause = toErrorPayload(new Error('x', { cause: new Error('inner') }))
  assert('Error cause is stringified', errorCause.cause === 'Error: inner', `got: ${errorCause.cause}`)
}

// --- Client / functions parity ---

function clientErrorPayload(raw: unknown): ErrorPayload | undefined {
  let captured: LogPayload | undefined
  const logger = new Logger({
    appId: 'acme',
    releaseId: 'test-release',
    logFunction: async (data) => {
      captured = data
    },
  })
  logger.error(raw)
  return captured?.jsonPayload?.error
}

function functionsErrorPayload(raw: unknown): ErrorPayload | undefined {
  clearLog(LOG_DIR)
  createLogWriter({ appId: 'acme' }).error(raw)
  const entry = readLastEntry(LOG_DIR)
  return (entry?.jsonPayload as { error?: ErrorPayload } | undefined)?.error
}

function assertParity(label: string, raw: unknown) {
  const client = clientErrorPayload(raw)
  const functions = functionsErrorPayload(raw)

  assert(`${label} — client produced a payload`, !!client)
  assert(`${label} — functions produced a payload`, !!functions)

  // `stack` is compared separately: when `raw` is not an Error each side
  // synthesises its own, so the two stacks legitimately differ by call site.
  const withoutStack = ({ message, name, cause }: ErrorPayload) => ({ message, name, cause })
  assert(
    `${label} — message, name and cause agree`,
    JSON.stringify(withoutStack(client!)) === JSON.stringify(withoutStack(functions!)),
    `client: ${JSON.stringify(withoutStack(client!))} vs functions: ${JSON.stringify(withoutStack(functions!))}`,
  )
  assert(
    `${label} — both sides carry a stack`,
    !!client?.stack && !!functions?.stack,
  )
  if (raw instanceof Error) {
    assert(
      `${label} — the original stack is preserved on both sides`,
      client?.stack === raw.stack && functions?.stack === raw.stack,
    )
  }
}

function testClientFunctionsParity() {
  console.log('\nTest: client and functions loggers build the same error payload')

  assertParity('plain Error', new Error('same on both sides'))
  assertParity('Error with null cause', new Error('nullish', { cause: null }))
  assertParity('Error with string cause', new Error('caused', { cause: 'upstream' }))
  assertParity('non-Error value', 'thrown string')
}

// --- Runner ---

function run() {
  testToError()
  testToErrorPayloadFields()
  testToErrorPayloadCause()
  testClientFunctionsParity()

  fs.rmSync(LOG_DIR, { recursive: true, force: true })

  reportResults()
}

try {
  run()
} catch (err) {
  fs.rmSync(LOG_DIR, { recursive: true, force: true })
  console.error('Fatal:', err)
  process.exit(1)
}
