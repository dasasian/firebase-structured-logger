import { getClientLogger } from './logger'
import { TraceRun, traceMessage, traceLabels, traceContext, type TraceConfig, type TraceReport } from '../shared/trace'

export type { TraceConfig, TraceLimits } from '../shared/trace'

function newPageLocalRunId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * `@dasasian/firebase-structured-logger/client/timing` — its own entry point
 * (CLAUDE.md, "Optional client helpers are separate entry points"), so an app
 * that never imports it ships none of this. Touches no browser global at module
 * load — `performance`, `document` and the timers below are only read once a
 * trace actually starts. See README, "Timing: when something is too slow".
 */
export interface Trace {
  step<T>(name: string, fn: () => T | Promise<T>): Promise<T>
  end(): void
}

let config: TraceConfig = {}

/** Replaces every limit. Read when a run starts, so configure before the first one. */
export function configureTraces(newConfig: TraceConfig): void {
  config = newConfig
}

interface ActiveRun {
  run: TraceRun
  disqualified: boolean
  marks: string[]
  measures: string[]
}

const WATCHDOG_INTERVAL_MS = 1000
const LATE_THRESHOLD_MS = 5000

const activeRuns = new Set<ActiveRun>()
let watchdogId: ReturnType<typeof setInterval> | undefined
let visibilityWired = false
let lastTickAt: number | undefined

function now(): number {
  return performance.now()
}

function markName(run: TraceRun, step: string, kind: 'start' | 'end' | 'measure'): string {
  return `fsl:${run.name}:${run.run}:${step}:${kind}`
}

function disqualifyActiveRuns(): void {
  for (const active of activeRuns) active.disqualified = true
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'hidden') disqualifyActiveRuns()
}

/** No-op outside a browser (Node, SSR) — nothing there can ever go hidden. */
function wireVisibility(): void {
  if (visibilityWired) return
  visibilityWired = true
  if (typeof document === 'undefined') return
  document.addEventListener('visibilitychange', onVisibilityChange)
}

function reportRun(run: TraceRun, report: TraceReport): void {
  getClientLogger().warning(traceMessage(run.name, report), traceLabels(run.name, run.run, report), traceContext(report))
}

function tick(): void {
  const nowMs = Date.now()
  const late = lastTickAt !== undefined && nowMs - lastTickAt - WATCHDOG_INTERVAL_MS >= LATE_THRESHOLD_MS
  lastTickAt = nowMs
  if (late) disqualifyActiveRuns()

  for (const active of activeRuns) {
    if (active.disqualified || active.run.hasReported) continue
    const report = active.run.check()
    if (!report) continue
    active.run.markReported()
    reportRun(active.run, report)
  }
}

function ensureWatchdog(): void {
  wireVisibility()
  if (watchdogId !== undefined) return
  lastTickAt = Date.now()
  watchdogId = setInterval(tick, WATCHDOG_INTERVAL_MS)
}

function stopWatchdogIfIdle(): void {
  if (activeRuns.size > 0 || watchdogId === undefined) return
  clearInterval(watchdogId)
  watchdogId = undefined
}

async function runStep<T>(run: TraceRun, active: ActiveRun, name: string, fn: () => T | Promise<T>): Promise<T> {
  if (run.isEnded) return fn()

  const startMark = markName(run, name, 'start')
  const endMark = markName(run, name, 'end')
  const measureName = markName(run, name, 'measure')
  active.marks.push(startMark, endMark)
  active.measures.push(measureName)

  performance.mark(startMark)
  run.startStep(name)
  try {
    return await fn()
  } finally {
    run.endStep(name)
    performance.mark(endMark)
    performance.measure(measureName, startMark, endMark)
  }
}

function endRun(run: TraceRun, active: ActiveRun): void {
  if (run.isEnded) return
  run.end()
  for (const mark of active.marks) performance.clearMarks(mark)
  for (const measure of active.measures) performance.clearMeasures(measure)
  activeRuns.delete(active)
  stopWatchdogIfIdle()
}

function startRun(name: string): Trace {
  const run = new TraceRun(name, config[name], now, newPageLocalRunId())
  const active: ActiveRun = { run, disqualified: false, marks: [], measures: [] }

  if (config[name]) {
    activeRuns.add(active)
    ensureWatchdog()
  }

  return {
    step: (stepName, fn) => runStep(run, active, stepName, fn),
    end: () => endRun(run, active),
  }
}

/** `startTrace(name)` returns the object; call `.end()` when the flow is over. */
export function startTrace(name: string): Trace {
  return startRun(name)
}

/** Runs `fn` with a trace object and ends the trace when `fn` settles, either way. */
export async function trace<T>(name: string, fn: (t: Trace) => T | Promise<T>): Promise<T> {
  const handle = startRun(name)
  try {
    return await fn(handle)
  } finally {
    handle.end()
  }
}
