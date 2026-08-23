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
import { initLogger } from '../src/functions/logger.js'
import { withLogging, initRequestLogger, getLogger } from '../src/functions/requestLogger.js'
import { assert, reportResults, readLastEntry, clearLog } from './testHelpers.js'

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

// --- Label seeding ---

function testSeedsRequestLabels() {
  console.log('\nTest: request labels are seeded on every log in the request')
  clearLog(LOG_DIR)

  const writer = initRequestLogger(makeCallableRequest('user_abc'), {
    functionName: 'createProduct',
    appId: 'acme',
  })

  writer.info('started')

  const labels = lastLabels()
  assert('functionName is seeded', labels.functionName === 'createProduct', `got: ${labels.functionName}`)
  assert('userId comes from request.auth', labels.userId === 'user_abc', `got: ${labels.userId}`)
  assert('appId is seeded', labels.appId === 'acme')
}

function testCustomLabelsAreSeeded() {
  console.log('\nTest: caller-supplied labels are seeded too')
  clearLog(LOG_DIR)

  const writer = initRequestLogger(makeCallableRequest('user_abc'), {
    functionName: 'createProduct',
    labels: { organizationId: 'org_42', tenant: 'acme' },
  })

  writer.info('started')

  const labels = lastLabels()
  assert('a custom label is seeded', labels.organizationId === 'org_42', `got: ${labels.organizationId}`)
  assert('a second custom label is seeded', labels.tenant === 'acme')
  assert('built-in labels survive alongside them', labels.functionName === 'createProduct')
}

function testUndefinedLabelsAreStripped() {
  console.log('\nTest: undefined labels are stripped, not written as "undefined"')
  clearLog(LOG_DIR)

  // No auth, no appId, no extra labels.
  const writer = initRequestLogger(makeCallableRequest(), { functionName: 'anonFunc' })
  writer.info('started')

  const labels = lastLabels()
  assert('functionName is present', labels.functionName === 'anonFunc')
  assert('userId is absent, not the string "undefined"', !('userId' in labels), `got: ${labels.userId}`)
  assert('appId is absent', !('appId' in labels))
}

function testPerCallLabelsOverrideSeeded() {
  console.log('\nTest: per-call labels override the seeded ones')
  clearLog(LOG_DIR)

  const writer = initRequestLogger(makeCallableRequest('user_abc'), {
    functionName: 'createProduct',
    labels: { stage: 'start' },
  })

  writer.info('finished', { stage: 'end' })

  const labels = lastLabels()
  assert('the per-call label wins', labels.stage === 'end', `got: ${labels.stage}`)
  assert('untouched seeded labels survive', labels.functionName === 'createProduct')
}

// --- Scoping ---

function testGetLoggerReturnsTheRequestWriter() {
  console.log('\nTest: getLogger returns the request-scoped writer')
  clearLog(LOG_DIR)

  initRequestLogger(makeCallableRequest('user_xyz'), { functionName: 'scopedFunc' })

  getLogger().info('written through getLogger')

  const labels = lastLabels()
  assert('the request labels are present', labels.functionName === 'scopedFunc', `got: ${labels.functionName}`)
  assert('the request user is present', labels.userId === 'user_xyz')
}

async function testScopeSurvivesAwait() {
  console.log('\nTest: the request scope survives an await')
  clearLog(LOG_DIR)

  initRequestLogger(makeCallableRequest('user_async'), { functionName: 'asyncFunc' })

  await new Promise((resolve) => setTimeout(resolve, 1))
  getLogger().info('after await')

  const labels = lastLabels()
  assert('labels survive the await', labels.functionName === 'asyncFunc', `got: ${labels.functionName}`)
  assert('the user survives the await', labels.userId === 'user_async')
}

function testLaterRequestReplacesEarlierOne() {
  console.log('\nTest: a later request replaces the earlier scope')
  clearLog(LOG_DIR)

  initRequestLogger(makeCallableRequest('user_one'), { functionName: 'first' })
  initRequestLogger(makeCallableRequest('user_two'), { functionName: 'second' })

  getLogger().info('which request am I in?')

  const labels = lastLabels()
  assert('the newest request wins', labels.functionName === 'second', `got: ${labels.functionName}`)
  assert('the newest user wins', labels.userId === 'user_two', `got: ${labels.userId}`)
  assert('the old user is gone', labels.userId !== 'user_one')
}

// --- Fallback outside a request ---

/**
 * MUST run before any initRequestLogger call. `enterWith` sets the store for
 * the whole current execution context, so once a request scope is entered
 * there is no way back to "outside a request" in this process.
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

function testAllSeveritiesReachTheLog() {
  console.log('\nTest: every severity from the request writer reaches the log')
  const writer = initRequestLogger(makeCallableRequest('user_abc'), { functionName: 'severityFunc' })

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

function testInitRequestLoggerStillLeaks() {
  console.log('\nTest: the deprecated path still leaks — documented, not fixed')
  clearLog(LOG_DIR)

  // Kept working for one version so consumers can migrate deliberately. The
  // leak is the reason it is deprecated, so it is asserted rather than assumed.
  initRequestLogger(makeCallableRequest('carol'), { functionName: 'legacy' })
  getLogger().info('inside')
  assert('the request is labelled', lastLabels().userId === 'carol')

  clearLog(LOG_DIR)
  getLogger().info('after, with no scope of its own')
  assert(
    'the previous request\'s id leaks into a later unscoped call',
    lastLabels().userId === 'carol',
    'if this now passes as undefined, initRequestLogger was fixed and this test should go',
  )
}

// --- Runner ---

async function run() {
  // ORDER MATTERS, and the reason is the bug this file documents.
  //
  // initRequestLogger binds with enterWith(), which is never unwound — once any
  // test calls it, the scope persists for the rest of the process. So every
  // test that asserts on the ABSENCE of a scope has to run before the first
  // leaky call: the anonymous fallback, and the withLogging isolation tests.
  //
  // testInitRequestLoggerStillLeaks goes last, since leaking is its point.
  testAnonymousFallback()

  await testWithLoggingDoesNotLeakAfterTheRequest()
  await testWithLoggingIsolatesConcurrentRequests()
  await testWithLoggingComputesLabelsPerRequest()
  await testWithLoggingReturnsTheHandlerResult()
  await testWithLoggingPropagatesErrors()

  testSeedsRequestLabels()
  testCustomLabelsAreSeeded()
  testUndefinedLabelsAreStripped()
  testPerCallLabelsOverrideSeeded()
  testGetLoggerReturnsTheRequestWriter()
  await testScopeSurvivesAwait()
  testLaterRequestReplacesEarlierOne()
  testAllSeveritiesReachTheLog()

  testInitRequestLoggerStillLeaks()

  fs.rmSync(LOG_DIR, { recursive: true, force: true })
  reportResults()
}

run().catch((err) => {
  fs.rmSync(LOG_DIR, { recursive: true, force: true })
  console.error('Fatal:', err)
  process.exit(1)
})
