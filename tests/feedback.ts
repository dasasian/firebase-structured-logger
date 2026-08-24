/**
 * User feedback capture (#9).
 *
 * The two exemptions are the whole reason this file exists. Feedback bypasses
 * the severity floor and the rate limiter, and both would otherwise drop it
 * silently — the floor only in PRODUCTION, since it defaults to DEBUG in the
 * emulator and WARNING live. A feature tested only under emulator defaults
 * would work perfectly in development and deliver nothing at all in production.
 *
 * Run: npx tsx tests/feedback.ts
 */

// Must come first — the client logger reads navigator at module load.
import { sessionStorageStub } from './browserStubs.js'

import { initLogger, sendFeedback } from '../src/client/logger.js'
import { configureRateLimiter, resetRateLimiter } from '../src/client/rateLimiter.js'
import { addBreadcrumb, clearBreadcrumbs, setCurrentScreen, MAX_BREADCRUMBS } from '../src/client/breadcrumbs.js'
import type { LogPayload, LogSeverity } from '../src/shared/types.js'
import { assert, reportResults } from './testHelpers.js'

let captured: LogPayload[] = []

function freshLogger(minLogLevel: LogSeverity = 'DEBUG') {
  captured = []
  clearBreadcrumbs()
  sessionStorageStub.failing = false
  configureRateLimiter({ sessionLimit: 50, duplicateLimit: 3 })
  resetRateLimiter()
  return initLogger({
    appId: 'acme',
    releaseId: 'r1',
    minLogLevel,
    logFunction: async (data) => { captured.push(data) },
  })
}

const flush = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 1)) }
const last = () => captured[captured.length - 1]

// --- The exemptions ---

async function testSurvivesTheProductionSeverityFloor() {
  console.log('\nTest: feedback survives a WARNING floor — the production default')
  freshLogger('WARNING')

  // NOTICE ranks below WARNING, so without the exemption send() returns before
  // the network call. In the emulator the floor is DEBUG, so this would pass
  // either way — which is exactly how the bug would reach production unseen.
  sendFeedback('the discount did not apply')
  await flush()

  assert('it was sent despite the floor', captured.length === 1, `got ${captured.length}`)
  assert('the text came through', last()?.message === 'the discount did not apply')
}

async function testAnOrdinaryNoticeStillRespectsTheFloor() {
  console.log('\nTest: the exemption keys on being feedback, not on NOTICE')
  const logger = freshLogger('WARNING')

  // If the exemption were keyed on the severity, we would have built a level
  // that silently defeats filtering for everyone.
  logger.info('routine chatter')
  await flush()
  assert('an INFO log is still dropped at a WARNING floor', captured.length === 0, `got ${captured.length}`)
}

async function testIgnoresTheSessionLimit() {
  console.log('\nTest: feedback is not counted against the session limit')
  freshLogger()
  configureRateLimiter({ sessionLimit: 2 })

  for (let i = 0; i < 5; i++) sendFeedback(`report ${i}`)
  await flush()

  assert('all five were sent', captured.length === 5, `got ${captured.length}`)
}

async function testIsNotDuplicateSuppressed() {
  console.log('\nTest: sending the same text twice is not suppressed')
  freshLogger()
  configureRateLimiter({ duplicateLimit: 1 })

  // Someone hitting send twice is not a duplicate error to throttle.
  sendFeedback('same complaint')
  sendFeedback('same complaint')
  sendFeedback('same complaint')
  await flush()

  assert('every submission arrived', captured.length === 3, `got ${captured.length}`)
}

async function testFeedbackDoesNotConsumeTheBudgetForOtherLogs() {
  console.log('\nTest: feedback does not eat the budget real logs need')
  const logger = freshLogger()
  configureRateLimiter({ sessionLimit: 3, duplicateLimit: 99 })

  for (let i = 0; i < 10; i++) sendFeedback(`report ${i}`)
  await flush()
  const afterFeedback = captured.length

  logger.error(new Error('a real error'))
  await flush()

  assert('the feedback all went', afterFeedback === 10, `got ${afterFeedback}`)
  assert('an error afterwards still had budget', captured.length === 11, 'feedback consumed the session limit')
}

// --- The payload ---

async function testSeverityIsNotice() {
  console.log('\nTest: feedback is emitted at NOTICE')
  freshLogger()
  sendFeedback('hello')
  await flush()
  assert('severity is NOTICE', last()?.severity === 'NOTICE', `got: ${last()?.severity}`)
}

async function testCarriesTheBreadcrumbTrail() {
  console.log('\nTest: the breadcrumb trail rides along — the reason this is actionable')
  freshLogger()

  setCurrentScreen('Checkout')
  addBreadcrumb('action', 'apply_discount', { code: 'SUMMER' })
  addBreadcrumb('state', 'total_recalculated')
  addBreadcrumb('action', 'tap_place_order')

  sendFeedback('the discount did not apply')
  await flush()

  const names = (last()?.jsonPayload?.breadcrumbs ?? []).map((b) => b.name)
  assert('the trail is attached', names.length === 4, `got: ${names.join(',')}`)
  assert('the nav breadcrumb is there', names.includes('navigate_Checkout'))
  assert('the action is there', names.includes('apply_discount'))
  assert('order is preserved', names[names.length - 1] === 'tap_place_order', `got: ${names.join(',')}`)
}

