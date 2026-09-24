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
 * The project a trace resource name belongs to, from the environment.
 *
 * Cloud Functions sets `GCLOUD_PROJECT`. Cloud Run sets NEITHER variable — 0.7.0
 * assumed it set `GOOGLE_CLOUD_PROJECT`, so on the backend createHttpLogHandler
 * exists for, the trace was silently never written (#39). See resolveTraceProject.
 */
function envProject(): string | undefined {
  return process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || undefined
}

const METADATA_PROJECT_URL = 'http://metadata.google.internal/computeMetadata/v1/project/project-id'

// undefined = not looked up; null = looked up and not found.
let metadataProject: string | null | undefined
let metadataLookup: Promise<void> | undefined

/**
 * Find the project on a Google runtime that does not put it in the environment.
 *
 * Why the resource name at all: Cloud Logging's LogEntry reference prefers the bare
 * trace id, but stores whichever form it is given, and the console's "show entries
 * for this trace" filters on the full `projects/<id>/traces/<trace>` — the form Cloud
 * Run writes its own request log in. A bare id never meets that request log; the
 * smoke run proved it. So the project has to be found.
 *
 * Asked of the metadata server, the way Google's own Cloud Run sample and its pino
 * config do: once, cached, and only on Cloud Run (`K_SERVICE` is set) — anywhere
 * else the lookup would only wait for a timeout. Async, so it is awaited where the
 * request starts (createHttpLogHandler), not on the synchronous log path.
 */
export function resolveTraceProject(): Promise<void> {
  if (envProject() || metadataProject !== undefined) return Promise.resolve()
  if (!process.env.K_SERVICE) {
    metadataProject = null
    return Promise.resolve()
  }
  metadataLookup ??= fetch(METADATA_PROJECT_URL, {
    headers: { 'Metadata-Flavor': 'Google' },
    signal: AbortSignal.timeout(1_000),
  })
    .then(async (res) => {
      metadataProject = res.ok ? (await res.text()).trim() || null : null
    })
    .catch(() => {
      metadataProject = null
    })
  return metadataLookup
}

/** Forget the looked-up project. Tests only. */
export function resetTraceProject(): void {
  metadataProject = undefined
  metadataLookup = undefined
}

/**
 * The `logging.googleapis.com/trace` value: the full resource name when the project
 * is known, and the bare id when it is not. The bare id is a valid LogEntry.trace —
 * the entry still carries its trace — it only fails to meet the request log in the
 * console, so it beats writing nothing.
 */
export function traceField(): string | undefined {
  const traceId = currentTraceId()
  if (!traceId) return undefined
  const project = envProject() ?? metadataProject ?? undefined
  return project ? `projects/${project}/traces/${traceId}` : traceId
}
