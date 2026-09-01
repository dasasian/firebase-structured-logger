/**
 * Request trace ids, for backends that are not Cloud Functions (#34).
 *
 * `firebase-functions/logger`'s `write()` attaches
 * `logging.googleapis.com/trace` from an AsyncLocalStorage that
 * firebase-functions populates inside its own request wrapper. Outside one —
 * Cloud Run, or anything behind `createHttpLogHandler` — that store is empty, so
 * no trace id is attached and Cloud Logging cannot group a request's entries.
 *
 * That is silent: the logs arrive, they simply do not correlate, and nothing
 * says why. So the adapter reads the headers itself and stores the id here.
 *
 * Inside Cloud Functions this is dormant — the store is never populated, and
 * firebase-functions' own value takes precedence anyway, since it overwrites the
 * field after we set it.
 */

import { AsyncLocalStorage } from 'async_hooks'

const traceStore = new AsyncLocalStorage<string>()

/**
 * Cloud Trace's own header: `TRACE_ID/SPAN_ID;o=TRACE_TRUE`.
 * Google's load balancers and Cloud Run set this.
 */
const CLOUD_TRACE_HEADER = 'x-cloud-trace-context'

/**
 * W3C Trace Context: `00-<32 hex trace>-<16 hex span>-<flags>`.
 * What OpenTelemetry and most third-party tracers send.
 */
const TRACEPARENT_HEADER = 'traceparent'

const CLOUD_TRACE = /^([0-9a-fA-F]{32})(?:\/(\d+))?(?:;o=[01])?$/
const TRACEPARENT = /^[0-9a-fA-F]{2}-([0-9a-fA-F]{32})-[0-9a-fA-F]{16}-[0-9a-fA-F]{2}$/

function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

/**
 * Pull a trace id out of request headers, preferring Cloud Trace's own format.
 *
 * Returns undefined rather than a partial id when nothing matches. A malformed
 * header is not worth guessing at: an invalid trace resource name is rejected by
 * Cloud Logging, which would cost the whole entry rather than just its
 * correlation.
 */
export function traceIdFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  // Header names are case-insensitive, and nothing guarantees the host framework
  // lower-cased them — Node's http does, a hand-rolled object may not.
  const lower: Record<string, string | string[] | undefined> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v

  const cloud = firstValue(lower[CLOUD_TRACE_HEADER])
  const cloudMatch = cloud && CLOUD_TRACE.exec(cloud.trim())
  if (cloudMatch) return cloudMatch[1]

  const parent = firstValue(lower[TRACEPARENT_HEADER])
  const parentMatch = parent && TRACEPARENT.exec(parent.trim())
  if (parentMatch) return parentMatch[1]

  return undefined
}

/** Run `fn` with `traceId` attached to every log written inside it. */
export function runWithTrace<T>(traceId: string | undefined, fn: () => T): T {
  return traceId ? traceStore.run(traceId, fn) : fn()
}

/** The current request's trace id, if one was parsed. */
export function currentTraceId(): string | undefined {
  return traceStore.getStore()
}

/**
 * The project a trace resource name belongs to.
 *
 * Cloud Functions sets `GCLOUD_PROJECT`; Cloud Run sets `GOOGLE_CLOUD_PROJECT`.
 * With neither there is no valid resource name to build, so the field is left
 * off rather than written wrong.
 */
export function traceProject(): string | undefined {
  return process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || undefined
}

/** The full `logging.googleapis.com/trace` value, or undefined if unavailable. */
export function traceResourceName(): string | undefined {
  const traceId = currentTraceId()
  const project = traceProject()
  if (!traceId || !project) return undefined
  return `projects/${project}/traces/${traceId}`
}
