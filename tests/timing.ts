/**
 * `trace`/`startTrace`/`configureTraces` from `/client/timing` (#51).
 *
 * Covers the watchdog (a 1 s check, faked here so nothing waits for real time —
 * see `installFakeClock` in `browserStubs.ts`), the hidden-tab and late-tick
 * cases that are never judged, step vs. trace limits, overlap between two runs
 * of the same trace, the callback form, the end()/step-after-end edge cases,
 * `performance.mark`/`measure` cleanup, and that none of this reaches the core
 * `/client` bundle.
 *
 * Run: npx tsx tests/timing.ts
 */

import '../tests/browserStubs.js'
import * as path from 'path'
import { build } from 'esbuild'
import { assert, reportResults } from './testHelpers.js'
import { initLogger } from '../src/client/logger.js'
import { configureTraces, trace, startTrace } from '../src/client/timing.js'
import { setVisibility, installFakeClock, uninstallFakeClock, advanceFakeTime, setFakeNow, fireDueTimers } from './browserStubs.js'
import type { LogPayload } from '../src/shared/types.js'

let sent: LogPayload[] = []
initLogger({
  appId: 'timing-test',
  releaseId: 'r1',
  minSeverity: 'DEBUG',
  logFunction: async (data) => void sent.push(data),
})

function resetSent(): void {
  sent = []
}

