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
 * Retrieve the request-scoped logger.
 *
 * Returns an anonymous writer (no request labels) when called outside a
 * request. `withLogging` unwinds the scope when a handler settles, so this is
 * genuinely anonymous rather than whatever ran last.
 */
export function getLogger(): LogWriter {
  return storage.getStore() ?? createLogWriter({})
}
