import type { LogSeverity, LogPayload, ErrorPayload, BaseLabels } from '../shared/types'
import { SEVERITY_ORDER, FEEDBACK_LABEL } from '../shared/severity'
import { toError, toErrorPayload } from '../shared/error'
import { warnDeprecated } from '../shared/deprecate'
import {
  addBreadcrumb,
  getLastBreadcrumbs,
  MAX_BREADCRUMBS,
  setCurrentScreen,
  clearBreadcrumbs,
  getCurrentRoute,
  getActiveScreen,
  getActiveView,
} from './breadcrumbs'
import {
  allow,
  signatureFor,
  describeSignature,
  configureRateLimiter,
  flushDueSummaries,
  peekPendingSummaries,
  acknowledgeSummary,
  type RateLimitConfig,
  type SentSummary,
} from './rateLimiter'

export type { RateLimitConfig }

type LogCallable = (data: LogPayload) => Promise<unknown>

type SendWatcher = (sending: Promise<unknown>) => void

let sendWatcher: SendWatcher | undefined

/**
 * Tells `/testing` about every send as it starts. Not exported from any entry point.
 * A second call replaces the first watcher; `undefined` removes it.
 */
export function setSendWatcher(watcher: SendWatcher | undefined): void {
  sendWatcher = watcher
}

export interface FeedbackOptions<
  AppLabels extends Record<string, string | undefined> = Record<string, string | undefined>,
> {
  /** A screenshot or any file. Rides the same GCS path as error attachments. */
  attachments?: Record<string, Blob | File | string>
  /** Anything the app wants to tag — which widget, which flow, its own ticket id. */
  labels?: Partial<AppLabels & BaseLabels>
}

export interface InitLoggerConfig<
  AppLabels extends Record<string, string | undefined> = Record<string, string | undefined>,
> {
  appId: string
  releaseId: string
  logFunction: LogCallable
  minSeverity?: LogSeverity
  rateLimitOptions?: RateLimitConfig
  /** @deprecated Use `minSeverity`. */
  minLogLevel?: LogSeverity
}

/**
 * No `typeof process` guard, on purpose. Every bundler folds `process.env.NODE_ENV` to a
 * string literal at build time, so the comparison is safe in a browser — but `process`
 * itself does not exist there, and guarding on it meant the folded branch was never
 * reached: every browser build defaulted to DEBUG in production, and the README's
 * "WARNING in production" was true only under Node. Seen in a real Vite bundle as
 * `typeof process<"u"?"WARNING":"DEBUG"`. A runtime with neither the fold nor
 * `process` throws on the read, and that is the case the catch is for.
 */
function defaultMinLevel(): LogSeverity {
  try {
    return process.env.NODE_ENV === 'production' ? 'WARNING' : 'DEBUG'
  } catch {
    return 'DEBUG'
  }
}

// Order matters — first match wins.
const PLATFORMS: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, 'ios'],
  [/Android/, 'android'],
  [/Mac/, 'macos'],
  [/Win/, 'windows'],
  [/Linux/, 'linux'],
]

const BROWSERS: [RegExp, string][] = [
  [/Firefox/, 'firefox'],
  [/Edg/, 'edge'],
  [/Chrome/, 'chrome'],
  [/Safari/, 'safari'],
]

function matchUserAgent(table: [RegExp, string][], fallback: string): string {
  if (typeof navigator === 'undefined') return 'unknown'
  const ua = navigator.userAgent
  return table.find(([pattern]) => pattern.test(ua))?.[1] ?? fallback
}

// The user agent never changes for the lifetime of the page, so resolve both
// once at module load rather than re-running the regexes on every log call.
const PLATFORM = matchUserAgent(PLATFORMS, 'web')
const BROWSER = matchUserAgent(BROWSERS, 'unknown')

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.split(',')[1] ?? result)
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

async function assetToBase64(asset: Blob | File | string): Promise<string> {
  if (typeof asset === 'string') return asset
  return blobToBase64(asset)
}

