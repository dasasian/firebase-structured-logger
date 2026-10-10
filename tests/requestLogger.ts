/**
 * Request-scoped logger tests.
 *
 * Covers label seeding, AsyncLocalStorage scoping, and the anonymous fallback
 * when getLogger() is called outside a request.
 *
 * Run: FUNCTIONS_EMULATOR=true npx tsx tests/requestLogger.ts
 *
 * NOTE: FUNCTIONS_EMULATOR must be set in the shell — ESM hoists imports before
 * any code runs, so setting process.env inside this file is too late.
 */

import fs from 'fs'

if (process.env.FUNCTIONS_EMULATOR !== 'true') {
  console.error('Run with: FUNCTIONS_EMULATOR=true npx tsx tests/requestLogger.ts')
  process.exit(1)
}

const LOG_DIR = './test-requestlogger-output'

import type { CallableRequest } from 'firebase-functions/v2/https'
import type { ScheduledEvent } from 'firebase-functions/v2/scheduler'
import { initLogger } from '../src/functions/logger.js'
import { withLogging, getLogger } from '../src/functions/requestLogger.js'
import { HttpsError } from 'firebase-functions/v2/https'
import { logError } from '../src/functions/index.js'
import { assert, reportResults, readLastEntry, readAllEntries, clearLog } from './testHelpers.js'

fs.mkdirSync(LOG_DIR, { recursive: true })
initLogger({ appId: 'acme', logLocalDir: LOG_DIR })

function makeCallableRequest(uid?: string): CallableRequest {
  return {
    data: {},
    auth: uid ? { uid, token: {} } : undefined,
    rawRequest: {},
  } as unknown as CallableRequest
}

function lastLabels(): Record<string, string> {
  return (readLastEntry(LOG_DIR)?.labels ?? {}) as Record<string, string>
}

async function testScheduleHandlerHasLabelsAndNoUserId() {
  console.log('\nTest: a schedule handler gets the labels and no userId')
  clearLog(LOG_DIR)

  const event = { scheduleTime: '2026-01-01T00:00:00Z' } as ScheduledEvent
  await withLogging<Record<string, string | undefined>, ScheduledEvent>(
    { functionName: 'nightly', labels: { job: 'cleanup' } },
    async () => {
      getLogger().info('tick')
    },
  )(event)

  const labels = lastLabels()
  assert('functionName is seeded', labels.functionName === 'nightly')
  assert('custom label is seeded', labels.job === 'cleanup')
  assert('userId is absent', !('userId' in labels))
}

// --- Label seeding ---

async function testSeedsRequestLabels() {
  console.log('\nTest: request labels are seeded on every log in the request')
  clearLog(LOG_DIR)

  await withLogging({ functionName: 'createProduct', appId: 'acme' }, async () => {
    getLogger().info('started')
  })(makeCallableRequest('user_abc'))

  const labels = lastLabels()
  assert('functionName is seeded', labels.functionName === 'createProduct', `got: ${labels.functionName}`)
  assert('userId comes from request.auth', labels.userId === 'user_abc', `got: ${labels.userId}`)
  assert('appId is seeded', labels.appId === 'acme')
}

async function testCustomLabelsAreSeeded() {
  console.log('\nTest: caller-supplied labels are seeded too')
  clearLog(LOG_DIR)

  await withLogging(
    { functionName: 'createProduct', labels: { organizationId: 'org_42', tenant: 'acme' } },
    async () => { getLogger().info('started') },
  )(makeCallableRequest('user_abc'))

  const labels = lastLabels()
  assert('a custom label is seeded', labels.organizationId === 'org_42', `got: ${labels.organizationId}`)
  assert('a second custom label is seeded', labels.tenant === 'acme')
  assert('built-in labels survive alongside them', labels.functionName === 'createProduct')
}

async function testUndefinedLabelsAreStripped() {
  console.log('\nTest: undefined labels are stripped, not written as "undefined"')
  clearLog(LOG_DIR)

  // No auth, no appId, no extra labels.
  await withLogging({ functionName: 'anonFunc' }, async () => {
    getLogger().info('started')
  })(makeCallableRequest())

  const labels = lastLabels()
  assert('functionName is present', labels.functionName === 'anonFunc')
  assert('userId is absent, not the string "undefined"', !('userId' in labels), `got: ${labels.userId}`)
  assert('appId is absent', !('appId' in labels))
}

