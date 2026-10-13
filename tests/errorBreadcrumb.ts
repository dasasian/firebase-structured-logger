/**
 * Every error that reaches the client logger leaves one `error` breadcrumb, sent or not, and
 * never twice in a row (#88, #94).
 *
 * Every case reads the trail of an entry that actually shipped, through the logger's own
 * `logFunction`. Feedback is the probe for "the breadcrumb is in the trail when `error()`
 * returns": it is sent on the next line, in the same tick, and its trail is what is checked.
 *
 * Run: npx tsx tests/errorBreadcrumb.ts
 */

// Must come first — supplies Blob/FileReader, window events, and the logger reads navigator
// at module load.
import { dispatchErrorEvent, dispatchRejectionEvent, sessionStorageStub, setVisibility, withFrozenTime } from './browserStubs.js'

import { initLogger, sendFeedback } from '../src/client/logger.js'
import { setupGlobalErrorHandler, handleReactError, handleVueError } from '../src/client/errorHandler.js'
import { configureRateLimiter, resetRateLimiter } from '../src/client/rateLimiter.js'
import { addBreadcrumb, clearBreadcrumbs } from '../src/client/breadcrumbs.js'
import type { BreadcrumbEntry, LogPayload, LogSeverity } from '../src/shared/types.js'
import { assert, reportResults } from './testHelpers.js'

let sent: LogPayload[] = []

function freshLogger(options: { minSeverity?: LogSeverity; burstLimit?: number; duplicateLimit?: number } = {}) {
  sent = []
  clearBreadcrumbs()
  sessionStorageStub.failing = false
  configureRateLimiter({ burstLimit: options.burstLimit ?? 100, duplicateLimit: options.duplicateLimit ?? 99 })
  resetRateLimiter()
  return initLogger({
    appId: 'acme',
    releaseId: 'r1',
    minSeverity: options.minSeverity ?? 'DEBUG',
    logFunction: async (data) => {
      sent.push(data)
    },
  })
}

const settle = async () => {
  for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 1))
}

function trailOf(entry: LogPayload | undefined): BreadcrumbEntry[] {
  return (entry?.jsonPayload?.breadcrumbs ?? []) as BreadcrumbEntry[]
}

function errorCrumbNames(entry: LogPayload | undefined): string[] {
  return trailOf(entry)
    .filter((crumb) => crumb.type === 'error')
    .map((crumb) => crumb.name)
}

function feedbackEntry(): LogPayload | undefined {
  return sent.find((entry) => entry.labels.feedback === 'true')
}

async function testSecondErrorHoldsTheFirstAndNotItself() {
  console.log('\nTest: error A then error B — B holds A, A holds nothing of its own')
  const logger = freshLogger()
  logger.error(new TypeError('a failed'))
  logger.error(new RangeError('b failed'))
  await settle()

  const [entryA, entryB] = sent
  assert('A holds no error breadcrumb', errorCrumbNames(entryA).length === 0, JSON.stringify(errorCrumbNames(entryA)))
  assert('B holds exactly A, named with A\'s errorType', JSON.stringify(errorCrumbNames(entryB)) === '["TypeError"]', JSON.stringify(errorCrumbNames(entryB)))
}

async function testFeedbackOnTheNextLineCarriesTheError() {
  console.log('\nTest: logger.error(x) then sendFeedback on the next line, same tick')
  const logger = freshLogger()
  logger.error(new TypeError('boom'))
  sendFeedback('it broke')
  await settle()

  assert('the feedback trail holds the error', JSON.stringify(errorCrumbNames(feedbackEntry())) === '["TypeError"]', JSON.stringify(errorCrumbNames(feedbackEntry())))
}

