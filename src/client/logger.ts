import type { LogSeverity, LogPayload, ErrorPayload, BaseLabels } from '../shared/types'
import { SEVERITY_ORDER, FEEDBACK_LABEL } from '../shared/severity'
import { toError, toErrorPayload } from '../shared/error'
import {
  addBreadcrumb,
  getLastBreadcrumbs,
  MAX_BREADCRUMBS,
  getCurrentScreen,
  setCurrentScreen,
  clearBreadcrumbs,
} from './breadcrumbs'
import {
  allow,
  signatureFor,
  configureRateLimiter,
  type RateLimitConfig,
} from './rateLimiter'

export type { RateLimitConfig }

type LogCallable = (data: LogPayload) => Promise<unknown>

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
  minLogLevel?: LogSeverity
  rateLimitOptions?: RateLimitConfig
}

function defaultMinLevel(): LogSeverity {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') return 'WARNING'
  return 'DEBUG'
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

export class Logger<
  AppLabels extends Record<string, string | undefined> = Record<string, string | undefined>,
> {
  private readonly config: InitLoggerConfig<AppLabels>
  private readonly minLevel: number
  private userId: string | undefined
  private userLabels: Partial<AppLabels> = {}

  constructor(config: InitLoggerConfig<AppLabels>) {
    this.config = config
    this.minLevel = SEVERITY_ORDER[config.minLogLevel ?? defaultMinLevel()]
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

    void this.send(
      error.message,
      'ERROR',
      errorLabels,
      context,
      attachments,
      toErrorPayload(error),
      signatureFor(error, getCurrentScreen()),
    )
  }

  info(
    message: string,
    labels?: Partial<AppLabels & BaseLabels>,
    context?: Record<string, unknown>,
    attachments?: Record<string, Blob | File | string>,
  ): void {
    void this.send(message, 'INFO', labels as Record<string, string | undefined>, context, attachments)
  }

  warning(
    message: string,
    labels?: Partial<AppLabels & BaseLabels>,
    context?: Record<string, unknown>,
    attachments?: Record<string, Blob | File | string>,
  ): void {
    void this.send(message, 'WARNING', labels as Record<string, string | undefined>, context, attachments)
  }

  debug(
    message: string,
    labels?: Partial<AppLabels & BaseLabels>,
    context?: Record<string, unknown>,
    attachments?: Record<string, Blob | File | string>,
  ): void {
    void this.send(message, 'DEBUG', labels as Record<string, string | undefined>, context, attachments)
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
   * Headless — the app owns the UI. Returns nothing: a reference number is
   * meaningless to a user with no portal to check it against. An app wanting
   * correlation passes its own id as a label, which it knows before sending.
   */
  sendFeedback(text: string, extras?: FeedbackOptions<AppLabels>): void {
    void this.send(
      text,
      'NOTICE',
      { [FEEDBACK_LABEL]: 'true', ...(extras?.labels as Record<string, string | undefined>) },
      undefined,
      extras?.attachments,
      undefined,
      undefined,
      true, // exempt from the severity floor and the rate limiter
    )
  }

  private async send(
    message: string,
    severity: LogSeverity,
    labels?: Record<string, string | undefined>,
    context?: Record<string, unknown>,
    attachments?: Record<string, Blob | File | string>,
    error?: ErrorPayload,
    signature?: string,
    // Both gates below are volume and cost controls for events the SYSTEM
    // emits. Feedback is a person sending a message that happens to travel the
    // same pipe — it is rare by nature and there is nothing to throttle. The
    // exemption keys on the record being feedback, not on its severity, so a
    // NOTICE emitted for anything else still behaves normally.
    bypassVolumeControls = false,
  ): Promise<void> {
    if (!bypassVolumeControls && SEVERITY_ORDER[severity] > this.minLevel) return

    // One gate for every severity. Passing a signature opts this log into
    // duplicate suppression; the check and the budget spend are one operation,
    // so a log can neither be counted twice nor checked without being counted.
    const decision = bypassVolumeControls ? ({ allowed: true } as const) : allow(signature)
    if (!decision.allowed) {
      if (decision.reason === 'duplicate') {
        console.warn(`[fsl] Duplicate suppressed: ${decision.signature}`)
      } else {
        console.warn('[fsl] Session log limit reached')
      }
      return
    }

    try {
      const allLabels: LogPayload['labels'] = {
        appId: this.config.appId,
        releaseId: this.config.releaseId,
        screen: getCurrentScreen(),
        userId: this.userId,
        platform: PLATFORM,
        browser: BROWSER,
        ...this.userLabels,
        ...labels,
      }

      // Each attachment is converted in its own try. A Blob or File can fail to
      // read — a user picks a file from <input type="file">, moves or deletes it,
      // then submits, and the browser raises NotReadableError. Previously one
      // such failure escaped to the outer catch and the ENTIRE entry was lost:
      // message, labels, breadcrumbs and all. The message and breadcrumbs are
      // the valuable part; an attachment is a bonus.
      let base64Attachments: Record<string, string> | undefined
      const failedAttachments: string[] = []
      if (attachments && Object.keys(attachments).length > 0) {
        const converted: Record<string, string> = {}
        for (const [name, attachment] of Object.entries(attachments)) {
          try {
            converted[name] = await assetToBase64(attachment)
          } catch (err) {
            failedAttachments.push(name)
            console.warn(
              `[fsl] Could not read attachment "${name}" — sending the log without it:`,
              err instanceof Error ? err.message : err,
            )
          }
        }
        if (Object.keys(converted).length > 0) base64Attachments = converted
      }

      // Without this the absence of hasAttachments is a mystery. Labels are
      // promoted to Cloud Logging entry labels, so this is filterable.
      if (failedAttachments.length > 0) {
        allLabels.attachmentsFailed = failedAttachments.join(',')
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
      }

      await this.config.logFunction(payload)
    } catch (err) {
      console.error('[fsl] Failed to send log:', err instanceof Error ? err.message : err)
    }
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
 * Trigger a test log entry to verify the logging pipeline is working end-to-end.
 * Logs at all severities with errorType: 'fsl-verify'. Safe to call in dev only.
 *
 * After clicking, check:
 * 1. dev.jsonl has entries with labels.errorType === 'fsl-verify'
 * 2. Stack trace is symbolicated (points to source file, not minified bundle)
 * 3. MCP query: source: local, where: [{ field: "labels.errorType", operator: "==", value: "fsl-verify" }]
 */
export function triggerTestLog(): void {
  console.info('[fsl] triggerTestLog called')
  const logger = getClientLogger()
  const testError = new Error('[fsl-verify] Test error — logging pipeline check')
  console.info('[fsl] sending error log...')
  logger.error(testError, { errorType: 'fsl-verify' }, { test: true })
  console.info('[fsl] sending warning log...')
  logger.warning('[fsl-verify] Test warning', { errorType: 'fsl-verify' })
  console.info('[fsl] sending info log...')
  logger.info('[fsl-verify] Test info', { errorType: 'fsl-verify' })
  console.info('[fsl] triggerTestLog scheduled — sends are fire-and-forget; check dev.jsonl in ~1-2s')
}

// Module-level singleton
let instance: Logger<Record<string, string | undefined>> | null = null

export function initLogger<
  AppLabels extends Record<string, string | undefined> = Record<string, string | undefined>,
>(config: InitLoggerConfig<AppLabels>): Logger<AppLabels> {
  instance = new Logger(config) as Logger<Record<string, string | undefined>>
  return instance as Logger<AppLabels>
}

export function getClientLogger<
  AppLabels extends Record<string, string | undefined> = Record<string, string | undefined>,
>(): Logger<AppLabels> {
  if (!instance) throw new Error('[fsl] initLogger() not called')
  return instance as Logger<AppLabels>
}