async function testCarriesTheSameLabelsAsAnyLog() {
  console.log('\nTest: feedback carries the labels every log carries')
  const logger = freshLogger()
  logger.setUser('u_8f2a', { organizationId: 'org_42' })
  setCurrentScreen('Checkout')

  sendFeedback('something is off')
  await flush()

  const l = last()?.labels
  assert('appId', l?.appId === 'acme')
  assert('releaseId', l?.releaseId === 'r1')
  assert('userId', l?.userId === 'u_8f2a')
  assert('screen', l?.screen === 'Checkout')
  assert('platform', !!l?.platform)
  assert('browser', !!l?.browser)
  assert('the org label seeded via setUser', l?.organizationId === 'org_42', `got: ${l?.organizationId}`)
  assert('a feedback marker for filtering', l?.feedback === 'true', `got: ${l?.feedback}`)
}

async function testCustomLabels() {
  console.log('\nTest: app-supplied labels come through — there is no separate "type"')
  freshLogger()
  sendFeedback('checkout is confusing', { labels: { source: 'checkout-widget', ticketId: 't_9' } })
  await flush()

  assert('a custom label', last()?.labels.source === 'checkout-widget')
  assert('an app-owned correlation id', last()?.labels.ticketId === 't_9')
  assert('the feedback marker survives alongside', last()?.labels.feedback === 'true')
}

// --- Attachments ---

async function testScreenshotAttaches() {
  console.log('\nTest: a screenshot attaches')
  freshLogger()
  sendFeedback('look at this', { attachments: { screenshot: new Blob(['png-bytes']) } })
  await flush()

  assert('the attachment is present', !!last()?.attachments?.screenshot)
  assert('base64 encoded', last()?.attachments?.screenshot === Buffer.from('png-bytes').toString('base64'))
}

async function testUnreadableScreenshotDoesNotLoseTheReport() {
  console.log('\nTest: an unreadable screenshot does not take the report with it')
  freshLogger()

  // A File picked from <input type="file"> and then moved or deleted raises
  // NotReadableError — exactly the shape of a feedback form.
  sendFeedback('the discount did not apply', {
    attachments: { screenshot: { not: 'a blob' } as unknown as Blob },
  })
  await flush()

  assert('the report still arrived', captured.length === 1, 'the whole report was lost with the screenshot')
  assert('the text survived', last()?.message === 'the discount did not apply')
  assert('the failure is recorded', last()?.labels.attachmentsFailed === 'screenshot')
}

// --- Retention and transmission are one rule ---

async function testTheWholeRetainedTrailIsSent() {
  console.log('\nTest: everything retained is everything sent')

  // These were two numbers: the trail retained 50 and the send path asked for
  // 20. Nothing failed — the 30 oldest were simply unreachable, kept in memory
  // for a reader that did not exist, and absent from every log without a word.
  // Asserting the exact retained count is what makes them one rule again;
  // lowering either number alone fails here.
  const logger = freshLogger()

  const overflow = MAX_BREADCRUMBS + 10
  for (let i = 1; i <= overflow; i++) addBreadcrumb('action', `step_${i}`)

  logger.error(new Error('boom'))
  await flush()

  const sent = last()?.jsonPayload?.breadcrumbs ?? []
  assert('the trail is sent at its retained size', sent.length === MAX_BREADCRUMBS,
    `retains ${MAX_BREADCRUMBS}, sent ${sent.length}`)
  assert('the newest step is included', sent[sent.length - 1]?.name === `step_${overflow}`,
    `got: ${sent[sent.length - 1]?.name}`)
  assert('the oldest retained step is included, not trimmed again on the way out',
    sent[0]?.name === `step_${overflow - MAX_BREADCRUMBS + 1}`, `got: ${sent[0]?.name}`)
}

// --- Runner ---

async function run() {
  await testSurvivesTheProductionSeverityFloor()
  await testAnOrdinaryNoticeStillRespectsTheFloor()
  await testIgnoresTheSessionLimit()
  await testIsNotDuplicateSuppressed()
  await testFeedbackDoesNotConsumeTheBudgetForOtherLogs()
  await testSeverityIsNotice()
  await testCarriesTheBreadcrumbTrail()
  await testCarriesTheSameLabelsAsAnyLog()
  await testCustomLabels()
  await testScreenshotAttaches()
  await testUnreadableScreenshotDoesNotLoseTheReport()
  await testTheWholeRetainedTrailIsSent()

  reportResults()
}

run().catch((err) => { console.error('Fatal:', err); process.exit(1) })