async function testAttachmentsDoNotChangeWhereTheTrailIsRead() {
  console.log('\nTest: an error entry with an attachment — own trail has no own breadcrumb, feedback in the same tick has it')
  for (const [label, attachment] of [
    ['a string', 'aGk='],
    ['a Blob read asynchronously', new Blob(['hello'], { type: 'text/plain' })],
  ] as const) {
    const logger = freshLogger()
    logger.error(new TypeError('with file'), undefined, undefined, { note: attachment })
    sendFeedback('it broke')
    await settle()

    const errorEntry = sent.find((entry) => entry.severity === 'ERROR')
    assert(`${label}: the attachment was sent`, errorEntry?.attachments?.note !== undefined)
    assert(`${label}: the error entry holds no breadcrumb of its own`, errorCrumbNames(errorEntry).length === 0, JSON.stringify(errorCrumbNames(errorEntry)))
    assert(`${label}: the feedback holds it`, JSON.stringify(errorCrumbNames(feedbackEntry())) === '["TypeError"]', JSON.stringify(errorCrumbNames(feedbackEntry())))
  }
}

async function testBreadcrumbAddedDuringAttachmentReadStaysOutOfTheEntry() {
  console.log('\nTest: a breadcrumb added while the attachment is being read is not in that entry\'s trail')
  const logger = freshLogger()
  logger.error(new TypeError('with file'), undefined, undefined, { note: new Blob(['hello']) })
  addBreadcrumb('action', 'clicked_while_reading')
  await settle()

  const trail = trailOf(sent[0]).map((crumb) => crumb.name)
  assert('the trail is the one at the moment of the call', !trail.includes('clicked_while_reading') && !trail.includes('TypeError'), JSON.stringify(trail))
}

async function testADuplicateAfterTheFirstBreadcrumbAgedOutLeavesABreadcrumb() {
  console.log('\nTest: a duplicate six minutes after the first error leaves a breadcrumb, and feedback after it holds the error')
  const logger = freshLogger({ duplicateLimit: 1 })
  const start = Date.now()
  const sixMinutes = 6 * 60 * 1000
  withFrozenTime(start, () => logger.error(new TypeError('same')))
  withFrozenTime(start + sixMinutes, () => logger.error(new TypeError('same')))
  withFrozenTime(start + sixMinutes + 1, () => sendFeedback('probe'))
  await settle()

  const errorEntries = sent.filter((entry) => entry.severity === 'ERROR')
  assert('the second error was a duplicate, not sent', errorEntries.length === 1, String(errorEntries.length))
  assert('the feedback trail holds the duplicate\'s breadcrumb', JSON.stringify(errorCrumbNames(feedbackEntry())) === '["TypeError"]', JSON.stringify(errorCrumbNames(feedbackEntry())))
}

async function testTheSameErrorFiftyTimesLeavesOneBreadcrumb() {
  console.log('\nTest: the same error fifty times with nothing between')
  const logger = freshLogger()
  for (let i = 0; i < 50; i++) logger.error(new TypeError('loop'))
  sendFeedback('probe')
  await settle()

  assert('one breadcrumb', JSON.stringify(errorCrumbNames(feedbackEntry())) === '["TypeError"]', JSON.stringify(errorCrumbNames(feedbackEntry())))
}

async function testErrorActionErrorLeavesThreeBreadcrumbsInOrder() {
  console.log('\nTest: error, action, the same error')
  const logger = freshLogger()
  logger.error(new TypeError('again'))
  addBreadcrumb('action', 'retry')
  logger.error(new TypeError('again'))
  sendFeedback('probe')
  await settle()

  const trail = trailOf(feedbackEntry()).map((crumb) => `${crumb.type}:${crumb.name}`)
  assert('three breadcrumbs in order', JSON.stringify(trail) === '["error:TypeError","action:retry","error:TypeError"]', JSON.stringify(trail))
}

async function testAnErrorTheBudgetRefusesLeavesABreadcrumb() {
  console.log('\nTest: an error the session budget refuses leaves a breadcrumb')
  const logger = freshLogger({ burstLimit: 2 })
  logger.error(new TypeError('one'))
  logger.error(new RangeError('two'))
  logger.error(new EvalError('three'))
  sendFeedback('probe')
  await settle()

  const errorEntries = sent.filter((entry) => entry.severity === 'ERROR')
  assert('the third error was refused by the budget', errorEntries.length === 2, String(errorEntries.length))
  assert('all three left a breadcrumb', JSON.stringify(errorCrumbNames(feedbackEntry())) === '["TypeError","RangeError","EvalError"]', JSON.stringify(errorCrumbNames(feedbackEntry())))
}

