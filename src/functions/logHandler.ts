import { onCall, HttpsError } from 'firebase-functions/v2/https'
import type { LogPayload, ErrorPayload } from '../shared/types'
import { SEVERITIES } from '../shared/severity'
import { writeLog, cleanLabels } from './logger'
import { configureSourceMapBucket, getSourceMap } from './sourceMapCache'
import {
  parseStackTrace,
  symbolicateStackTrace,
  formatStackTrace,
} from './symbolicate'

export interface ClientLogHandlerConfig {
  /**
   * Storage bucket for **both** source maps and attachments.
   *
   * Maps go to `sourcemaps/{releaseId}/`, attachments to `logAttachments/{logId}/`.
   * Defaults to the project's default bucket.
   *
   * Attachments read it as a fallback, not directly — this sets the process-wide
   * default that `writeLog` reaches for, since the upload happens outside any
   * handler. Override either half independently with `sourceMaps` below or
   * `configureAttachments()`.
   */
  bucketName?: string
  cors?: boolean | string | string[]
  maxInstances?: number
  /**
   * Where this handler looks for source maps in Cloud Storage.
   *
   * Genuinely per-handler: both values travel explicitly to `getSourceMap`, so
   * two handlers configured differently cannot resolve to whichever was
   * constructed last. `bucket` overrides `bucketName` for map lookups only.
   *
   * `prefix` must match `fsl upload-sourcemaps --prefix`. They are the two ends
   * of one contract (#35) and nothing checks them against each other — when they
   * disagree the maps are simply not found and stacks stay minified.
   *
   * Attachments are configured separately, with `configureAttachments()` — the
   * upload happens outside any handler, so a field here would be a lie.
   */
  sourceMaps?: { bucket?: string; prefix?: string }
}

const VALID_SEVERITIES = new Set<string>(SEVERITIES)

/**
 * What the bare handler throws.
 *
 * It used to throw `HttpsError` directly, which made the handler
 * Firebase-shaped in its failures as well as its input — a caller running it
 * behind anything else got an error carrying a callable protocol's vocabulary.
 * `createClientLogFunction` converts these back, so a callable client sees
 * exactly what it saw before.
 */
export class ClientLogError extends Error {
  constructor(
    readonly code: 'invalid-argument' | 'internal',
    message: string,
  ) {
    super(message)
    this.name = 'ClientLogError'
  }
}

/**
 * The minimum the handler actually reads.
 *
 * `CallableRequest` was in the signature and only `.data` was ever touched —
 * not `.auth`, not `.rawRequest`. Saying so is what lets an Express adapter, or
 * anything else, call this without constructing a callable request (#34).
 */
export interface ClientLogRequest {
  data: LogPayload
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
  bucketName?: string,
  prefix?: string,
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
        const map = await getSourceMap(releaseId, bundle, bucketName, prefix)
        if (map) sourceMaps.set(bundle, map)
      }),
    )

    if (sourceMaps.size === 0) return error

    // Symbolicate each frame with its bundle's source map
    const symbolicated = symbolicateStackTrace(frames, (frame) => {
      const bundle = frame.fileName && bundleFileFromUrl(frame.fileName)
      return bundle ? sourceMaps.get(bundle) : null
    })

    return { ...error, stack: formatStackTrace(symbolicated) }
  } catch (err) {
    console.warn('[fsl] Symbolication failed:', err)
  }

  return error
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

  return async (request: ClientLogRequest): Promise<void> => {
    const { message, severity, labels, jsonPayload } = request.data

    if (!message || !severity) {
      throw new ClientLogError('invalid-argument', 'Missing message or severity')
    }

    if (!VALID_SEVERITIES.has(severity)) {
      throw new ClientLogError('invalid-argument', `Invalid severity: ${severity}`)
    }

    const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'

    try {
      let processedError = jsonPayload?.error
      if (processedError?.stack && !isEmulator) {
        const releaseId = labels?.releaseId ?? 'unknown'
        processedError = await symbolicateError(
          releaseId,
          processedError,
          config.sourceMaps?.bucket ?? config.bucketName,
          config.sourceMaps?.prefix,
        )
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
      throw new ClientLogError('internal', 'Failed to process log')
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
  const handler = createClientLogHandler(config)
  return onCall<LogPayload, void>(
    { cors: config.cors ?? true, maxInstances: config.maxInstances ?? 1 },
    async (request) => {
      try {
        await handler(request)
      } catch (err) {
        // Convert back at the Firebase boundary, so a callable client sees the
        // same error it always did.
        if (err instanceof ClientLogError) throw new HttpsError(err.code, err.message)
        throw err
      }
    },
  )
}
