/**
 * The pure bookkeeping behind `/client/timing` and `/functions`' `trace`/`startTrace` —
 * which steps are finished (with their ms) and which are still running, checked
 * against configured limits through an injected monotonic clock so tests never wait
 * for real time. The two entry points differ only in how often they call `check()`
 * (a watchdog tick in the browser, a step/trace boundary on the server, per
 * CLAUDE.md "Traces report misbehaviour, nothing else") and in what they do with
 * the `TraceReport` it returns.
 */
export interface TraceLimits {
  warnAfterMs?: number
  steps?: Record<string, number>
}

/** `configureTraces({ name: { warnAfterMs?, steps? } })`. */
export type TraceConfig = Record<string, TraceLimits>

export interface TraceReport {
  slow: 'trace' | 'step'
  step?: string
  elapsedMs: number
  limitMs: number
  steps: Record<string, number>
  waiting: string[]
}

export class TraceRun {
  readonly run: string
  private readonly startedAt: number
  private readonly finishedSteps: Record<string, number> = {}
  private readonly runningSteps = new Map<string, number>()
  private reported = false
  private ended = false

  constructor(
    readonly name: string,
    private readonly limits: TraceLimits | undefined,
    private readonly clock: () => number,
    runId: string,
  ) {
    this.run = runId
    this.startedAt = clock()
  }

  get isEnded(): boolean {
    return this.ended
  }

  get hasReported(): boolean {
    return this.reported
  }

  startStep(name: string): void {
    if (this.ended) return
    this.runningSteps.set(name, this.clock())
  }

  endStep(name: string): number | undefined {
    const startedAt = this.runningSteps.get(name)
    if (startedAt === undefined) return undefined
    this.runningSteps.delete(name)
    const ms = this.clock() - startedAt
    this.finishedSteps[name] = ms
    return ms
  }

  end(): void {
    this.ended = true
  }

  /**
   * The first limit crossed right now, or undefined. Does not itself mark the
   * run as reported — callers do that only once they have actually sent it.
   */
  check(): TraceReport | undefined {
    if (this.reported || !this.limits) return undefined
    const limits = this.limits

    const elapsedMs = this.clock() - this.startedAt
    if (limits.warnAfterMs !== undefined && elapsedMs >= limits.warnAfterMs) {
      return {
        slow: 'trace',
        elapsedMs,
        limitMs: limits.warnAfterMs,
        steps: { ...this.finishedSteps },
        waiting: [...this.runningSteps.keys()],
      }
    }

    for (const [stepName, startedAt] of this.runningSteps) {
      const limitMs = limits.steps?.[stepName]
      if (limitMs === undefined) continue
      const stepElapsedMs = this.clock() - startedAt
      if (stepElapsedMs >= limitMs) {
        return {
          slow: 'step',
          step: stepName,
          elapsedMs: stepElapsedMs,
          limitMs,
          steps: { ...this.finishedSteps },
          waiting: [...this.runningSteps.keys()],
        }
      }
    }

    return undefined
  }

  /**
   * The server's counterpart to `check()`'s step loop: a step that has already
   * been moved into `finishedSteps` (so `endStep` has already run for it) is no
   * longer in `runningSteps` for `check()` to see, yet the instant it finished
   * is the only one the server — with no timer — gets to judge it against its
   * own limit. `ms` is the duration `endStep` just returned for it.
   */
  checkFinishedStep(name: string, ms: number): TraceReport | undefined {
    if (this.reported || !this.limits) return undefined
    const limitMs = this.limits.steps?.[name]
    if (limitMs === undefined || ms < limitMs) return undefined
    return {
      slow: 'step',
      step: name,
      elapsedMs: ms,
      limitMs,
      steps: { ...this.finishedSteps },
      waiting: [...this.runningSteps.keys()],
    }
  }

  markReported(): void {
    this.reported = true
  }
}

/** The message of a slow-trace entry, e.g. `"app_boot slow: products passed 3000 ms, still waiting"`. */
export function traceMessage(name: string, report: TraceReport): string {
  const subject = report.slow === 'step' ? `${report.step} ` : ''
  return `${name} slow: ${subject}passed ${report.limitMs} ms, still waiting`
}

export function traceLabels(name: string, run: string, report: TraceReport): Record<string, string> {
  const labels: Record<string, string> = { trace: name, run, slow: report.slow }
  if (report.step !== undefined) labels.step = report.step
  return labels
}

export function traceContext(report: TraceReport): Record<string, unknown> {
  return {
    timing: {
      elapsedMs: report.elapsedMs,
      limitMs: report.limitMs,
      steps: report.steps,
      waiting: report.waiting,
    },
  }
}