async function testASentEntryTrailDoesNotHoldItsOwnBreadcrumb() {
  console.log('\nTest: the trail of a sent error entry holds what came before it and not its own breadcrumb')
  const logger = freshLogger()
  addBreadcrumb('action', 'pay')
  logger.error(new TypeError('first'))
  logger.error(new RangeError('second'))
  await settle()

  const [first, second] = sent
  assert('the first holds only the action', JSON.stringify(trailOf(first).map((crumb) => crumb.name)) === '["pay"]', JSON.stringify(trailOf(first)))
  assert('the second holds the action and the first error, not its own', JSON.stringify(trailOf(second).map((crumb) => crumb.name)) === '["pay","TypeError"]', JSON.stringify(trailOf(second)))
}

async function testNoBreadcrumbForEntriesWithoutAnError() {
  console.log('\nTest: warning, info, debug, feedback and an entry below the floor add no breadcrumb')
  const logger = freshLogger()
  logger.warning('w')
  logger.info('i')
  logger.debug('d')
  sendFeedback('f')
  await settle()
  sendFeedback('probe')
  await settle()
  assert('the trail of the last feedback holds no error breadcrumb', errorCrumbNames(sent[sent.length - 1]).length === 0, JSON.stringify(errorCrumbNames(sent[sent.length - 1])))

  const floored = freshLogger({ minSeverity: 'ERROR' })
  floored.info('below the floor')
  floored.warning('below the floor')
  sendFeedback('probe')
  await settle()
  assert('only the feedback was sent', sent.length === 1, String(sent.length))
  assert('the trail holds no error breadcrumb', errorCrumbNames(feedbackEntry()).length === 0, JSON.stringify(errorCrumbNames(feedbackEntry())))
}

async function testARepeatSummaryAddsNoBreadcrumb() {
  console.log('\nTest: a repeat summary adds no breadcrumb')
  const logger = freshLogger({ duplicateLimit: 3 })
  for (let i = 0; i < 5; i++) logger.error(new TypeError('summarised'))
  await settle()
  addBreadcrumb('action', 'after_the_errors')
  setVisibility('hidden')
  await settle()
  setVisibility('visible')

  assert('a summary was sent', sent.some((entry) => entry.labels.repeatOf !== undefined))
  sendFeedback('probe')
  await settle()
  assert('five errors in a row -> one breadcrumb, none from the summary', JSON.stringify(errorCrumbNames(feedbackEntry())) === '["TypeError"]', JSON.stringify(errorCrumbNames(feedbackEntry())))
}

async function testTheBreadcrumbHoldsTheTypeAndNothingElse() {
  console.log('\nTest: the breadcrumb is the errorType label, with no data, message or stack')
  const logger = freshLogger()
  logger.error(new TypeError('card number 4111 declined'), { errorType: 'PaymentDeclined' })
  sendFeedback('probe')
  await settle()

  const crumb = trailOf(feedbackEntry()).find((entry) => entry.type === 'error')
  assert('it is named with the errorType label', crumb?.name === 'PaymentDeclined', crumb?.name)
  assert('it has no data', crumb?.data === undefined, JSON.stringify(crumb?.data))
  assert('it holds neither message nor stack', !JSON.stringify(crumb).includes('4111') && !JSON.stringify(crumb).includes(' at '), JSON.stringify(crumb))
}

async function testAFloodLeavesAsManyBreadcrumbsAsFullCopies() {
  console.log('\nTest: the same error 20 times in a loop, with the limiter letting 3 through')
  const logger = freshLogger({ duplicateLimit: 3 })
  for (let i = 0; i < 20; i++) logger.error(new TypeError('flood'))
  sendFeedback('probe')
  await settle()

  const fullCopies = sent.filter((entry) => entry.severity === 'ERROR')
  const crumbs = errorCrumbNames(feedbackEntry()).length
  assert('the limiter let 3 through', fullCopies.length === 3, String(fullCopies.length))
  assert('what the limiter decides does not change the breadcrumbs: one for the whole loop', crumbs === 1, String(crumbs))
}