function pending(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

// --- Fast runs send nothing ---

async function testFastRunSendsNothing() {
  console.log('\nTest: a run within its limits sends no entry')
  resetSent()
  configureTraces({ fast_demo: { warnAfterMs: 5000, steps: { quick: 5000 } } })

  await trace('fast_demo', async (t) => {
    await t.step('quick', async () => {})
  })

  assert('nothing was sent', sent.length === 0, JSON.stringify(sent))
}

// --- No limits configured ---

async function testNoLimitsConfiguredSendsNothing() {
  console.log('\nTest: a trace with no limits configured sends nothing, however slow')
  installFakeClock()
  try {
    resetSent()
    configureTraces({})

    const t = startTrace('unconfigured_demo')
    const step1 = t.step('slow', () => pending().promise)
    advanceFakeTime(10_000)
    assert('nothing was sent', sent.length === 0, JSON.stringify(sent))
    t.end()
    void step1
  } finally {
    uninstallFakeClock()
  }
}

// --- Trace limit ---

async function testTraceLimitReportsWhileAStepIsWaiting() {
  console.log('\nTest: a run past warnAfterMs sends exactly one WARNING, naming the waiting step')
  installFakeClock()
  try {
    resetSent()
    configureTraces({ trace_limit_demo: { warnAfterMs: 2500 } })

    const t = startTrace('trace_limit_demo')
    await t.step('sign-in', async () => advanceFakeTime(600))
    const { promise: productsPromise, resolve: resolveProducts } = pending()
    const stepPromise = t.step('products', () => productsPromise)

    advanceFakeTime(3000)

    assert('exactly one entry was sent', sent.length === 1, JSON.stringify(sent))
    const entry = sent[0]
    assert('severity is WARNING', entry.severity === 'WARNING', entry.severity)
    assert('slow is trace', entry.labels.slow === 'trace', JSON.stringify(entry.labels))
    assert('no step label for a trace-level warning', entry.labels.step === undefined, JSON.stringify(entry.labels))
    assert('trace label names the trace', entry.labels.trace === 'trace_limit_demo')
    const timing = entry.jsonPayload?.context?.timing as {
      elapsedMs: number
      limitMs: number
      steps: Record<string, number>
      waiting: string[]
    }
    assert('limitMs is the trace limit', timing.limitMs === 2500, JSON.stringify(timing))
    assert('the finished step is listed with its ms', timing.steps['sign-in'] === 600, JSON.stringify(timing))
    assert('the waiting step is named', timing.waiting.includes('products'), JSON.stringify(timing))

    resolveProducts()
    await stepPromise
    t.end()
    assert('nothing more was sent once the run later ends', sent.length === 1, JSON.stringify(sent))
  } finally {
    uninstallFakeClock()
  }
}

// --- Step limit ---

async function testStepLimitReportsWhileRunning() {
  console.log('\nTest: a step past its own limit is reported while still running')
  installFakeClock()
  try {
    resetSent()
    configureTraces({ step_limit_demo: { steps: { slow: 1500 } } })

    const t = startTrace('step_limit_demo')
    const { promise: slowPromise, resolve: resolveSlow } = pending()
    const stepPromise = t.step('slow', () => slowPromise)

    advanceFakeTime(2000)

    assert('exactly one entry was sent', sent.length === 1, JSON.stringify(sent))
    const entry = sent[0]
    assert('slow is step', entry.labels.slow === 'step', JSON.stringify(entry.labels))
    assert('step names the slow step', entry.labels.step === 'slow', JSON.stringify(entry.labels))

    resolveSlow()
    await stepPromise
    t.end()
  } finally {
    uninstallFakeClock()
  }
}

// --- Not judged: hidden ---

async function testHiddenRunIsNeverReported() {
  console.log('\nTest: a run hidden at any point sends nothing even when late')
  installFakeClock()
  try {
    resetSent()
    configureTraces({ hidden_demo: { warnAfterMs: 1500 } })

    const t = startTrace('hidden_demo')
    const { promise: slowPromise, resolve: resolveSlow } = pending()
    const stepPromise = t.step('slow', () => slowPromise)

    setVisibility('hidden')
    advanceFakeTime(3000)

    assert('nothing was sent', sent.length === 0, JSON.stringify(sent))
    setVisibility('visible')
    resolveSlow()
    await stepPromise
    t.end()
  } finally {
    uninstallFakeClock()
  }
}

// --- Not judged: a late watchdog tick ---

async function testLateWatchdogTickIsNeverReported() {
  console.log('\nTest: a run where the watchdog tick arrives 5s+ late sends nothing')
  installFakeClock()
  try {
    resetSent()
    configureTraces({ late_tick_demo: { warnAfterMs: 1500 } })

    const t = startTrace('late_tick_demo')
    t.step('slow', () => pending().promise)

    setFakeNow(6500)
    fireDueTimers()

    assert('nothing was sent', sent.length === 0, JSON.stringify(sent))
    t.end()
  } finally {
    uninstallFakeClock()
  }
}

// --- Overlap ---

async function testOverlappingRunsDoNotMix() {
  console.log('\nTest: two concurrent runs of the same trace carry different run labels, and their steps never mix')
  installFakeClock()
  try {
    resetSent()
    configureTraces({ overlap_demo: { steps: { s: 1500 } } })

    const t1 = startTrace('overlap_demo')
    const t2 = startTrace('overlap_demo')
    const p1 = t1.step('s', () => pending().promise)
    const p2 = t2.step('s', () => pending().promise)

    advanceFakeTime(2000)

    assert('two entries were sent', sent.length === 2, JSON.stringify(sent))
    const [run1, run2] = sent.map((e) => e.labels.run)
    assert('the two runs carry different run labels', run1 !== undefined && run1 !== run2, JSON.stringify(sent))
    for (const entry of sent) {
      assert('each entry reports its own trace', entry.labels.trace === 'overlap_demo')
      assert('each entry reports its own step', entry.labels.step === 's')
    }

    t1.end()
    t2.end()
    void p1
    void p2
  } finally {
    uninstallFakeClock()
  }
}

// --- Callback form ---

async function testCallbackFormEndsOnResolveAndReject() {
  console.log('\nTest: trace(name, fn) ends when fn resolves and when it rejects, and the rejection reaches the caller')
  configureTraces({})

  const result = await trace('callback_demo', async (t) => {
    await t.step('x', async () => 42)
    return 'done'
  })
  assert('the resolved value passes through', result === 'done')

  let caught: unknown
  try {
    await trace('callback_demo_reject', async () => {
      throw new Error('boom')
    })
  } catch (err) {
    caught = err
  }
  assert('the rejection reached the caller', caught instanceof Error && caught.message === 'boom')
}

// --- Edge cases ---

async function testStepAfterEndAndDoubleEndAreIgnored() {
  console.log('\nTest: a step after end(), and a second end(), send nothing and do not throw')
  resetSent()
  configureTraces({ edge_demo: { steps: { late: 1 } } })

  const t = startTrace('edge_demo')
  t.end()

  let ran = false
  const result = await t.step('late', async () => {
    ran = true
    return 'value'
  })
  assert('the function still ran', ran)
  assert("the function's result still comes back", result === 'value')
  assert('nothing was sent for a step after end', sent.length === 0, JSON.stringify(sent))
  assert(
    'no mark was created for a step after end',
    (performance.getEntriesByType('mark') as { name: string }[]).filter((e) => e.name.includes('edge_demo')).length === 0,
  )

  let threw = false
  try {
    t.end()
  } catch {
    threw = true
  }
  assert('a second end() does not throw', !threw)
}

// --- Marks ---

async function testMarksAndMeasuresAreClearedOnEnd() {
  console.log("\nTest: after a run ends, performance.getEntriesByType('mark'/'measure') hold none of its entries")
  const entriesFor = (type: string) =>
    (performance.getEntriesByType(type) as { name: string }[]).filter((e) => e.name.includes('marks_demo'))

  assert('no marks exist before the run', entriesFor('mark').length === 0)

  const t = startTrace('marks_demo')
  await t.step('m1', async () => {})
  assert('a mark exists mid-run', entriesFor('mark').length > 0)
  assert('a measure exists mid-run', entriesFor('measure').length > 0)

  t.end()
  assert('no marks remain for this run after end', entriesFor('mark').length === 0, JSON.stringify(performance.getEntriesByType('mark')))
  assert('no measures remain for this run after end', entriesFor('measure').length === 0)
}

// --- Severity floor ---

async function testWarningPassesTheProductionFloor() {
  console.log('\nTest: a timing WARNING passes the severity floor even when only WARNING+ is allowed')
  installFakeClock()
  try {
    const floorSent: LogPayload[] = []
    initLogger({
      appId: 'floor-test',
      releaseId: 'r1',
      minSeverity: 'WARNING',
      logFunction: async (data) => void floorSent.push(data),
    })
    configureTraces({ floor_demo: { warnAfterMs: 500 } })

    const t = startTrace('floor_demo')
    t.step('slow', () => pending().promise)
    advanceFakeTime(1000)

    assert('the WARNING reached logFunction under a WARNING floor', floorSent.length === 1, JSON.stringify(floorSent))
    t.end()
  } finally {
    uninstallFakeClock()
    initLogger({ appId: 'timing-test', releaseId: 'r1', minSeverity: 'DEBUG', logFunction: async (data) => void sent.push(data) })
  }
}

// --- Not in the core bundle ---

async function testTimingCodeIsNotInTheCoreBundle() {
  console.log('\nTest: an esbuild bundle of src/client/index.ts contains none of the timing code')
  const result = await build({
    stdin: {
      contents: "export * from './src/client/index'",
      resolveDir: path.join(process.cwd()),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
  })
  const code = result.outputFiles[0].text
  assert('configureTraces is absent', !code.includes('configureTraces'), 'found configureTraces in the core bundle')
  assert('startTrace is absent', !code.includes('startTrace'), 'found startTrace in the core bundle')
  assert('the watchdog interval constant is absent', !code.includes('WATCHDOG_INTERVAL_MS'), 'found the watchdog in the core bundle')
}

async function run() {
  await testFastRunSendsNothing()
  await testNoLimitsConfiguredSendsNothing()
  await testTraceLimitReportsWhileAStepIsWaiting()
  await testStepLimitReportsWhileRunning()
  await testHiddenRunIsNeverReported()
  await testLateWatchdogTickIsNeverReported()
  await testOverlappingRunsDoNotMix()
  await testCallbackFormEndsOnResolveAndReject()
  await testStepAfterEndAndDoubleEndAreIgnored()
  await testMarksAndMeasuresAreClearedOnEnd()
  await testWarningPassesTheProductionFloor()
  await testTimingCodeIsNotInTheCoreBundle()
  reportResults()
}

run()