async function convertReadableAttachmentsKeepingTheEntry(
  attachments: Record<string, Blob | File | string>,
): Promise<{ converted: Record<string, string> | undefined; failedNames: string[] }> {
  const converted: Record<string, string> = {}
  const failedNames: string[] = []
  for (const [name, attachment] of Object.entries(attachments)) {
    try {
      converted[name] = await assetToBase64(attachment)
    } catch (err) {
      failedNames.push(name)
      console.warn(
        `[fsl] Could not read attachment "${name}" — sending the log without it:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
  return { converted: Object.keys(converted).length > 0 ? converted : undefined, failedNames }
}

export class Logger<
  AppLabels extends Record<string, string | undefined> = Record<string, string | undefined>,
> {
  private readonly config: InitLoggerConfig<AppLabels>
  private readonly minLevel: number
  private userId: string | undefined
  private userLabels: Partial<AppLabels> = {}

  constructor(config: InitLoggerConfig<AppLabels>) {
    this.config = config
    if (config.minLogLevel !== undefined) warnDeprecated('minLogLevel', 'minSeverity')
    this.minLevel = SEVERITY_ORDER[config.minSeverity ?? config.minLogLevel ?? defaultMinLevel()]
    if (config.rateLimitOptions) {
      configureRateLimiter(config.rateLimitOptions)
    }
  }

  setUser(uid: string, extraLabels?: Partial<AppLabels>): void {
    this.userId = uid
    this.userLabels = extraLabels ?? {}
  }

  clearUser(): void {
    this.userId = undefined
    this.userLabels = {}
    clearBreadcrumbs()
  }

  setScreen(screen: string): void {
    setCurrentScreen(screen)
  }

  addBreadcrumb(
    type: 'action' | 'state' | 'nav' | 'error',
    name: string,
    data?: Record<string, unknown>,
  ): void {
    addBreadcrumb(type, name, data)
  }

  error(
    raw: unknown,
    labels?: Partial<AppLabels & BaseLabels>,
    context?: Record<string, unknown>,
    attachments?: Record<string, Blob | File | string>,
  ): void {
    const error = toError(raw)

    const errorLabels: Record<string, string | undefined> = {
      errorType: error.name || 'UnknownError',
      ...(labels as Record<string, string | undefined>),
    }

    this.send(
      error.message,
      'ERROR',
      errorLabels,
      context,
      attachments,
      toErrorPayload(error),
      signatureFor(error, getActiveScreen()),
    )
  }

  info(
    message: string,
    labels?: Partial<AppLabels & BaseLabels>,
    context?: Record<string, unknown>,
    attachments?: Record<string, Blob | File | string>,
  ): void {
    this.send(message, 'INFO', labels as Record<string, string | undefined>, context, attachments)
  }

  warning(
    message: string,
    labels?: Partial<AppLabels & BaseLabels>,
    context?: Record<string, unknown>,
    attachments?: Record<string, Blob | File | string>,
  ): void {
    this.send(message, 'WARNING', labels as Record<string, string | undefined>, context, attachments)
  }

  debug(
    message: string,
    labels?: Partial<AppLabels & BaseLabels>,
    context?: Record<string, unknown>,
    attachments?: Record<string, Blob | File | string>,
  ): void {
    this.send(message, 'DEBUG', labels as Record<string, string | undefined>, context, attachments)
  }

  /**
   * Send feedback a user typed, carrying everything the logger already knows.
   *
   * This exists because error tracking only sees things that throw. A button
   * that does nothing, a total that comes out wrong, the wrong data rendered —
   * none of them throw, so none are captured, and you hear about them weeks
   * later. Feedback is the capture mechanism for that whole class, and it is
   * actionable only because the breadcrumb trail is already in memory when the
   * user hits send: "the discount didn't apply" is a complaint, the same
   * sentence plus the trail is a reproduction.
   *
   * Exempt from the severity floor and the rate limiter: both control events the
   * system emits, and feedback is a person sending a message, rare by nature. The
   * exemption keys on the record being feedback, not on its NOTICE severity.
   *
   * Headless — the app owns the UI. Returns nothing: a reference number is
   * meaningless to a user with no portal to check it against. An app wanting
   * correlation passes its own id as a label, which it knows before sending.
   */
  sendFeedback(text: string, extras?: FeedbackOptions<AppLabels>): void {
    const isFeedback = true
    this.send(
      text,
      'NOTICE',
      { [FEEDBACK_LABEL]: 'true', ...(extras?.labels as Record<string, string | undefined>) },
      undefined,
      extras?.attachments,
      undefined,
      undefined,
      isFeedback,
    )
  }

  private send(...args: Parameters<Logger<AppLabels>['deliver']>): void {
    const delivering = this.deliver(...args)
    sendWatcher?.(delivering)
  }

  private async deliver(
    message: string,
    severity: LogSeverity,
    labels?: Record<string, string | undefined>,
    context?: Record<string, unknown>,
    attachments?: Record<string, Blob | File | string>,
    error?: ErrorPayload,
    signature?: string,
    isFeedback = false,
    isRepeatSummary = false,
    timestamp?: string,
  ): Promise<boolean> {
    if (!isFeedback && SEVERITY_ORDER[severity] > this.minLevel) return false

    const nav = getCurrentRoute()

    const allLabels: LogPayload['labels'] = {
      appId: this.config.appId,
      releaseId: this.config.releaseId,
      screen: getActiveScreen(),
      view: getActiveView(),
      route: nav?.route,
      path: nav?.path,
      routeSource: nav?.routeSource,
      userId: this.userId,
      platform: PLATFORM,
      browser: BROWSER,
      ...this.userLabels,
      ...labels,
    }

    const decision =
      isFeedback || isRepeatSummary
        ? ({ allowed: true } as const)
        : allow({ severity, signature, labels: allLabels })
    if (!decision.allowed) {
      if (decision.reason === 'duplicate') {
        console.warn(`[fsl] Duplicate counted for the next summary: ${describeSignature(decision.signature ?? '')}`)
      } else if (decision.reason === 'reserve') {
        console.warn('[fsl] Log limit: only errors can use the reserved logs now')
      } else {
        console.warn('[fsl] Log limit reached — recharging, next log in about a minute')
      }
      return false
    }

    const keyJoiningFullCopiesToTheirRepeatSummary = 'repeatKey' in decision ? decision.repeatKey : undefined
    if (keyJoiningFullCopiesToTheirRepeatSummary) {
      allLabels.repeatKey = keyJoiningFullCopiesToTheirRepeatSummary
    }

    try {
      let base64Attachments: Record<string, string> | undefined
      if (attachments && Object.keys(attachments).length > 0) {
        const conversion = await convertReadableAttachmentsKeepingTheEntry(attachments)
        base64Attachments = conversion.converted
        if (conversion.failedNames.length > 0) {
          allLabels.attachmentsFailed = conversion.failedNames.join(',')
        }
      }

      const payload: LogPayload = {
        message,
        severity,
        labels: allLabels,
        jsonPayload: {
          breadcrumbs: getLastBreadcrumbs(MAX_BREADCRUMBS),
          context,
          error,
        },
        ...(base64Attachments ? { attachments: base64Attachments } : {}),
        ...(timestamp ? { timestamp } : {}),
      }

      await this.config.logFunction(payload)
      return true
    } catch (err) {
      console.error('[fsl] Failed to send log:', err instanceof Error ? err.message : err)
      return false
    }
  }

  private readonly summaryIdsStillAwaitingTheirSend = new Set<string>()

  /** Send whatever repeat summaries are due, from this visit or an earlier one. */
  sendPendingSummaries(): void {
    for (const summary of peekPendingSummaries()) {
      if (this.summaryIdsStillAwaitingTheirSend.has(summary.id)) continue
      this.summaryIdsStillAwaitingTheirSend.add(summary.id)
      const sending = this.sendRepeatSummary(summary)
      sendWatcher?.(sending)
      void sending.finally(() => this.summaryIdsStillAwaitingTheirSend.delete(summary.id))
    }
  }

  /**
   * A repeat summary: a WARNING with no stack, timestamped at `lastSeen` (see
   * README, "Repeats are counted, not dropped"). It still respects the
   * severity floor — only the budget and the duplicate gate are skipped, via
   * `send`'s `skipBudget`.
   *
   * It is queued in `localStorage` precisely so a failed send does not lose
   * it — offline, or the tab tearing down right after the `visibilitychange`
   * that triggered this. So it is only acknowledged (removed from the queue)
   * once `send` reports the entry actually reached `logFunction`; otherwise
   * the next flush, or the next visit, finds it still there and retries it.
   */
  private async sendRepeatSummary(summary: SentSummary): Promise<void> {
    const labels: Record<string, string | undefined> = {
      appId: this.config.appId,
      releaseId: summary.releaseId ?? this.config.releaseId,
      userId: summary.userId,
      screen: summary.screen,
      view: undefined,
      errorType: summary.errorType,
      repeatOf: summary.repeatOf,
      repeatCount: String(summary.repeatCount),
      firstSeen: summary.firstSeen,
      lastSeen: summary.lastSeen,
      ...(summary.sentLate ? { sentLate: 'true' } : {}),
    }

    const repeatContextSoEntryHasJsonPayload = {
      repeat: { count: summary.repeatCount, firstSeen: summary.firstSeen, lastSeen: summary.lastSeen },
    }

    const reachedLogFunction = await this.deliver(
      `Repeated ${summary.repeatCount} more times: ${summary.message}`,
      'WARNING',
      labels,
      repeatContextSoEntryHasJsonPayload,
      undefined,
      undefined,
      undefined,
      false,
      true,
      summary.lastSeen,
    )
    if (reachedLogFunction) acknowledgeSummary(summary.id)
  }
}

/**
 * Send user feedback through the configured logger.
 *
 * Module-level for the same reason as `addBreadcrumb` and `bc`: the app calls
 * it from wherever its feedback UI lives, without threading a logger through.
 */
export function sendFeedback<
  AppLabels extends Record<string, string | undefined> = Record<string, string | undefined>,
>(text: string, extras?: FeedbackOptions<AppLabels>): void {
  getClientLogger<AppLabels>().sendFeedback(text, extras)
}

/**
 * Send a test log entry to verify the logging pipeline is working end-to-end.
 * Logs at all severities with errorType: 'fsl-verify'. Safe to call in dev only.
 *
 * After clicking, check:
 * 1. dev.jsonl has entries with labels.errorType === 'fsl-verify'
 * 2. Stack trace is symbolicated (points to source file, not minified bundle)
 * 3. MCP query: source: local, where: [{ field: "labels.errorType", operator: "==", value: "fsl-verify" }]
 */
export function sendTestLog(): void {
  console.info('[fsl] sendTestLog called')
  const logger = getClientLogger()
  const testError = new Error('[fsl-verify] Test error — logging pipeline check')
  console.info('[fsl] sending error log...')
  logger.error(testError, { errorType: 'fsl-verify' }, { test: true })
  console.info('[fsl] sending warning log...')
  logger.warning('[fsl-verify] Test warning', { errorType: 'fsl-verify' })
  console.info('[fsl] sending info log...')
  logger.info('[fsl-verify] Test info', { errorType: 'fsl-verify' })
  console.info('[fsl] sendTestLog scheduled — sends are fire-and-forget; check dev.jsonl in ~1-2s')
}

/** @deprecated Use `sendTestLog()`. */
export function triggerTestLog(): void {
  warnDeprecated('triggerTestLog', 'sendTestLog')
  sendTestLog()
}

// Module-level singleton
let instance: Logger<Record<string, string | undefined>> | null = null

function sendPreviousVisitSummariesOnceInitHasFinished(): void {
  if (typeof setTimeout !== 'undefined') {
    setTimeout(() => instance?.sendPendingSummaries(), 0)
  }
}

export function initLogger<
  AppLabels extends Record<string, string | undefined> = Record<string, string | undefined>,
>(config: InitLoggerConfig<AppLabels>): Logger<AppLabels> {
  instance = new Logger(config) as Logger<Record<string, string | undefined>>

  sendPreviousVisitSummariesOnceInitHasFinished()

  return instance as Logger<AppLabels>
}

let warnedLoggerMissingInHook = false

/**
 * For code that runs inside a framework's or router's own error path (`handleReactError`,
 * `handleVueError`, the router adapters), where a throw would turn an error the framework
 * handled into an exception in the app. Returns `undefined` before `initLogger()`, saying
 * once on the console that errors are not being logged. Not exported from any entry point.
 */
export function getLoggerForFrameworkHook(): Logger<Record<string, string | undefined>> | undefined {
  if (instance) return instance
  if (!warnedLoggerMissingInHook) {
    warnedLoggerMissingInHook = true
    console.warn('[fsl] Framework error not logged: initLogger() has not run')
  }
  return undefined
}

export function getClientLogger<
  AppLabels extends Record<string, string | undefined> = Record<string, string | undefined>,
>(): Logger<AppLabels> {
  if (!instance) throw new Error('[fsl] initLogger() not called')
  return instance as Logger<AppLabels>
}

/**
 * Repeat summaries are sent hourly and when the tab is hidden (README,
 * "Repeats are counted, not dropped"). Neither is triggered by an ordinary
 * log call — `send` does not check for due summaries itself, since doing so
 * with frozen-for-testing time reliably makes an interval-based check look
 * due immediately (see tests/rateLimiter.ts). So there are exactly three
 * triggers for a flush: `initLogger` (a previous visit's queue, once, above),
 * this `visibilitychange` listener (the tab going hidden), and the interval
 * below (an app that never hides its tab and rarely reloads).
 *
 * Neither exists in the esbuild bundle test's sandbox (no `window`/`document`
 * there — see tests/browserBundle.ts), so both are guarded.
 */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return
    flushDueSummaries(true)
    instance?.sendPendingSummaries()
  })
}

if (typeof window !== 'undefined') {
  const interval = setInterval(() => {
    flushDueSummaries()
    instance?.sendPendingSummaries()
  }, 60_000)
  ;(interval as unknown as { unref?: () => void }).unref?.()
}