function signatureKeysFor(message: string): string[] {
  const state = JSON.parse(sessionStorageStub.peek('fsl_ratelimit') ?? '{}') as { signatures?: Record<string, unknown> }
  return Object.keys(state.signatures ?? {}).filter((key) => key.includes(message))
}

async function testTheRepeatSignatureIgnoresEarlierLoggedErrors() {
  console.log('\nTest: the repeat signature of an error is the same with and without earlier logged errors')
  const alone = freshLogger()
  addBreadcrumb('action', 'pay')
  alone.error(new TypeError('signed'))
  const keysAlone = signatureKeysFor('signed')

  const afterOthers = freshLogger()
  addBreadcrumb('action', 'pay')
  afterOthers.error(new RangeError('earlier one'))
  afterOthers.error(new EvalError('earlier two'))
  afterOthers.error(new TypeError('signed'))
  const keysAfterOthers = signatureKeysFor('signed')
  await settle()

  assert('one key each', keysAlone.length === 1 && keysAfterOthers.length === 1, `${keysAlone.length}, ${keysAfterOthers.length}`)
  assert('the keys are equal', keysAlone[0] === keysAfterOthers[0], `${keysAlone[0]} vs ${keysAfterOthers[0]}`)
}

async function testEveryWayInSharesTheOnePathThroughError() {
  console.log('\nTest: the global handler, the React hook and the Vue hook each leave the breadcrumb with no code of their own')
  setupGlobalErrorHandler()
  const realConsoleError = console.error
  console.error = () => {}
  try {
    const cases: [string, () => void, string][] = [
      ['window error event', () => dispatchErrorEvent({ error: new TypeError('uncaught') }), 'UncaughtError'],
      ['cross-origin script error', () => dispatchErrorEvent({ message: 'Script error.' }), 'CrossOriginError'],
      ['unhandled rejection', () => dispatchRejectionEvent(new Error('rejected')), 'UnhandledRejection'],
      ['handleReactError', () => handleReactError(new Error('render'), { componentStack: '\n at X' }), 'ReactError'],
      ['handleVueError', () => handleVueError(new Error('component'), null, 'render function'), 'VueError'],
    ]
    for (const [label, trigger, expectedName] of cases) {
      freshLogger()
      trigger()
      sendFeedback('probe')
      await settle()
      assert(`${label}: the feedback trail holds ${expectedName}`, JSON.stringify(errorCrumbNames(feedbackEntry())) === JSON.stringify([expectedName]), JSON.stringify(errorCrumbNames(feedbackEntry())))
    }
  } finally {
    console.error = realConsoleError
  }
}

async function main(): Promise<void> {
  await testSecondErrorHoldsTheFirstAndNotItself()
  await testFeedbackOnTheNextLineCarriesTheError()
  await testAttachmentsDoNotChangeWhereTheTrailIsRead()
  await testBreadcrumbAddedDuringAttachmentReadStaysOutOfTheEntry()
  await testADuplicateAfterTheFirstBreadcrumbAgedOutLeavesABreadcrumb()
  await testTheSameErrorFiftyTimesLeavesOneBreadcrumb()
  await testErrorActionErrorLeavesThreeBreadcrumbsInOrder()
  await testAnErrorTheBudgetRefusesLeavesABreadcrumb()
  await testASentEntryTrailDoesNotHoldItsOwnBreadcrumb()
  await testNoBreadcrumbForEntriesWithoutAnError()
  await testARepeatSummaryAddsNoBreadcrumb()
  await testTheBreadcrumbHoldsTheTypeAndNothingElse()
  await testAFloodLeavesAsManyBreadcrumbsAsFullCopies()
  await testTheRepeatSignatureIgnoresEarlierLoggedErrors()
  await testEveryWayInSharesTheOnePathThroughError()
  reportResults()
}

main()
