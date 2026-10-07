/**
 * `enableViews()` and `data-fsl-view` — `@dasasian/firebase-structured-logger/client/views` (#58).
 *
 * Views are read when an entry is written (CLAUDE.md), from the visible
 * `[data-fsl-view]` marks in page order — no listeners, no observers, no
 * open/close calls. Covers the `checkVisibility()`/`getClientRects()` split
 * (both stubbed in browserStubs.ts off the same inline-style rule, since
 * jsdom has neither real visibility nor layout), that a repeat summary
 * carries no `view`, that two views of the same error still collapse to one
 * repeat signature, and that `view` survives the functions-side relay
 * (`createClientLogHandler`, emulator mode).
 *
 * Run: FUNCTIONS_EMULATOR=true npx tsx tests/views.ts
 */

import fs from 'fs'
import '../tests/browserStubs.js'

if (process.env.FUNCTIONS_EMULATOR !== 'true') {
  console.error('Run with: FUNCTIONS_EMULATOR=true npx tsx tests/views.ts')
  process.exit(1)
}

const LOG_DIR = './test-views-output'

import { initializeApp } from 'firebase-admin/app'
import { enableViews } from '../src/client/views.js'
import { getActiveView } from '../src/client/breadcrumbs.js'
import { initLogger } from '../src/client/logger.js'
import { configureRateLimiter, resetRateLimiter, flushDueSummaries } from '../src/client/rateLimiter.js'
import { initLogger as initFunctionsLogger } from '../src/functions/logger.js'
import { createClientLogHandler } from '../src/functions/logHandler.js'
import { assert, reportResults, readLastEntry, clearLog, makeRequest } from './testHelpers.js'
import { jsdomWindow, removeCheckVisibilityStub } from './browserStubs.js'
import type { LogPayload } from '../src/shared/types.js'

initializeApp({ projectId: 'demo-project' })
fs.mkdirSync(LOG_DIR, { recursive: true })
initFunctionsLogger({ appId: 'views-test', logLocalDir: LOG_DIR })

const doc = jsdomWindow.document

type HideBy = 'display' | 'opacity' | 'visibility'

function mark(name: string, hideBy?: HideBy | true): HTMLElement {
  const el = doc.createElement('div')
  el.setAttribute('data-fsl-view', name)
  if (hideBy === true || hideBy === 'display') el.style.display = 'none'
  if (hideBy === 'opacity') el.style.opacity = '0'
  if (hideBy === 'visibility') el.style.visibility = 'hidden'
  doc.body.appendChild(el)
  return el
}

function clearMarks(): void {
  doc.body.innerHTML = ''
}

let sent: LogPayload[] = []
function resetSent(): void {
  sent = []
}

const logger = initLogger({
  appId: 'views-test',
  releaseId: 'r1',
  minSeverity: 'DEBUG',
  logFunction: async (data) => void sent.push(data),
})