async function testPerCallLabelsOverrideSeeded() {
  console.log('\nTest: per-call labels override the seeded ones')
  clearLog(LOG_DIR)

  await withLogging(
    { functionName: 'createProduct', labels: { stage: 'start' } },
    async () => { getLogger().info('finished', { stage: 'end' }) },
  )(makeCallableRequest('user_abc'))

  const labels = lastLabels()
  assert('the per-call label wins', labels.stage === 'end', `got: ${labels.stage}`)
  assert('untouched seeded labels survive', labels.functionName === 'createProduct')
}

// --- Scoping ---

async function testGetLoggerReturnsTheRequestWriter() {
  console.log('\nTest: getLogger returns the request-scoped writer')
  clearLog(LOG_DIR)

  await withLogging({ functionName: 'scopedFunc' }, async () => {
    getLogger().info('written through getLogger')
  })(makeCallableRequest('user_xyz'))

  const labels = lastLabels()
  assert('the request labels are present', labels.functionName === 'scopedFunc', `got: ${labels.functionName}`)
  assert('the request user is present', labels.userId === 'user_xyz')
}

async function testScopeSurvivesAwait() {
  console.log('\nTest: the request scope survives an await')
  clearLog(LOG_DIR)

  await withLogging({ functionName: 'asyncFunc' }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1))
    getLogger().info('after await')
  })(makeCallableRequest('user_async'))

  const labels = lastLabels()
  assert('labels survive the await', labels.functionName === 'asyncFunc', `got: ${labels.functionName}`)
  assert('the user survives the await', labels.userId === 'user_async')
}

async function testSequentialRequestsAreIndependent() {
  console.log('\nTest: sequential requests each get their own scope')

  // This used to assert "a later request replaces the earlier scope", which
  // only made sense while the scope leaked — the question was which stale value
  // won. With run() there is no shared scope to replace: each request has its
  // own and gives it back.
  clearLog(LOG_DIR)
  await withLogging({ functionName: 'first' }, async () => {
    getLogger().info('from the first request')
  })(makeCallableRequest('user_one'))
  const first = lastLabels()

  clearLog(LOG_DIR)
  await withLogging({ functionName: 'second' }, async () => {
    getLogger().info('from the second request')
  })(makeCallableRequest('user_two'))
  const second = lastLabels()

  assert('the first saw its own labels', first.functionName === 'first' && first.userId === 'user_one',
    `got: ${JSON.stringify(first)}`)
  assert('the second saw its own labels', second.functionName === 'second' && second.userId === 'user_two',
    `got: ${JSON.stringify(second)}`)
  assert('no bleed between them', second.userId !== 'user_one')
}

// --- Fallback outside a request ---

/**
 * This used to have to run first. While `initRequestLogger` bound the scope
 * with `enterWith()`, the first call leaked it for the rest of the process and
 * there was no way back to "outside a request". `withLogging` unwinds, so the
 * ordering constraint is gone — kept as a note because the constraint was the
 * bug, described as a quirk.
 */
function testAnonymousFallback() {
  console.log('\nTest: getLogger outside a request falls back to an anonymous writer')
  clearLog(LOG_DIR)

  let threw = false
  try {
    getLogger().info('no request here')
  } catch {
    threw = true
  }

  assert('it does not throw outside a request', !threw)

  const entry = readLastEntry(LOG_DIR)
  assert('the log was still written', !!entry)
  assert('the message came through', entry?.message === 'no request here')

  const labels = (entry?.labels ?? {}) as Record<string, string>
  assert('there is no functionName label', !('functionName' in labels))
  assert('there is no userId label', !('userId' in labels))
  assert('a logId is still assigned', typeof labels.logId === 'string' && labels.logId.length > 0)
}

