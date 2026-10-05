/**
 * `trace`/`startTrace`/`configureTraces` from `/functions` (#51).
 *
 * The server has no timer — a step or the trace ending is the only thing that can
 * notice a crossed limit (CLAUDE.md, "Traces report misbehaviour, nothing else").
 * These tests delay with a real, short `setTimeout` rather than a fake clock: the
 * server module itself starts no timer, so there is nothing to fake — the delay
 * here only stands in for slow work.
 *
 * Run: FUNCTIONS_EMULATOR=true npx tsx tests/serverTrace.ts
 */

import fs from 'fs'

if (process.env.FUNCTIONS_EMULATOR !== 'true') {
  console.error('Run with: FUNCTIONS_EMULATOR=true npx tsx tests/serverTrace.ts')
  process.exit(1)
}

const LOG_DIR = './test-servertrace-output'

import type { CallableRequest } from 'firebase-functions/v2/https'
import { initLogger } from '../src/functions/logger.js'
import { withLogging } from '../src/functions/requestLogger.js'
import { trace, startTrace, configureTraces } from '../src/functions/trace.js'
import { assert, reportResults, readLastEntry, clearLog } from './testHelpers.js'

fs.mkdirSync(LOG_DIR, { recursive: true })
initLogger({ appId: 'trace-test', logLocalDir: LOG_DIR })