/** `Logger.error` is fire-and-forget; the send resolves on a later microtask. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

// --- Never enabled ---

async function testNeverEnabledGivesNoViewLabel() {
  console.log('\nTest: views never enabled — no view key, even with marks in the page')
  clearMarks()
  resetSent()
  mark('payment')
  logger.error(new Error('before enableViews'))
  await flush()
  assert('no view label', sent[0]?.labels.view === undefined, JSON.stringify(sent[0]?.labels))
}

// --- Visible marks join in page order ---

async function testVisibleMarksJoinInPageOrder() {
  console.log('\nTest: two visible marks join in page order')
  clearMarks()
  resetSent()
  enableViews()
  mark('payment')
  mark('Attachment')
  logger.error(new Error('boom'))
  await flush()
  assert('view joins in page order', sent[0]?.labels.view === 'payment › Attachment', JSON.stringify(sent[0]?.labels))
}

// --- Hidden marks are excluded ---

function testHiddenMarkIsExcluded() {
  console.log('\nTest: a mark checkVisibility reports hidden is left out')
  clearMarks()
  mark('visible')
  mark('hidden', true)
  assert('only the visible mark is read', getActiveView() === 'visible', String(getActiveView()))
}

async function testNoneVisibleGivesNoViewLabel() {
  console.log('\nTest: none visible — no view key')
  clearMarks()
  resetSent()
  mark('hidden-one', true)
  mark('hidden-two', true)
  logger.error(new Error('all hidden'))
  await flush()
  assert('no view label', sent[0]?.labels.view === undefined, JSON.stringify(sent[0]?.labels))
}

function testOpacityZeroMarkIsExcluded() {
  console.log('\nTest: an opacity: 0 mark is left out')
  clearMarks()
  mark('visible')
  mark('faded', 'opacity')
  assert('only the visible mark is read', getActiveView() === 'visible', String(getActiveView()))
}

function testVisibilityHiddenMarkIsExcluded() {
  console.log('\nTest: a visibility: hidden mark is left out')
  clearMarks()
  mark('visible')
  mark('invisible', 'visibility')
  assert('only the visible mark is read', getActiveView() === 'visible', String(getActiveView()))
}

// --- The getClientRects fallback ---

function testGetClientRectsFallbackDecidesWithoutCheckVisibility() {
  console.log('\nTest: without checkVisibility, the getClientRects fallback decides')
  clearMarks()
  mark('visible')
  mark('hidden', true)
  const restore = removeCheckVisibilityStub()
  try {
    assert('the fallback still finds only the visible mark', getActiveView() === 'visible', String(getActiveView()))
  } finally {
    restore()
  }
}

// --- Repeat summaries carry no view ---

async function testRepeatSummaryCarriesNoView() {
  console.log('\nTest: a repeat summary has no view, even with a mark visible when it is sent')
  clearMarks()
  resetSent()
  configureRateLimiter({ burstLimit: 50, duplicateLimit: 1, reservedForErrors: 0 })
  resetRateLimiter()
  mark('dashboard')

  logger.error(new Error('flaky'))
  logger.error(new Error('flaky'))
  await flush()

  flushDueSummaries(true)
  logger.sendPendingSummaries()
  await flush()

  const summary = sent.find((entry) => entry.labels.repeatCount !== undefined)
  assert('a repeat summary was sent', summary !== undefined, JSON.stringify(sent))
  assert('it carries no view', summary?.labels.view === undefined, JSON.stringify(summary?.labels))
}

// --- One repeat signature across two views ---

async function testSameErrorDifferentViewsOneSignature() {
  console.log('\nTest: the same error with two different views gives one repeat signature')
  clearMarks()
  resetSent()
  configureRateLimiter({ burstLimit: 50, duplicateLimit: 1, reservedForErrors: 0 })
  resetRateLimiter()

  mark('viewA')
  logger.error(new Error('collapses'))
  await flush()

  clearMarks()
  mark('viewB')
  logger.error(new Error('collapses'))
  await flush()

  assert('only the first full copy was sent — the second was counted as a duplicate', sent.length === 1, JSON.stringify(sent.map((e) => e.labels.view)))
}

// --- Functions-side relay ---

async function testViewSurvivesTheFunctionsSideRelay() {
  console.log('\nTest: an entry relayed through createClientLogHandler keeps view')
  clearLog(LOG_DIR)
  const handler = createClientLogHandler({})

  await handler(makeRequest({
    message: 'relayed error',
    severity: 'ERROR',
    labels: {
      appId: 'views-test',
      releaseId: 'r1',
      errorType: 'Error',
      view: 'payment › Attachment',
    },
  }))

  const entry = readLastEntry(LOG_DIR)
  assert('entry was written', entry !== undefined)
  assert('view survived the relay', (entry?.labels as Record<string, string>)?.view === 'payment › Attachment', JSON.stringify(entry?.labels))
}

async function run() {
  await testNeverEnabledGivesNoViewLabel()
  await testVisibleMarksJoinInPageOrder()
  testHiddenMarkIsExcluded()
  await testNoneVisibleGivesNoViewLabel()
  testOpacityZeroMarkIsExcluded()
  testVisibilityHiddenMarkIsExcluded()
  testGetClientRectsFallbackDecidesWithoutCheckVisibility()
  await testRepeatSummaryCarriesNoView()
  await testSameErrorDifferentViewsOneSignature()
  await testViewSurvivesTheFunctionsSideRelay()
  fs.rmSync(LOG_DIR, { recursive: true, force: true })
  reportResults()
}

run()