async function testAllSeveritiesReachTheLog() {
  console.log('\nTest: every severity from the request writer reaches the log')
  const writer = await withLogging({ functionName: 'severityFunc' }, async () =>
    getLogger(),
  )(makeCallableRequest('user_abc'))

  for (const [name, write] of [
    ['info', () => writer.info('info message')],
    ['warning', () => writer.warning('warning message')],
    ['debug', () => writer.debug('debug message')],
  ] as const) {
    clearLog(LOG_DIR)
    write()
    const entry = readLastEntry(LOG_DIR)
    assert(`${name}() wrote an entry`, !!entry)
    assert(`${name}() used the right severity`, entry?.severity === name.toUpperCase(), `got: ${entry?.severity}`)
    assert(`${name}() kept the request labels`, (entry?.labels as Record<string, string>)?.functionName === 'severityFunc')
  }

  clearLog(LOG_DIR)
  writer.error(new Error('error message'))
  const entry = readLastEntry(LOG_DIR)
  assert('error() wrote an entry', !!entry)
  assert('error() used ERROR severity', entry?.severity === 'ERROR')
  assert('error() set the errorType label', (entry?.labels as Record<string, string>)?.errorType === 'Error')
  assert('error() kept the request labels', (entry?.labels as Record<string, string>)?.functionName === 'severityFunc')
}


// --- Scope isolation (#19) ---

async function testWithLoggingDoesNotLeakAfterTheRequest() {
  console.log('\nTest: withLogging does not leak the scope past the request')
  clearLog(LOG_DIR)

  await withLogging({ functionName: 'chargeCard' }, async () => {
    getLogger().info('inside the request')
  })(makeCallableRequest('alice'))

  assert('the request itself was labelled', lastLabels().userId === 'alice', `got: ${lastLabels().userId}`)

  // A later handler that does NOT scope itself — a scheduled function, a
  // Firestore trigger, or anything leaning on the anonymous fallback.
  clearLog(LOG_DIR)
  getLogger().info('outside any request')
  const after = lastLabels()

  assert('it does NOT inherit the previous userId', after.userId === undefined, `got: ${after.userId}`)
  assert('it does NOT inherit the previous functionName', after.functionName === undefined, `got: ${after.functionName}`)
}

async function testWithLoggingIsolatesConcurrentRequests() {
  console.log('\nTest: concurrent requests do not see each other\'s labels')

  const seen: Record<string, string | undefined> = {}
  const handler = (uid: string, delayMs: number) =>
    withLogging({ functionName: 'concurrent' }, async () => {
      await new Promise((r) => setTimeout(r, delayMs))
      clearLog(LOG_DIR)
      getLogger().info(`log from ${uid}`)
      seen[uid] = lastLabels().userId
    })(makeCallableRequest(uid))

  // Deliberately interleaved: the slower request starts first.
  await Promise.all([handler('alice', 30), handler('bob', 5)])

  assert('alice saw her own id', seen.alice === 'alice', `got: ${seen.alice}`)
  assert('bob saw his own id', seen.bob === 'bob', `got: ${seen.bob}`)
}

async function testWithLoggingComputesLabelsPerRequest() {
  console.log('\nTest: labels can be derived from the request')
  clearLog(LOG_DIR)

  await withLogging(
    (req) => ({ functionName: 'perRequest', labels: { tenant: (req.data as { tenant?: string })?.tenant } }),
    async () => { getLogger().info('with derived labels') },
  )({ data: { tenant: 'acme-co' }, auth: { uid: 'u1', token: {} }, rawRequest: {} } as never)

  assert('the derived label is present', lastLabels().tenant === 'acme-co', `got: ${lastLabels().tenant}`)
}

async function testWithLoggingReturnsTheHandlerResult() {
  console.log('\nTest: the wrapper returns whatever the handler returns')
  const result = await withLogging({ functionName: 'returns' }, async () => ({ ok: true, n: 42 }))(
    makeCallableRequest('u1'),
  )
  assert('the value passes through', (result as { n: number }).n === 42)
}

async function testWithLoggingPropagatesErrors() {
  console.log('\nTest: a throwing handler still throws, and the scope is unwound')
  clearLog(LOG_DIR)

  let caught = false
  try {
    await withLogging({ functionName: 'throws' }, async () => {
      throw new Error('handler exploded')
    })(makeCallableRequest('alice'))
  } catch (err) {
    caught = (err as Error).message === 'handler exploded'
  }
  assert('the error reached the caller', caught)

  clearLog(LOG_DIR)
  getLogger().info('after the throw')
  assert('the scope was unwound despite the throw', lastLabels().userId === undefined, `got: ${lastLabels().userId}`)
}

