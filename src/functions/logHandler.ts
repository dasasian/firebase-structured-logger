import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import type { LogPayload } from '../shared/types'
import { writeLog } from './logger'
import { configureSourceMapBucket, getSourceMap } from './sourceMapCache'
import {
  parseStackTrace,
  symbolicateStackTrace,
  formatStackTrace,
} from './symbolicate'

export interface ClientLogHandlerConfig {
  bucketName?: string   // defaults to Firebase default storage bucket
  cors?: boolean | string | string[]
  maxInstances?: number
}

const VALID_SEVERITIES = new Set(['ERROR', 'WARNING', 'INFO', 'DEBUG'])

interface ErrorPayload {
  message: string
  stack?: string
  name?: string
  cause?: string
}

/**
 * Attempt to symbolicate a minified error stack trace using source maps.
 */
async function symbolicateError(
  releaseId: string,
  error: ErrorPayload | undefined,
): Promise<ErrorPayload | undefined> {
  if (!error?.stack) return error

  try {
    const frames = parseStackTrace(error.stack)
    const bundleNames = ['main', 'index', 'app']

    for (const name of bundleNames) {
      const sourceMap = await getSourceMap(releaseId, name)
      if (sourceMap) {
        const symbolicated = symbolicateStackTrace(frames, sourceMap)
        return { ...error, stack: formatStackTrace(symbolicated) }
      }
    }
  } catch (err) {
    console.warn('[fsl] Symbolication failed:', err)
  }

  return error
}

/**
 * Strip null/undefined labels and convert all values to strings for Cloud Logging.
 */
function cleanLabels(
  labels: LogPayload['labels'] | undefined,
): Record<string, string> {
  if (!labels) return {}
  const cleaned: Record<string, string> = {}
  for (const [key, value] of Object.entries(labels)) {
    if (value !== null && value !== undefined) {
      cleaned[key] = String(value)
    }
  }
  return cleaned
}

/**
 * Create an onCall handler that receives LogPayload from the client,
 * symbolicates stack traces, and writes structured entries to Cloud Logging.
 *
 * @example
 * export const logFrontendEvent = onCall(createClientLogHandler({ bucketName: 'my-bucket' }))
 */
export function createClientLogHandler(config: ClientLogHandlerConfig) {
  if (config.bucketName) configureSourceMapBucket(config.bucketName)

  return async (request: CallableRequest<LogPayload>): Promise<void> => {
    const { message, severity, labels, jsonPayload } = request.data

    if (!message || !severity) {
      throw new HttpsError('invalid-argument', 'Missing message or severity')
    }

    if (!VALID_SEVERITIES.has(severity)) {
      throw new HttpsError('invalid-argument', `Invalid severity: ${severity}`)
    }

    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'

    try {
      let processedError = jsonPayload?.error
      if (processedError?.stack && !isEmulator) {
        const releaseId = labels?.releaseId ?? 'unknown'
        processedError = await symbolicateError(releaseId, processedError)
      }

      writeLog({
        message,
        severity,
        labels: cleanLabels(labels) as LogPayload['labels'],
        jsonPayload: { ...jsonPayload, error: processedError },
        attachments: request.data.attachments,
      })
    } catch (err) {
      console.error('[fsl] Error processing client log:', err)
      throw new HttpsError('internal', 'Failed to process log')
    }
  }
}

/**
 * Convenience factory that wraps createClientLogHandler in onCall.
 * Use when you want a ready-to-export Cloud Function.
 *
 * @example
 * export const logFrontendEvent = createClientLogFunction({ bucketName: 'my-bucket' })
 */
export function createClientLogFunction(
  config: ClientLogHandlerConfig & { cors?: boolean | string | string[]; maxInstances?: number },
) {
  return onCall<LogPayload, void>(
    { cors: config.cors ?? true, maxInstances: config.maxInstances ?? 1 },
    createClientLogHandler(config),
  )
}
