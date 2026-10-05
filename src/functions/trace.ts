import { ulid } from 'ulid'
import { getLogger } from './requestLogger'
import { TraceRun, traceMessage, traceLabels, traceContext, type TraceConfig } from '../shared/trace'

export type { TraceConfig, TraceLimits } from '../shared/trace'

export interface Trace {
  step<T>(name: string, fn: () => T | Promise<T>): Promise<T>
  end(): void
}

let config: TraceConfig = {}

/** Replaces every limit. Read when a run starts, so configure before the first one. */
export function configureTraces(newConfig: TraceConfig): void {
  config = newConfig
}

function now(): number {
  return Date.now()
}

/**
 * Judged only when a step finishes or the trace ends — no timer, since Cloud
 * Functions and Cloud Run can throttle the CPU once a response is sent (see
 * CLAUDE.md, "Traces report misbehaviour, nothing else"). Sent through the
 * request-scoped writer, so it carries that request's labels like any other entry.
 */
function report(run: TraceRun, found: ReturnType<TraceRun['check']>): void {
  if (!found) return
  run.markReported()
  getLogger().warning(traceMessage(run.name, found), traceLabels(run.name, run.run, found), traceContext(found))
}

function startRun(name: string): Trace {
  const run = new TraceRun(name, config[name], now, ulid())

  return {
    async step(stepName, fn) {
      if (run.isEnded) return fn()
      run.startStep(stepName)
      try {
        return await fn()
      } finally {
        const ms = run.endStep(stepName)
        if (ms !== undefined) report(run, run.checkFinishedStep(stepName, ms))
        report(run, run.check())
      }
    },
    end() {
      if (run.isEnded) return
      report(run, run.check())
      run.end()
    },
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
