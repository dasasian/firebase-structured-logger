import * as fs from 'fs'
import * as path from 'path'
import { logger as ffLogger } from 'firebase-functions'
import type { LogSeverity, LogPayload } from '../shared/types'

const IS_EMULATOR = process.env.FUNCTIONS_EMULATOR === 'true'
const LOG_FILENAME = 'dev.jsonl'

interface FunctionsLoggerConfig {
  appId: string
  logLocalDir?: string
  logMaxRecordsPerFile?: number  // default 2000
  logMaxRotatedFiles?: number    // default 5
}

let globalConfig: FunctionsLoggerConfig | null = null
let currentRecordCount = 0

/**
 * Initialize the functions-side logger.
 * Call once at module load (before any onCall handlers run).
 */
export function initLogger(config: FunctionsLoggerConfig): void {
  globalConfig = config
  currentRecordCount = 0

  if (IS_EMULATOR && config.logLocalDir) {
    fs.mkdirSync(config.logLocalDir, { recursive: true })
    rotateLogFile(config.logLocalDir, config.logMaxRotatedFiles ?? 5)
  }
}

/**
 * Rotate the current log file to a timestamped backup, delete oldest files beyond limit.
 */
function rotateLogFile(logDir: string, maxRotatedFiles: number): void {
  const current = path.join(logDir, LOG_FILENAME)
  try {
    if (fs.existsSync(current)) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      fs.renameSync(current, path.join(logDir, `dev-${timestamp}.jsonl`))
    }

    // Delete oldest rotated files beyond limit
    const rotated = fs.readdirSync(logDir)
      .filter(f => f.startsWith('dev-') && f.endsWith('.jsonl'))
      .sort()  // ISO timestamps sort lexicographically = chronologically

    const toDelete = rotated.slice(0, Math.max(0, rotated.length - maxRotatedFiles))
    for (const f of toDelete) {
      fs.unlinkSync(path.join(logDir, f))
    }
  } catch (err) {
    console.warn('[fsl] Failed to rotate log file:', err)
  }
}

/**
 * Write a structured log entry. Transport depends on environment.
 */
export function writeLog(
  payload: LogPayload & { functionName?: string; requestId?: string },
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    severity: payload.severity,
    message: payload.message,
    labels: { ...payload.labels },
    jsonPayload: payload.jsonPayload,
    ...(payload.functionName ? { functionName: payload.functionName } : {}),
    ...(payload.requestId ? { requestId: payload.requestId } : {}),
  }

  if (IS_EMULATOR) {
    if (globalConfig?.logLocalDir) {
      try {
        const maxRecords = globalConfig.logMaxRecordsPerFile ?? 2000
        const maxRotated = globalConfig.logMaxRotatedFiles ?? 5
        if (currentRecordCount >= maxRecords) {
          rotateLogFile(globalConfig.logLocalDir, maxRotated)
          currentRecordCount = 0
        }
        const logFile = path.join(globalConfig.logLocalDir, LOG_FILENAME)
        fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf-8')
        currentRecordCount++
      } catch (err) {
        console.warn('[fsl] Failed to write to log file:', err)
      }
    }

    // Also write to console for immediate visibility
    const consoleFn = payload.severity === 'ERROR'
      ? console.error
      : payload.severity === 'WARNING'
        ? console.warn
        : payload.severity === 'DEBUG'
          ? console.debug
          : console.log

    consoleFn(`[${payload.severity}] ${payload.message}`, entry.labels)
    return
  }

  // Production: write to Cloud Logging via firebase-functions logger
  const structuredData = { labels: entry.labels, jsonPayload: entry.jsonPayload }

  switch (payload.severity) {
    case 'ERROR':
      ffLogger.error(payload.message, structuredData)
      break
    case 'WARNING':
      ffLogger.warn(payload.message, structuredData)
      break
    case 'DEBUG':
      ffLogger.debug(payload.message, structuredData)
      break
    default:
      ffLogger.info(payload.message, structuredData)
  }
}

/**
 * Convenience wrapper that builds a logger object for a given label set.
 */
export function createLogWriter(baseLabels: Record<string, string | undefined>) {
  const merge = (extra?: Record<string, string | undefined>) => ({
    ...baseLabels,
    ...extra,
  })

  return {
    error(
      raw: unknown,
      labels?: Record<string, string | undefined>,
      context?: Record<string, unknown>,
    ): void {
      const error = raw instanceof Error ? raw : new Error(String(raw))
      writeLog({
        message: error.message,
        severity: 'ERROR',
        labels: merge({ errorType: error.name, ...labels }) as LogPayload['labels'],
        jsonPayload: {
          context,
          error: {
            message: error.message,
            stack: error.stack,
            name: error.name,
            cause: error.cause !== undefined ? String(error.cause) : undefined,
          },
        },
      })
    },
    info(
      message: string,
      labels?: Record<string, string | undefined>,
      context?: Record<string, unknown>,
    ): void {
      writeLog({
        message,
        severity: 'INFO',
        labels: merge(labels) as LogPayload['labels'],
        jsonPayload: { context },
      })
    },
    warning(
      message: string,
      labels?: Record<string, string | undefined>,
      context?: Record<string, unknown>,
    ): void {
      writeLog({
        message,
        severity: 'WARNING',
        labels: merge(labels) as LogPayload['labels'],
        jsonPayload: { context },
      })
    },
    debug(
      message: string,
      labels?: Record<string, string | undefined>,
      context?: Record<string, unknown>,
    ): void {
      writeLog({
        message,
        severity: 'DEBUG',
        labels: merge(labels) as LogPayload['labels'],
        jsonPayload: { context },
      })
    },
  }
}

export type LogWriter = ReturnType<typeof createLogWriter>

// Re-export severity type for consumers
export type { LogSeverity }
