import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import type { LogPayload } from '../shared/types'
import { writeLog } from './logger'
import { configureSourceMapBucket, getSourceMap } from './sourceMapCache'
import {
  parseStackTrace,
  symbolicate,
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
 * Extract the bundle filename (e.g. "index-DnZ05f3M.js") from a frame URL.
 */
function bundleFileFromUrl(url: string): string | null {
  const match = url.match(/\/([^/]+\.js)(?:[?#].*)?$/)
  return match ? match[1] : null
}

/**
 * Attempt to symbolicate a minified error stack trace using source maps.
 * Loads source maps per-bundle so multiple chunks are handled correctly.
 */
async function symbolicateError(
  releaseId: string,
  error: ErrorPayload | undefined,
): Promise<ErrorPayload | undefined> {
  if (!error?.stack) return error

  try {
    const frames = parseStackTrace(error.stack)

    // Collect unique bundle filenames referenced across all frames
    const bundleFiles = new Set<string>()
    for (const frame of frames) {
      if (frame.fileName) {
        const bundle = bundleFileFromUrl(frame.fileName)
        if (bundle) bundleFiles.add(bundle)
      }
    }

    if (bundleFiles.size === 0) return error

    // Load source map for each unique bundle (getSourceMap handles caching)
    const sourceMaps = new Map<string, Awaited<ReturnType<typeof getSourceMap>>>()
    await Promise.all(
      Array.from(bundleFiles).map(async (bundle) => {
        const map = await getSourceMap(releaseId, bundle)
        if (map) sourceMaps.set(bundle, map)
      }),
    )

    if (sourceMaps.size === 0) return error

    // Symbolicate each frame with its bundle's source map
    const symbolicated = frames.map((frame) => {
      if (!frame.fileName || !frame.lineNumber || !frame.columnNumber) return frame
      const bundle = bundleFileFromUrl(frame.fileName)
      if (!bundle) return frame
      const sourceMap = sourceMaps.get(bundle)
      if (!sourceMap) return frame
      const result = symbolicate(sourceMap, frame.lineNumber, frame.columnNumber)
      if (!result) return frame
      return {
        ...frame,
        fileName: result.source,
        lineNumber: result.line,
        columnNumber: result.column,
        functionName: result.name ?? frame.functionName,
      }
    })

    return { ...error, stack: formatStackTrace(symbolicated) }
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
