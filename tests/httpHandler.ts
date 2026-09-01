/**
 * The HTTP adapter (#34).
 *
 * A callable gets Firebase's token check for free. An HTTP endpoint gets
 * nothing, and an open one writes to the customer's Cloud Logging bill on
 * anyone's say-so — so most of what is asserted here is about the gate holding,
 * not about the happy path.
 *
 * Runs with FUNCTIONS_EMULATOR=true so entries go to a throwaway JSONL rather
 * than needing credentials:
 *   FUNCTIONS_EMULATOR=true npx tsx tests/httpHandler.ts
 */

import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { initializeApp } from 'firebase-admin/app'
import { initLogger } from '../src/functions/logger.js'
import { createHttpLogHandler, type HttpLogRequest, type HttpLogResponse } from '../src/functions/httpHandler.js'
import { assert, reportResults, readLastEntry, clearLog } from './testHelpers.js'

initializeApp({ projectId: 'demo-http-handler' })

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fsl-http-'))
initLogger({ appId: 'http-app', logLocalDir: LOG_DIR, minSeverity: 'DEBUG' })

interface Captured {
  status: number
  headers: Record<string, string>
  body?: string
}

function respond(): { res: HttpLogResponse; out: Captured } {
  const out: Captured = { status: 0, headers: {} }
  const res: HttpLogResponse = {
    get statusCode() {
      return out.status
    },
    set statusCode(v: number) {
      out.status = v
    },
    setHeader(name: string, value: string) {
      out.headers[name.toLowerCase()] = value
    },
    end(body?: string) {
      out.body = body
    },
  }
  return { res, out }
}

function post(body: unknown, headers: Record<string, string> = {}): HttpLogRequest {
  return { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }
}

const VALID = {
  message: 'checkout started',
  severity: 'INFO' as const,
  labels: { appId: 'http-app', userId: 'u1' },
}

async function testAValidPostIsWritten() {
  console.log('\nTest: a valid POST writes an entry and returns 204')
  clearLog(LOG_DIR)

  const handler = createHttpLogHandler({ authorize: 'unauthenticated' })
  const { res, out } = respond()
  await handler(post(VALID), res)

  assert('204, with no body', out.status === 204 && out.body === undefined, `got ${out.status}`)
  const entry = readLastEntry(LOG_DIR)
  assert('the entry was written', !!entry)
  assert('with its message', entry?.message === 'checkout started', entry?.message)
  assert('and its labels', entry?.labels?.userId === 'u1')
}

/**
 * The reason the gate has no default. A missing `authorize` should not be
 * expressible; an open one should have to be said out loud.
 */
async function testTheGateRejects() {
  console.log('\nTest: a failing gate rejects before anything is written')
  clearLog(LOG_DIR)

  const handler = createHttpLogHandler({ authorize: () => false })
  const { res, out } = respond()
  await handler(post(VALID), res)

  assert('401', out.status === 401, `got ${out.status}`)
  assert('nothing was written', !readLastEntry(LOG_DIR), 'a rejected request must not reach Cloud Logging')
}

async function testTheGateCanPass() {
  console.log('\nTest: a passing gate lets the request through, and sees the request')
  clearLog(LOG_DIR)

  let sawHeader: string | undefined
  const handler = createHttpLogHandler({
    authorize: (req) => {
      sawHeader = String(req.headers.authorization ?? '')
      return sawHeader === 'Bearer good'
    },
  })

  const bad = respond()
  await handler(post(VALID, { authorization: 'Bearer wrong' }), bad.res)
  assert('the wrong token is refused', bad.out.status === 401)

  const good = respond()
  await handler(post(VALID, { authorization: 'Bearer good' }), good.res)
  assert('the right token is accepted', good.out.status === 204, `got ${good.out.status}`)
  assert('the gate was handed the real request', sawHeader === 'Bearer good')
  assert('and the entry was written', readLastEntry(LOG_DIR)?.message === 'checkout started')
}

/**
 * A gate that threw did not pass. Treating an exception as anything but a
 * rejection would mean a bug in someone's token check opens the endpoint.
 */