// --- What the handler throws (#83) ---

async function thrownBy(call: () => Promise<unknown>): Promise<{ threw: boolean; value: unknown }> {
  try {
    await call()
    return { threw: false, value: undefined }
  } catch (value) {
    return { threw: true, value }
  }
}

function errorPayloadOf(entry: { jsonPayload?: Record<string, unknown> } | undefined): Record<string, unknown> | undefined {
  return entry?.jsonPayload?.error as Record<string, unknown> | undefined
}

async function testPlainErrorIsLoggedOnceAndThrownAgain() {
  console.log('\nTest: a plain Error is one ERROR with the request labels, thrown again as the same object')
  clearLog(LOG_DIR)
  const original = new Error('card declined')

  const result = await thrownBy(() =>
    withLogging({ functionName: 'checkout' }, async () => { throw original })(makeCallableRequest('alice')),
  )

  const entries = readAllEntries(LOG_DIR)
  assert('exactly one entry', entries.length === 1, `got: ${entries.length}`)
  assert('it is an ERROR', entries[0]?.severity === 'ERROR', `got: ${entries[0]?.severity}`)
  assert('it carries functionName', entries[0]?.labels?.functionName === 'checkout')
  assert('it carries userId', entries[0]?.labels?.userId === 'alice')
  assert('it carries the error payload', errorPayloadOf(entries[0])?.message === 'card declined')
  assert('the caller got a rejection', result.threw)
  assert('the caller got the same object', result.value === original)
}

async function testRefusalWithClientStatusIsAWarning() {
  console.log('\nTest: an HttpsError with a 4xx status is one WARNING with code and status and no stack')
  clearLog(LOG_DIR)
  const refusal = new HttpsError('permission-denied', 'not your order')

  const result = await thrownBy(() =>
    withLogging({ functionName: 'checkout' }, async () => { throw refusal })(makeCallableRequest('alice')),
  )

  const entries = readAllEntries(LOG_DIR)
  assert('exactly one entry', entries.length === 1, `got: ${entries.length}`)
  assert('it is a WARNING', entries[0]?.severity === 'WARNING', `got: ${entries[0]?.severity}`)
  assert('the message is the error message', entries[0]?.message === 'not your order')
  const context = entries[0]?.jsonPayload?.context as Record<string, unknown> | undefined
  assert('the context has the code', context?.code === 'permission-denied', JSON.stringify(context))
  assert('the context has the status', context?.status === 403, JSON.stringify(context))
  assert('there is no error payload, so no stack', errorPayloadOf(entries[0]) === undefined)
  assert('it keeps the request labels', entries[0]?.labels?.functionName === 'checkout' && entries[0]?.labels?.userId === 'alice')
  assert('the same object is thrown again', result.threw && result.value === refusal)
}

async function testStatusFiveHundredIsAnError() {
  console.log('\nTest: an HttpsError with status 500 is an ERROR with the payload')
  clearLog(LOG_DIR)
  const fault = new HttpsError('internal', 'ledger unreachable')

  const result = await thrownBy(() =>
    withLogging({ functionName: 'checkout' }, async () => { throw fault })(makeCallableRequest('alice')),
  )

  const entries = readAllEntries(LOG_DIR)
  assert('exactly one entry', entries.length === 1, `got: ${entries.length}`)
  assert('it is an ERROR', entries[0]?.severity === 'ERROR', `got: ${entries[0]?.severity}`)
  assert('it has the error payload', errorPayloadOf(entries[0])?.message === 'ledger unreachable')
  assert('the same object is thrown again', result.threw && result.value === fault)
}

async function testStatusReadFromTheValuesOwnShape() {
  console.log('\nTest: any object with a numeric httpErrorCode.status below 500 is a WARNING')
  clearLog(LOG_DIR)
  const shaped = Object.assign(new Error('gone'), { code: 'not-found', httpErrorCode: { status: 404 } })
  await thrownBy(() => withLogging({ functionName: 'f' }, async () => { throw shaped })(makeCallableRequest('alice')))
  const [entry] = readAllEntries(LOG_DIR)
  assert('404 is a WARNING', entry?.severity === 'WARNING', `got: ${entry?.severity}`)

  clearLog(LOG_DIR)
  const stringStatus = Object.assign(new Error('odd'), { httpErrorCode: { status: '403' } })
  await thrownBy(() => withLogging({ functionName: 'f' }, async () => { throw stringStatus })(makeCallableRequest('alice')))
  assert('a non-numeric status is an ERROR', readLastEntry(LOG_DIR)?.severity === 'ERROR')
}

