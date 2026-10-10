import { AsyncLocalStorage } from 'async_hooks'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { toError } from '../shared/error'
import { createLogWriter, cleanLabels, rememberErrorWasLogged, wasErrorAlreadyLogged, type LogWriter } from './logger'

const storage = new AsyncLocalStorage<LogWriter>()

interface RequestLoggerOptions<AppLabels extends Record<string, string | undefined>> {
  functionName?: string
  appId?: string
  labels?: Partial<AppLabels>
}

function writerFor<AppLabels extends Record<string, string | undefined>>(
  request: object,
  extra?: RequestLoggerOptions<AppLabels>,
): LogWriter {
  return createLogWriter(
    cleanLabels({
      functionName: extra?.functionName,
      userId: (request as { auth?: { uid?: string } }).auth?.uid,
      appId: extra?.appId,
      ...extra?.labels,
    }),
  )
}

function clientErrorStatus(thrown: unknown): number | undefined {
  if (typeof thrown !== 'object' || thrown === null) return undefined
  const status = (thrown as { httpErrorCode?: { status?: unknown } }).httpErrorCode?.status
  return typeof status === 'number' && status < 500 ? status : undefined
}

function logThrown(writer: LogWriter, thrown: unknown): void {
  if (wasErrorAlreadyLogged(thrown)) return
  const status = clientErrorStatus(thrown)
  if (status === undefined) {
    writer.error(thrown)
    return
  }
  const error = toError(thrown)
  rememberErrorWasLogged(thrown)
  writer.warning(error.message, { errorType: error.name }, { code: (thrown as { code?: unknown }).code, status })
}

/**
 * Wrap an onCall, onSchedule or onTaskDispatched handler so every log inside it carries the request's labels.
 *
 * This is the correct way to scope a request logger. The store is bound with
 * `AsyncLocalStorage.run()`, which restores the previous context when the
 * handler settles — so a request's labels cannot outlive the request.
 *
 * What the handler throws is logged with those labels and thrown again, the same value,
 * so a handler needs no `try`/`catch` only to log. A plain `Error`, or an error whose
 * `httpErrorCode.status` is 500 or more, is an `ERROR`. A 4xx `HttpsError` is a
 * `WARNING` with its code and status and no stack. An error already given to `logError`
 * is not logged a second time.
 *
 * @example
 * export const myFunc = onCall(
 *   withLogging<AppLabels>({ functionName: 'myFunc' }, async (request) => {
 *     logInfo('started')
 *   }),
 * )
 *
 * For the other triggers, name the event type: `withLogging<AppLabels, ScheduledEvent>`
 * inside `onSchedule`, `withLogging<AppLabels, Request<Data>>` inside `onTaskDispatched`.
 * `userId` comes from `auth.uid` when the event has one; a schedule has none.
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
  Req extends object = CallableRequest,
  Res = any,
>(
  options:
    | RequestLoggerOptions<AppLabels>
    | ((request: Req) => RequestLoggerOptions<AppLabels>),
  handler: (request: Req) => Res | Promise<Res>,
): (request: Req) => Promise<Res> {
  return (request: Req) => {
    const resolved = typeof options === 'function' ? options(request) : options
    const writer = writerFor<AppLabels>(request, resolved)
    return storage.run(writer, async () => {
      try {
        return await handler(request)
      } catch (thrown) {
        logThrown(writer, thrown)
        throw thrown
      }
    })
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
