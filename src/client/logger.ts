import type { LogSeverity, LogPayload } from '../shared/types'
import {
  addBreadcrumb,
  getLastBreadcrumbs,
  getCurrentScreen,
  getActiveActivity,
  setCurrentScreen,
  clearBreadcrumbs,
} from './breadcrumbs'
import {
  canLogEvent,
  canLogError,
  recordLog,
  recordError,
  configureRateLimiter,
  type RateLimitConfig,
} from './rateLimiter'

export type { RateLimitConfig }

type LogCallable = (data: LogPayload) => Promise<unknown>

export interface InitLoggerConfig<
  AppLabels extends Record<string, string | undefined> = Record<string, string | undefined>,
> {
  appId: string
  releaseId: string
  logFunction: LogCallable
  minLogLevel?: LogSeverity
  rateLimitOptions?: RateLimitConfig
}

const SEVERITY_ORDER: Record<LogSeverity, number> = {
  ERROR: 0,
  WARNING: 1,
  INFO: 2,
  DEBUG: 3,
}

function defaultMinLevel(): LogSeverity {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') return 'WARNING'
  return 'DEBUG'
}

function getPlatform(): string {
  if (typeof navigator === 'undefined') return 'unknown'
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios'
  if (/Android/.test(ua)) return 'android'
  if (/Mac/.test(ua)) return 'macos'
  if (/Win/.test(ua)) return 'windows'
  if (/Linux/.test(ua)) return 'linux'
  return 'web'
}

function getBrowser(): string {
  if (typeof navigator === 'undefined') return 'unknown'
  const ua = navigator.userAgent
  if (/Firefox/.test(ua)) return 'firefox'
  if (/Edg/.test(ua)) return 'edge'
  if (/Chrome/.test(ua)) return 'chrome'
  if (/Safari/.test(ua)) return 'safari'
  return 'unknown'
}

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

  async error(
    raw: unknown,
    labels?: Partial<AppLabels>,
    context?: Record<string, unknown>,
    attachments?: Record<string, Blob | File | string>,
  ): Promise<void> {
    const error = raw instanceof Error ? raw : new Error(String(raw))
    const screen = getCurrentScreen()
    const activity = getActiveActivity()

    if (!canLogError(error, screen, activity)) {
      console.error('[fsl] Error suppressed:', error.message)
      return
    }

    recordError(error, screen, activity)

    const errorLabels: Record<string, string | undefined> = {
      errorType: error.name || 'UnknownError',
      ...(labels as Record<string, string | undefined>),
    }

    await this.send(error.message, 'ERROR', errorLabels, {
      ...context,
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name,
        cause: error.cause !== undefined ? String(error.cause) : undefined,
      },
    }, attachments)
  }

  async info(
    message: string,
    labels?: Partial<AppLabels>,
    context?: Record<string, unknown>,
    attachments?: Record<string, Blob | File | string>,
  ): Promise<void> {
    await this.send(message, 'INFO', labels as Record<string, string | undefined>, context, attachments)
  }

  async warning(
    message: string,
    labels?: Partial<AppLabels>,
    context?: Record<string, unknown>,
    attachments?: Record<string, Blob | File | string>,
  ): Promise<void> {
    await this.send(message, 'WARNING', labels as Record<string, string | undefined>, context, attachments)
  }

  async debug(
    message: string,
    labels?: Partial<AppLabels>,
    context?: Record<string, unknown>,
    attachments?: Record<string, Blob | File | string>,
  ): Promise<void> {
    await this.send(message, 'DEBUG', labels as Record<string, string | undefined>, context, attachments)
  }

  private async send(
    message: string,
    severity: LogSeverity,
    labels?: Record<string, string | undefined>,
    context?: Record<string, unknown>,
    attachments?: Record<string, Blob | File | string>,
  ): Promise<void> {
    if (SEVERITY_ORDER[severity] > this.minLevel) return

    if (!canLogEvent()) {
      console.warn('[fsl] Rate limit exceeded')
      return
    }

    const allLabels: LogPayload['labels'] = {
      appId: this.config.appId,
      releaseId: this.config.releaseId,
      screen: getCurrentScreen(),
      userId: this.userId,
      platform: getPlatform(),
      browser: getBrowser(),
      ...this.userLabels,
      ...labels,
    }

    let base64Attachments: Record<string, string> | undefined
    if (attachments && Object.keys(attachments).length > 0) {
      base64Attachments = {}
      for (const [name, attachment] of Object.entries(attachments)) {
        base64Attachments[name] = await assetToBase64(attachment)
      }
    }

    const payload: LogPayload = {
      message,
      severity,
      labels: allLabels,
      jsonPayload: {
        breadcrumbs: getLastBreadcrumbs(20),
        context,
        error: context?.error as { message: string; stack?: string; name?: string } | undefined,
      },
      ...(base64Attachments ? { attachments: base64Attachments } : {}),
    }

    recordLog()

    try {
      await this.config.logFunction(payload)
    } catch (err) {
      console.error('[fsl] Failed to send log:', err instanceof Error ? err.message : err)
    }
  }
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
export async function triggerTestLog(): Promise<void> {
  console.info('[fsl] triggerTestLog called')
  const logger = getClientLogger()
  const testError = new Error('[fsl-verify] Test error — logging pipeline check')
  console.info('[fsl] sending error log...')
  await logger.error(testError, { errorType: 'fsl-verify' }, { test: true })
  console.info('[fsl] sending warning log...')
  await logger.warning('[fsl-verify] Test warning', { errorType: 'fsl-verify' })
  console.info('[fsl] sending info log...')
  await logger.info('[fsl-verify] Test info', { errorType: 'fsl-verify' })
  console.info('[fsl] triggerTestLog complete — check dev.jsonl for fsl-verify entries')
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
