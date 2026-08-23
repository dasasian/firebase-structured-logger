import { AsyncLocalStorage } from 'async_hooks'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { createLogWriter, cleanLabels, type LogWriter } from './logger'

const storage = new AsyncLocalStorage<LogWriter>()

interface RequestLoggerOptions<AppLabels extends Record<string, string | undefined>> {
  functionName?: string
  appId?: string
  labels?: Partial<AppLabels>
}

function writerFor<AppLabels extends Record<string, string | undefined>>(
  request: CallableRequest,
  extra?: RequestLoggerOptions<AppLabels>,
): LogWriter {
  return createLogWriter(
    cleanLabels({
      functionName: extra?.functionName,
      userId: request.auth?.uid,
      appId: extra?.appId,
      ...extra?.labels,
    }),
  )
}

/**
 * Wrap an onCall handler so every log inside it carries the request's labels.
 *
 * This is the correct way to scope a request logger. The store is bound with
 * `AsyncLocalStorage.run()`, which restores the previous context when the
 * handler settles — so a request's labels cannot outlive the request.
 *
 * @example
 * export const myFunc = onCall(
 *   withLogging<AppLabels>({ functionName: 'myFunc' }, async (request) => {
 *     logInfo('started')
 *   }),
 * )
 *
 * Labels that depend on the request are computed per call:
 *
 * @example
 * withLogging<AppLabels>(
 *   (request) => ({ functionName: 'myFunc', labels: { orgId: request.data.orgId } }),
 *   async (request) => { ... },
 * )
 */
export function withLogging<
  AppLabels extends Record<string, string | undefined> = Record<string, string | undefined>,
  Req extends CallableRequest = CallableRequest,
  Res = unknown,
>(
  options:
    | RequestLoggerOptions<AppLabels>
    | ((request: Req) => RequestLoggerOptions<AppLabels>),
  handler: (request: Req) => Res | Promise<Res>,
): (request: Req) => Promise<Res> {
  return (request: Req) => {
    const resolved = typeof options === 'function' ? options(request) : options
    const writer = writerFor<AppLabels>(request, resolved)
    return storage.run(writer, async () => handler(request))
  }
}

/**
 * Initialize a request-scoped logger and store it in AsyncLocalStorage.
 *
 * @deprecated Use {@link withLogging}. This leaks the request scope: it binds
 * with `AsyncLocalStorage.enterWith()`, which persists for the remainder of the
 * execution context and is never unwound. The labels therefore outlive the
 * request, and any later handler that does NOT call this — a scheduled
 * function, a Firestore or Storage trigger, or anything relying on
 * `getLogger()`'s anonymous fallback — inherits whichever user last touched the
 * warm instance.
 *
 * Handlers that all call this are unaffected: each overwrites the store with
 * its own labels. The hazard is the handlers that do not.
 *
 * Removed in 0.6.0.
 */
export function initRequestLogger<
  AppLabels extends Record<string, string | undefined> = Record<string, string | undefined>,
>(
  request: CallableRequest,
  extra?: RequestLoggerOptions<AppLabels>,
): LogWriter {
  warnDeprecated(extra?.functionName)
  const writer = writerFor<AppLabels>(request, extra)
  storage.enterWith(writer)
  return writer
}

// Warn once per function name rather than per invocation — a per-request warning
// on a hot path is noise that gets filtered out and then ignored.
const warned = new Set<string>()
function warnDeprecated(functionName: string | undefined): void {
  const key = functionName ?? '(unnamed)'
  if (warned.has(key)) return
  warned.add(key)
  console.warn(
    `[fsl] initRequestLogger() is deprecated (${key}). It binds the request scope with ` +
      'enterWith(), which is never unwound — the labels outlive the request, so a later ' +
      'handler that does not call it inherits this request\'s userId. Wrap the handler ' +
      'with withLogging() instead. Removed in 0.6.0.',
  )
}

/**
 * Retrieve the request-scoped logger.
 *
 * Returns an anonymous writer (no request labels) when called outside a
 * request. That is only reliable when requests are scoped with
 * {@link withLogging} — under the deprecated `initRequestLogger`, a previous
 * request's writer can still be in scope here.
 */
export function getLogger(): LogWriter {
  return storage.getStore() ?? createLogWriter({})
}