async function testLoggedThenRethrownInsideTheHandlerIsOneEntry() {
  console.log('\nTest: catch { logError(err); throw err } inside the handler gives one entry')
  clearLog(LOG_DIR)
  const original = new Error('card declined')

  const result = await thrownBy(() =>
    withLogging({ functionName: 'checkout' }, async () => {
      try {
        throw original
      } catch (err) {
        logError(err, undefined, { orderId: 'o_1' })
        throw err
      }
    })(makeCallableRequest('alice')),
  )

  const entries = readAllEntries(LOG_DIR)
  assert('exactly one entry', entries.length === 1, `got: ${entries.length}`)
  assert("it is the handler's own entry, with its context", (entries[0]?.jsonPayload?.context as { orderId?: string } | undefined)?.orderId === 'o_1')
  assert('the same object is thrown again', result.threw && result.value === original)
}

async function testALoggedErrorAndADifferentThrowAreTwoEntries() {
  console.log('\nTest: logging one error and throwing another gives two entries')
  clearLog(LOG_DIR)
  const logged = new Error('first')
  const thrown = new Error('second')

  const result = await thrownBy(() =>
    withLogging({ functionName: 'checkout' }, async () => {
      logError(logged)
      throw thrown
    })(makeCallableRequest('alice')),
  )

  const messages = readAllEntries(LOG_DIR).map((e) => e.message)
  assert('two entries', messages.length === 2, `got: ${JSON.stringify(messages)}`)
  assert('one for each error', messages.includes('first') && messages.includes('second'))
  assert('the second is thrown again', result.value === thrown)
}

async function testSynchronousThrowIsLoggedAndThrownAgain() {
  console.log('\nTest: a handler that throws synchronously is logged once and thrown again')
  clearLog(LOG_DIR)
  const original = new Error('sync boom')

  const result = await thrownBy(async () =>
    withLogging({ functionName: 'sync' }, () => { throw original })(makeCallableRequest('alice')),
  )

  const entries = readAllEntries(LOG_DIR)
  assert('exactly one entry', entries.length === 1, `got: ${entries.length}`)
  assert('it is an ERROR with the labels', entries[0]?.severity === 'ERROR' && entries[0]?.labels?.functionName === 'sync')
  assert('the same object is thrown again', result.threw && result.value === original)
}

async function testThrownPrimitivesAreLoggedOnceAndThrownAsTheyWere() {
  console.log('\nTest: a thrown string and a thrown undefined are logged once and thrown as they were')
  clearLog(LOG_DIR)
  const fromString = await thrownBy(() =>
    withLogging({ functionName: 'str' }, async () => { throw 'plain text' })(makeCallableRequest('alice')),
  )
  let entries = readAllEntries(LOG_DIR)
  assert('the string: one ERROR entry', entries.length === 1 && entries[0]?.severity === 'ERROR', `got: ${entries.length}`)
  assert('the string: the message is the text', entries[0]?.message === 'plain text')
  assert('the string: thrown again as the same string', fromString.threw && fromString.value === 'plain text')

  clearLog(LOG_DIR)
  const fromUndefined = await thrownBy(() =>
    withLogging({ functionName: 'undef' }, async () => { throw undefined })(makeCallableRequest('alice')),
  )
  entries = readAllEntries(LOG_DIR)
  assert('undefined: one ERROR entry', entries.length === 1 && entries[0]?.severity === 'ERROR', `got: ${entries.length}`)
  assert('undefined: thrown again as undefined', fromUndefined.threw && fromUndefined.value === undefined)

  clearLog(LOG_DIR)
  await thrownBy(() =>
    withLogging({ functionName: 'str' }, async () => { throw 'plain text' })(makeCallableRequest('alice')),
  )
  await thrownBy(() =>
    withLogging({ functionName: 'str' }, async () => { throw 'plain text' })(makeCallableRequest('alice')),
  )
  assert('the same string thrown by two requests is logged by each', readAllEntries(LOG_DIR).length === 2)
}