function makeRequest(uid: string): CallableRequest {
  return { data: {}, auth: { uid, token: {} }, rawRequest: {} } as unknown as CallableRequest
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function testFastRunSendsNothing() {
  console.log('\nTest: a run within its limits sends no entry')
  clearLog(LOG_DIR)
  configureTraces({ fast_trace: { warnAfterMs: 5000, steps: { quick: 5000 } } })

  await trace('fast_trace', async (t) => {
    await t.step('quick', async () => {})
  })

  assert('nothing was written', readLastEntry(LOG_DIR) === undefined)
}

async function testStepLimitReportsAtStepEnd() {
  console.log('\nTest: a step past its own limit is reported, slow: "step", when it finishes')
  clearLog(LOG_DIR)
  configureTraces({ step_trace: { steps: { slow: 10 } } })

  await trace('step_trace', async (t) => {
    await t.step('slow', () => sleep(30))
  })

  const entry = readLastEntry(LOG_DIR)
  assert('an entry was written', !!entry)
  assert('severity is WARNING', entry?.severity === 'WARNING', entry?.severity)
  const labels = (entry?.labels ?? {}) as Record<string, string>
  assert('trace label is set', labels.trace === 'step_trace', JSON.stringify(labels))
  assert('slow is step', labels.slow === 'step', JSON.stringify(labels))
  assert('step names the slow step', labels.step === 'slow', JSON.stringify(labels))
  assert('run is set', typeof labels.run === 'string' && labels.run.length > 0)

  const timing = (entry?.jsonPayload as { context?: { timing?: Record<string, unknown> } })?.context?.timing
  assert('timing.limitMs is the step limit', timing?.limitMs === 10, JSON.stringify(timing))
  // The server judges a step at the instant it finishes — unlike the browser's
  // live watchdog, it is never caught "still running" — so by the time this is
  // judged, the step itself is already finished rather than waiting.
  assert('the slow step is listed as finished, with its own ms', typeof (timing?.steps as Record<string, number>)?.slow === 'number', JSON.stringify(timing))
  assert('nothing else was left waiting', Array.isArray(timing?.waiting) && (timing?.waiting as string[]).length === 0, JSON.stringify(timing))
}

async function testTraceLimitReportsAtTraceEnd() {
  console.log('\nTest: the trace\'s own limit is reported, slow: "trace", when the trace ends')
  clearLog(LOG_DIR)
  configureTraces({ overall_trace: { warnAfterMs: 10 } })

  await trace('overall_trace', async (t) => {
    await t.step('a', () => sleep(5))
    await t.step('b', () => sleep(20))
  })

  const entry = readLastEntry(LOG_DIR)
  assert('an entry was written', !!entry)
  const labels = (entry?.labels ?? {}) as Record<string, string>
  assert('slow is trace', labels.slow === 'trace', JSON.stringify(labels))
  assert('no step label for a trace-level warning', !('step' in labels), JSON.stringify(labels))

  const timing = (entry?.jsonPayload as { context?: { timing?: Record<string, unknown> } })?.context?.timing
  assert('steps lists both finished steps', typeof (timing?.steps as Record<string, number>)?.a === 'number'
    && typeof (timing?.steps as Record<string, number>)?.b === 'number', JSON.stringify(timing))
  assert('waiting is empty once the trace has ended', Array.isArray(timing?.waiting) && (timing?.waiting as string[]).length === 0, JSON.stringify(timing))
}

async function testNothingMoreAfterReporting() {
  console.log('\nTest: nothing more is sent once a run has reported')
  clearLog(LOG_DIR)
  configureTraces({ once_trace: { steps: { slow: 5 } } })

  const t = startTrace('once_trace')
  await t.step('slow', () => sleep(20))
  const firstEntry = readLastEntry(LOG_DIR)
  assert('the first slow step reported', !!firstEntry)

  clearLog(LOG_DIR)
  await t.step('slow2', () => sleep(20))
  t.end()
  assert('no second entry was written for the same run', readLastEntry(LOG_DIR) === undefined)
}

async function testStepAfterEndAndDoubleEndAreIgnored() {
  console.log('\nTest: a step after end(), and a second end(), send nothing and do not throw')
  clearLog(LOG_DIR)
  configureTraces({ edge_trace: { steps: { late: 1 } } })

  const t = startTrace('edge_trace')
  t.end()
  let ran = false
  const result = await t.step('late', async () => {
    ran = true
    await sleep(20)
    return 'value'
  })
  assert('the function still ran', ran)
  assert('the function\'s result still comes back', result === 'value')
  assert('nothing was sent for a step after end', readLastEntry(LOG_DIR) === undefined)

  let threw = false
  try {
    t.end()
  } catch {
    threw = true
  }
  assert('a second end() does not throw', !threw)
}

async function testCarriesTheRequestsLabels() {
  console.log('\nTest: inside withLogging, a trace entry carries the request\'s labels')
  clearLog(LOG_DIR)
  configureTraces({ request_trace: { warnAfterMs: 5 } })

  await withLogging({ functionName: 'loadsSlowly' }, async () => {
    await trace('request_trace', async (t) => {
      await t.step('work', () => sleep(20))
    })
  })(makeRequest('user_1'))

  const entry = readLastEntry(LOG_DIR)
  const labels = (entry?.labels ?? {}) as Record<string, string>
  assert('the request\'s functionName is on the entry', labels.functionName === 'loadsSlowly', JSON.stringify(labels))
  assert('the request\'s userId is on the entry', labels.userId === 'user_1', JSON.stringify(labels))
  assert('the trace label is still on the entry', labels.trace === 'request_trace', JSON.stringify(labels))
}

async function testCallbackFormEndsOnRejection() {
  console.log('\nTest: trace(name, fn) ends when fn rejects, and the rejection reaches the caller')
  clearLog(LOG_DIR)
  configureTraces({ reject_trace: {} })

  let caught: unknown
  try {
    await trace('reject_trace', async () => {
      throw new Error('boom')
    })
  } catch (err) {
    caught = err
  }
  assert('the rejection reached the caller', caught instanceof Error && caught.message === 'boom')
}

async function testNoLimitsConfiguredSendsNothing() {
  console.log('\nTest: a trace with no limits configured sends nothing, however slow')
  clearLog(LOG_DIR)
  configureTraces({})

  await trace('unconfigured_trace', async (t) => {
    await t.step('slow', () => sleep(30))
  })

  assert('nothing was written', readLastEntry(LOG_DIR) === undefined)
}

function testNoTimerIsUsed() {
  console.log('\nTest: the server trace module starts no timer')
  const source = fs.readFileSync(new URL('../src/functions/trace.ts', import.meta.url), 'utf-8')
  assert('no setTimeout', !source.includes('setTimeout'))
  assert('no setInterval', !source.includes('setInterval'))
}

async function run() {
  await testFastRunSendsNothing()
  await testStepLimitReportsAtStepEnd()
  await testTraceLimitReportsAtTraceEnd()
  await testNothingMoreAfterReporting()
  await testStepAfterEndAndDoubleEndAreIgnored()
  await testCarriesTheRequestsLabels()
  await testCallbackFormEndsOnRejection()
  await testNoLimitsConfiguredSendsNothing()
  testNoTimerIsUsed()

  fs.rmSync(LOG_DIR, { recursive: true, force: true })
  reportResults()
}

run().catch((err) => {
  fs.rmSync(LOG_DIR, { recursive: true, force: true })
  console.error('Fatal:', err)
  process.exit(1)
})