async function testAThrowingGateRejects() {
  console.log('\nTest: a gate that throws is a rejection, not an opening')
  clearLog(LOG_DIR)

  const handler = createHttpLogHandler({
    authorize: () => {
      throw new Error('token service unreachable')
    },
  })
  const { res, out } = respond()
  await handler(post(VALID), res)

  assert('401', out.status === 401, `got ${out.status}`)
  assert('nothing was written', !readLastEntry(LOG_DIR))
  assert('and the reason is not leaked to the caller', !String(out.body).includes('unreachable'), out.body)
}

async function testBadPayloadsAreRefused() {
  console.log('\nTest: malformed payloads come back as 400, not 500')
  clearLog(LOG_DIR)
  const handler = createHttpLogHandler({ authorize: 'unauthenticated' })

  const noSeverity = respond()
  await handler(post({ message: 'x' }), noSeverity.res)
  assert('a missing severity is a 400', noSeverity.out.status === 400, `got ${noSeverity.out.status}`)

  const badSeverity = respond()
  await handler(post({ message: 'x', severity: 'LOUD', labels: {} }), badSeverity.res)
  assert('an unknown severity is a 400', badSeverity.out.status === 400, `got ${badSeverity.out.status}`)
  assert('and says which', String(badSeverity.out.body).includes('LOUD'), badSeverity.out.body)

  assert('nothing was written', !readLastEntry(LOG_DIR))
}

/**
 * Overwhelmingly a missing body parser rather than a bad client, and that is a
 * five-minute fix once someone says it out loud.
 */
async function testAnUnparsedBodySaysSo() {
  console.log('\nTest: an unparsed body names the likely cause')
  const handler = createHttpLogHandler({ authorize: 'unauthenticated' })

  const { res, out } = respond()
  await handler({ method: 'POST', headers: {}, body: undefined }, res)
  assert('400', out.status === 400, `got ${out.status}`)
  assert('and mentions the body parser', String(out.body).includes('express.json()'), out.body)
}

async function testPreflightAndMethods() {
  console.log('\nTest: CORS preflight and non-POST methods')
  const handler = createHttpLogHandler({ authorize: () => false, allowOrigin: 'https://app.example.com' })

  const pre = respond()
  await handler({ method: 'OPTIONS', headers: {} }, pre.res)
  assert('preflight is 204', pre.out.status === 204, `got ${pre.out.status}`)
  assert('the named origin is echoed', pre.out.headers['access-control-allow-origin'] === 'https://app.example.com')
  assert('Authorization is allowed, or the gate can never be fed', String(pre.out.headers['access-control-allow-headers']).includes('Authorization'))
  assert('preflight is not gated — a browser sends no credentials on it', pre.out.status !== 401)

  const get = respond()
  await handler({ method: 'GET', headers: {} }, get.res)
  assert('GET is 405', get.out.status === 405, `got ${get.out.status}`)
  assert('with an Allow header', get.out.headers['allow'] === 'POST, OPTIONS')
}

async function testOriginDefaultsToWildcard() {
  console.log('\nTest: the origin defaults to *, matching cors: true on the callable')
  const handler = createHttpLogHandler({ authorize: 'unauthenticated' })
  const { res, out } = respond()
  await handler(post(VALID), res)
  assert('wildcard by default', out.headers['access-control-allow-origin'] === '*', out.headers['access-control-allow-origin'])
  assert('and Vary: Origin is set', out.headers['vary'] === 'Origin')
}

async function run() {
  try {
    await testAValidPostIsWritten()
    await testTheGateRejects()
    await testTheGateCanPass()
    await testAThrowingGateRejects()
    await testBadPayloadsAreRefused()
    await testAnUnparsedBodySaysSo()
    await testPreflightAndMethods()
    await testOriginDefaultsToWildcard()
  } finally {
    fs.rmSync(LOG_DIR, { recursive: true, force: true })
  }
  reportResults()
}

run().catch((err) => {
  fs.rmSync(LOG_DIR, { recursive: true, force: true })
  console.error('Fatal:', err)
  process.exit(1)
})