async function testNormalReturnWritesNothing() {
  console.log('\nTest: a handler that returns normally writes no entry')
  clearLog(LOG_DIR)
  await withLogging({ functionName: 'quiet' }, async () => 'fine')(makeCallableRequest('alice'))
  assert('no entry', readAllEntries(LOG_DIR).length === 0)
}

async function testScopeIsUnwoundAfterARejectedCall() {
  console.log('\nTest: after a rejected call, a log call outside carries no request labels')
  await thrownBy(() =>
    withLogging({ functionName: 'rejects' }, async () => { throw new Error('boom') })(makeCallableRequest('alice')),
  )
  clearLog(LOG_DIR)
  getLogger().info('outside')
  const labels = lastLabels()
  assert('no userId', labels.userId === undefined, `got: ${labels.userId}`)
  assert('no functionName', labels.functionName === undefined, `got: ${labels.functionName}`)
}

async function testNestedWithLoggingLogsOnce() {
  console.log('\nTest: a throw through two nested withLogging is logged once, by the inner one')
  clearLog(LOG_DIR)
  const original = new Error('deep')
  const inner = withLogging({ functionName: 'inner' }, async () => { throw original })

  const result = await thrownBy(() =>
    withLogging({ functionName: 'outer' }, async (request) => inner(request))(makeCallableRequest('alice')),
  )

  const entries = readAllEntries(LOG_DIR)
  assert('exactly one entry', entries.length === 1, `got: ${entries.length}`)
  assert('it carries the inner labels', entries[0]?.labels?.functionName === 'inner')
  assert('the same object reaches the caller', result.value === original)

  clearLog(LOG_DIR)
  const refusal = new HttpsError('not-found', 'nothing here')
  const innerRefusal = withLogging({ functionName: 'inner' }, async () => { throw refusal })
  await thrownBy(() =>
    withLogging({ functionName: 'outer' }, async (request) => innerRefusal(request))(makeCallableRequest('alice')),
  )
  const warnings = readAllEntries(LOG_DIR)
  assert('a nested 4xx is also one entry', warnings.length === 1 && warnings[0]?.severity === 'WARNING', `got: ${warnings.length}`)
}

// --- Runner ---

async function run() {
  // Order no longer matters. Every scope here is bound with run() and unwinds
  // when its handler settles, so a test asserting the ABSENCE of a scope can run
  // at any point. That was not true while initRequestLogger existed.
  testAnonymousFallback()

  await testWithLoggingDoesNotLeakAfterTheRequest()
  await testWithLoggingIsolatesConcurrentRequests()
  await testWithLoggingComputesLabelsPerRequest()
  await testWithLoggingReturnsTheHandlerResult()
  await testWithLoggingPropagatesErrors()
  await testPlainErrorIsLoggedOnceAndThrownAgain()
  await testRefusalWithClientStatusIsAWarning()
  await testStatusFiveHundredIsAnError()
  await testStatusReadFromTheValuesOwnShape()
  await testLoggedThenRethrownInsideTheHandlerIsOneEntry()
  await testALoggedErrorAndADifferentThrowAreTwoEntries()
  await testSynchronousThrowIsLoggedAndThrownAgain()
  await testThrownPrimitivesAreLoggedOnceAndThrownAsTheyWere()
  await testNormalReturnWritesNothing()
  await testScopeIsUnwoundAfterARejectedCall()
  await testNestedWithLoggingLogsOnce()

  await testSeedsRequestLabels()
  await testCustomLabelsAreSeeded()
  await testUndefinedLabelsAreStripped()
  await testPerCallLabelsOverrideSeeded()
  await testScheduleHandlerHasLabelsAndNoUserId()
  await testGetLoggerReturnsTheRequestWriter()
  await testScopeSurvivesAwait()
  await testSequentialRequestsAreIndependent()
  await testAllSeveritiesReachTheLog()


  fs.rmSync(LOG_DIR, { recursive: true, force: true })
  reportResults()
}

run().catch((err) => {
  fs.rmSync(LOG_DIR, { recursive: true, force: true })
  console.error('Fatal:', err)
  process.exit(1)
})
